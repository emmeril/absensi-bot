const path = require("path");
const { Worker } = require("worker_threads");

class FaceWorkerPool {
  constructor({
    size = 2,
    maxQueue = 100,
    timeoutMs = 60000,
    estimatedJobMs = 2500,
    workerFactory,
  } = {}) {
    this.size = Math.max(1, size);
    this.maxQueue = Math.max(1, maxQueue);
    this.timeoutMs = Math.max(50, timeoutMs);
    this.estimatedJobMs = Math.max(10, estimatedJobMs);
    this.workerFile = path.join(__dirname, "..", "workers", "face-worker.js");
    this.workerFactory = workerFactory || (() => new Worker(this.workerFile));
    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextJobId = 1;
    this.closing = false;
    this.terminations = new Set();

    for (let index = 0; index < this.size; index += 1) this.#spawnWorker();
  }

  verify(userId, photo) {
    if (this.closing) throw this.#error("Worker ditutup", "POOL_CLOSED");
    if (this.queue.length >= this.maxQueue) {
      throw this.#error("Antrean verifikasi wajah penuh", "QUEUE_FULL");
    }

    const position = this.queue.length + this.workers.filter((item) => item.busy).length + 1;
    const estimatedCompletionMs =
      Math.ceil(position / Math.max(1, this.workers.length || this.size)) *
      this.estimatedJobMs;
    if (estimatedCompletionMs > this.timeoutMs) {
      throw this.#error(
        "Antrean verifikasi wajah terlalu panjang untuk diselesaikan tepat waktu",
        "FACE_QUEUE_DEADLINE"
      );
    }

    const jobId = this.nextJobId++;
    const promise = new Promise((resolve, reject) => {
      const job = {
        jobId,
        userId,
        photo,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: null,
      };
      job.timer = setTimeout(
        () => this.#deadlineExceeded(job),
        this.timeoutMs
      );
      job.timer.unref?.();
      this.queue.push(job);
      this.#drain();
    });

    return { promise, position, estimatedCompletionMs };
  }

  status() {
    return {
      workers: this.workers.length,
      active: this.workers.filter((item) => item.busy).length,
      queued: this.queue.length,
      maxQueue: this.maxQueue,
      deadlineMs: this.timeoutMs,
      estimatedJobMs: Math.round(this.estimatedJobMs),
      estimatedWaitMs:
        Math.ceil(this.queue.length / Math.max(1, this.workers.length || this.size)) *
        Math.round(this.estimatedJobMs),
      ready:
        this.workers.length === this.size &&
        this.workers.every((item) => item.ready === true),
      errors: this.workers.map((item) => item.error).filter(Boolean),
    };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    const error = this.#error("Worker ditutup", "POOL_CLOSED");
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.jobs.clear();
    const workers = this.workers.splice(0);
    await Promise.all([
      ...workers.map((state) => {
        state.stopping = true;
        const { worker } = state;
        return worker.terminate().catch(() => {});
      }),
      ...this.terminations,
    ]);
  }

  #spawnWorker() {
    if (this.closing) return;
    const state = {
      worker: this.workerFactory(),
      busy: false,
      jobId: null,
      stopping: false,
      ready: false,
      error: null,
    };
    this.workers.push(state);

    state.worker.on("message", (message) => this.#finish(state, message));
    state.worker.on("error", (error) => this.#workerFailed(state, error));
    state.worker.on("exit", (code) => {
      if (!state.stopping && !this.closing && code !== 0) {
        this.#workerFailed(
          state,
          this.#error(`Face worker berhenti (${code})`, "WORKER_EXIT")
        );
      }
    });
  }

  #drain() {
    for (const state of this.workers) {
      if (state.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      state.busy = true;
      state.jobId = job.jobId;
      job.startedAt = Date.now();
      this.jobs.set(job.jobId, job);
      if (Buffer.isBuffer(job.photo) || ArrayBuffer.isView(job.photo)) {
        const transferable = Uint8Array.from(job.photo);
        state.worker.postMessage(
          { jobId: job.jobId, userId: job.userId, photo: transferable },
          [transferable.buffer]
        );
      } else {
        state.worker.postMessage({ jobId: job.jobId, userId: job.userId, photo: job.photo });
      }
    }
  }

  #finish(state, message) {
    if (message.type === "ready") {
      state.ready = message.ready === true;
      state.error = message.error || null;
      return;
    }
    if (message.jobId !== state.jobId) return;
    const job = this.jobs.get(message.jobId);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(message.jobId);
    if (job.startedAt) {
      const durationMs = Math.max(1, Date.now() - job.startedAt);
      this.estimatedJobMs = this.estimatedJobMs * 0.8 + durationMs * 0.2;
    }
    state.busy = false;
    state.jobId = null;

    if (message.error) job.reject(this.#error(message.error.message, message.error.code));
    else job.resolve(message.result);
    this.#drain();
  }

  #workerFailed(state, error) {
    if (!this.workers.includes(state) || state.stopping) return;
    state.stopping = true;
    const job = this.jobs.get(state.jobId);
    if (job) {
      clearTimeout(job.timer);
      this.jobs.delete(state.jobId);
      job.reject(error);
    }
    this.workers = this.workers.filter((item) => item !== state);
    this.#drain();

    // Wait for the old worker to release its model/native allocations before
    // starting a replacement. This avoids briefly keeping two model copies.
    const termination = Promise.resolve(state.worker.terminate())
      .catch(() => {})
      .finally(() => {
        this.terminations.delete(termination);
        if (!this.closing) this.#spawnWorker();
        this.#drain();
      });
    this.terminations.add(termination);
  }

  #deadlineExceeded(job) {
    const queuedIndex = this.queue.findIndex((item) => item.jobId === job.jobId);
    const error = this.#error(
      "Verifikasi wajah melebihi batas waktu total",
      "FACE_DEADLINE_EXCEEDED"
    );
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      job.reject(error);
      return;
    }
    const state = this.workers.find((item) => item.jobId === job.jobId);
    if (state) this.#workerFailed(state, error);
  }

  #error(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}

module.exports = { FaceWorkerPool };
