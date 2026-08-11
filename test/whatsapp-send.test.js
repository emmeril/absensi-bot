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
