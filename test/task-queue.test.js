const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskQueue } = require("../lib/task-queue");

test("TaskQueue membatasi jumlah pekerjaan bersamaan", async () => {
  const queue = new TaskQueue({ concurrency: 2, maxQueue: 10 });
  let active = 0;
  let maxActive = 0;

  const tasks = Array.from({ length: 6 }, (_, index) =>
    queue.add(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return index;
    })
  );

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});

test("TaskQueue menolak pekerjaan ketika antrean penuh", async () => {
  const queue = new TaskQueue({ concurrency: 1, maxQueue: 1 });
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });

  const first = queue.add(() => blocker);
  const second = queue.add(() => Promise.resolve());
  await assert.rejects(queue.add(() => Promise.resolve()), { code: "QUEUE_FULL" });
  release();
  await Promise.all([first, second]);
});
