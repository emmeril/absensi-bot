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
  verifyFace,
  faceServiceStatus,
} = require("./services/face-verification");
const app = express();
const PORT = 3200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const loginOtps = new Map();
const webSessions = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const STORAGE_PATH = "./storage.json";
const KONTAK_PATH = "./kontak.json";
const ROLE_PATH = "./roles.json";
const LOKASI_PATH = "./lokasi.json";
const JAM_PATH = "./jam.json";
const EXPORTS_DIR = "./exports";
const REQUESTS_PATH = "./pending_requests.json";
const PENDING_FOTO_PATH = "./pending_selfie.json";
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
    fallback: { masuk: "09:00:00", pulang: "16:00:00" },
  },
  [REQUESTS_PATH]: { path: REQUESTS_PATH, fallback: [] },
  [PENDING_FOTO_PATH]: { path: PENDING_FOTO_PATH, fallback: {} },
  [IZIN_PATH]: { path: IZIN_PATH, fallback: {} },
  [KELAS_PATH]: { path: KELAS_PATH, fallback: {} },
  [USER_NAMES_PATH]: { path: USER_NAMES_PATH, fallback: {} },
};

let jsonCache = {};

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

function clearPendingAbsen(sender) {
  if (pendingAbsen[sender]?.timeout) clearTimeout(pendingAbsen[sender].timeout);
  delete pendingAbsen[sender];
}

function clearPendingIzin(sender) {
  if (pendingIzin[sender]?.timeout) clearTimeout(pendingIzin[sender].timeout);
  delete pendingIzin[sender];
}

function loadRequests() {
  return loadJSON(REQUESTS_PATH, []);
}
async function saveRequests(list) {
  await saveJSON(REQUESTS_PATH, list);
}

function hitungTelat(waktuMasuk, jamResmi = "09:00:00") {
  const masuk = moment(waktuMasuk, "HH:mm:ss");
  const resmi = moment(jamResmi, "HH:mm:ss");
  const selisih = masuk.diff(resmi, "minutes");
  return selisih > 0 ? selisih : 0;
}

function loadPendingFoto() {
  return loadJSON(PENDING_FOTO_PATH, {});
}
async function savePendingFoto(data) {
  await saveJSON(PENDING_FOTO_PATH, data);
}

let pendingFoto = {};

async function verifikasiWajah(userId, fotoBase64) {
  try {
    const result = await verifyFace(userId.replace("@c.us", ""), fotoBase64);
    return result.match === true;
  } catch (e) {
    console.error("[FaceVerify ERROR]", e.message);
    return false;
  }
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

function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadMediaLangsung(msg) {
  const mediaData = msg._data || {};
  if (!mediaData.directPath || !mediaData.mediaKey) return null;

  const result = await client.pupPage.evaluate(async (data) => {
    const mockQpl = {
      addAnnotations() {
        return this;
      },
      addPoint() {
        return this;
      },
    };
    const decryptedMedia = await window
      .require("WAWebDownloadManager")
      .downloadManager.downloadAndMaybeDecrypt({
        directPath: data.directPath,
        encFilehash: data.encFilehash,
        filehash: data.filehash,
        mediaKey: data.mediaKey,
        mediaKeyTimestamp: data.mediaKeyTimestamp,
        type: data.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });

    return window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
  }, {
    directPath: mediaData.directPath,
    encFilehash: mediaData.encFilehash,
    filehash: mediaData.filehash,
    mediaKey: mediaData.mediaKey,
    mediaKeyTimestamp: mediaData.mediaKeyTimestamp,
    type: mediaData.type || msg.type,
  });

  if (!result) return null;
  return new MessageMedia(
    mediaData.mimetype || "image/jpeg",
    result,
    mediaData.filename,
    mediaData.size
  );
}

async function downloadMediaDenganRetry(msg, maxAttempts = 4) {
  let currentMessage = msg;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const media = await currentMessage.downloadMedia();
      if (media?.data) return media;
      lastError = new Error("WhatsApp belum menyediakan data media");
    } catch (error) {
      lastError = error;
    }

    try {
      const media = await downloadMediaLangsung(currentMessage);
      if (media?.data) {
        console.log("[Media Fallback] Unduh langsung berhasil");
        return media;
      }
    } catch (fallbackError) {
      console.warn(`[Media Fallback ERROR] ${fallbackError.message}`);
      lastError = fallbackError;
    }

    console.warn(
      `[Media Retry] ${msg.id?._serialized || "unknown"} percobaan ${attempt}/${maxAttempts}: ${lastError.message}`
    );

    if (attempt < maxAttempts) {
      await tunggu(attempt * 1000);
      try {
        const reloaded = await msg.reload();
        currentMessage = reloaded || msg;
      } catch (reloadError) {
        console.warn(`[Media Reload ERROR] ${reloadError.message}`);
        currentMessage = msg;
      }
    }
  }

  throw lastError;
}

