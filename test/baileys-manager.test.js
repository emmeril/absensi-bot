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
  const message = await adaptIncomingMessage({
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

test("maps Baileys v7 contacts regardless of whether id is PN or LID", () => {
  const { BaileysManager } = require("../lib/baileys-manager");
  const manager = new BaileysManager();
  const session = { lidMap: new Map() };
  manager.rememberContacts(session, [
    { id: "1234@lid", phoneNumber: "628111@s.whatsapp.net" },
    { id: "628222@s.whatsapp.net", lid: "5678@lid" },
  ]);
  assert.equal(session.lidMap.get("1234@lid"), "628111@s.whatsapp.net");
  assert.equal(session.lidMap.get("5678@lid"), "628222@s.whatsapp.net");
});

test("resolves inbound LID using Baileys signal repository when alt JID is absent", async () => {
  const map = new Map();
  const message = await adaptIncomingMessage({
    key: { id: "wamid-1", remoteJid: "1234@lid" },
    message: { conversation: "!masuk" },
  }, {
    signalRepository: { lidMapping: { getPNForLID: async () => "628111@s.whatsapp.net" } },
    sendMessage: async () => {},
  }, map);
  assert.equal(message.from, "628111@c.us");
  assert.equal(message.messageId, "wamid-1");
  assert.equal(message.chatJid, "1234@lid");
  assert.equal(map.get("1234@lid"), "628111@s.whatsapp.net");
});

test("retry counter cache expires entries and caps memory", () => {
  const { RetryCounterCache } = require("../lib/baileys-manager");
  let now = 0;
  const cache = new RetryCounterCache({ maxEntries: 2, ttlMs: 20, now: () => now });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
  now += 21;
  assert.equal(cache.get("b"), undefined);
  cache.flushAll();
  assert.equal(cache.get("c"), undefined);
});

test("ignores events from a closed socket and stops reconnect timers on shutdown", async () => {
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const sockets = [];
  const manager = new BaileysManager();
  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();
  manager.library = {
    default: () => {
      const socket = {
        ev: new EventEmitter(),
        user: { id: "628111:1@s.whatsapp.net" },
        end: () => {},
      };
      sockets.push(socket);
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => {},
    }),
  };
  const received = [];
  manager.on("message", ({ message }) => received.push(message.body));
  await manager.sync({
    "7A": { waliKelas: "628111@c.us", siswa: {} },
  });
  const socket = sockets[0];
  socket.ev.emit("connection.update", { connection: "open" });
  socket.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "first", remoteJid: "628222@s.whatsapp.net" },
      message: { conversation: "!masuk" },
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ["!masuk"]);

  socket.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: new Error("network disconnected") },
  });
  socket.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "late", remoteJid: "628222@s.whatsapp.net" },
      message: { conversation: "!izin" },
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ["!masuk"]);
  await manager.close();
  assert.equal(manager.sessions.size, 0);
});
