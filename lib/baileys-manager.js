const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

function digits(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function toAppUserId(jid) {
  const value = String(jid || "");
  if (value.endsWith("@lid")) return value;
  const number = digits(value);
  return number ? `${number}@c.us` : value;
}

function toBaileysJid(id) {
  const value = String(id || "");
  if (value.endsWith("@lid") || value.endsWith("@g.us")) return value;
  const number = digits(value);
  return number ? `${number}@s.whatsapp.net` : value;
}

function validWaVersion(version) {
  return Array.isArray(version) &&
    version.length === 3 &&
    version.every((part) => Number.isSafeInteger(part) && part >= 0);
}

async function resolveWaVersion(library, { timeoutMs = 10_000 } = {}) {
  const configured = String(process.env.WA_WEB_VERSION || "").trim();
  if (configured) {
    const version = configured.split(".").map(Number);
    if (!validWaVersion(version)) {
      throw new Error("WA_WEB_VERSION harus berformat angka.angka.angka.");
    }
    return { version, source: "konfigurasi" };
  }

  const fallback = library.DEFAULT_CONNECTION_CONFIG?.version;
  try {
    const result = await library.fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!result?.isLatest || !validWaVersion(result.version)) {
      throw result?.error || new Error("Versi WhatsApp Web terbaru tidak tersedia.");
    }
    return { version: [...result.version], source: "web.whatsapp.com" };
  } catch (error) {
    if (!validWaVersion(fallback)) throw error;
    console.warn(
      `[Baileys] Gagal mengambil versi WhatsApp Web terbaru; memakai versi bawaan ${fallback.join(".")}:`,
      error.message
    );
    return { version: [...fallback], source: "bawaan Baileys" };
  }
}

function unwrapMessage(content) {
  let current = content || {};
  const wrappers = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage"];
  for (let depth = 0; depth < 6; depth += 1) {
    const next = wrappers.find((key) => current[key]?.message);
    if (!next) break;
    current = current[next].message;
  }
  return current;
}

function messageBody(content) {
  return String(
    content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      content.buttonsResponseMessage?.selectedDisplayText ||
      content.listResponseMessage?.title ||
      content.templateButtonReplyMessage?.selectedDisplayText ||
      ""
  );
}

class RetryCounterCache {
  constructor({ maxEntries = 1024, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    const ms = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ms });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return true;
  }

  del(key) {
    return this.entries.delete(key) ? 1 : 0;
  }

  flushAll() {
    this.entries.clear();
  }
}

class RecentMessageStore {
  constructor({ maxEntries = 256, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 256);
    this.ttlMs = Math.max(1, Number(ttlMs) || 60 * 60 * 1000);
    this.now = now;
    this.messages = new Map();
  }

  set(key, message) {
    const id = String(key?.id || "");
    if (!id || !message) return;
    this.messages.delete(id);
    this.messages.set(id, { message, expiresAt: this.now() + this.ttlMs });
    this.prune();
  }

  get(key) {
    const id = String(key?.id || "");
    const entry = this.messages.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.messages.delete(id);
      return undefined;
    }
    return entry.message;
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.messages) {
      if (entry.expiresAt <= now) this.messages.delete(id);
    }
    while (this.messages.size > this.maxEntries) {
      this.messages.delete(this.messages.keys().next().value);
    }
  }

  clear() {
    this.messages.clear();
  }
}

async function adaptIncomingMessage(raw, socket, lidMap) {
  const content = unwrapMessage(raw.message);
  const location = content.locationMessage;
  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    location?.contextInfo ||
    {};
  const rawSender = raw.key.participant || raw.key.remoteJid || "";
  const alternateSender = raw.key.participantAlt || raw.key.remoteJidAlt || "";
  if (String(rawSender).endsWith("@lid") && alternateSender) {
    lidMap.set(rawSender, alternateSender);
  } else if (String(alternateSender).endsWith("@lid") && rawSender) {
    lidMap.set(alternateSender, rawSender);
  }
  let phoneJid = lidMap.get(rawSender) ||
    (String(alternateSender).endsWith("@s.whatsapp.net") ? alternateSender : rawSender);
  if (String(rawSender).endsWith("@lid") && String(phoneJid).endsWith("@lid")) {
    try {
      const mapped = await socket.signalRepository?.lidMapping?.getPNForLID?.(rawSender);
      if (String(mapped || "").endsWith("@s.whatsapp.net")) {
        phoneJid = mapped;
        lidMap.set(rawSender, mapped);
      }
    } catch (error) {
      console.warn("[Baileys] Pemetaan LID pesan gagal:", error.message);
    }
  }
  const sender = toAppUserId(phoneJid);

  return {
    body: messageBody(content),
    messageId: String(raw.key.id || ""),
    chatJid: String(raw.key.remoteJid || ""),
    from: sender,
    author: raw.key.participant ? sender : undefined,
    type: location ? "location" : "chat",
    location: location
      ? {
          latitude: Number(location.degreesLatitude),
          longitude: Number(location.degreesLongitude),
          name: location.name || "",
          address: location.address || "",
        }
      : null,
    isForwarded: Boolean(contextInfo.isForwarded),
    forwardingScore: Number(contextInfo.forwardingScore || 0),
    pushName: raw.pushName || "",
    // Keep the reply on the exact PN/LID conversation selected by WhatsApp.
    // Baileys v7 then migrates Signal sessions without mixing addressing modes.
    reply: (text) => socket.sendMessage(raw.key.remoteJid || rawSender, { text: String(text) }),
  };
}

