function readInteger(name, fallback, minimum = 0) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} harus berupa bilangan bulat minimal ${minimum}.`);
  }
  return parsed;
}

function readRatio(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} harus berupa angka antara 0 dan 1.`);
  }
  return parsed;
}

function readSafetyMode() {
  const mode = String(process.env.WA_SEND_SAFETY_MODE || "automatic").toLowerCase();
  if (!["automatic", "conservative", "off"].includes(mode)) {
    throw new Error(
      "WA_SEND_SAFETY_MODE harus automatic, conservative, atau off."
    );
  }
  return mode;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, options) {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** attempt
  );
  const jitter = exponential * options.jitterRatio * options.random();
  return Math.round(exponential + jitter);
}

function isRetryableWhatsappError(error) {
  const message = String(error?.message || error || "");
  return ![
    /No LID for user/i,
    /nomor tidak terdaftar di WhatsApp/i,
    /invalid (?:wid|chat|contact)/i,
  ].some((pattern) => pattern.test(message));
}

function safetyDefaults(mode) {
  if (mode === "off") {
    return {
      minIntervalMs: 0,
      maxIntervalMs: 0,
      recipientIntervalMs: 0,
      maxPerMinute: 0,
      failureThreshold: 0,
      failureCooldownMs: 0,
    };
  }

  if (mode === "conservative") {
    return {
      minIntervalMs: 1800,
      maxIntervalMs: 3200,
      recipientIntervalMs: 8000,
      maxPerMinute: 18,
      failureThreshold: 4,
      failureCooldownMs: 5 * 60 * 1000,
    };
  }

  return {
    minIntervalMs: 1000,
    maxIntervalMs: 2200,
    recipientIntervalMs: 3500,
    maxPerMinute: 30,
    failureThreshold: 5,
    failureCooldownMs: 2 * 60 * 1000,
  };
}

function randomBetween(minimum, maximum, random) {
  if (maximum <= minimum) return minimum;
  return Math.round(minimum + (maximum - minimum) * random());
}

