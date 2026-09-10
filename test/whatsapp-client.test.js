const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  attachBrowserDisconnectMonitor,
  retryInjection,
} = require("../lib/whatsapp-client");

const contextError = new Error("Protocol error: Execution context was destroyed.");

test("authentication resumes after a page reload without restarting the browser", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryInjection(async () => {
    if (++attempts < 3) throw contextError;
    return "ready";
  }, { delay: async (ms) => delays.push(ms), warn() {} });
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1500, 3000]);
});

test("persistent context loss stops after the retry limit", async () => {
  let attempts = 0;
  await assert.rejects(retryInjection(async () => {
    attempts++;
    throw contextError;
  }, { delay: async () => {}, warn() {} }), contextError);
  assert.equal(attempts, 5);
});

test("other errors and a closed browser are not retried", async () => {
  for (const error of [new Error("auth timeout"), contextError]) {
    let attempts = 0;
    await assert.rejects(retryInjection(async () => {
      attempts++;
      throw error;
    }, { canRetry: () => false, delay: async () => assert.fail("unexpected retry") }), error);
    assert.equal(attempts, 1);
  }
});

test("reports an unexpected browser exit only once", () => {
  const browser = new EventEmitter();
  let disconnects = 0;

  attachBrowserDisconnectMonitor(browser, () => disconnects++);
  browser.emit("disconnected");
  browser.emit("disconnected");

  assert.equal(disconnects, 1);
});

test("browser disconnect monitor can be removed during an intentional shutdown", () => {
  const browser = new EventEmitter();
  let disconnects = 0;

  const removeMonitor = attachBrowserDisconnectMonitor(
    browser,
    () => disconnects++
  );
  removeMonitor();
  browser.emit("disconnected");

  assert.equal(disconnects, 0);
});
