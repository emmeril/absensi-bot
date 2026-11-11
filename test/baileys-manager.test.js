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

test("buffers live messages during connection handshake without replaying history", async () => {
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const manager = new BaileysManager();
  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();
  let socket;
  manager.library = {
    default: () => {
      socket = {
        ev: new EventEmitter(),
        user: { id: "628111:1@s.whatsapp.net" },
        end: () => {},
      };
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
  };
  const received = [];
  manager.on("message", ({ message }) => received.push(message.body));
  await manager.sync({ "7A": { waliKelas: "628111@c.us", siswa: {} } });
  const event = (id, text) => ({
    key: { id, remoteJid: "628222@s.whatsapp.net" },
    message: { conversation: text },
  });
  socket.ev.emit("messages.upsert", { type: "notify", messages: [event("1", "!bantuan")] });
  socket.ev.emit("messages.upsert", { type: "append", messages: [event("2", "!masuk")] });
  assert.deepEqual(received, []);
  socket.ev.emit("connection.update", { connection: "open" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ["!bantuan"]);
  await manager.close();
});

test("restarts a live but stuck WhatsApp connection once and ignores the old socket", async () => {
  const { EventEmitter } = require("node:events");
  const { BaileysManager, RecentMessageStore } = require("../lib/baileys-manager");
  const manager = new BaileysManager();
  let ended = 0;
  let connected = 0;
  const socket = { ev: new EventEmitter(), end: () => { ended += 1; } };
  const session = {
    definition: { key: "wali:628111", role: "wali", expectedNumber: "628111", classNames: [], studentNumbers: [] },
    ready: true, socket, stopped: false, generation: 1,
    state: "open", error: "", reconnectTimer: null, reconnectAttempts: 0,
    lidMap: new Map(), recentMessages: new RecentMessageStore(),
  };
  manager.sessions.set("wali:628111", session);
  manager.connect = async () => { connected += 1; };
  assert.equal(await manager.restartConnection("wali:628111"), true);
  assert.equal(ended, 1);
  assert.equal(connected, 1);
  assert.equal(session.ready, false);
  assert.equal(await manager.restartConnection("wali:628111"), false);
  manager.stopping = true;
  manager.sessions.clear();
});

test("nested Baileys message wrappers are unwrapped", async () => {
  const msg = await adaptIncomingMessage({
    key: { id: "nested", remoteJid: "628222@s.whatsapp.net" },
    message: { viewOnceMessage: { message: { ephemeralMessage: {
      message: { extendedTextMessage: { text: "!bantuan" } },
    } } } },
  }, { sendMessage: async () => {} }, new Map());
  assert.equal(msg.body, "!bantuan");
});

test("reset an active session after pending auth writes and create a fresh QR", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baileys-reset-active-"));
  t.after(() => fs.rmSync(authRoot, { recursive: true, force: true }));

  const manager = new BaileysManager({ authRoot });
  t.after(async () => manager.close());
  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();

  const sockets = [];
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let writingStarted;
  const started = new Promise((resolve) => { writingStarted = resolve; });
  const sessionKey = "wali:628111";
  const credentialFile = path.join(manager.sessionFolder(sessionKey), "creds.json");
  manager.library = {
    default: () => {
      const socket = {
        ev: new EventEmitter(),
        user: { id: "628111:2@s.whatsapp.net" },
        logout: async () => { socket.loggedOut = true; },
        end: () => { socket.ended = true; },
      };
      sockets.push(socket);
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async (folder) => {
      fs.mkdirSync(folder, { recursive: true });
      return {
        state: { creds: {}, keys: {} },
        saveCreds: async () => {
          if (sockets.length !== 1) return;
          writingStarted();
          await writeGate;
          fs.writeFileSync(credentialFile, "old-credentials");
        },
      };
    },
  };

  await manager.sync({ "7A": { waliKelas: "628111@c.us", siswa: {} } });
  const activeSocket = sockets[0];
  activeSocket.ev.emit("connection.update", { connection: "open" });
  assert.equal(manager.isReady(sessionKey), true);
  activeSocket.ev.emit("creds.update", {});
  await started;

  const firstReset = manager.reset(sessionKey);
  const secondReset = manager.reset(sessionKey);
  assert.equal(manager.statuses()[0].state, "resetting");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeSocket.loggedOut, true);
  assert.equal(activeSocket.ended, true);
  assert.equal(activeSocket.ev.listenerCount("messages.upsert"), 0);
  assert.equal(sockets.length, 1);
  releaseWrite();
  await Promise.all([firstReset, secondReset]);
  assert.equal(sockets.length, 2);
  assert.equal(fs.existsSync(credentialFile), false);
  assert.equal(manager.isReady(sessionKey), false);

  sockets[1].ev.emit("connection.update", { qr: "QR-baru" });
  assert.equal(manager.statuses()[0].state, "qr");
  assert.equal(manager.statuses()[0].qr, "QR-baru");
  activeSocket.ev.emit("connection.update", { connection: "open" });
  assert.equal(manager.statuses()[0].state, "qr");
});

test("reset only deletes the selected bot while other active bots stay connected", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baileys-reset-isolation-"));
  const manager = new BaileysManager({ authRoot });
  t.after(async () => {
    await manager.close();
    fs.rmSync(authRoot, { recursive: true, force: true });
  });

  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();
  const sockets = [];
  let authGeneration = 0;
  manager.library = {
    default: () => {
      const number = sockets.length === 1 ? "628222" : "628111";
      const socket = {
        ev: new EventEmitter(),
        user: { id: number + ":1@s.whatsapp.net" },
        end: () => {},
      };
      sockets.push(socket);
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async (folder) => {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "session.txt"), String(++authGeneration));
      return { state: { creds: {}, keys: {} }, saveCreds: async () => {} };
    },
  };

  await manager.sync({
    "7A": { waliKelas: "628111@c.us", siswa: {} },
    "7B": { waliKelas: "628222@c.us", siswa: {} },
  });
  sockets[0].ev.emit("connection.update", { connection: "open" });
  sockets[1].ev.emit("connection.update", { connection: "open" });
  assert.equal(manager.isReady("wali:628222"), true);
  const otherCredentials = path.join(manager.sessionFolder("wali:628222"), "session.txt");
  const originalOther = fs.readFileSync(otherCredentials, "utf8");
  await manager.reset("wali:628111");

  assert.equal(fs.readFileSync(otherCredentials, "utf8"), originalOther);
  assert.equal(manager.isReady("wali:628222"), true);
  assert.equal(sockets.length, 3);
});

