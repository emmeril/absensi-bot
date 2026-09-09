const test = require("node:test");
const assert = require("node:assert/strict");

// This test process never opens the application's database.
process.env.DB_PATH = ":memory:";
const { JsonStore, sequelize, initJsonStore, saveJsonBatch, closeDatabase } = require("../models/database");
const { JsonState } = require("../lib/json-state");

test("failed batch rolls back SQLite and cache, then accepts another update", async (t) => {
  t.after(closeDatabase);
  await sequelize.sync();
  const initial = { contacts: { name: "Before" }, classes: { name: "Before" } };
  await saveJsonBatch(initial);
  const state = new JsonState({ initial, writeBatch: saveJsonBatch });
  JsonStore.addHook("beforeUpsert", "fail-second-write", (values) => {
    if (values.key === "classes") throw Error("simulated failure");
  });
  await assert.rejects(state.update(["contacts", "classes"], (draft) => {
    draft.contacts.name = "After";
    draft.classes.name = "After";
  }), /simulated failure/);
  assert.equal((await JsonStore.findByPk("contacts")).value.name, "Before");
  assert.equal((await JsonStore.findByPk("classes")).value.name, "Before");
  assert.equal(state.read("contacts").name, "Before");
  JsonStore.removeHook("beforeUpsert", "fail-second-write");
  await state.update(["contacts", "classes"], (draft) => {
    draft.contacts.name = "After";
    draft.classes.name = "After";
  });
  assert.equal((await JsonStore.findByPk("contacts")).value.name, "After");
  assert.equal(state.read("classes").name, "After");

  // Initialization must never restore administrators removed from durable state.
  await saveJsonBatch({ roles: {} });
  const loaded = await initJsonStore({ roles: { path: "missing-roles.json", fallback: { "old@c.us": "admin" } } });
  assert.deepEqual(loaded.roles, {});
});
