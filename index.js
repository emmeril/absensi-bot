require("dotenv").config();

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const moment = require("moment");
const haversine = require("haversine-distance");
const XLSX = require("xlsx");
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { DB_PATH, initJsonStore, saveJsonData } = require("./models/database");
const { resolveWhatsappUserId } = require("./lib/whatsapp-id");
const { qrToSvg } = require("./lib/qr-svg");
const {
  validateLocationMessage,
  locationRejectionMessage,
} = require("./lib/location-message");
const { FaceWorkerPool } = require("./services/face-worker-pool");
const { TaskQueue } = require("./lib/task-queue");
const {
  getDailyStudentStatus,
  getArrivalStatus,
  isWithinAttendanceWindow,
  validateAttendance,
  validatePermission,
} = require("./lib/attendance-rules");
const app = express();
const PORT = 3200;
const CAMERA_SESSION_TTL_MS = 2 * 60 * 1000;
const PERMISSION_SESSION_TTL_MS = 5 * 60 * 1000;
const ATTENDANCE_RADIUS_METERS = 100;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const loginOtps = new Map();
const webSessions = new Map();
const cameraSessions = new Map();
const permissionSessions = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const STORAGE_PATH = "./storage.json";
const KONTAK_PATH = "./kontak.json";
const ROLE_PATH = "./roles.json";
const LOKASI_PATH = "./lokasi.json";
const JAM_PATH = "./jam.json";
const EXPORTS_DIR = "./exports";
const FACE_DB = "./face_db";
const FACE_REC = "./face_rec";
const IZIN_BUKTI_DIR = "./izin_bukti";
const IZIN_PATH = "./izin.json";
const KELAS_PATH = "./kelas.json";
const USER_NAMES_PATH = "./user_names.json";

const DEFAULT_ROLES = {
  "6287728972090@c.us": "admin",
};

const JSON_STORES = {
  [STORAGE_PATH]: { path: STORAGE_PATH, fallback: {} },
  [KONTAK_PATH]: { path: KONTAK_PATH, fallback: {} },
  [ROLE_PATH]: { path: ROLE_PATH, fallback: DEFAULT_ROLES },
  [LOKASI_PATH]: {
    path: LOKASI_PATH,
    fallback: { latitude: -6.7329, longitude: 108.5522 },
  },
  [JAM_PATH]: {
    path: JAM_PATH,
    fallback: {
      masuk: "09:00:00",
      pulang: "16:00:00",
      toleransi: 0,
      mulaiMasuk: "00:00:00",
      selesaiMasuk: "23:59:59",
      mulaiPulang: "00:00:00",
      selesaiPulang: "23:59:59",
    },
  },
  [IZIN_PATH]: { path: IZIN_PATH, fallback: {} },
  [KELAS_PATH]: { path: KELAS_PATH, fallback: {} },
  [USER_NAMES_PATH]: { path: USER_NAMES_PATH, fallback: {} },
};

let jsonCache = {};

const facePool = new FaceWorkerPool({
  size: Number(process.env.FACE_WORKER_COUNT) || 2,
  maxQueue: Number(process.env.FACE_QUEUE_LIMIT) || 100,
  timeoutMs: Number(process.env.FACE_TIMEOUT_MS) || 60000,
});
const notificationQueue = new TaskQueue({
  concurrency: Number(process.env.NOTIFICATION_CONCURRENCY) || 2,
  maxQueue: Number(process.env.NOTIFICATION_QUEUE_LIMIT) || 200,
});
const activeFaceJobs = new Set();

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function loadJSON(path, fallback = {}) {
  return cloneData(jsonCache[path] ?? fallback);
}
async function saveJSON(path, data) {
  jsonCache[path] = cloneData(data);
  await saveJsonData(path, jsonCache[path]);
}
function getWaktu() {
  const now = moment();
  return {
    tanggal: now.format("YYYY-MM-DD"),
    jam: now.format("HH:mm:ss"),
  };
}
function exportExcel(data, filename) {
  ensureDir(EXPORTS_DIR);
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rekap");
  const filePath = `${EXPORTS_DIR}/Rekap-${filename}.xlsx`;
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeJam(jam) {
  if (typeof jam !== "string") return jam;
  if (/^\d{2}:\d{2}$/.test(jam)) return `${jam}:00`;
  return jam;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function isValidDate(value) {
  const input = String(value || "");
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(input) &&
    moment(input, "YYYY-MM-DD", true).isValid()
  );
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(
    /\/$/,
    ""
  );
}

function createCameraSession(userId, tipe) {
  for (const [token, session] of cameraSessions) {
    if (session.userId === userId) cameraSessions.delete(token);
  }

  const token = crypto.randomBytes(32).toString("hex");
  cameraSessions.set(token, {
    userId,
    tipe,
    expiresAt: Date.now() + CAMERA_SESSION_TTL_MS,
    processing: false,
  });
  return token;
}

function getCameraSession(token) {
  const session = cameraSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    cameraSessions.delete(token);
    return null;
  }
  return session;
}

function createPermissionSession(userId, alasan, tanggal) {
  for (const [token, session] of permissionSessions) {
    if (session.userId === userId) permissionSessions.delete(token);
  }

  const token = crypto.randomBytes(32).toString("hex");
  permissionSessions.set(token, {
    userId,
    alasan,
    tanggal,
    expiresAt: Date.now() + PERMISSION_SESSION_TTL_MS,
    verified: false,
    processing: false,
  });
  return token;
}

function getPermissionSession(token) {
  const session = permissionSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    permissionSessions.delete(token);
    return null;
  }
  return session;
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(
    /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match || match[2].length > 8 * 1024 * 1024) return null;
  return { mimetype: match[1], data: match[2] };
}

function antreVerifikasiWajah(userId, fotoBase64) {
  if (activeFaceJobs.has(userId)) {
    const error = new Error("Verifikasi wajah untuk pengguna ini masih berjalan");
    error.code = "FACE_JOB_ACTIVE";
    throw error;
  }

  activeFaceJobs.add(userId);
  try {
    const queued = facePool.verify(userId.replace("@c.us", ""), fotoBase64);
    queued.promise = queued.promise
      .then((result) => result.match === true)
      .finally(() => activeFaceJobs.delete(userId));
    return queued;
  } catch (e) {
    activeFaceJobs.delete(userId);
    throw e;
  }
}

