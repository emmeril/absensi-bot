const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveWhatsappRecipientId,
  resolveWhatsappUserId,
} = require("../lib/whatsapp-id");

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

test("reuses the inbound LID when sending to the same phone number", async () => {
  const cache = new Map();
  const client = {
    getContactLidAndPhone: async () => [
      { lid: "123456789@lid", pn: "628123456789@c.us" },
    ],
    getNumberId: async () => {
      throw new Error("lookup outbound seharusnya tidak dipanggil");
    },
  };

  await resolveWhatsappUserId(client, "123456789@lid", cache);
  assert.equal(
    await resolveWhatsappRecipientId(client, "628123456789@c.us", cache),
    "123456789@lid"
  );
});

test("resolves an outbound phone number to its current LID", async () => {
  const client = {
    getNumberId: async () => ({ _serialized: "628123456789@c.us" }),
    getContactLidAndPhone: async () => [
      { lid: "123456789@lid", pn: "628123456789@c.us" },
    ],
  };

  assert.equal(
    await resolveWhatsappRecipientId(client, "628123456789@c.us"),
    "123456789@lid"
  );
});

test("rejects outbound numbers that are not registered", async () => {
  const client = {
    getNumberId: async () => null,
    getContactLidAndPhone: async () => [],
  };

  await assert.rejects(
    resolveWhatsappRecipientId(client, "628123456789@c.us"),
    { code: "WA_RECIPIENT_NOT_REGISTERED" }
  );
});

test("limits the complete outbound recipient lookup", async () => {
  const client = {
    getNumberId: async () => ({ _serialized: "628123456789@c.us" }),
    getContactLidAndPhone: () => new Promise(() => {}),
  };
  const startedAt = Date.now();

  assert.equal(
    await resolveWhatsappRecipientId(
      client,
      "628123456789@c.us",
      new Map(),
      { timeoutMs: 10 }
    ),
    "628123456789@c.us"
  );
  assert.ok(Date.now() - startedAt < 500);
});
