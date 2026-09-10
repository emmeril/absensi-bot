const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonState } = require("../lib/json-state");

test("JsonState mencegah pembaruan bersamaan saling menimpa", async () => {
  const writes = [];
  const state = new JsonState({
    initial: { data: { count: 0, users: {} } },
    writeBatch: async (values) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push(structuredClone(values));
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
  const state = new JsonState({ initial: { data: { value: 1 } }, writeBatch: async () => {} });

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

test("JsonState dapat menyalin bagian data tanpa menyalin seluruh dokumen", () => {
  const state = new JsonState({ initial: { data: { a: { value: 1 }, b: { value: 2 } } }, writeBatch: async () => {} });
  const selected = state.readSelected("data", (data) => data.a);
  selected.value = 99;
  assert.equal(state.read("data").a.value, 1);
});
