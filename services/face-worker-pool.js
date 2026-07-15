const path = require("path");
const { Worker } = require("worker_threads");

class FaceWorkerPool {
  constructor({ size = 2, maxQueue = 100, timeoutMs = 60000 } = {}) {
    this.size = Math.max(1, size);
    this.maxQueue = Math.max(1, maxQueue);
    this.timeoutMs = Math.max(1000, timeoutMs);
    this.workerFile = path.join(__dirname, "..", "workers", "face-worker.js");
    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextJobId = 1;
    this.closing = false;

    for (let index = 0; index < this.size; index += 1) this.#spawnWorker();
  }

  verify(userId, photo) {
    if (this.closing) throw this.#error("Worker ditutup", "POOL_CLOSED");
    if (this.queue.length >= this.maxQueue) {
      throw this.#error("Antrean verifikasi wajah penuh", "QUEUE_FULL");
    }

    const jobId = this.nextJobId++;
    const position = this.queue.length + this.workers.filter((item) => item.busy).length + 1;
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ jobId, userId, photo, resolve, reject });
      this.#drain();
    });

    return { promise, position };
  }

  status() {
    return {
      workers: this.workers.length,
      active: this.workers.filter((item) => item.busy).length,
      queued: this.queue.length,
      maxQueue: this.maxQueue,
    };
  }

  async close() {
    this.closing = true;
    const error = this.#error("Worker ditutup", "POOL_CLOSED");
    for (const job of this.queue.splice(0)) job.reject(error);
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
    this.workers = [];
  }

  #spawnWorker() {
    if (this.closing) return;
    const state = { worker: new Worker(this.workerFile), busy: false, jobId: null };
    this.workers.push(state);

    state.worker.on("message", (message) => this.#finish(state, message));
    state.worker.on("error", (error) => this.#workerFailed(state, error));
    state.worker.on("exit", (code) => {
      if (!this.closing && code !== 0) this.#workerFailed(state, this.#error(`Face worker berhenti (${code})`, "WORKER_EXIT"));
    });
  }

  #drain() {
    for (const state of this.workers) {
      if (state.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      state.busy = true;
      state.jobId = job.jobId;
      job.timer = setTimeout(() => {
        this.#workerFailed(state, this.#error("Verifikasi wajah melebihi batas waktu", "FACE_TIMEOUT"));
        state.worker.terminate().catch(() => {});
      }, this.timeoutMs);
      this.jobs.set(job.jobId, job);
      state.worker.postMessage({ jobId: job.jobId, userId: job.userId, photo: job.photo });
    }
  }

  #finish(state, message) {
    if (message.jobId !== state.jobId) return;
    const job = this.jobs.get(message.jobId);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(message.jobId);
    state.busy = false;
    state.jobId = null;

    if (message.error) job.reject(this.#error(message.error.message, message.error.code));
    else job.resolve(message.result);
    this.#drain();
  }

  #workerFailed(state, error) {
    if (!this.workers.includes(state)) return;
    const job = this.jobs.get(state.jobId);
    if (job) {
      clearTimeout(job.timer);
      this.jobs.delete(state.jobId);
      job.reject(error);
    }
    this.workers = this.workers.filter((item) => item !== state);
    if (!this.closing) this.#spawnWorker();
    this.#drain();
  }

  #error(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
}

module.exports = { FaceWorkerPool };
