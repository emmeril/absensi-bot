const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { FaceWorkerPool } = require("../services/face-worker-pool");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeWorker extends EventEmitter {
  constructor(termination = { promise: Promise.resolve(0) }) {
    super();
    this.termination = termination;
    this.messages = [];
    this.terminateCalls = 0;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

test("FaceWorkerPool menunggu worker lama berhenti sebelum membuat pengganti", async () => {
  const firstTermination = deferred();
  const workers = [];
  const pool = new FaceWorkerPool({
    size: 1,
    workerFactory: () => {
      const worker = new FakeWorker(
        workers.length === 0 ? firstTermination : undefined
      );
      workers.push(worker);
      return worker;
    },
  });

  const job = pool.verify("6281", "photo").promise;
  workers[0].emit("error", new Error("worker gagal"));

  await assert.rejects(job, /worker gagal/);
  assert.equal(workers[0].terminateCalls, 1);
  assert.equal(workers.length, 1);

  firstTermination.resolve(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 2);

  await pool.close();
});

test("FaceWorkerPool tidak membuat pengganti ketika sedang ditutup", async () => {
  const termination = deferred();
  const workers = [];
  const pool = new FaceWorkerPool({
    size: 1,
    workerFactory: () => {
      const worker = new FakeWorker(termination);
      workers.push(worker);
      return worker;
    },
  });

  const job = pool.verify("6281", "photo").promise;
  workers[0].emit("error", new Error("worker gagal"));
  await assert.rejects(job, /worker gagal/);

  const closing = pool.close();
  termination.resolve(1);
  await closing;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(workers.length, 1);
});
