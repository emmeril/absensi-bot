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

test("FaceWorkerPool menolak antrean yang diperkirakan melewati deadline", async () => {
  const workers = [];
  const pool = new FaceWorkerPool({
    size: 1,
    timeoutMs: 150,
    estimatedJobMs: 100,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  const active = pool.verify("6281", Buffer.from("photo")).promise;
  assert.throws(
    () => pool.verify("6282", Buffer.from("photo")),
    (error) => error.code === "FACE_QUEUE_DEADLINE"
  );
  workers[0].emit("message", { jobId: 1, result: { match: true } });
  await active;
  await pool.close();
});

test("FaceWorkerPool menghitung deadline sejak pekerjaan masuk", async () => {
  const workers = [];
  const pool = new FaceWorkerPool({
    size: 1,
    timeoutMs: 50,
    estimatedJobMs: 20,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  const keepAlive = setTimeout(() => {}, 100);
  const job = pool.verify("6281", Buffer.from("photo")).promise;
  await assert.rejects(job, (error) => error.code === "FACE_DEADLINE_EXCEEDED");
  clearTimeout(keepAlive);
  assert.equal(workers[0].terminateCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await pool.close();
});