function sessionDefinitions(classes, tuConfig = {}) {
  const definitions = new Map();
  for (const [className, data] of Object.entries(classes || {})) {
    const number = digits(data.waliKelas);
    if (!number) continue;
    const key = `wali:${number}`;
    let definition = definitions.get(key);
    if (!definition) {
      definition = {
        key,
        role: "wali",
        label: data.namaWali ? `${data.namaWali} (${number})` : number,
        expectedNumber: number,
        classNames: [],
        studentNumbers: [],
      };
      definitions.set(key, definition);
    }
    definition.classNames.push(className);
    definition.studentNumbers.push(...Object.keys(data.siswa || {}).map(digits).filter(Boolean));
  }
  const tuNumber = digits(tuConfig.number);
  if (tuNumber) {
    if (definitions.has(`wali:${tuNumber}`)) throw new Error("Nomor bot guru harus berbeda dari bot siswa.");
    definitions.set(`tu:${tuNumber}`, {
      key: `tu:${tuNumber}`, role: "tu", label: `Bot Guru (${tuNumber})`,
      expectedNumber: tuNumber, classNames: [], studentNumbers: tuConfig.teacherNumbers || [],
    });
  }
  return definitions;
}

class BaileysManager extends EventEmitter {
  constructor({ authRoot = "./.baileys_auth" } = {}) {
    super();
    this.authRoot = path.resolve(authRoot);
    this.sessions = new Map();
    this.library = null;
    this.logger = null;
    this.waVersion = null;
    this.versionResolvedAt = 0;
    this.versionPromise = null;
    this.stopping = false;
  }

  async loadLibrary() {
    if (!this.library) {
      this.library = await import("@whiskeysockets/baileys");
      const pino = require("pino");
      this.logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
    }
    if (!this.waVersion || Date.now() - this.versionResolvedAt > 60 * 60 * 1000) {
      if (!this.versionPromise) {
        this.versionPromise = resolveWaVersion(this.library)
          .then((resolved) => {
            this.waVersion = resolved.version;
            this.versionResolvedAt = Date.now();
            console.log(
              `[Baileys] Menggunakan WhatsApp Web ${this.waVersion.join(".")} dari ${resolved.source}.`
            );
          })
          .finally(() => { this.versionPromise = null; });
      }
      await this.versionPromise;
    }
    return this.library;
  }

  async start(classes = {}) {
    fs.mkdirSync(this.authRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.authRoot, 0o700);
    await this.loadLibrary();
    await this.sync(classes);
  }

  async sync(classes = {}) {
    const wanted = sessionDefinitions(classes, this.getTuConfig?.() || {});
    for (const [key, session] of this.sessions) {
      if (wanted.has(key)) continue;
      this.stopSession(session);
      this.sessions.delete(key);
    }

    const starts = [];
    for (const [key, definition] of wanted) {
      const existing = this.sessions.get(key);
      if (existing) {
        existing.definition = definition;
        if (existing.ready) starts.push(this.mapKnownStudents(existing));
        continue;
      }
      const session = {
        definition,
        socket: null,
        qr: null,
        ready: false,
        state: "starting",
        connectedNumber: "",
        error: "",
        stopped: false,
        reconnectTimer: null,
        reconnectAttempts: 0,
        generation: 0,
        connectPromise: null,
        disposeListeners: null,
        credentialSaveQueue: Promise.resolve(),
        resetPromise: null,
        lastCommandAt: null,
        lidMap: new Map(),
        recentMessages: new RecentMessageStore(),
        retryCounterCache: new RetryCounterCache(),
      };
      this.sessions.set(key, session);
      starts.push(this.connect(session).catch((error) => {
        session.ready = false;
        session.state = "error";
        session.error = String(error?.message || error);
        this.emit("status", this.publicStatus(session));
      }));
    }
    await Promise.allSettled(starts);
  }