function antreNotifikasi(task, context) {
  notificationQueue.add(task).catch((error) => {
    console.error(`[Antrean Notifikasi ERROR] ${context}:`, error.message);
  });
}

function loadRoles() {
  return loadJSON(ROLE_PATH, {});
}

function dashboardUserName(id, role) {
  const savedName = loadJSON(USER_NAMES_PATH, {})[id];
  if (savedName) return savedName;

  if (role === "wali_kelas") {
    const wali = Object.values(loadKelas()).find((data) => data.waliKelas === id);
    if (wali?.namaWali) return wali.namaWali;
  }

  return role === "admin" ? "Administrator" : "Wali Kelas";
}

function teksBantuan(role, terdaftar) {
  const lines = ["*Perintah WhatsApp Ruang Hadir*"];

  if (role === "admin") {
    lines.push(
      "",
      "Akses: Administrator",
      "• *!setlokasi* - Mengatur titik lokasi sekolah. Setelah perintah ini, bagikan lokasi sekolah melalui fitur Lokasi WhatsApp.",
      "• *!bantuan* - Menampilkan daftar perintah yang tersedia untuk role kamu.",
      "",
      `Pengelolaan siswa, kelas, jadwal, izin, admin, dan laporan tersedia di dashboard: ${publicBaseUrl()}`
    );
    return lines.join("\n");
  }

  if (role === "wali_kelas") {
    lines.push(
      "",
      "Akses: Wali Kelas",
      "• *!bantuan* - Menampilkan daftar perintah yang tersedia untuk role kamu.",
      "",
      `Data siswa dan foto referensi kelas dikelola melalui dashboard: ${publicBaseUrl()}`
    );
    return lines.join("\n");
  }

  if (terdaftar) {
    lines.push(
      "",
      "Akses: Siswa Terdaftar",
      "• *!masuk* - Memulai absensi masuk dan menerima tautan kamera sekali pakai.",
      "• *!pulang* - Memulai absensi pulang dan menerima tautan kamera sekali pakai.",
      "• *!izin alasan* - Mengajukan izin melalui tautan verifikasi dan unggah bukti.",
      "• *!bantuan* - Menampilkan daftar perintah yang tersedia untuk role kamu."
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "Akses: Belum Terdaftar",
    "• *!bantuan* - Menampilkan bantuan dasar.",
    "",
    "Nomor kamu belum terdaftar untuk absensi. Hubungi admin sekolah agar dapat menggunakan perintah absensi."
  );
  return lines.join("\n");
}

async function saveDashboardUserName(id, name) {
  const names = loadJSON(USER_NAMES_PATH, {});
  names[id] = toTitleCase(String(name || "").trim());
  await saveJSON(USER_NAMES_PATH, names);
}

async function resolveDashboardUserName(id, role) {
  const knownName = dashboardUserName(id, role);
  if (knownName !== "Administrator" && knownName !== "Wali Kelas") return knownName;

  try {
    const contact = await client.getContactById(id);
    const whatsappName = contact.pushname || contact.name || contact.shortName;
    if (whatsappName) {
      await saveDashboardUserName(id, whatsappName);
      return dashboardUserName(id, role);
    }
  } catch (error) {
    console.warn(`[Dashboard] Nama WhatsApp ${id} tidak dapat dibaca:`, error.message);
  }

  return knownName;
}

async function ensureDefaultRoles() {
  const roles = loadRoles();
  let changed = false;

  for (const [id, role] of Object.entries(DEFAULT_ROLES)) {
    if (roles[id] !== role) {
      roles[id] = role;
      changed = true;
    }
  }

  if (changed) await saveJSON(ROLE_PATH, roles);
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeNomor(rawNomor) {
  const nomor = String(rawNomor || "").replace(/\D/g, "");
  if (nomor.startsWith("0")) return `62${nomor.slice(1)}`;
  return nomor;
}

function loadIzin() {
  return loadJSON(IZIN_PATH, {});
}

async function saveIzin(data) {
  await saveJSON(IZIN_PATH, data);
}

function loadKelas() {
  return loadJSON(KELAS_PATH, {});
}

async function saveKelas(data) {
  await saveJSON(KELAS_PATH, data);
}

function findKelasSiswa(dataKelas, siswaId) {
  for (const [namaKelas, data] of Object.entries(dataKelas)) {
    if (data.siswa?.[siswaId]) return { namaKelas, ...data };
  }
  return null;
}

async function kirimPesanAman(id, pesan) {
  if (!id) return;
  try {
    await client.sendMessage(id, pesan);
  } catch (error) {
    console.error(`[Notifikasi ERROR] ${id}:`, error.message);
  }
}

async function kirimMediaAman(id, media, caption) {
  if (!id) return;
  try {
    await client.sendMessage(id, media, { caption });
  } catch (error) {
    console.error(`[Notifikasi Media ERROR] ${id}:`, error.message);
  }
}

function getAttendanceWindow(jamResmi, tipe) {
  return tipe === "masuk"
    ? { mulai: jamResmi.mulaiMasuk, selesai: jamResmi.selesaiMasuk }
    : { mulai: jamResmi.mulaiPulang, selesai: jamResmi.selesaiPulang };
}

function getAttendanceStatus(waktu, jamResmi, tipe) {
  if (tipe === "masuk") {
    return getArrivalStatus(
      waktu,
      normalizeJam(jamResmi.masuk),
      jamResmi.toleransi
    );
  }

  return waktu >= normalizeJam(jamResmi.pulang)
    ? "Sesuai Waktu"
    : "Pulang Cepat";
}

function getStudentNotificationRecipients(studentId, kelasSiswa) {
  const recipients = new Set(
    Object.entries(loadRoles())
      .filter(([, role]) => role === "admin")
      .map(([id]) => id)
  );
  if (kelasSiswa?.waliKelas) recipients.add(kelasSiswa.waliKelas);
  if (kelasSiswa?.siswa[studentId]?.orangTua) {
    recipients.add(kelasSiswa.siswa[studentId].orangTua);
  }
  recipients.delete(studentId);
  return recipients;
}

async function catatAbsensiKamera(userId, tipe, lokasi, foto) {
  const storage = loadJSON(STORAGE_PATH);
  const kontak = loadJSON(KONTAK_PATH);
  const jamResmi = loadJSON(JAM_PATH, {
    masuk: "09:00:00",
    pulang: "16:00:00",
    toleransi: 0,
    mulaiMasuk: "00:00:00",
    selesaiMasuk: "23:59:59",
    mulaiPulang: "00:00:00",
    selesaiPulang: "23:59:59",
  });
  const waktu = getWaktu();
  const attendanceError = validateAttendance(
    getDailyStudentStatus(storage, loadIzin(), waktu.tanggal, userId),
    tipe
  );
  if (attendanceError) throw new Error(attendanceError);

  const { mulai: mulaiAbsen, selesai: selesaiAbsen } = getAttendanceWindow(
    jamResmi,
    tipe
  );
  if (!isWithinAttendanceWindow(waktu.jam, mulaiAbsen, selesaiAbsen)) {
    throw new Error(
      `Absen ${tipe} hanya dapat dilakukan pukul ${String(
        mulaiAbsen || "00:00"
      ).slice(0, 5)}-${String(selesaiAbsen || "23:59").slice(0, 5)}.`
    );
  }

  const lokasiKantor = loadJSON(LOKASI_PATH, {
    latitude: -6.7329,
    longitude: 108.5522,
  });
  if (haversine(lokasi, lokasiKantor) > ATTENDANCE_RADIUS_METERS) {
    throw new Error("Kamu berada di luar area sekolah.");
  }

  const status = getAttendanceStatus(waktu.jam, jamResmi, tipe);
  const dataHariIni = (storage[waktu.tanggal] = storage[waktu.tanggal] || {});
  const userLog = (dataHariIni[userId] = dataHariIni[userId] || {});
  userLog[tipe] = {
    waktu: waktu.jam,
    lokasi,
    status,
    foto,
    nama: kontak[userId],
  };
  await saveJSON(STORAGE_PATH, storage);

  const mediaMsg = new MessageMedia(
    foto.mimetype,
    foto.data,
    `${userId.replace("@c.us", "")}.jpg`
  );
  const kelasSiswa = findKelasSiswa(loadKelas(), userId);
  const caption =
    `*${kontak[userId] || userId}* telah absen *${tipe}*\n` +
    `Status: *${status}*\n` +
    `Jam: ${waktu.jam}`;
  const penerima = getStudentNotificationRecipients(userId, kelasSiswa);
  for (const id of penerima) {
    antreNotifikasi(
      () => kirimMediaAman(id, mediaMsg, caption),
      `absen kamera ${userId} -> ${id}`
    );
  }

  return { status, waktu: waktu.jam, tanggal: waktu.tanggal };
}

const client = new Client({
  authStrategy: new LocalAuth(), // Simpan sesi login secara lokal
  puppeteer: {
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-features=VizDisplayCompositor",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--max-old-space-size=512",
    ],
    ignoreHTTPSErrors: true,
  },
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html",
  },
});

