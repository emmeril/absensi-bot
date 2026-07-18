const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWhatsappUserId } = require("../lib/whatsapp-id");

test("keeps phone IDs unchanged", async () => {
  let called = false;
  const client = {
    getContactLidAndPhone: async () => {
      called = true;
      return [];
    },
  };

  assert.equal(
    await resolveWhatsappUserId(client, "628123456789@c.us"),
    "628123456789@c.us"
  );
  assert.equal(called, false);
});

test("resolves LID IDs to phone IDs and caches the result", async () => {
  let calls = 0;
  const client = {
    getContactLidAndPhone: async () => {
      calls += 1;
      return [{ lid: "123456789@lid", pn: "628123456789@c.us" }];
    },
  };
  const cache = new Map();

  assert.equal(
    await resolveWhatsappUserId(client, "123456789@lid", cache),
    "628123456789@c.us"
  );
  assert.equal(
    await resolveWhatsappUserId(client, "123456789@lid", cache),
    "628123456789@c.us"
  );
  assert.equal(calls, 1);
});

test("falls back to the original LID when no phone mapping exists", async () => {
  const client = { getContactLidAndPhone: async () => [{}] };

  assert.equal(
    await resolveWhatsappUserId(client, "123456789@lid"),
    "123456789@lid"
  );
});

test("shares one lookup for concurrent messages from the same LID", async () => {
  let calls = 0;
  let finishLookup;
  const client = {
    getContactLidAndPhone: () => {
      calls += 1;
      return new Promise((resolve) => {
        finishLookup = resolve;
      });
    },
  };
  const options = { pending: new Map() };
  const first = resolveWhatsappUserId(client, "123456789@lid", new Map(), options);
  const second = resolveWhatsappUserId(client, "123456789@lid", new Map(), options);

  finishLookup([{ lid: "123456789@lid", pn: "628123456789@c.us" }]);

  assert.equal(await first, "628123456789@c.us");
  assert.equal(await second, "628123456789@c.us");
  assert.equal(calls, 1);
});

test("limits a slow LID lookup and temporarily caches the failure", async () => {
  let calls = 0;
  const client = {
    getContactLidAndPhone: () => {
      calls += 1;
      return new Promise(() => {});
    },
  };
  const failures = new Map();
  const options = { failures, timeoutMs: 10, failureTtlMs: 1000 };
  const startedAt = Date.now();

  assert.equal(
    await resolveWhatsappUserId(client, "123456789@lid", new Map(), options),
    "123456789@lid"
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(
    await resolveWhatsappUserId(client, "123456789@lid", new Map(), options),
    "123456789@lid"
  );
  assert.equal(calls, 1);
});
