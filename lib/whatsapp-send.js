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

function createWhatsappSender({
  maxRetries = readInteger("WA_SEND_MAX_RETRIES", 3),
  baseDelayMs = readInteger("WA_SEND_RETRY_BASE_DELAY_MS", 5000),
  maxDelayMs = readInteger("WA_SEND_RETRY_MAX_DELAY_MS", 60000),
  jitterRatio = readRatio("WA_SEND_RETRY_JITTER_RATIO", 0.35),
  sleep = wait,
  random = Math.random,
  onRetry,
  shouldRetry = () => true,
} = {}) {
  if (maxDelayMs < baseDelayMs) {
    throw new Error("WA_SEND_RETRY_MAX_DELAY_MS harus >= WA_SEND_RETRY_BASE_DELAY_MS.");
  }

  return async function sendWithRetry(send) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (attempt >= maxRetries || !shouldRetry(error, { attempt })) {
          throw error;
        }

        const delayMs = retryDelayMs(attempt, {
          baseDelayMs,
          maxDelayMs,
          jitterRatio,
          random,
        });
        if (onRetry) onRetry({ attempt: attempt + 1, delayMs, error });
        await sleep(delayMs);
      }
    }
  };
}

module.exports = {
  createWhatsappSender,
  isRetryableWhatsappError,
  retryDelayMs,
};
