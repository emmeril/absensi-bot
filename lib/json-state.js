class JsonState {
  constructor({ write, initial = {} }) {
    this.write = write;
    this.cache = structuredClone(initial);
    this.tail = Promise.resolve();
  }

  replace(initial) {
    this.cache = structuredClone(initial);
  }

  read(key, fallback = {}) {
    return structuredClone(this.cache[key] ?? fallback);
  }

  update(keys, mutate) {
    const uniqueKeys = [...new Set(Array.isArray(keys) ? keys : [keys])];
    const operation = this.tail.then(async () => {
      const draft = Object.fromEntries(
        uniqueKeys.map((key) => [key, this.read(key)])
      );
      const result = await mutate(draft);

      // Publish the new cache only after every durable write succeeds.
      for (const key of uniqueKeys) await this.write(key, draft[key]);
      for (const key of uniqueKeys) this.cache[key] = structuredClone(draft[key]);
      return result;
    });

    this.tail = operation.catch(() => {});
    return operation;
  }
}

module.exports = { JsonState };
