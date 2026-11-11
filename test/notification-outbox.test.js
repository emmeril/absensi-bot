const test = require("node:test");
const assert = require("node:assert/strict");
const { NotificationOutboxProcessor } = require("../services/notification-outbox");

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("outbox memproses paralel dan menyimpan kegagalan untuk retry", async () => {
  const pending = [
    { id: "1", attempts: 1 },
    { id: "2", attempts: 1 },
    { id: "3", attempts: 1 },
  ];
  const sent = [];
  const rescheduled = [];
  let active = 0;
  let maxActive = 0;
  const processor = new NotificationOutboxProcessor({
    concurrency: 2,
    pollIntervalMs: 250,
    retryBaseDelayMs: 1000,
    store: {
      recover: async () => {},
      purgeSent: async () => {},
      claim: async () => pending.shift() || null,
      markSent: async (id) => sent.push(id),
      reschedule: async (id, options) => rescheduled.push({ id, ...options }),
    },
    deliver: async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (job.id === "2") throw new Error("offline");
    },
    isRetryable: () => true,
  });

  await processor.start();
  await waitFor(() => sent.length + rescheduled.length === 3);
  await processor.stop();

  assert.equal(maxActive, 2);
  assert.deepEqual(sent.sort(), ["1", "3"]);
  assert.equal(rescheduled[0].id, "2");
  assert.equal(rescheduled[0].failed, false);
  assert.ok(rescheduled[0].availableAt > new Date());
});

test("uncertain delivery is held for manual review and never retried automatically", async () => {
  const pending = [{ id: "uncertain-1", attempts: 1 }];
  const sent = [], retried = [], uncertain = [];
  const processor = new NotificationOutboxProcessor({
    concurrency: 1,
    pollIntervalMs: 250,
    store: {
      recover: async () => {},
      purgeSent: async () => {},
      claim: async () => pending.shift() || null,
      markSent: async (id) => sent.push(id),
      markUncertain: async (id) => uncertain.push(id),
      reschedule: async (id) => retried.push(id),
    },
    deliver: async () => {
      const error = new Error("Network connection terminated after sending started");
      error.code = "WA_DELIVERY_UNCERTAIN";
      throw error;
    },
  });
  await processor.start();
  await waitFor(() => uncertain.length === 1);
  await processor.stop();
  assert.deepEqual(uncertain, ["uncertain-1"]);
  assert.deepEqual(retried, []);
  assert.deepEqual(sent, []);
});

test("successful delivery passes Baileys message id to receipt storage", async () => {
  const pending = [{ id: "ok-1", attempts: 1 }];
  const saved = [];
  const processor = new NotificationOutboxProcessor({
    concurrency: 1,
    pollIntervalMs: 250,
    store: {
      recover: async () => {},
      purgeSent: async () => {},
      claim: async () => pending.shift() || null,
      markSent: async (id, messageId) => saved.push([id, messageId]),
      reschedule: async () => {},
    },
    deliver: async () => ({ key: { id: "WA-123" } }),
  });
  await processor.start();
  await waitFor(() => saved.length === 1);
  await processor.stop();
  assert.deepEqual(saved, [["ok-1", "WA-123"]]);
});