test("command replies remain bound to their socket and stop after reset", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baileys-command-reply-"));
  const manager = new BaileysManager({ authRoot });
  t.after(async () => {
    await manager.close();
    fs.rmSync(authRoot, { recursive: true, force: true });
  });
  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();
  const sockets = [];
  manager.library = {
    default: () => {
      const socket = {
        ev: new EventEmitter(),
        user: { id: "628111@s.whatsapp.net" },
        sent: [],
        end() {},
        async logout() {},
        async sendMessage(jid, data) {
          this.sent.push({ jid, data });
          return { key: { id: String(this.sent.length) }, message: data };
        },
      };
      sockets.push(socket);
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
  };
  const received = [];
  manager.on("message", ({ message }) => received.push(message));
  await manager.sync({ "7A": { waliKelas: "628111@c.us", siswa: {} } });
  const first = sockets[0];
  first.ev.emit("connection.update", { connection: "open" });
  first.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "command-1", remoteJid: "12345@lid", remoteJidAlt: "628222@s.whatsapp.net" },
      message: { conversation: "!bantuan" },
    }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.ok(manager.statuses()[0].lastCommandAt);
  await received[0].reply("Panduan");
  assert.deepEqual(first.sent[0], { jid: "12345@lid", data: { text: "Panduan" } });

  await manager.reset("wali:628111");
  assert.equal(first.ev.listenerCount("messages.upsert"), 0);
  await assert.rejects(received[0].reply("Balasan lama"), { code: "WA_SESSION_NOT_READY" });
  assert.equal(first.sent.length, 1);
  sockets[1].ev.emit("connection.update", { qr: "QR-baru" });
  assert.equal(manager.statuses()[0].state, "qr");
  assert.equal(manager.statuses()[0].lastCommandAt, null);
});

test("failed remote logout does not prevent generating a new WhatsApp session", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { BaileysManager } = require("../lib/baileys-manager");
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baileys-logout-fallback-"));
  const manager = new BaileysManager({ authRoot });
  t.after(async () => {
    await manager.close();
    fs.rmSync(authRoot, { recursive: true, force: true });
  });
  manager.waVersion = [2, 3000, 1];
  manager.versionResolvedAt = Date.now();
  const sockets = [];
  manager.library = {
    default: () => {
      const socket = {
        ev: new EventEmitter(),
        user: { id: "628111@s.whatsapp.net" },
        end() {},
        async logout() { throw new Error("offline"); },
      };
      sockets.push(socket);
      return socket;
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
    DisconnectReason: { loggedOut: 401 },
    makeCacheableSignalKeyStore: (keys) => keys,
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
  };
  await manager.sync({ "7A": { waliKelas: "628111@c.us", siswa: {} } });
  sockets[0].ev.emit("connection.update", { connection: "open" });
  const warn = t.mock.method(console, "warn", () => {});
  await manager.reset("wali:628111");
  assert.equal(sockets.length, 2);
  assert.equal(manager.statuses()[0].ready, false);
  assert.ok(warn.mock.calls.some((call) => call.arguments.join(" ").includes("Logout perangkat tertaut gagal")));
});