  async connect(session) {
    if (this.stopping || session.stopped) return;
    if (session.connectPromise) return session.connectPromise;
    const pending = this.openSocket(session);
    session.connectPromise = pending;
    try {
      await pending;
    } finally {
      if (session.connectPromise === pending) session.connectPromise = null;
    }
  }

  async openSocket(session) {
    const generation = ++session.generation;
    this.disposeSocket(session);
    try {
    const {
      default: makeWASocket,
      Browsers,
      DisconnectReason,
      makeCacheableSignalKeyStore,
      useMultiFileAuthState,
    } = await this.loadLibrary();
    if (this.stopping || session.stopped || session.generation !== generation) return;
    const folder = this.sessionFolder(session.definition.key);
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    if (this.stopping || session.stopped || session.generation !== generation) return;
    const socket = makeWASocket({
      version: this.waVersion,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      logger: this.logger,
      browser: Browsers.ubuntu("Ruang Hadir"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => session.recentMessages.get(key),
      msgRetryCounterCache: session.retryCounterCache,
    });
    if (this.stopping || session.stopped || session.generation !== generation) {
      socket.end(new Error("STALE_CONNECTION"));
      return;
    }
    session.socket = socket;
    session.state = "connecting";
    session.error = "";

    const listeners = [];
    const listen = (event, handler) => {
      socket.ev.on(event, handler);
      listeners.push([event, handler]);
    };
    session.disposeListeners = () => {
      for (const [event, handler] of listeners) {
        socket.ev.off?.(event, handler);
      }
    };
    const pendingNotify = [];
    const isCurrent = () =>
      !this.stopping && !session.stopped && session.generation === generation &&
      session.socket === socket && session.ready;
    const dispatchMessages = (messages) => {
      void (async () => {
        for (const raw of messages) {
          if (!isCurrent()) return;
          if (!raw.message || raw.key.fromMe || !raw.key.remoteJid ||
              String(raw.key.remoteJid).endsWith("@g.us")) continue;
          try {
            const message = await adaptIncomingMessage(raw, socket, session.lidMap);
            if (!isCurrent()) return;
            message.reply = (text) => {
              if (!isCurrent()) {
                const error = new Error("Balasan dibatalkan karena sesi WhatsApp telah berubah.");
                error.code = "WA_SESSION_NOT_READY";
                return Promise.reject(error);
              }
              return this.sendReply(session, message.chatJid, text);
            };
            if (message.body.trim().startsWith("!")) {
              session.lastCommandAt = new Date().toISOString();
              if (process.env.WA_DIAGNOSTICS === "1") {
                const command = message.body.trim().split(/\s+/, 1)[0].slice(0, 30);
                console.info(`[Baileys ${session.definition.key}] command=${command} identity=${message.from.endsWith("@lid") ? "lid" : "phone"}`);
              }
            }
            this.emit("message", {
              botKey: session.definition.key,
              botRole: session.definition.role,
              expectedNumber: session.definition.expectedNumber,
              classNames: [...session.definition.classNames],
              message,
            });
          } catch (error) {
            console.error(`[Baileys ${session.definition.key}] Gagal menerjemahkan pesan masuk:`, error);
          }
        }
      })().catch((error) => console.error("[Baileys] Gagal mendistribusikan pesan:", error));
    };

    session.credentialSaveQueue ||= Promise.resolve();
    listen("creds.update", () => {
      if (generation !== session.generation || session.stopped) return;
      session.credentialSaveQueue = session.credentialSaveQueue
        .catch(() => {})
        .then(() => {
          if (generation !== session.generation || session.stopped || session.socket !== socket) return;
          return saveCreds();
        })
        .catch((error) => {
          console.error("[Baileys] Gagal menyimpan kredensial:", error);
        });
    });
    listen("chats.phoneNumberShare", ({ lid, jid }) => {
      if (generation === session.generation && session.socket === socket && lid && jid) {
        session.lidMap.set(lid, jid);
      }
    });
    listen("contacts.upsert", (contacts) => {
      if (generation === session.generation && session.socket === socket) {
        this.rememberContacts(session, contacts);
      }
    });
    listen("contacts.update", (contacts) => {
      if (generation === session.generation && session.socket === socket) {
        this.rememberContacts(session, contacts);
      }
    });
    listen("connection.update", (update) => {
      if (generation !== session.generation || session.stopped || session.socket !== socket) return;
      if (update.qr) {
        session.qr = update.qr;
        session.ready = false;
        session.state = "qr";
        this.emit("status", this.publicStatus(session));
      }
      if (update.connection === "open") {
        const connectedNumber = digits(socket.user?.id);
        session.connectedNumber = connectedNumber;
        if (
          session.definition.expectedNumber &&
          connectedNumber !== session.definition.expectedNumber
        ) {
          session.ready = false;
          session.qr = null;
          session.state = "mismatch";
          session.error = `Nomor terhubung ${connectedNumber || "tidak diketahui"}; seharusnya ${session.definition.expectedNumber}.`;
          this.emit("status", this.publicStatus(session));
          socket.end(new Error("WA_ACCOUNT_MISMATCH"));
          return;
        }
        session.ready = true;
        session.reconnectAttempts = 0;
        session.qr = null;
        session.state = "open";
        session.error = "";
        this.emit("status", this.publicStatus(session));
        void this.mapKnownStudents(session);
        if (pendingNotify.length) dispatchMessages(pendingNotify.splice(0));
      }
      if (update.connection === "close") {
        session.ready = false;
        session.qr = null;
        if (session.state === "mismatch") return;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        session.state = code === DisconnectReason.loggedOut ? "logged_out" : "closed";
        const detail = String(update.lastDisconnect?.error?.message || "Koneksi terputus.");
        session.error = code ? `${detail} (kode ${code})` : detail;
        this.emit("status", this.publicStatus(session));
        session.socket = null;
        session.disposeListeners?.();
        session.disposeListeners = null;
        if (!this.stopping && !session.stopped && code !== DisconnectReason.loggedOut) {
          this.scheduleReconnect(session);
        }
      }
    });
    listen("messages.upsert", ({ messages, type }) => {
      if (generation !== session.generation || session.stopped || session.socket !== socket) return;
      for (const raw of messages || []) session.recentMessages.set(raw.key, raw.message);
      if (process.env.WA_DIAGNOSTICS === "1") {
        console.info(`[Baileys ${session.definition.key}] upsert type=${type} count=${messages?.length || 0} ready=${session.ready}`);
      }
      if (type !== "notify") return;
      if (!session.ready) {
        for (const message of messages || []) {
          if (pendingNotify.length >= 100) pendingNotify.shift();
          pendingNotify.push(message);
        }
        return;
      }
      dispatchMessages(messages || []);
    });
    } catch (error) {
      if (this.stopping || session.stopped || session.generation !== generation) return;
      session.ready = false;
      session.state = "error";
      session.error = String(error?.message || error);
      this.emit("status", this.publicStatus(session));
      this.scheduleReconnect(session);
    }
  }

  disposeSocket(session) {
    const socket = session.socket;
    session.socket = null;
    session.disposeListeners?.();
    session.disposeListeners = null;
    if (!socket) return;
    try {
      socket.end(new Error("SOCKET_REPLACED"));
    } catch (error) {
      console.warn(`[Baileys ${session.definition.key}] Gagal menutup socket lama:`, error.message);
    }
  }

  scheduleReconnect(session) {
    if (this.stopping || session.stopped || session.reconnectTimer) return;
    const attempt = Math.min(session.reconnectAttempts || 0, 6);
    const delayMs = Math.round(
      Math.min(60_000, 3000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
    );
    session.reconnectAttempts = attempt + 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(session);
    }, delayMs);
    session.reconnectTimer.unref?.();
  }

