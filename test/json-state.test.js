const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonState } = require("../lib/json-state");

test("JsonState mencegah pembaruan bersamaan saling menimpa", async () => {
  const writes = [];
  const state = new JsonState({
    initial: { data: { count: 0, users: {} } },
    write: async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push([key, structuredClone(value)]);
    },
  });

  await Promise.all([
    state.update("data", async ({ data }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      data.count += 1;
      data.users.a = true;
    }),
    state.update("data", ({ data }) => {
      data.count += 1;
      data.users.b = true;
    }),
  ]);

  assert.deepEqual(state.read("data"), {
    count: 2,
    users: { a: true, b: true },
  });
  assert.equal(writes.length, 2);
});

test("JsonState tetap dapat dipakai setelah mutasi gagal", async () => {
  const state = new JsonState({ initial: { data: { value: 1 } }, write: async () => {} });

  await assert.rejects(
    state.update("data", () => {
      throw new Error("gagal");
    })
  );
  await state.update("data", ({ data }) => {
    data.value = 2;
  });

  assert.equal(state.read("data").value, 2);
});
