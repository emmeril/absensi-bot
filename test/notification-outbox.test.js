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