async function downloadMediaAman(msg, context) {
  try {
    return await downloadMediaDenganRetry(msg);
  } catch (error) {
    console.error(`[Media ERROR] ${context}:`, error);
    return null;
  }
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

const pendingAbsen = {};
const pendingIzin = {};
const pendingKontak = {};
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
  const lokasiKantor = loadJSON(LOKASI_PATH, {
    latitude: -6.7329,
    longitude: 108.5522,
  });
  const jamResmi = loadJSON(JAM_PATH, {
    masuk: "09:00:00",
    pulang: "16:00:00",
  });
  const waktu = getWaktu();
  const role = roles[sender] || "user";

  if (!kontak[sender] && !["admin", "wali_kelas"].includes(role)) {
    return msg.reply(
      "❌ Nomor kamu belum terdaftar di absensi. Hubungi admin untuk didaftarkan."
    );
  }

  const commandDiizinkan =
    body === "!masuk" ||
    body === "!pulang" ||
    body === "!setfoto" ||
    body === "!setlokasi" ||
    body === "!izin" ||
    body.startsWith("!izin ");
  if (
    body.startsWith("!") &&
    !commandDiizinkan
  ) {
    return msg.reply(
      "🌐 Pengelolaan data sudah dipindahkan ke dashboard web.\n" +
        `Buka: http://localhost:${PORT}`
    );
  }

  // Hubungkan siswa terdaftar dengan kelas dan nomor WhatsApp orang tua.
  if (body.startsWith("!setsiswa")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const parts = msg.body.trim().split(/\s+/);
    const nomorSiswa = normalizeNomor(parts[1]);
    const namaKelas = (parts[2] || "").toUpperCase();
    const nomorOrangTua = normalizeNomor(parts[3]);
    const siswaId = `${nomorSiswa}@c.us`;

    if (
      !/^62\d{8,14}$/.test(nomorSiswa) ||
      !namaKelas ||
      !/^62\d{8,14}$/.test(nomorOrangTua)
    ) {
      return msg.reply(
        "⚠️ Format: *!setsiswa 628nomorsiswa 7A 628nomororangtua*"
      );
    }
    if (!kontak[siswaId]) {
      return msg.reply(
        `❌ Siswa ${nomorSiswa} belum terdaftar. Tambahkan dengan *!tambah kontak* terlebih dahulu.`
      );
    }

    const dataKelas = loadKelas();
    if (!dataKelas[namaKelas]?.waliKelas) {
      return msg.reply(
        `❌ Wali kelas *${namaKelas}* belum diatur. Atur wali kelas melalui dashboard web.`
      );
    }

    // Satu siswa hanya boleh terhubung dengan satu kelas.
    for (const data of Object.values(dataKelas)) {
      if (data.siswa) delete data.siswa[siswaId];
    }
    dataKelas[namaKelas].siswa = dataKelas[namaKelas].siswa || {};
    dataKelas[namaKelas].siswa[siswaId] = {
      nama: kontak[siswaId],
      orangTua: `${nomorOrangTua}@c.us`,
    };

    await saveKelas(dataKelas);
    return msg.reply(
      `✅ *${kontak[siswaId]}* dihubungkan ke kelas *${namaKelas}* dan orang tua ${nomorOrangTua}.`
    );
  }

  // Tambah kontak absensi oleh admin
  if (body.startsWith("!tambah kontak")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const parts = msg.body.trim().split(/\s+/);
    const nomor = normalizeNomor(parts[2]);
    const nama = toTitleCase(parts.slice(3).join(" ").trim());

    if (!nomor || !/^62\d{8,14}$/.test(nomor) || !nama || nama.length < 3) {
      return msg.reply(
        "⚠️ Format: *!tambah kontak 628xxxxx Nama Lengkap*"
      );
    }

    const id = `${nomor}@c.us`;
    kontak[id] = nama;
    await saveJSON(KONTAK_PATH, kontak);

    const requests = loadRequests().filter((r) => r.id !== id);
    await saveRequests(requests);

    return msg.reply(
      `✅ ${nama} (${nomor}) ditambahkan ke kontak absensi.\nMinta user kirim foto selfie dengan caption *!setfoto* sebelum absen pertama.`
    );
  }

  // Simpan foto referensi wajah untuk user yang sudah didaftarkan admin
  if (body.startsWith("!setfoto")) {
    if (!kontak[sender]) {
      return msg.reply(
        "❌ Nomor kamu belum terdaftar di absensi. Hubungi admin untuk didaftarkan."
      );
    }

    if (!msg.hasMedia || msg.type !== "image") {
      return msg.reply("⚠️ Kirim foto selfie dengan caption *!setfoto*.");
    }

    const media = await downloadMediaAman(msg, `setfoto ${sender}`);
    if (!media || !media.data) return msg.reply("❌ Gagal membaca foto.");

    const nomor = sender.replace("@c.us", "");
    ensureDir(FACE_DB);
    ensureDir(FACE_REC);
    fs.writeFileSync(
      `${FACE_DB}/${nomor}.jpg`,
      Buffer.from(media.data, "base64")
    );
    fs.writeFileSync(
      `${FACE_REC}/${nomor}.jpg`,
      Buffer.from(media.data, "base64")
    );

    return msg.reply("✅ Foto referensi wajah disimpan. Kamu sudah bisa absen.");
  }

  // Daftar kontak
  if (body.startsWith("!daftar") && msg.hasMedia && msg.type === "image") {
    if (role !== "admin") {
      return msg.reply("❌ Pendaftaran hanya bisa dilakukan oleh admin.");
    }

    if (kontak[sender]) return msg.reply("✅ Kamu sudah terdaftar.");

    const rawNama = body.slice(8).trim();
    const nama = toTitleCase(rawNama);
    if (!nama || nama.length < 3)
      return msg.reply(
        "⚠️ Format salah. Kirim *foto selfie* dengan caption: *!daftar Nama Lengkap*"
      );

    const requests = loadRequests();
    if (requests.find((r) => r.id === sender))
      return msg.reply(
        "📨 Permintaan kamu sudah dikirim. Tunggu admin menyetujui."
      );

    const media = await downloadMediaAman(msg, `daftar ${sender}`);
    if (!media || !media.data) return msg.reply("❌ Gagal membaca foto.");

    const nomor = sender.replace("@c.us", "");
    const filePath = `${FACE_DB}/${nomor}.jpg`;
    const recPath = `${FACE_REC}/${nomor}.jpg`;
    ensureDir(FACE_DB);
    ensureDir(FACE_REC);
    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

    if (!fs.existsSync(recPath)) {
      fs.writeFileSync(recPath, Buffer.from(media.data, "base64"));
    }

    requests.push({ id: sender, nama });
    await saveRequests(requests);

    msg.reply(
      "✅ Foto selfie dan nama diterima. Permintaan akses dikirim ke admin."
    );

    const userNomor = sender.replace("@c.us", "");
    const mediaMsg = new MessageMedia(
      media.mimetype,
      media.data,
      `${userNomor}.jpg`
    );

    const roles = loadRoles();
    for (const id in roles) {
      if (roles[id] === "admin") {
        await client.sendMessage(id, mediaMsg, {
          caption: `🔔 *Permintaan Akses Baru*\nNama: *${nama}*\nNomor: ${userNomor}\n\nKetik: !approve ${userNomor}`,
        });
      }
    }
  }

  if (body.startsWith("!daftar")) {
    return msg.reply(
      "❌ Pendaftaran hanya bisa dilakukan oleh admin. Minta admin memakai *!tambah kontak 628xxxxx Nama Lengkap*."
    );
  }

  if (msg.type === "image" && pendingFoto[sender]) {
    const media = await downloadMediaAman(msg, `pending-foto ${sender}`);
    if (!media || !media.data) return msg.reply("❌ Gagal membaca foto.");

    const nomor = sender.replace("@c.us", "");
    const filePath = `${FACE_DB}/${nomor}.jpg`;
    ensureDir(FACE_DB);
    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

    // Simpan ke pending_requests
    const requests = loadRequests();
    if (!requests.find((r) => r.id === sender)) {
      requests.push({ id: sender, nama: pendingFoto[sender].nama });
      await saveRequests(requests);
    }

    delete pendingFoto[sender];
    await savePendingFoto(pendingFoto);

    return msg.reply("✅ Foto selfie diterima. Permintaan kamu dikirim ke admin.");
  }

  if (body === "!lihat daftar") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const requests = loadRequests();
    if (requests.length === 0)
      return msg.reply("✅ Tidak ada permintaan baru.");

    let daftar = "📋 Pending Request:\n\n";
    requests.forEach((r, i) => {
      const no = r.id.replace("@c.us", "");
      daftar += `${i + 1}. ${r.nama} (${no})\n`;
    });

    msg.reply(daftar);
  }

  // Setujui permintaan
  if (body.startsWith("!approve")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const arg = body.split(" ")[1];
    if (!arg)
      return msg.reply("⚠️ Gunakan: *!approve 1* atau *!approve 628xxxxx*");

    const requests = loadRequests();
    let approved;

    if (/^\d+$/.test(arg)) {
      if (arg.length <= 2) {
        // Mode urutan pendek: !approve 1
        const index = parseInt(arg) - 1;
        if (isNaN(index) || index < 0 || index >= requests.length) {
          return msg.reply("⚠️ Nomor permintaan tidak valid.");
        }
        approved = requests.splice(index, 1)[0];
      } else {
        // Mode nomor HP (angka panjang)
        const index = requests.findIndex((r) => r.id.includes(arg));
        if (index === -1)
          return msg.reply(`❌ Tidak ada permintaan dari ${arg}`);
        approved = requests.splice(index, 1)[0];
      }
    } else {
      return msg.reply(
        "⚠️ Format salah. Gunakan *!approve 1* atau *!approve 628xxxxx*"
      );
    }

    kontak[approved.id] = approved.nama;
    await saveJSON(KONTAK_PATH, kontak);
    await saveRequests(requests);

    msg.reply(
      `✅ ${approved.nama} (${approved.id.replace(
        "@c.us",
        ""
      )}) ditambahkan ke kontak.`
    );
    // Kirim notifikasi ke user yang disetujui
    await client.sendMessage(
      approved.id,
      `✅ Pendaftaran kamu telah disetujui.\nSelamat bergabung, *${approved.nama}*!`
    );
  }

  // Lihat daftar kontak
  if (body === "!kontak list") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const entries = Object.entries(kontak);
    if (!entries.length) return msg.reply("📭 Kontak masih kosong.");

    let teks = "📋 *Daftar Kontak Terdaftar:*\n\n";
    let no = 1;
    for (const [id, nama] of entries) {
      const nomor = id.replace("@c.us", "");
      teks += `${no++}. ${nama} - ${nomor}\n`;
    }
    msg.reply(teks);
  }

  // Hapus kontak berdasarkan nomor
  if (body.startsWith("!hapus kontak")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const nomor = body.split(" ")[2];
    if (!nomor || !/^\d{9,}$/.test(nomor)) {
      return msg.reply("⚠️ Format salah. Gunakan: *!hapus kontak 628xxxxx*");
    }

    const id = `${nomor}@c.us`;
    if (!kontak[id]) return msg.reply(`❌ Kontak ${nomor} tidak ditemukan.`);

    const nama = kontak[id];
    delete kontak[id];
    await saveJSON(KONTAK_PATH, kontak);

    msg.reply(`🗑️ Kontak *${nama}* (${nomor}) berhasil dihapus.`);
  }

  // Set lokasi
  if (body === "!setlokasi") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    pendingLokasi[sender] = true;
    return msg.reply("📍 Kirim lokasi sekarang.");
  }
  if (msg.type === "location" && pendingLokasi[sender]) {
    await saveJSON(LOKASI_PATH, {
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
    delete pendingLokasi[sender];
    return msg.reply("✅ Lokasi sekolah disimpan.");
  }

  // Set jam kerja
  if (body.startsWith("!setjam")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const [, jenis, jam] = msg.body.split(" ");
    if (!["masuk", "pulang"].includes(jenis) || !/^\d{2}:\d{2}$/.test(jam)) {
      return msg.reply(
        "⚠️ Format: !setjam masuk 08:00 atau !setjam pulang 17:00"
      );
    }
    jamResmi[jenis] = jam + ":00";
    await saveJSON(JAM_PATH, jamResmi);
    return msg.reply(`✅ Jam ${jenis} diatur ke ${jam}`);
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

    if (!fs.existsSync(`${FACE_REC}/${nomor}.jpg`)) {
      return msg.reply(
        "⚠️ Foto referensi wajah belum ada. Kirim foto selfie dengan caption *!setfoto* dulu."
      );
    }

    clearPendingIzin(sender);
    clearPendingAbsen(sender);
    pendingAbsen[sender] = {
      tipe,
      foto: null,
      lokasi: null,
      timeout: setTimeout(() => delete pendingAbsen[sender], 2 * 60 * 1000),
    };

    return msg.reply(
      `📸 Kirim foto selfie untuk absen *${tipe}* dalam waktu 2 menit.`
    );
  }

  if (msg.hasMedia && pendingAbsen[sender]) {
    await msg.reply("⏳ Foto diterima, sedang memverifikasi wajah...");

    try {
      const prosesAbsen = pendingAbsen[sender];
      const media = await downloadMediaDenganRetry(msg);
      if (!media?.data || !media.mimetype?.startsWith("image/")) {
        return msg.reply("❌ File yang diterima bukan foto yang valid.");
      }

      const cocok = await verifikasiWajah(sender, media.data);
      if (pendingAbsen[sender] !== prosesAbsen) {
        return msg.reply(
          "⌛ Waktu pengiriman foto sudah habis. Silakan kirim *!masuk* atau *!pulang* lagi."
        );
      }
      if (!cocok) {
        clearPendingAbsen(sender);
        return msg.reply(
          "❌ Wajah tidak dikenali atau layanan verifikasi sedang bermasalah. Silakan kirim *!masuk* atau *!pulang* lalu coba selfie lagi."
        );
      }

      prosesAbsen.foto = media;

      if (!prosesAbsen.lokasi) {
        return msg.reply(
          "✅ Foto dikenali.\n📍 Sekarang kirim lokasi untuk absen."
        );
      }

      return msg.reply(
        "✅ Foto dan lokasi sudah lengkap. Kamu bisa kirim perintah absen."
      );
    } catch (error) {
      console.error(`[Selfie ERROR] ${sender}:`, error);
      clearPendingAbsen(sender);
      return msg.reply(
        "❌ Foto gagal diproses oleh bot. Silakan kirim *!masuk* atau *!pulang* lalu coba lagi."
      );
    }
  }

  if (msg.type === "location" && pendingAbsen[sender]) {
    if (!pendingAbsen[sender].foto) {
      return msg.reply("📸 Kirim dan verifikasi foto selfie terlebih dahulu.");
    }

    const lokasi = {
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    };
    const absen = pendingAbsen[sender];
    absen.lokasi = lokasi;
    clearTimeout(absen.timeout);

    const jarak = haversine(lokasi, lokasiKantor);
    if (jarak > 100) {
      clearPendingAbsen(sender);
      return msg.reply("❌ Kamu berada di luar area sekolah.");
    }

    const tipe = absen.tipe;
    const izinData = loadIzin();
    if (izinData[waktu.tanggal] && izinData[waktu.tanggal][sender]) {
      clearPendingAbsen(sender);
      return msg.reply("❌ Kamu sudah mengajukan izin hari ini.");
    }

    const dataHariIni = (storage[waktu.tanggal] = storage[waktu.tanggal] || {});
    const userLog = (dataHariIni[sender] = dataHariIni[sender] || {});

    if (userLog[tipe]) {
      clearPendingAbsen(sender);
      return msg.reply(`✅ Sudah absen ${tipe}.`);
    }

    const jamMasuk = normalizeJam(jamResmi.masuk);
    const jamPulang = normalizeJam(jamResmi.pulang);

    const status =
      tipe === "masuk"
        ? waktu.jam <= jamMasuk
          ? "Tepat Waktu"
          : "Terlambat"
        : waktu.jam >= jamPulang
        ? "Sesuai Waktu"
        : "Pulang Cepat";

    userLog[tipe] = {
      waktu: waktu.jam,
      lokasi,
      status,
      foto: absen.foto,
      nama: kontak[sender],
    };

    await saveJSON(STORAGE_PATH, storage);
    clearPendingAbsen(sender);

    msg.reply(`✅ Absen ${tipe} dicatat (${status})`);

    const mediaMsg = new MessageMedia(
      absen.foto.mimetype,
      absen.foto.data,
      `${sender.replace("@c.us", "")}.jpg`
    );

    const roles = loadRoles();
    for (const id in roles) {
      if (roles[id] === "admin") {
        try {
          await client.sendMessage(id, mediaMsg, {
            caption: `🕘 *${kontak[sender] || sender}* telah absen *${tipe}*\nStatus: *${status}*\nJam: ${waktu.jam}`,
          });
        } catch (error) {
          console.error(`[Notifikasi Admin ERROR] ${id}:`, error.message);
        }
      }
    }

    const kelasSiswa = findKelasSiswa(loadKelas(), sender);
    if (kelasSiswa) {
      const infoSiswa = kelasSiswa.siswa[sender];
      const notifikasi =
        `🔔 *Notifikasi Absensi Siswa*\n` +
        `👤 Nama: *${kontak[sender] || sender}*\n` +
        `🏫 Kelas: ${kelasSiswa.namaKelas}\n` +
        `🕘 Absen: ${toTitleCase(tipe)}\n` +
        `⏰ Jam: ${waktu.jam}\n` +
        `📌 Status: *${status}*`;

      await kirimPesanAman(infoSiswa.orangTua, notifikasi);
      if (kelasSiswa.waliKelas !== sender) {
        await kirimPesanAman(kelasSiswa.waliKelas, notifikasi);
      }
    }
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
    if (loadIzin()[waktu.tanggal]?.[sender]) {
      return msg.reply("⚠️ Kamu sudah mengajukan izin hari ini.");
    }

    clearPendingAbsen(sender);
    clearPendingIzin(sender);
    pendingIzin[sender] = {
      alasan,
      tanggal: waktu.tanggal,
      timeout: setTimeout(() => clearPendingIzin(sender), 2 * 60 * 1000),
    };

    const instruksiSakit = alasan.toLowerCase().includes("sakit")
      ? "\n🤒 Karena izin sakit, pastikan wajah kamu dan surat/bukti sakit terlihat bersama dalam foto."
      : "";
    return msg.reply(
      `📷 Kirim *foto bukti izin* dalam waktu 2 menit.${instruksiSakit}\n\nIzin baru dicatat setelah foto diterima.`
    );
  }

  if (msg.hasMedia && pendingIzin[sender]) {
    const pengajuan = pendingIzin[sender];
    const media = await downloadMediaAman(msg, `izin ${sender}`);
    if (!media?.data || !media.mimetype?.startsWith("image/")) {
      return msg.reply("❌ Bukti izin harus berupa foto.");
    }

    if (pendingIzin[sender] !== pengajuan) {
      return msg.reply(
        "⌛ Waktu pengajuan izin sudah habis. Silakan kirim perintah *!izin alasan* lagi."
      );
    }
    const izinSakit = pengajuan.alasan.toLowerCase().includes("sakit");
    if (izinSakit) {
      const wajahCocok = await verifikasiWajah(sender, media.data);
      if (pendingIzin[sender] !== pengajuan) {
        return msg.reply(
          "⌛ Waktu pengajuan izin sudah habis. Silakan kirim perintah *!izin alasan* lagi."
        );
      }
      if (!wajahCocok) {
        clearPendingIzin(sender);
        return msg.reply(
          "❌ Wajah tidak dikenali. Untuk izin sakit, foto ulang dengan wajah kamu dan surat/bukti sakit terlihat jelas bersama."
        );
      }
    }

    ensureDir(IZIN_BUKTI_DIR);
    const nomor = sender.replace("@c.us", "");
    const buktiPath = `${IZIN_BUKTI_DIR}/${pengajuan.tanggal}-${nomor}.jpg`;
    fs.writeFileSync(buktiPath, Buffer.from(media.data, "base64"));

    const izinData = loadIzin();
    izinData[pengajuan.tanggal] = izinData[pengajuan.tanggal] || {};
    izinData[pengajuan.tanggal][sender] = {
      alasan: pengajuan.alasan,
      nama: kontak[sender] || sender,
      bukti: buktiPath,
      terverifikasiWajah: izinSakit,
    };
    await saveIzin(izinData);
    clearPendingIzin(sender);

    const kelasSiswa = findKelasSiswa(loadKelas(), sender);
    const caption =
      `📩 *Pengajuan Izin Siswa*\n` +
      `👤 Nama: *${kontak[sender] || sender}*\n` +
      `🏫 Kelas: ${kelasSiswa?.namaKelas || "-"}\n` +
      `📅 Tanggal: ${pengajuan.tanggal}\n` +
      `📌 Alasan: ${pengajuan.alasan}` +
      (izinSakit ? "\n✅ Wajah siswa terverifikasi" : "");
    const buktiMedia = new MessageMedia(media.mimetype, media.data, "bukti-izin.jpg");

    const penerima = new Set(
      Object.entries(loadRoles())
        .filter(([, penerimaRole]) => penerimaRole === "admin")
        .map(([id]) => id)
    );
    if (kelasSiswa?.waliKelas) penerima.add(kelasSiswa.waliKelas);
    if (kelasSiswa?.siswa[sender]?.orangTua) {
      penerima.add(kelasSiswa.siswa[sender].orangTua);
    }
    penerima.delete(sender);

    for (const id of penerima) {
      await kirimMediaAman(id, buktiMedia, caption);
    }

    return msg.reply(
      `✅ Izin hari ini berhasil dicatat.\nAlasan: ${pengajuan.alasan}\nFoto bukti sudah dikirim ke pihak terkait.`
    );
  }

  if (msg.hasMedia && msg.type === "image") {
    return msg.reply(
      "⚠️ Foto diterima, tetapi tidak ada proses yang sedang menunggu foto.\n" +
        "Untuk absen, kirim *!masuk* atau *!pulang* lalu kirim selfie dalam 2 menit.\n" +
        "Untuk menyimpan foto wajah, kirim selfie dengan caption *!setfoto*."
    );
  }

  // Rekap hari ini
  if (body === "!rekap hari ini") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const data = storage[waktu.tanggal] || {};
    const izinData = loadIzin()[waktu.tanggal] || {};
    let teks = `📅 Rekap ${waktu.tanggal}:\n\n`;

    const semuaID = new Set([...Object.keys(data), ...Object.keys(izinData)]);

    for (const id of semuaID) {
      const u = data[id] || {};
      const nama =
        u.masuk?.nama ||
        u.pulang?.nama ||
        izinData[id]?.nama ||
        kontak[id] ||
        id;

      teks += `👤 ${nama}\n`;

      if (izinData[id]) {
        teks += `📝 Izin: ${izinData[id].alasan}\n\n`;
        continue;
      }

      if (u.masuk) {
        teks += `🕘 Masuk: ${u.masuk.waktu} (${u.masuk.status})\n`;
        if (u.masuk.status === "Terlambat") {
          const menit = hitungTelat(u.masuk.waktu, jamResmi.masuk);
          teks += `⏱ Telat: ${menit} menit\n`;
        }
      } else {
        teks += `🕘 Masuk: ❌\n`;
      }

      if (u.pulang) {
        teks += `🕓 Pulang: ${u.pulang.waktu} (${u.pulang.status})\n`;
      } else {
        teks += `🕓 Pulang: ❌\n`;
      }

      teks += `\n`;
    }

    return msg.reply(teks || "❌ Tidak ada data.");
  }

  // Rekap tanggal
  if (body.startsWith("!rekap tanggal")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const split = body.trim().split(" ");
    if (split.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(split[2])) {
      return msg.reply("⚠️ Format salah. Gunakan: *!rekap tanggal YYYY-MM-DD*");
    }

    const tanggal = split[2];
    const data = storage[tanggal] || {};
    const izinData = loadIzin()[tanggal] || {};
    const semuaID = new Set([...Object.keys(data), ...Object.keys(izinData)]);
    if (!semuaID.size)
      return msg.reply(`❌ Tidak ada data untuk tanggal ${tanggal}`);

    let teks = `📅 Rekap ${tanggal}:\n\n`;

    for (const id of semuaID) {
      const u = data[id] || {};
      const nama =
        u.masuk?.nama ||
        u.pulang?.nama ||
        izinData[id]?.nama ||
        kontak[id] ||
        id;

      teks += `👤 ${nama}\n`;

      if (izinData[id]) {
        teks += `📝 Izin: ${izinData[id].alasan}\n\n`;
        continue;
      }

      if (u.masuk) {
        teks += `🕘 Masuk: ${u.masuk.waktu} (${u.masuk.status})\n`;

        if (u.masuk.status === "Terlambat") {
          const menit = hitungTelat(u.masuk.waktu, jamResmi.masuk);
          teks += `⏱ Telat: ${menit} menit\n`;
        }
      } else {
        teks += `🕘 Masuk: ❌\n`;
      }

      if (u.pulang) {
        teks += `🕓 Pulang: ${u.pulang.waktu} (${u.pulang.status})\n`;
      } else {
        teks += `🕓 Pulang: ❌\n`;
      }

      teks += `\n`;
    }

    msg.reply(teks);
  }

  // Rekap bulan
  if (body.startsWith("!rekap bulan")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const split = body.trim().split(" ");
    if (split.length < 3 || !/^\d{2}-\d{4}$/.test(split[2])) {
      return msg.reply("⚠️ Format salah. Gunakan: *!rekap bulan MM-YYYY*");
    }

    const bulan = split[2];
    const izinData = loadIzin();
    let teks = `📅 Rekap Bulan ${bulan}:\n\n`;
    let ditemukan = false;

    const semuaTanggal = Object.keys(storage).filter(
      (tgl) =>
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
    );

    const semuaTanggalIzin = Object.keys(izinData).filter(
      (tgl) =>
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
    );

    const semuaTanggalGabung = new Set([...semuaTanggal, ...semuaTanggalIzin]);

    for (const tgl of semuaTanggalGabung) {
      const data = storage[tgl] || {};
      const izin = izinData[tgl] || {};
      const semuaID = new Set([...Object.keys(data), ...Object.keys(izin)]);

      for (const id of semuaID) {
        const log = data[id] || {};
        const nama =
          log.masuk?.nama ||
          log.pulang?.nama ||
          izin[id]?.nama ||
          kontak[id] ||
          id;

        teks += `🗓️ ${tgl} - ${nama}\n`;

        if (izin[id]) {
          teks += `📝 Izin: ${izin[id].alasan}\n\n`;
          ditemukan = true;
          continue;
        }

        if (log.masuk) {
          teks += `🕘 Masuk: ${log.masuk.waktu} (${log.masuk.status})\n`;

          if (log.masuk.status === "Terlambat") {
            const menit = hitungTelat(log.masuk.waktu, jamResmi.masuk);
            teks += `⏱ Telat: ${menit} menit\n`;
          }
        } else {
          teks += `🕘 Masuk: ❌\n`;
        }

        if (log.pulang) {
          teks += `🕓 Pulang: ${log.pulang.waktu} (${log.pulang.status})\n`;
        } else {
          teks += `🕓 Pulang: ❌\n`;
        }

        teks += `\n`;
        ditemukan = true;
      }
    }

    if (!ditemukan) return msg.reply(`❌ Tidak ada data untuk bulan ${bulan}`);
    msg.reply(teks);
  }

  // Export Hari Ini
  if (body === "!export hari ini") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const data = storage[waktu.tanggal] || {};
    const izinData = loadIzin()[waktu.tanggal] || {};
    const hasil = [];

    const semuaID = new Set([...Object.keys(data), ...Object.keys(izinData)]);

    for (const id of semuaID) {
      const u = data[id] || {};
      const nama =
        u.masuk?.nama ||
        u.pulang?.nama ||
        izinData[id]?.nama ||
        kontak[id] ||
        id;

      if (izinData[id]) {
        hasil.push({
          Tanggal: waktu.tanggal,
          Nama: nama,
          Masuk: "IZIN",
          StatusMasuk: izinData[id].alasan,
          Terlambat: "",
          MenitTelat: "",
          Pulang: "",
          StatusPulang: "",
        });
        continue;
      }

      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamResmi.masuk)
          : 0;

      hasil.push({
        Tanggal: waktu.tanggal,
        Nama: nama,
        Masuk: u.masuk?.waktu || "",
        StatusMasuk: u.masuk?.status || "",
        Terlambat: telat > 0 ? 1 : 0,
        MenitTelat: telat,
        Pulang: u.pulang?.waktu || "",
        StatusPulang: u.pulang?.status || "",
      });
    }

    if (!hasil.length) return msg.reply("❌ Tidak ada data.");

    const path = exportExcel(hasil, waktu.tanggal);
    const media = MessageMedia.fromFilePath(path);
    msg.reply(media, msg.from, {
      caption: `✅ File export *${waktu.tanggal}*`,
    });
  }

  // Export Tanggal
  if (body.startsWith("!export tanggal")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const split = body.trim().split(" ");
    if (split.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(split[2])) {
      return msg.reply(
        "⚠️ Format salah. Gunakan: *!export tanggal YYYY-MM-DD*"
      );
    }

    const tanggal = split[2];
    const data = storage[tanggal] || {};
    const izinData = loadIzin()[tanggal] || {};
    const hasil = [];

    const semuaID = new Set([...Object.keys(data), ...Object.keys(izinData)]);

    for (const id of semuaID) {
      const u = data[id] || {};
      const nama =
        u.masuk?.nama ||
        u.pulang?.nama ||
        izinData[id]?.nama ||
        kontak[id] ||
        id;

      if (izinData[id]) {
        hasil.push({
          Tanggal: tanggal,
          Nama: nama,
          Masuk: "IZIN",
          StatusMasuk: izinData[id].alasan,
          Terlambat: "",
          MenitTelat: "",
          Pulang: "",
          StatusPulang: "",
        });
        continue;
      }

      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamResmi.masuk)
          : 0;

      hasil.push({
        Tanggal: tanggal,
        Nama: nama,
        Masuk: u.masuk?.waktu || "",
        StatusMasuk: u.masuk?.status || "",
        Terlambat: telat > 0 ? 1 : 0,
        MenitTelat: telat,
        Pulang: u.pulang?.waktu || "",
        StatusPulang: u.pulang?.status || "",
      });
    }

    if (!hasil.length)
      return msg.reply(`❌ Tidak ada data untuk tanggal ${tanggal}`);

    const path = exportExcel(hasil, tanggal);
    const media = MessageMedia.fromFilePath(path);
    msg.reply(media, msg.from, { caption: `✅ File export *${tanggal}*` });
  }

  // Export Bulan
  if (body.startsWith("!export bulan")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const split = body.trim().split(" ");
    if (split.length < 3 || !/^\d{2}-\d{4}$/.test(split[2])) {
      return msg.reply("⚠️ Format salah. Gunakan: *!export bulan MM-YYYY*");
    }

    const bulan = split[2]; // MM-YYYY
    const hasil = [];
    const ringkasan = {};
    const izinData = loadIzin();

    const semuaTanggalStorage = Object.keys(storage).filter(
      (tgl) =>
        typeof tgl === "string" &&
        tgl.length === 10 &&
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
    );

    const semuaTanggalIzin = Object.keys(izinData).filter(
      (tgl) =>
        typeof tgl === "string" &&
        tgl.length === 10 &&
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
    );

    const semuaTanggal = new Set([...semuaTanggalStorage, ...semuaTanggalIzin]);

    for (const tgl of semuaTanggal) {
      const data = storage[tgl] || {};
      const izin = izinData[tgl] || {};
      const semuaID = new Set([...Object.keys(data), ...Object.keys(izin)]);

      for (const id of semuaID) {
        const u = data[id] || {};
        const nama =
          u.masuk?.nama || u.pulang?.nama || izin[id]?.nama || kontak[id] || id;

        if (izin[id]) {
          hasil.push({
            Tanggal: tgl,
            Nama: nama,
            Masuk: "IZIN",
            StatusMasuk: izin[id].alasan,
            Terlambat: "",
            MenitTelat: "",
            Pulang: "",
            StatusPulang: "",
          });

          if (!ringkasan[nama]) {
            ringkasan[nama] = {
              Nama: nama,
              Hadir: 0,
              Telat: 0,
              TotalMenit: 0,
              Izin: 0,
            };
          }

          ringkasan[nama].Izin++;
          continue;
        }

        const telat =
          u.masuk?.status === "Terlambat"
            ? hitungTelat(u.masuk.waktu, jamResmi.masuk)
            : 0;

        hasil.push({
          Tanggal: tgl,
          Nama: nama,
          Masuk: u.masuk?.waktu || "",
          StatusMasuk: u.masuk?.status || "",
          Terlambat: telat > 0 ? 1 : 0,
          MenitTelat: telat,
          Pulang: u.pulang?.waktu || "",
          StatusPulang: u.pulang?.status || "",
        });

        if (!ringkasan[nama]) {
          ringkasan[nama] = {
            Nama: nama,
            Hadir: 0,
            Telat: 0,
            TotalMenit: 0,
            Izin: 0,
          };
        }

        ringkasan[nama].Hadir++;
        if (telat > 0) {
          ringkasan[nama].Telat++;
          ringkasan[nama].TotalMenit += telat;
        }
      }
    }

    if (!hasil.length)
      return msg.reply(`❌ Tidak ada data untuk bulan ${bulan}`);

    const sheet1 = XLSX.utils.json_to_sheet(hasil);
    const sheet2 = XLSX.utils.json_to_sheet(Object.values(ringkasan));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet1, "Rekap");
    XLSX.utils.book_append_sheet(wb, sheet2, "Ringkasan");

    const filePath = `./exports/Rekap-${bulan}.xlsx`;
    ensureDir(EXPORTS_DIR);
    XLSX.writeFile(wb, filePath);

    const media = MessageMedia.fromFilePath(filePath);
    msg.reply(media, msg.from, {
      caption: `✅ File export *${bulan}* berhasil.\nSheet: Rekap & Ringkasan`,
    });
  }

  // Belum absen
  if (body === "!belum absen") {
    if (!["admin", "wali_kelas"].includes(role)) {
      return msg.reply("❌ Hanya admin atau wali kelas.");
    }

    const data = storage[waktu.tanggal] || {};
    const izinData = loadIzin()[waktu.tanggal] || {};
    const dataKelas = loadKelas();
    const belumMasuk = [],
      belumPulang = [];

    let daftarSiswa;
    let judulKelas = "Semua Kelas";

    if (role === "wali_kelas") {
      const kelasWali = Object.entries(dataKelas).find(
        ([, kelas]) => kelas.waliKelas === sender
      );
      if (!kelasWali) {
        return msg.reply("❌ Kamu belum terhubung dengan kelas mana pun.");
      }
      judulKelas = kelasWali[0];
      daftarSiswa = Object.keys(kelasWali[1].siswa || {});
    } else {
      daftarSiswa = Object.values(dataKelas).flatMap((kelas) =>
        Object.keys(kelas.siswa || {})
      );
    }

    if (!daftarSiswa.length) {
      return msg.reply(
        `📭 Belum ada siswa yang terhubung dengan ${
          role === "wali_kelas" ? `kelas *${judulKelas}*` : "data kelas"
        }.`
      );
    }

    for (const id of new Set(daftarSiswa)) {
      const nomor = id.replace("@c.us", "");
      const nama = kontak[id] || nomor;

      if (izinData[id]) continue; // skip yang izin

      if (!data[id]?.masuk) belumMasuk.push(`• ${nama} - ${nomor}`);
      if (!data[id]?.pulang) belumPulang.push(`• ${nama} - ${nomor}`);
    }

    let teks = `📋 *Belum Absen - ${judulKelas}*\n📅 ${waktu.tanggal}\n\n`;
    teks += `🚫 Masuk:\n${belumMasuk.join("\n") || "✅ Semua sudah masuk"}\n\n`;
    teks += `🚫 Pulang:\n${belumPulang.join("\n") || "✅ Semua sudah pulang"}`;
    return msg.reply(teks);
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
  const jam = loadJSON(JAM_PATH, { masuk: "07:00:00", pulang: "14:00:00" });
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
    faceService: faceServiceStatus(),
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
  requireWebAdmin,
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
  if (!isValidTime(masuk) || !isValidTime(pulang)) {
    return res.status(400).json({ error: "Format jam harus HH:MM." });
  }
  await saveJSON(JAM_PATH, { masuk: `${masuk}:00`, pulang: `${pulang}:00` });
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
});

async function startBot() {
  try {
    jsonCache = await initJsonStore(JSON_STORES);
    await ensureDefaultRoles();
    pendingFoto = loadPendingFoto();
    console.log(`Database Sequelize siap: ${DB_PATH}`);
    client.initialize();
  } catch (error) {
    console.error("Gagal inisialisasi database:", error);
    process.exit(1);
  }
}

startBot();
