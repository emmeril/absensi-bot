const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachStatusAckFallback } = require("../lib/baileys-status-ack");

test("acks online and offline status stanzas using Baileys protocol attributes", async () => {
  const { buildAckStanza } = await import("@whiskeysockets/baileys/lib/Utils/stanza-ack.js");
  const ws = new EventEmitter();
  const sent = [];
  let acknowledged = 0;
  const dispose = attachStatusAckFallback({ ws, sendNode: async (node) => sent.push(node) }, {
    isCurrent: () => true, onAck: () => acknowledged++,
  });
  const nodes = [
    { tag: "status", attrs: { id: "online", from: "status@broadcast", type: "media" } },
    { tag: "status", attrs: { id: "offline", from: "group@g.us", participant: "123@lid", recipient: "456@lid", type: "text", offline: "1" } },
  ];
  for (const node of nodes) ws.emit("CB:status", node);
  await new Promise(setImmediate);
  assert.deepEqual(sent, nodes.map((node) => buildAckStanza(node)));
  assert.equal(acknowledged, 2);
  dispose();
  assert.equal(ws.listenerCount("CB:status"), 0);
});

test("does not duplicate the handler supplied by a newer Baileys version", () => {
  const ws = new EventEmitter();
  const native = () => {};
  ws.on("CB:status", native);
  const dispose = attachStatusAckFallback({ ws, sendNode: async () => assert.fail("duplicate ACK") }, { isCurrent: () => true });
  assert.equal(ws.listenerCount("CB:status"), 1);
  dispose();
  assert.equal(ws.listeners("CB:status")[0], native);
});

test("does not send a queued ACK after a socket was replaced", async () => {
  const ws = new EventEmitter();
  let current = true;
  const dispose = attachStatusAckFallback({ ws, sendNode: async () => assert.fail("stale socket") }, { isCurrent: () => current });
  ws.emit("CB:status", { tag: "status", attrs: { id: "stale", from: "123@lid" } });
  current = false;
  await new Promise(setImmediate);
  dispose();
});

test("reports an ACK failure without rejecting the event listener", async () => {
  for (const sendNode of [() => { throw new Error("sync failure"); }, async () => { throw new Error("async failure"); }]) {
    const ws = new EventEmitter();
    const errors = [];
    let acknowledged = 0;
    const dispose = attachStatusAckFallback({ ws, sendNode }, {
      isCurrent: () => true, onAck: () => acknowledged++, onError: (error) => errors.push(error.message),
    });
    ws.emit("CB:status", { tag: "status", attrs: { id: "failure", from: "123@lid" } });
    await new Promise(setImmediate);
    assert.equal(errors.length, 1);
    assert.equal(acknowledged, 0);
    dispose();
  }
});