  async restartConnection(key) {
    const session = this.sessions.get(key);
    if (!session || this.stopping || session.stopped || !session.ready || !session.socket) return false;
    session.generation++;
    this.disposeSocket(session);
    session.ready = false;
    session.state = "recovering";
    session.error = "Pengiriman WhatsApp melewati batas waktu; memulihkan koneksi.";
    this.emit("status", this.publicStatus(session));
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    await this.connect(session);
    return true;
  }

  async sendReply(session, chatJid, text) {
    const current = this.requireReady(session.definition.key);
    if (current !== session || !chatJid) {
      const error = new Error("Percakapan WhatsApp tidak tersedia pada sesi aktif.");
      error.code = "WA_SESSION_NOT_READY";
      throw error;
    }
    const sent = await current.socket.sendMessage(chatJid, { text: String(text) });
    current.recentMessages.set(sent?.key, sent?.message);
    return sent;
  }

  rememberContacts(session, contacts) {
    for (const contact of contacts || []) {
      const lid = contact.lid || (String(contact.id).endsWith("@lid") ? contact.id : "");
      const jid = contact.phoneNumber || (String(contact.id).endsWith("@s.whatsapp.net") ? contact.id : "");
      if (String(lid).endsWith("@lid") && String(jid).endsWith("@s.whatsapp.net")) {
        session.lidMap.set(lid, jid);
      }
    }
  }