function createWhatsappSender(options = {}) {
  const safetyMode = options.safetyMode || readSafetyMode();
  const defaults = safetyDefaults(safetyMode);
  const maxRetries = options.maxRetries ?? readInteger("WA_SEND_MAX_RETRIES", 3);
  const baseDelayMs =
    options.baseDelayMs ?? readInteger("WA_SEND_RETRY_BASE_DELAY_MS", 5000);
  const maxDelayMs =
    options.maxDelayMs ?? readInteger("WA_SEND_RETRY_MAX_DELAY_MS", 60000);
  const jitterRatio =
    options.jitterRatio ?? readRatio("WA_SEND_RETRY_JITTER_RATIO", 0.35);
  const minIntervalMs =
    options.minIntervalMs ??
    readInteger("WA_SEND_MIN_INTERVAL_MS", defaults.minIntervalMs);
  const maxIntervalMs =
    options.maxIntervalMs ??
    readInteger("WA_SEND_MAX_INTERVAL_MS", defaults.maxIntervalMs);
  const recipientIntervalMs =
    options.recipientIntervalMs ??
    readInteger("WA_SEND_RECIPIENT_INTERVAL_MS", defaults.recipientIntervalMs);
  const maxPerMinute =
    options.maxPerMinute ??
    readInteger("WA_SEND_MAX_PER_MINUTE", defaults.maxPerMinute);
  const maxQueue =
    options.maxQueue ?? readInteger("WA_SEND_QUEUE_LIMIT", 500, 1);
  const failureThreshold =
    options.failureThreshold ??
    readInteger("WA_SEND_FAILURE_THRESHOLD", defaults.failureThreshold);
  const failureCooldownMs =
    options.failureCooldownMs ??
    readInteger("WA_SEND_FAILURE_COOLDOWN_MS", defaults.failureCooldownMs);
  const sleep = options.sleep || wait;
  const random = options.random || Math.random;
  const now = options.now || Date.now;
  const onRetry = options.onRetry;
  const onThrottle = options.onThrottle;
  const shouldRetry = options.shouldRetry || (() => true);

  if (maxDelayMs < baseDelayMs) {
    throw new Error("WA_SEND_RETRY_MAX_DELAY_MS harus >= WA_SEND_RETRY_BASE_DELAY_MS.");
  }
  if (maxIntervalMs < minIntervalMs) {
    throw new Error("WA_SEND_MAX_INTERVAL_MS harus >= WA_SEND_MIN_INTERVAL_MS.");
  }

  const highPriorityQueue = [];
  const normalQueue = [];
  const recipientLastSentAt = new Map();
  const sentAt = [];
  let active = false;
  let lastSentAt = 0;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  function queuedCount() {
    return highPriorityQueue.length + normalQueue.length;
  }

  function pruneHistory(currentTime) {
    while (sentAt.length && sentAt[0] <= currentTime - 60_000) sentAt.shift();
  }

  async function throttle(recipientId) {
    const currentTime = now();
    pruneHistory(currentTime);

    // A growing backlog automatically slows the sender instead of creating a burst.
    const pressureMultiplier =
      safetyMode === "automatic"
        ? queuedCount() > 50
          ? 2
          : queuedCount() > 10
            ? 1.5
            : 1
        : 1;
    const intervalMs = Math.round(
      randomBetween(minIntervalMs, maxIntervalMs, random) * pressureMultiplier
    );
    let readyAt = Math.max(cooldownUntil, lastSentAt + intervalMs);

    if (recipientId && recipientLastSentAt.has(recipientId)) {
      readyAt = Math.max(
        readyAt,
        recipientLastSentAt.get(recipientId) + recipientIntervalMs
      );
    }
    if (maxPerMinute > 0 && sentAt.length >= maxPerMinute) {
      readyAt = Math.max(readyAt, sentAt[0] + 60_000);
    }

    const delayMs = Math.max(0, readyAt - currentTime);
    if (delayMs > 0) {
      onThrottle?.({ delayMs, recipientId, queueSize: queuedCount() });
      await sleep(delayMs);
    }

    const startedAt = now();
    lastSentAt = startedAt;
    sentAt.push(startedAt);
    if (recipientId) recipientLastSentAt.set(recipientId, startedAt);
  }

  async function execute(job) {
    await throttle(job.recipientId);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await job.send();
        consecutiveFailures = 0;
        cooldownUntil = 0;
        return result;
      } catch (error) {
        const retryable = shouldRetry(error, { attempt });
        if (retryable) {
          consecutiveFailures += 1;
          if (failureThreshold > 0 && consecutiveFailures >= failureThreshold) {
            cooldownUntil = Math.max(cooldownUntil, now() + failureCooldownMs);
          }
        }

        if (attempt >= maxRetries || !retryable) throw error;

        const delayMs = retryDelayMs(attempt, {
          baseDelayMs,
          maxDelayMs,
          jitterRatio,
          random,
        });
        onRetry?.({ attempt: attempt + 1, delayMs, error });
        await sleep(delayMs);
      }
    }
  }

  async function drain() {
    if (active) return;
    active = true;
    try {
      while (queuedCount() > 0) {
        const job = highPriorityQueue.shift() || normalQueue.shift();
        try {
          job.resolve(await execute(job));
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      active = false;
      if (queuedCount() > 0) void drain();
    }
  }

  return function sendWithRetry(send, metadata = {}) {
    if (typeof send !== "function") {
      return Promise.reject(new TypeError("send harus berupa function."));
    }
    if (queuedCount() >= maxQueue) {
      const error = new Error("Antrean pengiriman WhatsApp penuh.");
      error.code = "WA_SEND_QUEUE_FULL";
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const queue = metadata.priority === "high" ? highPriorityQueue : normalQueue;
      queue.push({
        send,
        resolve,
        reject,
        recipientId: metadata.recipientId,
      });
      void drain();
    });
  };
}

module.exports = {
  createWhatsappSender,
  isRetryableWhatsappError,
  retryDelayMs,
  safetyDefaults,
};