const pendingLokasi = {};
const lidToPhoneCache = new Map();

client.on("qr", (qr) => {
  qrCodeData = qr;
  isReady = false;
  console.log("📲 QR tersedia: buka http://localhost:3200/qr");
});

client.on("ready", () => {
  isReady = true;
  qrCodeData = null;
  console.clear();
  console.log("✅ Bot sudah terhubung ke WhatsApp.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp disconnected:", reason);
  fs.rmSync(".wwebjs_auth", { recursive: true, force: true });
  process.exit(); // atau restart otomatis
});

client.on("message", async (msg) => {
  const rawSender = msg.author || msg.from;
  const sender = await resolveWhatsappUserId(client, rawSender, lidToPhoneCache);
  if (rawSender !== sender) {
    console.log(`[WhatsApp ID] ${rawSender} -> ${sender}`);
  }
  const body = String(msg.body || "").trim().toLowerCase();
  const storage = loadJSON(STORAGE_PATH);
  const kontak = loadJSON(KONTAK_PATH);
  const roles = loadJSON(ROLE_PATH);
  const jamResmi = loadJSON(JAM_PATH, {
    masuk: "09:00:00",
    pulang: "16:00:00",
    toleransi: 0,
    mulaiMasuk: "00:00:00",
    selesaiMasuk: "23:59:59",
    mulaiPulang: "00:00:00",
    selesaiPulang: "23:59:59",
  });
  const waktu = getWaktu();
  const role = roles[sender] || "user";
  const terdaftar = Boolean(kontak[sender]);

  if (body === "!bantuan") {
    return msg.reply(teksBantuan(role, terdaftar));
  }

  if (!terdaftar && !["admin", "wali_kelas"].includes(role)) {
    return msg.reply(
      "❌ Nomor kamu belum terdaftar di absensi. Hubungi admin untuk didaftarkan."
    );
  }

  const commandDiizinkan =
    body === "!masuk" ||
    body === "!pulang" ||
    body === "!setlokasi" ||
    body === "!bantuan" ||
    body === "!izin" ||
    body.startsWith("!izin ");
  if (
    body.startsWith("!") &&
    !commandDiizinkan
  ) {
    return msg.reply(
      "❌ Perintah tidak dikenali. Ketik *!bantuan* untuk melihat perintah yang tersedia."
    );
  }

  // Set lokasi
  if (body === "!setlokasi") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    pendingLokasi[sender] = true;
    return msg.reply("📍 Bagikan lokasi sekolah sekarang melalui fitur Lokasi WhatsApp.");
  }
  if (msg.type === "location" && pendingLokasi[sender]) {
    const validation = validateLocationMessage(msg);
    if (!validation.valid) {
      return msg.reply(locationRejectionMessage(validation.reason));
    }

    await saveJSON(LOKASI_PATH, validation.location);
    delete pendingLokasi[sender];
    return msg.reply("✅ Lokasi sekolah disimpan.");
  }

  // Absen masuk/pulang
  if (body.startsWith("!masuk") || body.startsWith("!pulang")) {
    if (!kontak[sender]) {
      return msg.reply(
        "❌ Nomor kamu belum terdaftar. Hubungi admin untuk mendaftar."
      );
    }

    const tipe = body.startsWith("!masuk") ? "masuk" : "pulang";
    const nomor = sender.replace("@c.us", "");
    const attendanceError = validateAttendance(
      getDailyStudentStatus(storage, loadIzin(), waktu.tanggal, sender),
      tipe
    );
    if (attendanceError) return msg.reply(`❌ ${attendanceError}`);
    const { mulai: mulaiAbsen, selesai: selesaiAbsen } = getAttendanceWindow(
      jamResmi,
      tipe
    );
    if (!isWithinAttendanceWindow(waktu.jam, mulaiAbsen, selesaiAbsen)) {
      return msg.reply(
        `❌ Absen ${tipe} hanya dapat dilakukan pukul ${String(
          mulaiAbsen || "00:00"
        ).slice(0, 5)}–${String(selesaiAbsen || "23:59").slice(0, 5)}.`
      );
    }

    if (!fs.existsSync(`${FACE_REC}/${nomor}.jpg`)) {
      return msg.reply(
        "⚠️ Foto referensi wajah belum ada. Hubungi admin atau wali kelas untuk mengunggah foto melalui dashboard."
      );
    }

    const token = createCameraSession(sender, tipe);
    const cameraUrl = `${publicBaseUrl()}/camera.html?token=${token}`;

    return msg.reply(
      `Buka tautan berikut untuk absen *${tipe}*:\n${cameraUrl}\n\n` +
        "Ambil selfie langsung dari kamera dan izinkan akses lokasi. " +
        "Tautan hanya berlaku selama 2 menit dan hanya bisa digunakan sekali."
    );
  }

  // Pengajuan izin wajib dilengkapi foto bukti.
  if (body === "!izin") {
    return msg.reply("⚠️ Format: *!izin alasan*\nContoh: *!izin sakit demam*");
  }

  if (body.startsWith("!izin ")) {
    if (!kontak[sender]) {
      return msg.reply("❌ Nomor kamu belum terdaftar. Tidak bisa mengajukan izin.");
    }

    const alasan = msg.body.trim().slice(6).trim();
    if (alasan.length < 3) return msg.reply("⚠️ Alasan izin terlalu singkat.");
    const permissionError = validatePermission(
      getDailyStudentStatus(storage, loadIzin(), waktu.tanggal, sender)
    );
    if (permissionError) return msg.reply(`❌ ${permissionError}`);

    const token = createPermissionSession(sender, alasan, waktu.tanggal);
    const permissionUrl = `${publicBaseUrl()}/permission.html?token=${token}`;
    return msg.reply(
      `Buka tautan berikut untuk mengajukan izin:\n${permissionUrl}\n\n` +
        "Tahap 1: ambil selfie langsung dan izinkan GPS.\n" +
        "Tahap 2: unggah foto surat atau bukti izin secara terpisah.\n" +
        "Tautan berlaku selama 5 menit."
    );
  }

  function cetak(id) {
    return `- ${kontak[id] || id}`;
  }
});

