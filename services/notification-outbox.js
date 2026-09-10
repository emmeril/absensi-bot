const fs = require("node:fs");

class NotificationOutboxProcessor {
  constructor({
    store,
    deliver,
    isRetryable = () => true,
    concurrency = 4,
    pollIntervalMs = 2000,
    retryBaseDelayMs = 15000,
    retryMaxDelayMs = 15 * 60 * 1000,
    maxAttempts = 12,
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    onError,
  }) {
    this.store = store;
    this.deliver = deliver;
    this.isRetryable = isRetryable;
    this.concurrency = Math.max(1, concurrency);
    this.pollIntervalMs = Math.max(250, pollIntervalMs);
    this.retryBaseDelayMs = Math.max(1000, retryBaseDelayMs);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, retryMaxDelayMs);
    this.maxAttempts = Math.max(1, maxAttempts);
    this.retentionMs = Math.max(0, retentionMs);
    this.onError = onError;
    this.running = false;
    this.draining = false;
    this.timer = null;
    this.drainPromise = null;
    this.purgeIntervalMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(60 * 1000, this.retentionMs || 24 * 60 * 60 * 1000)
    );
    this.nextPurgeAt = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.store.recover();
    await this.#purgeSentIfDue(true);
    this.wake();
  }

  wake() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.draining) this.#schedule(0);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  #schedule(delayMs) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drainPromise = this.#drain()
        .catch((error) => this.onError?.({ job: null, error, failed: false, delayMs: 0 }))
        .finally(() => {
          this.drainPromise = null;
        });
    }, delayMs);
    this.timer.unref?.();
  }

  async #drain() {
    if (!this.running || this.draining) return;
    this.draining = true;
    const active = new Set();
    try {
      await this.#purgeSentIfDue();
      while (this.running || active.size > 0) {
        let foundDueJob = false;
        while (this.running && active.size < this.concurrency) {
          const job = await this.store.claim();
          if (!job) break;
          foundDueJob = true;
          const operation = this.#process(job)
            .catch((error) => this.onError?.({ job, error, failed: false, delayMs: 0 }))
            .finally(() => active.delete(operation));
          active.add(operation);
        }
        if (!active.size) break;
        await Promise.race(active);
        if (!foundDueJob && !this.running) await Promise.allSettled(active);
      }
    } finally {
      this.draining = false;
      this.#schedule(this.pollIntervalMs);
    }
  }

  async #purgeSentIfDue(force = false) {
    if (this.retentionMs <= 0 || (!force && Date.now() < this.nextPurgeAt)) return;
    this.nextPurgeAt = Date.now() + this.purgeIntervalMs;
    try {
      await this.store.purgeSent(new Date(Date.now() - this.retentionMs));
    } catch (error) {
      this.onError?.({ job: null, error, failed: false, delayMs: 0 });
    }
  }

  async #process(job) {
    try {
      await this.deliver(job);
      await this.store.markSent(job.id);
    } catch (error) {
      const retryable = this.isRetryable(error, job);
      const failed = !retryable || job.attempts >= this.maxAttempts;
      const exponent = Math.max(0, job.attempts - 1);
      const delayMs = Math.min(
        this.retryMaxDelayMs,
        this.retryBaseDelayMs * 2 ** exponent
      );
      await this.store.reschedule(job.id, {
        error,
        failed,
        availableAt: new Date(Date.now() + (failed ? 0 : delayMs)),
      });
      this.onError?.({ job, error, failed, delayMs });
    }
  }
}

async function mediaForOutboxJob(job) {
  if (job.kind !== "image") return null;
  if (!job.mediaPath) {
    const error = new Error("File media notifikasi tidak tersedia.");
    error.code = "OUTBOX_MEDIA_MISSING";
    throw error;
  }
  try {
    return {
      buffer: await fs.promises.readFile(job.mediaPath),
      mimetype: job.mimetype || "image/jpeg",
      filename: job.filename || "image.jpg",
    };
  } catch (error) {
    error.code ||= "OUTBOX_MEDIA_MISSING";
    throw error;
  }
}

module.exports = { NotificationOutboxProcessor, mediaForOutboxJob };
