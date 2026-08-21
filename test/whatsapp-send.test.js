const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createWhatsappSender,
  isRetryableWhatsappError,
  retryDelayMs,
} = require("../lib/whatsapp-send");

test("retry delay memakai exponential backoff dan batas maksimum", () => {
  assert.equal(
    retryDelayMs(0, {
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      jitterRatio: 0,
      random: () => 0,
    }),
    1000
  );
  assert.equal(
    retryDelayMs(2, {
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      jitterRatio: 0,
      random: () => 0,
    }),
    2500
  );
});

test("pengiriman diulang sesuai jumlah retry dan berhenti setelah berhasil", async () => {
  const delays = [];
  let attempts = 0;
  const send = createWhatsappSender({
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    jitterRatio: 0,
    sleep: async (delay) => delays.push(delay),
  });

  const result = await send(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("sementara gagal");
    return "terkirim";
  });

  assert.equal(result, "terkirim");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("error terakhir diteruskan setelah retry habis", async () => {
  const send = createWhatsappSender({
    maxRetries: 1,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    sleep: async () => {},
  });
  await assert.rejects(send(async () => { throw new Error("gagal"); }), {
    message: "gagal",
  });
});

test("error recipient permanen tidak diulang", async () => {
  let attempts = 0;
  const send = createWhatsappSender({
    maxRetries: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    sleep: async () => {},
    shouldRetry: isRetryableWhatsappError,
  });

  await assert.rejects(
    send(async () => {
      attempts += 1;
      throw new Error("No LID for user");
    }),
    /No LID for user/
  );
  assert.equal(attempts, 1);
});

test("pengiriman diberi jeda otomatis dan jeda tambahan untuk penerima yang sama", async () => {
  let currentTime = 0;
  const delays = [];
  const send = createWhatsappSender({
    safetyMode: "automatic",
    minIntervalMs: 100,
    maxIntervalMs: 100,
    recipientIntervalMs: 250,
    maxPerMinute: 0,
    maxRetries: 0,
    now: () => currentTime,
    random: () => 0,
    sleep: async (delay) => {
      delays.push(delay);
      currentTime += delay;
    },
  });

  await send(async () => "pertama", { recipientId: "6281@c.us" });
  await send(async () => "kedua", { recipientId: "6281@c.us" });

  assert.deepEqual(delays, [100, 250]);
});

test("kegagalan berulang memicu cooldown otomatis", async () => {
  let currentTime = 0;
  const delays = [];
  let attempts = 0;
  const send = createWhatsappSender({
    safetyMode: "automatic",
    minIntervalMs: 0,
    maxIntervalMs: 0,
    recipientIntervalMs: 0,
    maxPerMinute: 0,
    maxRetries: 0,
    failureThreshold: 2,
    failureCooldownMs: 500,
    now: () => currentTime,
    sleep: async (delay) => {
      delays.push(delay);
      currentTime += delay;
    },
  });

  await assert.rejects(send(async () => {
    attempts += 1;
    throw new Error("gagal pertama");
  }));
  await assert.rejects(send(async () => {
    attempts += 1;
    throw new Error("gagal kedua");
  }));
  await send(async () => "pulih");

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("batas per menit menahan pengiriman berikutnya", async () => {
  let currentTime = 0;
  const delays = [];
  const send = createWhatsappSender({
    safetyMode: "automatic",
    minIntervalMs: 0,
    maxIntervalMs: 0,
    recipientIntervalMs: 0,
    maxPerMinute: 2,
    maxRetries: 0,
    now: () => currentTime,
    sleep: async (delay) => {
      delays.push(delay);
      currentTime += delay;
    },
  });

  await send(async () => "satu");
  await send(async () => "dua");
  await send(async () => "tiga");

  assert.deepEqual(delays, [60_000]);
});

test("pesan prioritas didahulukan dari notifikasi yang masih mengantre", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];
  const send = createWhatsappSender({
    safetyMode: "off",
    maxRetries: 0,
  });

  const first = send(async () => {
    order.push("pertama");
    await firstGate;
  });
  const normal = send(async () => order.push("normal"));
  const priority = send(async () => order.push("prioritas"), {
    priority: "high",
  });
  releaseFirst();
  await Promise.all([first, normal, priority]);

  assert.deepEqual(order, ["pertama", "prioritas", "normal"]);
});