let qrCodeData = null;
let isReady = false;

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function webUser(req) {
  const token = parseCookies(req).absensi_session;
  const session = token ? webSessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) webSessions.delete(token);
    return null;
  }
  const currentRole = loadRoles()[session.id];
  if (
    currentRole !== session.role ||
    !["admin", "wali_kelas"].includes(currentRole)
  ) {
    webSessions.delete(token);
    return null;
  }
  return session;
}

function requireWebAuth(req, res, next) {
  const user = webUser(req);
  if (!user) return res.status(401).json({ error: "Silakan login terlebih dahulu." });
  req.webUser = user;
  next();
}

function requireWebAdmin(req, res, next) {
  if (req.webUser?.role !== "admin") {
    return res.status(403).json({ error: "Fitur ini hanya tersedia untuk admin." });
  }
  next();
}

function requireWebPhotoManager(req, res, next) {
  if (req.webUser?.role === "admin") return next();

  const siswaId = `${normalizeNomor(req.params.number)}@c.us`;
  const kelasWali = kelasUntukWali(loadKelas(), req.webUser?.id);
  if (req.webUser?.role === "wali_kelas" && findKelasSiswa(kelasWali, siswaId)) {
    return next();
  }

  return res.status(403).json({
    error: "Wali kelas hanya dapat mengunggah foto siswa di kelasnya.",
  });
}

function kelasUntukWali(kelas, userId) {
  return Object.fromEntries(
    Object.entries(kelas).filter(([, data]) => data.waliKelas === userId)
  );
}

function removeUnusedWaliRole(userId, kelas, roles) {
  if (!userId || roles[userId] !== "wali_kelas") return;
  const masihMenjadiWali = Object.values(kelas).some(
    (data) => data.waliKelas === userId
  );
  if (!masihMenjadiWali) delete roles[userId];
}

app.get("/api/permission-camera/:token", (req, res) => {
  const session = getPermissionSession(req.params.token);
  if (!session) {
    return res.status(410).json({ error: "Tautan izin sudah tidak berlaku." });
  }
  const kontak = loadJSON(KONTAK_PATH);
  res.json({
    nama: kontak[session.userId] || "Siswa",
    alasan: session.alasan,
    expiresAt: session.expiresAt,
    verified: session.verified,
  });
});

app.post("/api/permission-camera/:token/verify", async (req, res) => {
  const session = getPermissionSession(req.params.token);
  if (!session || session.processing || session.verified) {
    return res.status(410).json({ error: "Tahap verifikasi sudah tidak berlaku." });
  }
  const foto = parseImageDataUrl(req.body.image);
  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = Number(req.body.accuracy);
  if (!foto) return res.status(400).json({ error: "Selfie kamera tidak valid." });
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(accuracy) ||
    accuracy <= 0
  ) {
    return res.status(400).json({ error: "Lokasi GPS tidak valid." });
  }

  session.processing = true;
  try {
    const queued = antreVerifikasiWajah(session.userId, foto.data);
    const cocok = await queued.promise;
    if (!cocok) {
      permissionSessions.delete(req.params.token);
      return res.status(400).json({
        error: "Wajah tidak dikenali. Kirim perintah izin lagi untuk mencoba ulang.",
      });
    }
    session.verified = true;
    session.processing = false;
    session.selfie = foto;
    session.lokasi = { latitude, longitude, accuracy };
    session.expiresAt = Date.now() + PERMISSION_SESSION_TTL_MS;
    res.json({ ok: true, expiresAt: session.expiresAt });
  } catch (error) {
    permissionSessions.delete(req.params.token);
    console.error(`[Verifikasi Izin ERROR] ${session.userId}:`, error.message);
    res.status(400).json({ error: "Selfie gagal diverifikasi. Kirim perintah izin lagi." });
  }
});

