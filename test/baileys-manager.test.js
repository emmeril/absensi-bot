const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adaptIncomingMessage,
  RecentMessageStore,
  resolveWaVersion,
  sessionDefinitions,
  toAppUserId,
  toBaileysJid,
} = require("../lib/baileys-manager");

test("uses the current WhatsApp Web version for new connections", async () => {
  const library = {
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 1] },
    fetchLatestWaWebVersion: async () => ({
      version: [2, 3000, 99],
      isLatest: true,
    }),
  };

  assert.deepEqual(await resolveWaVersion(library), {
    version: [2, 3000, 99],
    source: "web.whatsapp.com",
  });
});

test("falls back to the bundled WhatsApp version when lookup fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const library = {
    DEFAULT_CONNECTION_CONFIG: { version: [2, 3000, 1] },
    fetchLatestWaWebVersion: async () => {
      throw new Error("offline");
    },
  };

  assert.deepEqual(await resolveWaVersion(library), {
    version: [2, 3000, 1],
    source: "bawaan Baileys",
  });
});

test("keeps recent messages available for WhatsApp decryption retries", () => {
  let now = 1_000;
  const store = new RecentMessageStore({ maxEntries: 2, ttlMs: 100, now: () => now });
  const first = { conversation: "pertama" };
  const second = { conversation: "kedua" };
  const third = { conversation: "ketiga" };

  store.set({ id: "one" }, first);
  store.set({ id: "two" }, second);
  assert.equal(store.get({ id: "one", remoteJid: "different-format@lid" }), first);

  store.set({ id: "three" }, third);
  assert.equal(store.get({ id: "one" }), undefined);
  assert.equal(store.get({ id: "two" }), second);

  now += 101;
  assert.equal(store.get({ id: "two" }), undefined);
  assert.equal(store.get({ id: "three" }), undefined);
});

test("converts IDs between application and Baileys formats", () => {
  assert.equal(toAppUserId("628123456789:4@s.whatsapp.net"), "628123456789@c.us");
  assert.equal(toBaileysJid("628123456789@c.us"), "628123456789@s.whatsapp.net");
  assert.equal(toAppUserId("12345@lid"), "12345@lid");
});

test("creates only one session per unique wali number", () => {
  const definitions = sessionDefinitions({
    "7A": {
      waliKelas: "628111@c.us",
      namaWali: "Bu Ana",
      siswa: { "628201@c.us": {} },
    },
    "7B": {
      waliKelas: "628111@c.us",
      namaWali: "Bu Ana",
      siswa: { "628202@c.us": {} },
    },
    "8A": {
      waliKelas: "628112@c.us",
      namaWali: "Pak Budi",
      siswa: {},
    },
  });

  assert.deepEqual([...definitions.keys()], ["wali:628111", "wali:628112"]);
  assert.deepEqual(definitions.get("wali:628111").classNames, ["7A", "7B"]);
  assert.deepEqual(definitions.get("wali:628111").studentNumbers, ["628201", "628202"]);
});

test("adapts text, location, forwarding metadata, and LID mapping", async () => {
  const sends = [];
  const socket = { sendMessage: async (...args) => sends.push(args) };
  const lidMap = new Map();
  const message = adaptIncomingMessage({
    key: {
      remoteJid: "12345@lid",
      remoteJidAlt: "628123456789@s.whatsapp.net",
      fromMe: false,
    },
    pushName: "Siswa",
    message: {
      locationMessage: {
        degreesLatitude: -6.7,
        degreesLongitude: 108.5,
        contextInfo: { isForwarded: true, forwardingScore: 1 },
      },
    },
  }, socket, lidMap);

  assert.equal(message.from, "628123456789@c.us");
  assert.equal(message.type, "location");
  assert.deepEqual(message.location, {
    latitude: -6.7,
    longitude: 108.5,
    name: "",
    address: "",
  });
  assert.equal(message.isForwarded, true);
  assert.equal(lidMap.get("12345@lid"), "628123456789@s.whatsapp.net");
  await message.reply("ok");
  assert.deepEqual(sends, [["12345@lid", { text: "ok" }]]);
});