  async mapKnownStudents(session) {
    if (!session.ready || !session.definition.studentNumbers.length) return;
    const socket = session.socket;
    const generation = session.generation;
    try {
      const mapping = socket?.signalRepository?.lidMapping;
      if (!mapping?.getLIDForPN) return;
      for (const number of new Set(session.definition.studentNumbers)) {
        if (!session.ready || session.socket !== socket || session.generation !== generation) return;
        const jid = toBaileysJid(number);
        const lid = await mapping.getLIDForPN(jid);
        if (!session.ready || session.socket !== socket || session.generation !== generation) return;
        if (String(lid || "").endsWith("@lid")) session.lidMap.set(lid, jid);
      }
    } catch (error) {
      console.warn(`[Baileys ${session.definition.key}] Pemetaan nomor siswa gagal:`, error.message);
    }
  }

  sessionFolder(key) {
    return path.join(this.authRoot, key.replace(":", "-"));
  }

  publicStatus(session) {
    return {
      key: session.definition.key,
      role: session.definition.role,
      label: session.definition.label,
      expectedNumber: session.definition.expectedNumber,
      connectedNumber: session.connectedNumber,
      classes: [...session.definition.classNames],
      ready: session.ready,
      state: session.state,
      lastCommandAt: session.lastCommandAt,
      qr: session.qr,
      error: session.error,
    };
  }

  statuses() {
    return [...this.sessions.values()].map((session) => this.publicStatus(session));
  }

  isReady(key = "main") {
    return Boolean(this.sessions.get(key)?.ready);
  }

  async sendText(key, recipientId, text) {
    const session = this.requireReady(key);
    const sent = await session.socket.sendMessage(toBaileysJid(recipientId), {
      text: String(text),
    });
    session.recentMessages.set(sent?.key, sent?.message);
    return sent;
  }

  async sendImage(key, recipientId, media, caption = "") {
    const session = this.requireReady(key);
    const image = Buffer.isBuffer(media.buffer)
      ? media.buffer
      : Buffer.from(String(media.data || ""), "base64");
    const sent = await session.socket.sendMessage(toBaileysJid(recipientId), {
      image,
      caption,
      mimetype: media.mimetype,
      fileName: media.filename || "image.jpg",
    });
    session.recentMessages.set(sent?.key, sent?.message);
    return sent;
  }

  requireReady(key) {
    const session = this.sessions.get(key);
    if (!session?.ready || !session.socket) {
      const error = new Error(`Sesi WhatsApp ${key} belum terhubung.`);
      error.code = "WA_SESSION_NOT_READY";
      throw error;
    }
    return session;
  }

  stopSession(session) {
    session.stopped = true;
    session.ready = false;
    session.generation++;
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    this.disposeSocket(session);
  }

  async reset(key) {
    const session = this.sessions.get(key);
    if (!session) throw new Error("Sesi WhatsApp tidak ditemukan.");
    if (session.resetPromise) return session.resetPromise;

    const folder = path.resolve(this.sessionFolder(key));
    if (path.dirname(folder) !== this.authRoot) {
      throw new Error("Lokasi sesi WhatsApp tidak valid.");
    }

    const work = (async () => {
      this.stopSession(session);
      session.state = "resetting";
      session.qr = null;
      session.connectedNumber = "";
      session.error = "";
      this.emit("status", this.publicStatus(session));

      // Wait for auth writes already queued before removing credentials.
      await session.credentialSaveQueue;
      await fs.promises.rm(folder, { recursive: true, force: true });
      if (this.stopping || this.sessions.get(key) !== session) return;

      session.stopped = false;
      session.state = "starting";
      session.reconnectAttempts = 0;
      session.lidMap.clear();
      session.recentMessages.clear();
      session.retryCounterCache.flushAll();
      this.emit("status", this.publicStatus(session));
      await this.connect(session);
    })();

    session.resetPromise = work;
    try {
      return await work;
    } catch (error) {
      session.ready = false;
      session.state = "error";
      session.error = `Gagal menghapus sesi: ${String(error.message || error)}`;
      this.emit("status", this.publicStatus(session));
      throw error;
    } finally {
      if (session.resetPromise === work) session.resetPromise = null;
    }
  }

  async close() {
    this.stopping = true;
    for (const session of this.sessions.values()) this.stopSession(session);
    this.sessions.clear();
  }
}

module.exports = {
  BaileysManager,
  RecentMessageStore,
  RetryCounterCache,
  adaptIncomingMessage,
  resolveWaVersion,
  sessionDefinitions,
  toAppUserId,
  toBaileysJid,
};