app.post("/api/permission-camera/:token/evidence", async (req, res) => {
  const token = req.params.token;
  const session = getPermissionSession(token);
  if (!session || !session.verified || session.processing) {
    return res.status(410).json({ error: "Sesi unggah bukti sudah tidak berlaku." });
  }
  const bukti = parseImageDataUrl(req.body.image);
  if (!bukti) return res.status(400).json({ error: "Foto bukti tidak valid." });

  session.processing = true;
  try {
    const storage = loadJSON(STORAGE_PATH);
    const izinData = loadIzin();
    const permissionError = validatePermission(
      getDailyStudentStatus(storage, izinData, session.tanggal, session.userId)
    );
    if (permissionError) throw new Error(permissionError);

    const nomor = session.userId.replace("@c.us", "");
    ensureDir(IZIN_BUKTI_DIR);
    ensureDir(FACE_REC);
    const buktiPath = `${IZIN_BUKTI_DIR}/${session.tanggal}-${nomor}-bukti.jpg`;
    const selfiePath = `${IZIN_BUKTI_DIR}/${session.tanggal}-${nomor}-selfie.jpg`;
    fs.writeFileSync(buktiPath, Buffer.from(bukti.data, "base64"));
    fs.writeFileSync(selfiePath, Buffer.from(session.selfie.data, "base64"));

    const kontak = loadJSON(KONTAK_PATH);
    izinData[session.tanggal] = izinData[session.tanggal] || {};
    izinData[session.tanggal][session.userId] = {
      alasan: session.alasan,
      nama: kontak[session.userId] || session.userId,
      bukti: buktiPath,
      selfie: selfiePath,
      lokasi: session.lokasi,
      terverifikasiWajah: true,
    };
    await saveIzin(izinData);
    permissionSessions.delete(token);

    const kelasSiswa = findKelasSiswa(loadKelas(), session.userId);
    const caption =
      `📩 *Pengajuan Izin Siswa*\n` +
      `👤 Nama: *${kontak[session.userId] || session.userId}*\n` +
      `🏫 Kelas: ${kelasSiswa?.namaKelas || "-"}\n` +
      `📅 Tanggal: ${session.tanggal}\n` +
      `📌 Alasan: ${session.alasan}\n` +
      `✅ Wajah terverifikasi dan lokasi tercatat`;
    const mediaMsg = new MessageMedia(bukti.mimetype, bukti.data, "bukti-izin.jpg");
    const penerima = getStudentNotificationRecipients(
      session.userId,
      kelasSiswa
    );
    for (const id of penerima) {
      antreNotifikasi(
        () => kirimMediaAman(id, mediaMsg, caption),
        `izin web ${session.userId} -> ${id}`
      );
    }
    await kirimPesanAman(
      session.userId,
      `✅ Izin hari ini berhasil dicatat.\nAlasan: ${session.alasan}`
    );
    res.json({ ok: true, tanggal: session.tanggal });
  } catch (error) {
    permissionSessions.delete(token);
    console.error(`[Bukti Izin ERROR] ${session.userId}:`, error.message);
    res.status(400).json({ error: error.message || "Bukti izin gagal disimpan." });
  }
});

app.get("/api/attendance-camera/:token", (req, res) => {
  const session = getCameraSession(req.params.token);
  if (!session || session.processing) {
    return res.status(410).json({ error: "Tautan absensi sudah tidak berlaku." });
  }

  const kontak = loadJSON(KONTAK_PATH);
  res.json({
    tipe: session.tipe,
    nama: kontak[session.userId] || "Siswa",
    expiresAt: session.expiresAt,
  });
});

app.post("/api/attendance-camera/:token", async (req, res) => {
  const token = req.params.token;
  const session = getCameraSession(token);
  if (!session || session.processing) {
    return res.status(410).json({ error: "Tautan absensi sudah tidak berlaku." });
  }

  const latitude = Number(req.body.latitude);
  const longitude = Number(req.body.longitude);
  const accuracy = Number(req.body.accuracy);
  const foto = parseImageDataUrl(req.body.image);
  if (!foto) {
    return res.status(400).json({ error: "Hasil foto kamera tidak valid." });
  }
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({ error: "Lokasi GPS tidak valid." });
  }
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 100) {
    return res.status(400).json({
      error: "Akurasi GPS harus 100 meter atau lebih baik. Coba di area terbuka.",
    });
  }

  session.processing = true;
  cameraSessions.delete(token);
  try {
    const queued = antreVerifikasiWajah(session.userId, foto.data);
    const cocok = await queued.promise;
    if (!cocok) {
      throw new Error(
        "Wajah tidak dikenali. Kirim perintah absensi lagi untuk mengambil selfie baru."
      );
    }

    const result = await catatAbsensiKamera(
      session.userId,
      session.tipe,
      { latitude, longitude, accuracy },
      foto
    );
    await kirimPesanAman(
      session.userId,
      `✅ Absen ${session.tipe} dicatat (${result.status}) pada ${result.waktu}.`
    );
    res.json({ ok: true, tipe: session.tipe, ...result });
  } catch (error) {
    console.error(`[Kamera Absensi ERROR] ${session.userId}:`, error.message);
    res.status(400).json({ error: error.message || "Absensi gagal diproses." });
  }
});

