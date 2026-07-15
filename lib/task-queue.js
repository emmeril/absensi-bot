class TaskQueue {
  constructor({ concurrency = 1, maxQueue = 100 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.maxQueue = Math.max(1, maxQueue);
    this.active = 0;
    this.queue = [];
  }

  add(task) {
    if (this.queue.length >= this.maxQueue) {
      const error = new Error("Antrean penuh");
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  get size() {
    return this.queue.length;
  }

  get pending() {
    return this.active;
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.#drain();
        });
    }
  }
}

module.exports = { TaskQueue };
