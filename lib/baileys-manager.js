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

function unwrapMessage(content) {
  let current = content || {};
  for (const key of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2"]) {
    if (current[key]?.message) current = current[key].message;
  }
  return current;
}

function messageBody(content) {
  return String(
    content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      ""
  );
}

function adaptIncomingMessage(raw, socket, lidMap) {
  const content = unwrapMessage(raw.message);
  const location = content.locationMessage;
  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    location?.contextInfo ||
    {};
  const rawSender = raw.key.participant || raw.key.remoteJid || "";
  const phoneJid = lidMap.get(rawSender) || rawSender;
  const sender = toAppUserId(phoneJid);

  return {
    body: messageBody(content),
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
    reply: (text) => socket.sendMessage(toBaileysJid(phoneJid), { text: String(text) }),
  };
}

function sessionDefinitions(classes, mainExpectedNumber) {
  const definitions = new Map();
  definitions.set("main", {
    key: "main",
    role: "main",
    label: "Bot Utama",
    expectedNumber: digits(mainExpectedNumber),
    classNames: [],
    studentNumbers: [],
  });

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
  return definitions;
}

class BaileysManager extends EventEmitter {
  constructor({ authRoot = "./.baileys_auth", mainExpectedNumber = "" } = {}) {
    super();
    this.authRoot = path.resolve(authRoot);
    this.mainExpectedNumber = digits(mainExpectedNumber);
    this.sessions = new Map();
    this.library = null;
    this.logger = null;
    this.stopping = false;
  }

  async loadLibrary() {
    if (!this.library) {
      this.library = await import("@whiskeysockets/baileys");
      const pino = require("pino");
      this.logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });
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
    const wanted = sessionDefinitions(classes, this.mainExpectedNumber);
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
        generation: 0,
        lidMap: new Map(),
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
    const generation = ++session.generation;
    const {
      default: makeWASocket,
      Browsers,
      DisconnectReason,
      useMultiFileAuthState,
    } = await this.loadLibrary();
    const folder = this.sessionFolder(session.definition.key);
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const socket = makeWASocket({
      auth: state,
      logger: this.logger,
      browser: Browsers.ubuntu("Ruang Hadir"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    session.socket = socket;
    session.state = "connecting";
    session.error = "";

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
      if (lid && jid) session.lidMap.set(lid, jid);
    });
    socket.ev.on("contacts.upsert", (contacts) => this.rememberContacts(session, contacts));
    socket.ev.on("contacts.update", (contacts) => this.rememberContacts(session, contacts));
    socket.ev.on("connection.update", (update) => {
      if (generation !== session.generation || session.stopped) return;
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
        session.qr = null;
        session.state = "open";
        session.error = "";
        this.emit("status", this.publicStatus(session));
        void this.mapKnownStudents(session);
      }
      if (update.connection === "close") {
        session.ready = false;
        session.qr = null;
        if (session.state === "mismatch") return;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        session.state = code === DisconnectReason.loggedOut ? "logged_out" : "closed";
        session.error = String(update.lastDisconnect?.error?.message || "Koneksi terputus.");
        this.emit("status", this.publicStatus(session));
        if (!this.stopping && !session.stopped && code !== DisconnectReason.loggedOut) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = setTimeout(() => void this.connect(session), 3000);
          session.reconnectTimer.unref?.();
        }
      }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" || !session.ready) return;
      for (const raw of messages) {
        if (!raw.message || raw.key.fromMe || String(raw.key.remoteJid).endsWith("@g.us")) continue;
        const message = adaptIncomingMessage(raw, socket, session.lidMap);
        this.emit("message", {
          botKey: session.definition.key,
          botRole: session.definition.role,
          expectedNumber: session.definition.expectedNumber,
          classNames: [...session.definition.classNames],
          message,
        });
      }
    });
  }

  rememberContacts(session, contacts) {
    for (const contact of contacts || []) {
      const lid = contact.lid || (String(contact.id).endsWith("@lid") ? contact.id : "");
      const jid = contact.jid || (String(contact.id).endsWith("@s.whatsapp.net") ? contact.id : "");
      if (lid && jid) session.lidMap.set(lid, jid);
    }
  }

  async mapKnownStudents(session) {
    if (!session.ready || !session.definition.studentNumbers.length) return;
    try {
      const results = await session.socket.onWhatsApp(
        ...[...new Set(session.definition.studentNumbers)].map(toBaileysJid)
      );
      for (const result of results || []) {
        if (result.lid && result.jid) session.lidMap.set(result.lid, result.jid);
      }
    } catch (error) {
      console.warn(`[Baileys ${session.definition.key}] Pemetaan nomor siswa gagal:`, error.message);
    }
  }

  sessionFolder(key) {
    return path.join(this.authRoot, key === "main" ? "main" : key.replace(":", "-"));
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
    return session.socket.sendMessage(toBaileysJid(recipientId), { text: String(text) });
  }

  async sendImage(key, recipientId, media, caption = "") {
    const session = this.requireReady(key);
    const image = Buffer.isBuffer(media.buffer)
      ? media.buffer
      : Buffer.from(String(media.data || ""), "base64");
    return session.socket.sendMessage(toBaileysJid(recipientId), {
      image,
      caption,
      mimetype: media.mimetype,
      fileName: media.filename || "image.jpg",
    });
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
    session.socket?.end(new Error("SESSION_REMOVED"));
  }

  async reset(key) {
    const session = this.sessions.get(key);
    if (!session) throw new Error("Sesi WhatsApp tidak ditemukan.");
    this.stopSession(session);
    const folder = path.resolve(this.sessionFolder(key));
    if (path.dirname(folder) !== this.authRoot) {
      throw new Error("Lokasi sesi WhatsApp tidak valid.");
    }
    await fs.promises.rm(folder, { recursive: true, force: true });
    session.stopped = false;
    session.state = "starting";
    session.connectedNumber = "";
    session.error = "";
    session.lidMap.clear();
    await this.connect(session);
  }

  async close() {
    this.stopping = true;
    for (const session of this.sessions.values()) this.stopSession(session);
    this.sessions.clear();
  }
}

module.exports = {
  BaileysManager,
  adaptIncomingMessage,
  sessionDefinitions,
  toAppUserId,
  toBaileysJid,
};