app.post("/api/auth/request-otp", async (req, res) => {
  const nomor = normalizeNomor(req.body.nomor);
  const id = `${nomor}@c.us`;
  const role = loadRoles()[id];
  if (!/^(admin|wali_kelas)$/.test(role || "")) {
    return res.status(403).json({ error: "Nomor tidak memiliki akses dashboard." });
  }
  if (!isReady) {
    return res.status(503).json({ error: "Bot WhatsApp belum terhubung." });
  }

  const existing = loginOtps.get(id);
  if (existing && existing.sentAt + 60_000 > Date.now()) {
    return res.status(429).json({ error: "Tunggu satu menit sebelum meminta OTP baru." });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  loginOtps.set(id, {
    hash: crypto.createHash("sha256").update(code).digest("hex"),
    expiresAt: Date.now() + 5 * 60_000,
    sentAt: Date.now(),
    attempts: 0,
  });
  try {
    await client.sendMessage(
      id,
      `🔐 *Kode Login Ruang Hadir*\n\nKode OTP: *${code}*\nBerlaku selama 5 menit. Jangan berikan kode ini kepada siapa pun.`
    );
    res.json({ ok: true });
  } catch (error) {
    loginOtps.delete(id);
    res.status(500).json({ error: "Gagal mengirim OTP ke WhatsApp." });
  }
});

app.post("/api/auth/verify", async (req, res) => {
  const nomor = normalizeNomor(req.body.nomor);
  const id = `${nomor}@c.us`;
  const otp = loginOtps.get(id);
  const codeHash = crypto
    .createHash("sha256")
    .update(String(req.body.code || ""))
    .digest("hex");
  if (!otp || otp.expiresAt < Date.now()) {
    loginOtps.delete(id);
    return res.status(400).json({ error: "Kode OTP sudah kedaluwarsa." });
  }
  otp.attempts++;
  if (otp.attempts > 5 || otp.hash !== codeHash) {
    if (otp.attempts > 5) loginOtps.delete(id);
    return res.status(400).json({ error: "Kode OTP tidak sesuai." });
  }

  const role = loadRoles()[id];
  if (!/^(admin|wali_kelas)$/.test(role || "")) {
    return res.status(403).json({ error: "Akses dashboard sudah dicabut." });
  }
  loginOtps.delete(id);
  const token = crypto.randomBytes(32).toString("hex");
  const nama = await resolveDashboardUserName(id, role);
  webSessions.set(token, { id, nomor, nama, role, expiresAt: Date.now() + 8 * 60 * 60_000 });
  res.setHeader(
    "Set-Cookie",
    `absensi_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
  );
  res.json({ ok: true, user: { nomor, nama, role } });
});

app.get("/api/auth/me", (req, res) => {
  const user = webUser(req);
  if (!user) return res.status(401).json({ error: "Belum login." });
  res.json({ nomor: user.nomor, nama: dashboardUserName(user.id, user.role), role: user.role });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req).absensi_session;
  if (token) webSessions.delete(token);
  res.setHeader("Set-Cookie", "absensi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.use("/api", requireWebAuth);

function dashboardData(user) {
  const kontak = loadJSON(KONTAK_PATH);
  const semuaKelas = loadKelas();
  const kelas =
    user.role === "admin" ? semuaKelas : kelasUntukWali(semuaKelas, user.id);
  const roles = loadRoles();
  const jam = loadJSON(JAM_PATH, {
    masuk: "07:00:00",
    pulang: "14:00:00",
    toleransi: 0,
    mulaiMasuk: "00:00:00",
    selesaiMasuk: "23:59:59",
    mulaiPulang: "00:00:00",
    selesaiPulang: "23:59:59",
  });
  const izin = loadIzin();
  const storage = loadJSON(STORAGE_PATH);
  const today = getWaktu().tanggal;
  const absensiHariIni = storage[today] || {};
  const izinHariIni = izin[today] || {};

  const siswaIds = new Set(
    Object.values(kelas).flatMap((data) => Object.keys(data.siswa || {}))
  );
  const siswa = Object.entries(kontak)
    .filter(([id]) => user.role === "admin" || siswaIds.has(id))
    .map(([id, nama]) => {
    const relasi = findKelasSiswa(kelas, id);
    return {
      id,
      nomor: id.replace("@c.us", ""),
      nama,
      kelas: relasi?.namaKelas || "",
      orangTua: relasi?.siswa[id]?.orangTua?.replace("@c.us", "") || "",
      punyaFoto: fs.existsSync(`${FACE_REC}/${id.replace("@c.us", "")}.jpg`),
      masuk: absensiHariIni[id]?.masuk || null,
      pulang: absensiHariIni[id]?.pulang || null,
      izin: izinHariIni[id] || null,
    };
  });

  return {
    tanggal: today,
    botReady: isReady,
    jam,
    siswa,
    kelas: Object.entries(kelas).map(([nama, data]) => ({
      nama,
      waliKelas: data.waliKelas?.replace("@c.us", "") || "",
      namaWali: data.namaWali || "",
      jumlahSiswa: Object.keys(data.siswa || {}).length,
    })),
    admins: user.role === "admin" ? Object.entries(roles)
      .filter(([, role]) => role === "admin")
      .map(([id]) => id.replace("@c.us", "")) : [],
    currentUser: {
      nomor: user.nomor,
      nama: dashboardUserName(user.id, user.role),
      role: user.role,
    },
    faceService: { ready: true, ...facePool.status() },
  };
}

app.get("/api/dashboard", (req, res) => {
  res.json(dashboardData(req.webUser));
});

app.post("/api/admins", requireWebAdmin, async (req, res) => {
  const nomor = normalizeNomor(req.body.nomor);
  const nama = toTitleCase(String(req.body.nama || "").trim());
  if (!/^62\d{8,14}$/.test(nomor)) {
    return res.status(400).json({ error: "Nomor WhatsApp admin belum valid." });
  }
  if (nama.length < 3) {
    return res.status(400).json({ error: "Nama admin minimal 3 karakter." });
  }

  const id = `${nomor}@c.us`;
  const roles = loadRoles();
  if (roles[id] === "admin") {
    return res.status(409).json({ error: "Nomor tersebut sudah menjadi admin." });
  }

  roles[id] = "admin";
  await saveJSON(ROLE_PATH, roles);
  await saveDashboardUserName(id, nama);
  res.status(201).json({ ok: true, nomor, nama, role: "admin" });
});

app.delete("/api/admins/:number", requireWebAdmin, async (req, res) => {
  const nomor = normalizeNomor(req.params.number);
  if (!/^62\d{8,14}$/.test(nomor)) {
    return res.status(400).json({ error: "Nomor WhatsApp admin belum valid." });
  }

  const id = `${nomor}@c.us`;
  if (id === req.webUser.id) {
    return res.status(400).json({ error: "Anda tidak dapat menghapus akun admin sendiri." });
  }

  const roles = loadRoles();
  if (roles[id] !== "admin") {
    return res.status(404).json({ error: "Admin tidak ditemukan." });
  }

  delete roles[id];
  loginOtps.delete(id);
  await saveJSON(ROLE_PATH, roles);
  res.json({ ok: true, nomor });
});

app.post("/api/classes", requireWebAdmin, async (req, res) => {
  const nama = String(req.body.nama || "").trim().toUpperCase();
  const waliKelas = normalizeNomor(req.body.waliKelas);
  const namaWali = toTitleCase(String(req.body.namaWali || "").trim());
  if (!nama || !/^62\d{8,14}$/.test(waliKelas) || !namaWali) {
    return res.status(400).json({ error: "Data kelas dan wali kelas belum valid." });
  }

  const kelas = loadKelas();
  const roles = loadRoles();
  const waliSebelumnya = kelas[nama]?.waliKelas;
  kelas[nama] = kelas[nama] || { siswa: {} };
  kelas[nama].waliKelas = `${waliKelas}@c.us`;
  kelas[nama].namaWali = namaWali;
  const waliId = `${waliKelas}@c.us`;
  if (roles[waliId] !== "admin") roles[waliId] = "wali_kelas";
  await saveDashboardUserName(waliId, namaWali);
  removeUnusedWaliRole(waliSebelumnya, kelas, roles);
  await saveKelas(kelas);
  await saveJSON(ROLE_PATH, roles);
  res.json({ ok: true });
});

app.delete("/api/classes/:name", requireWebAdmin, async (req, res) => {
  const nama = String(req.params.name || "").toUpperCase();
  const kelas = loadKelas();
  if (!kelas[nama]) return res.status(404).json({ error: "Kelas tidak ditemukan." });
  if (Object.keys(kelas[nama].siswa || {}).length) {
    return res.status(400).json({ error: "Pindahkan siswa sebelum menghapus kelas." });
  }
  const waliKelas = kelas[nama].waliKelas;
  delete kelas[nama];
  const roles = loadRoles();
  removeUnusedWaliRole(waliKelas, kelas, roles);
  await saveKelas(kelas);
  await saveJSON(ROLE_PATH, roles);
  res.json({ ok: true });
});

app.post("/api/students", requireWebAdmin, async (req, res) => {
  const nomor = normalizeNomor(req.body.nomor);
  const nama = toTitleCase(String(req.body.nama || "").trim());
  const namaKelas = String(req.body.kelas || "").trim().toUpperCase();
  const orangTua = normalizeNomor(req.body.orangTua);
  if (!/^62\d{8,14}$/.test(nomor) || nama.length < 3) {
    return res.status(400).json({ error: "Nomor atau nama siswa belum valid." });
  }

  const kontak = loadJSON(KONTAK_PATH);
  const kelas = loadKelas();
  const siswaId = `${nomor}@c.us`;
  if (namaKelas && !kelas[namaKelas]) {
    return res.status(400).json({ error: "Kelas belum tersedia." });
  }
  if (namaKelas && !/^62\d{8,14}$/.test(orangTua)) {
    return res.status(400).json({ error: "Nomor orang tua belum valid." });
  }

  kontak[siswaId] = nama;
  for (const data of Object.values(kelas)) {
    if (data.siswa) delete data.siswa[siswaId];
  }
  if (namaKelas) {
    kelas[namaKelas].siswa = kelas[namaKelas].siswa || {};
    kelas[namaKelas].siswa[siswaId] = {
      nama,
      orangTua: `${orangTua}@c.us`,
    };
  }
  await saveJSON(KONTAK_PATH, kontak);
  await saveKelas(kelas);
  res.json({ ok: true });
});

app.delete("/api/students/:number", requireWebAdmin, async (req, res) => {
  const nomor = normalizeNomor(req.params.number);
  const siswaId = `${nomor}@c.us`;
  const kontak = loadJSON(KONTAK_PATH);
  const kelas = loadKelas();
  if (!kontak[siswaId]) return res.status(404).json({ error: "Siswa tidak ditemukan." });

  delete kontak[siswaId];
  for (const data of Object.values(kelas)) {
    if (data.siswa) delete data.siswa[siswaId];
  }
  await saveJSON(KONTAK_PATH, kontak);
  await saveKelas(kelas);
  res.json({ ok: true });
});

app.post(
  "/api/students/:number/photo",
  requireWebPhotoManager,
  upload.single("photo"),
  (req, res) => {
  const nomor = normalizeNomor(req.params.number);
  const siswaId = `${nomor}@c.us`;
  if (!loadJSON(KONTAK_PATH)[siswaId]) {
    return res.status(404).json({ error: "Siswa tidak ditemukan." });
  }
  if (!req.file || !req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "Pilih file foto yang valid." });
  }
  ensureDir(FACE_DB);
  ensureDir(FACE_REC);
  fs.writeFileSync(`${FACE_DB}/${nomor}.jpg`, req.file.buffer);
  fs.writeFileSync(`${FACE_REC}/${nomor}.jpg`, req.file.buffer);
    res.json({ ok: true });
  }
);

app.post("/api/settings/time", requireWebAdmin, async (req, res) => {
  const masuk = String(req.body.masuk || "");
  const pulang = String(req.body.pulang || "");
  const toleransi = Number(req.body.toleransi);
  const mulaiMasuk = String(req.body.mulaiMasuk || "");
  const selesaiMasuk = String(req.body.selesaiMasuk || "");
  const mulaiPulang = String(req.body.mulaiPulang || "");
  const selesaiPulang = String(req.body.selesaiPulang || "");
  if (
    !isValidTime(masuk) ||
    !isValidTime(pulang) ||
    !Number.isInteger(toleransi) ||
    toleransi < 0 ||
    toleransi > 180 ||
    !isValidTime(mulaiMasuk) ||
    !isValidTime(selesaiMasuk) ||
    !isValidTime(mulaiPulang) ||
    !isValidTime(selesaiPulang) ||
    mulaiMasuk >= selesaiMasuk ||
    mulaiPulang >= selesaiPulang
  ) {
    return res.status(400).json({
      error: "Jam harus berformat HH:MM, jam selesai harus setelah jam mulai, dan toleransi harus 0-180 menit.",
    });
  }
  await saveJSON(JAM_PATH, {
    masuk: `${masuk}:00`,
    pulang: `${pulang}:00`,
    toleransi,
    mulaiMasuk: `${mulaiMasuk}:00`,
    selesaiMasuk: `${selesaiMasuk}:00`,
    mulaiPulang: `${mulaiPulang}:00`,
    selesaiPulang: `${selesaiPulang}:00`,
  });
  res.json({ ok: true });
});

app.post("/api/permissions", requireWebAdmin, async (req, res) => {
  const nomor = normalizeNomor(req.body.nomor);
  const tanggal = String(req.body.tanggal || "");
  const alasan = String(req.body.alasan || "").trim();
  const siswaId = `${nomor}@c.us`;
  const kontak = loadJSON(KONTAK_PATH);
  if (!kontak[siswaId] || !isValidDate(tanggal) || alasan.length < 3) {
    return res.status(400).json({ error: "Data izin belum lengkap atau tidak valid." });
  }
  const izin = loadIzin();
  const permissionError = validatePermission(
    getDailyStudentStatus(loadJSON(STORAGE_PATH), izin, tanggal, siswaId)
  );
  if (permissionError) {
    return res.status(409).json({ error: permissionError });
  }
  izin[tanggal] = izin[tanggal] || {};
  izin[tanggal][siswaId] = { nama: kontak[siswaId], alasan };
  await saveIzin(izin);

  const kelasSiswa = findKelasSiswa(loadKelas(), siswaId);
  if (kelasSiswa) {
    const pesan =
      `📩 *Izin Siswa*\n` +
      `👤 Nama: *${kontak[siswaId]}*\n` +
      `🏫 Kelas: ${kelasSiswa.namaKelas}\n` +
      `📅 Tanggal: ${tanggal}\n` +
      `📌 Alasan: ${alasan}`;
    await kirimPesanAman(kelasSiswa.siswa[siswaId].orangTua, pesan);
    await kirimPesanAman(kelasSiswa.waliKelas, pesan);
  }
  res.json({ ok: true });
});

app.delete("/api/permissions/:date/:number", requireWebAdmin, async (req, res) => {
  const izin = loadIzin();
  const siswaId = `${normalizeNomor(req.params.number)}@c.us`;
  if (izin[req.params.date]) delete izin[req.params.date][siswaId];
  await saveIzin(izin);
  res.json({ ok: true });
});

app.get("/api/permissions/:date/:number/evidence", (req, res) => {
  const siswaId = `${normalizeNomor(req.params.number)}@c.us`;
  if (
    req.webUser.role === "wali_kelas" &&
    !findKelasSiswa(kelasUntukWali(loadKelas(), req.webUser.id), siswaId)
  ) {
    return res.status(403).json({ error: "Siswa bukan anggota kelas kamu." });
  }
  const bukti = loadIzin()[req.params.date]?.[siswaId]?.bukti;
  if (!bukti || !fs.existsSync(bukti)) {
    return res.status(404).json({ error: "Foto bukti tidak ditemukan." });
  }
  res.sendFile(require("path").resolve(bukti));
});

app.get("/api/report", (req, res) => {
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
    ? req.query.date
    : getWaktu().tanggal;
  const kontak = loadJSON(KONTAK_PATH);
  const storage = loadJSON(STORAGE_PATH)[tanggal] || {};
  const izin = loadIzin()[tanggal] || {};
  const kelas = loadKelas();
  const kelasWali = kelasUntukWali(kelas, req.webUser.id);
  const rows = Object.entries(kontak)
    .filter(
      ([id]) =>
        req.webUser.role === "admin" || Boolean(findKelasSiswa(kelasWali, id))
    )
    .map(([id, nama]) => ({
    nomor: id.replace("@c.us", ""),
    nama,
    kelas: findKelasSiswa(kelas, id)?.namaKelas || "-",
    masuk: storage[id]?.masuk?.waktu || "-",
    statusMasuk: storage[id]?.masuk?.status || "-",
    pulang: storage[id]?.pulang?.waktu || "-",
    statusPulang: storage[id]?.pulang?.status || "-",
    izin: izin[id]?.alasan || "",
    buktiIzin: Boolean(izin[id]?.bukti),
  }));
  res.json({ tanggal, rows });
});

app.get("/api/export", (req, res) => {
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
    ? req.query.date
    : getWaktu().tanggal;
  const kontak = loadJSON(KONTAK_PATH);
  const storage = loadJSON(STORAGE_PATH)[tanggal] || {};
  const izin = loadIzin()[tanggal] || {};
  const kelas = loadKelas();
  const kelasWali = kelasUntukWali(kelas, req.webUser.id);
  const rows = Object.entries(kontak)
    .filter(
      ([id]) =>
        req.webUser.role === "admin" || Boolean(findKelasSiswa(kelasWali, id))
    )
    .map(([id, nama]) => ({
    Tanggal: tanggal,
    Nama: nama,
    Kelas: findKelasSiswa(kelas, id)?.namaKelas || "",
    Masuk: storage[id]?.masuk?.waktu || (izin[id] ? "IZIN" : ""),
    StatusMasuk: storage[id]?.masuk?.status || izin[id]?.alasan || "",
    Pulang: storage[id]?.pulang?.waktu || "",
    StatusPulang: storage[id]?.pulang?.status || "",
  }));
  const filePath = exportExcel(rows, tanggal);
  res.download(filePath);
});

app.get("/qr", (req, res) => {
  if (isReady) {
    return res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;text-align:center;">
          <div>
            <h2>✅ Bot sudah terhubung ke WhatsApp.</h2>
          </div>
        </body>
      </html>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;text-align:center;">
          <div>
            <h2>⏳ Menunggu QR Code...</h2>
          </div>
        </body>
      </html>
    `);
  }

  const qrSvg = qrToSvg(qrCodeData);
  res.send(`
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>QR Login Bot</title>
      <style>
        body {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-family: sans-serif;
          text-align: center;
          margin: 0;
        }
        img {
          max-width: 90vw;
          height: auto;
        }
        h2, p {
          margin: 10px 0;
        }
      </style>
    </head>
    <body>
      <div>
        <h2>🔐 Scan QR WhatsApp:</h2>
        ${qrSvg}
        <p>QR akan otomatis hilang setelah login.</p>
      </div>
    </body>
  </html>
`);
});

app.listen(PORT, () => {
  console.log(`🌐 Akses QR di: http://localhost:${PORT}/qr`);
  if (!process.env.PUBLIC_BASE_URL) {
    console.warn(
      "⚠️ PUBLIC_BASE_URL belum diatur. Tautan kamera hanya akan memakai localhost dan tidak dapat dibuka dari ponsel lain."
    );
  } else if (!publicBaseUrl().startsWith("https://")) {
    console.warn(
      "⚠️ PUBLIC_BASE_URL sebaiknya memakai HTTPS agar kamera dan GPS diizinkan browser ponsel."
    );
  }
});

async function startBot() {
  try {
    jsonCache = await initJsonStore(JSON_STORES);
    await ensureDefaultRoles();
    console.log(`Database Sequelize siap: ${DB_PATH}`);
    client.initialize();
  } catch (error) {
    console.error("Gagal inisialisasi database:", error);
    process.exit(1);
  }
}

startBot();
