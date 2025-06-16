const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const moment = require("moment");
const haversine = require("haversine-distance");
const XLSX = require("xlsx");
const axios = require("axios");

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

function loadJSON(path, fallback = {}) {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : fallback;
}
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}
function getWaktu() {
  const now = moment();
  return {
    tanggal: now.format("YYYY-MM-DD"),
    jam: now.format("HH:mm:ss"),
  };
}
function exportExcel(data, filename) {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR);
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Rekap");
  const filePath = `${EXPORTS_DIR}/Rekap-${filename}.xlsx`;
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function loadRequests() {
  return loadJSON(REQUESTS_PATH, []);
}
function saveRequests(list) {
  saveJSON(REQUESTS_PATH, list);
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
function savePendingFoto(data) {
  saveJSON(PENDING_FOTO_PATH, data);
}

const pendingFoto = loadPendingFoto();

async function verifikasiWajah(userId, fotoBase64) {
  try {
    const res = await axios.post("http://38.47.176.155:5000/verify-face", {
      id: userId.replace("@c.us", ""),
      photo: fotoBase64,
    });
    return res.data?.match === true;
  } catch (e) {
    console.error("[FaceVerify ERROR]", e.response?.data || e.message);
    return false;
  }
}

const client = new Client({
  authStrategy: new LocalAuth(), // Simpan sesi login secara lokal
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // ✅ Fix error root user
    headless: true,
  },
});

const pendingAbsen = {};
const pendingKontak = {};
const pendingLokasi = {};

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("✅ Bot siap digunakan"));

client.on("message", async (msg) => {
  const sender = msg.author || msg.from;
  const body = msg.body.trim().toLowerCase();
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

  if (!kontak[sender] && role !== "admin") {
    const allowed = ["!setadmin", "!daftar"];
    if (!allowed.some((cmd) => body.startsWith(cmd))) {
      return msg.reply(
        "❌ Nomor kamu belum terdaftar. Kirim *!daftar Nama Lengkap* untuk mendaftar."
      );
    }
  }

  // Role info
  if (body === "!role saya") return msg.reply(`🔐 Role kamu: *${role}*`);

  // Set admin
  if (body.startsWith("!setadmin")) {
    const no = body.split(" ")[1];
    if (!no) return msg.reply("⚠️ Format: !setadmin 628xxxx");

    const targetId = no + "@c.us";
    const alreadyHasAdmin = Object.values(roles).includes("admin");

    if (alreadyHasAdmin && roles[sender] !== "admin") {
      return msg.reply("❌ Hanya admin yang bisa menambahkan admin.");
    }

    roles[targetId] = "admin";
    saveJSON(ROLE_PATH, roles);
    return msg.reply(`✅ ${no} sekarang menjadi admin.`);
  }

  // Daftar kontak
  if (body.startsWith("!daftar") && msg.hasMedia && msg.type === "image") {
    if (kontak[sender]) return msg.reply("✅ Kamu sudah terdaftar.");

    const nama = body.slice(8).trim();
    if (!nama || nama.length < 3)
      return msg.reply(
        "⚠️ Format salah. Kirim *foto selfie* dengan caption: *!daftar Nama Lengkap*"
      );

    const requests = loadRequests();
    if (requests.find((r) => r.id === sender))
      return msg.reply(
        "📨 Permintaan kamu sudah dikirim. Tunggu admin menyetujui."
      );

    const media = await msg.downloadMedia();
    if (!media || !media.data) return msg.reply("❌ Gagal membaca foto.");

    const nomor = sender.replace("@c.us", "");
    const filePath = `${FACE_DB}/${nomor}.jpg`;
    const recPath = `${FACE_REC}/${nomor}.jpg`;
    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

    if (!fs.existsSync(recPath)) {
      fs.writeFileSync(recPath, Buffer.from(media.data, "base64"));
    }

    requests.push({ id: sender, nama });
    saveRequests(requests);

    msg.reply(
      "✅ Foto selfie dan nama diterima. Permintaan akses dikirim ke admin."
    );
  }

  if (msg.type === "image" && pendingFoto[sender]) {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return msg.reply("❌ Gagal membaca foto.");

    const nomor = sender.replace("@c.us", "");
    const filePath = `${FACE_DB}/${nomor}.jpg`;
    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

    // Simpan ke pending_requests
    const requests = loadRequests();
    if (!requests.find((r) => r.id === sender)) {
      requests.push({ id: sender, nama: pendingFoto[sender].nama });
      saveRequests(requests);
    }

    delete pendingFoto[sender];
    savePendingFoto(pendingFoto);

    msg.reply("✅ Foto selfie diterima. Permintaan kamu dikirim ke admin.");
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

  if (body.startsWith("!approve")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const index = parseInt(body.split(" ")[1]) - 1;

    const requests = loadRequests();
    if (isNaN(index) || index < 0 || index >= requests.length) {
      return msg.reply("⚠️ Nomor permintaan tidak valid.");
    }

    const approved = requests.splice(index, 1)[0];
    kontak[approved.id] = approved.nama;
    saveJSON(KONTAK_PATH, kontak);
    saveRequests(requests);

    msg.reply(
      `✅ ${approved.nama} (${approved.id.replace(
        "@c.us",
        ""
      )}) ditambahkan ke kontak.`
    );
  }

  // Set lokasi
  if (body === "!setlokasi") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    pendingLokasi[sender] = true;
    return msg.reply("📍 Kirim lokasi sekarang.");
  }
  if (msg.type === "location" && pendingLokasi[sender]) {
    saveJSON(LOKASI_PATH, {
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    });
    delete pendingLokasi[sender];
    return msg.reply("✅ Lokasi kantor disimpan.");
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
    saveJSON(JAM_PATH, jamResmi);
    return msg.reply(`✅ Jam ${jenis} diatur ke ${jam}`);
  }

  // Absen masuk/pulang
  if (body === "!masuk" || body === "!pulang") {
    pendingAbsen[sender] = { tipe: body.slice(1), foto: null, lokasi: null };
    pendingAbsen[sender].timeout = setTimeout(
      () => delete pendingAbsen[sender],
      60000
    );
    return msg.reply(
      `📸 Kirim foto dan lokasi untuk absen ${pendingAbsen[sender].tipe}.`
    );
  }
  if (msg.hasMedia && pendingAbsen[sender]) {
    const media = await msg.downloadMedia();
    if (!media || media.mimetype !== "image/jpeg")
      return msg.reply("❌ Hanya foto dengan format JPEG yang didukung.");

    const cocok = await verifikasiWajah(sender, media.data);
    if (!cocok) {
      delete pendingAbsen[sender];
      return msg.reply("❌ Wajah tidak dikenali. Gunakan selfie asli kamu.");
    }

    pendingAbsen[sender].foto = media;

    if (!pendingAbsen[sender].lokasi) {
      return msg.reply(
        "✅ Foto dikenali.\n📍 Sekarang kirim lokasi untuk absen."
      );
    } else {
      return msg.reply(
        "✅ Foto dan lokasi sudah lengkap. Kamu bisa kirim perintah absen."
      );
    }
  }

  if (msg.type === "location" && pendingAbsen[sender]) {
    const lokasi = {
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    };
    const absen = pendingAbsen[sender];
    absen.lokasi = lokasi;
    clearTimeout(absen.timeout);

    const jarak = haversine(lokasi, lokasiKantor);
    if (jarak > 100) return msg.reply("❌ Di luar area kantor.");

    const tipe = absen.tipe;
    const dataHariIni = (storage[waktu.tanggal] = storage[waktu.tanggal] || {});
    const userLog = (dataHariIni[sender] = dataHariIni[sender] || {});

    if (userLog[tipe]) return msg.reply(`✅ Sudah absen ${tipe}.`);

    const status =
      tipe === "masuk"
        ? waktu.jam <= jamResmi.masuk
          ? "Tepat Waktu"
          : "Terlambat"
        : waktu.jam >= jamResmi.pulang
        ? "Sesuai Waktu"
        : "Pulang Cepat";

    userLog[tipe] = {
      waktu: waktu.jam,
      lokasi,
      status,
      foto: absen.foto,
      nama: kontak[sender],
    };

    saveJSON(STORAGE_PATH, storage);
    delete pendingAbsen[sender];
    return msg.reply(`✅ Absen ${tipe} dicatat (${status})`);
  }

  // Rekap hari ini
  if (body === "!rekap hari ini") {
    const data = storage[waktu.tanggal] || {};
    let teks = `📅 Rekap ${waktu.tanggal}:\n\n`;
    for (const id in data) {
      const u = data[id];
      teks += `👤 ${u.masuk?.nama || kontak[id]}\n`;
      teks += `🕘 Masuk: ${u.masuk?.waktu || "❌"} (${
        u.masuk?.status || "-"
      })\n`;
      if (u.masuk?.status === "Terlambat") {
        const menit = hitungTelat(u.masuk.waktu, jamResmi.masuk);
        teks += `⏱ Telat: ${menit} menit\n`;
      }
      teks += `🕓 Pulang: ${u.pulang?.waktu || "❌"} (${
        u.pulang?.status || "-"
      })\n\n`;
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
    const data = storage[tanggal];
    if (!data) return msg.reply(`❌ Tidak ada data untuk tanggal ${tanggal}`);

    let teks = `📅 Rekap ${tanggal}:\n\n`;

    for (const id in data) {
      const u = data[id];
      const nama = u.masuk?.nama || kontak[id] || id;

      teks += `👤 ${nama}\n`;
      teks += `🕘 Masuk: ${u.masuk?.waktu || "❌"} (${
        u.masuk?.status || "-"
      })\n`;

      if (u.masuk?.status === "Terlambat") {
        const menit = hitungTelat(u.masuk.waktu, jamResmi.masuk);
        teks += `⏱ Telat: ${menit} menit\n`;
      }

      teks += `🕓 Pulang: ${u.pulang?.waktu || "❌"} (${
        u.pulang?.status || "-"
      })\n\n`;
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
    let teks = `📅 Rekap Bulan ${bulan}:\n\n`;
    let ditemukan = false;

    for (const tgl in storage) {
      if (
        typeof tgl === "string" &&
        tgl.length === 10 &&
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
      ) {
        for (const id in storage[tgl]) {
          const log = storage[tgl][id];
          const nama = log.masuk?.nama || kontak[id] || id;

          teks += `🗓️ ${tgl} - ${nama}\n`;
          teks += `🕘 Masuk: ${log.masuk?.waktu || "❌"} (${
            log.masuk?.status || "-"
          })\n`;

          if (log.masuk?.status === "Terlambat") {
            const menit = hitungTelat(log.masuk.waktu, jamResmi.masuk);
            teks += `⏱ Telat: ${menit} menit\n`;
          }

          teks += `🕓 Pulang: ${log.pulang?.waktu || "❌"} (${
            log.pulang?.status || "-"
          })\n\n`;
          ditemukan = true;
        }
      }
    }

    if (!ditemukan) return msg.reply(`❌ Tidak ada data untuk bulan ${bulan}`);
    msg.reply(teks);
  }

  // Export Hari Ini
  if (body === "!export hari ini") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const data = storage[waktu.tanggal];
    if (!data) return msg.reply("❌ Tidak ada data.");
    const hasil = Object.entries(data).map(([id, u]) => {
      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamResmi.masuk)
          : 0;
      return {
        Tanggal: waktu.tanggal,
        Nama: kontak[id],
        Masuk: u.masuk?.waktu || "",
        StatusMasuk: u.masuk?.status || "",
        Terlambat: telat > 0 ? 1 : 0,
        MenitTelat: telat,
        Pulang: u.pulang?.waktu || "",
        StatusPulang: u.pulang?.status || "",
      };
    });
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
    const data = storage[tanggal];
    if (!data) return msg.reply(`❌ Tidak ada data untuk tanggal ${tanggal}`);

    const hasil = Object.entries(data).map(([id, u]) => {
      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamResmi.masuk)
          : 0;
      return {
        Tanggal: tanggal,
        Nama: kontak[id],
        Masuk: u.masuk?.waktu || "",
        StatusMasuk: u.masuk?.status || "",
        Terlambat: telat > 0 ? 1 : 0,
        MenitTelat: telat,
        Pulang: u.pulang?.waktu || "",
        StatusPulang: u.pulang?.status || "",
      };
    });

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

    for (const tgl in storage) {
      if (
        typeof tgl === "string" &&
        tgl.length === 10 &&
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
      ) {
        for (const id in storage[tgl]) {
          const log = storage[tgl][id];
          const nama = kontak[id] || log.masuk?.nama || id;
          const telat =
            log.masuk?.status === "Terlambat"
              ? hitungTelat(log.masuk.waktu, jamResmi.masuk)
              : 0;

          hasil.push({
            Tanggal: tgl,
            Nama: nama,
            Masuk: log.masuk?.waktu || "",
            StatusMasuk: log.masuk?.status || "",
            Terlambat: telat > 0 ? 1 : 0,
            MenitTelat: telat,
            Pulang: log.pulang?.waktu || "",
            StatusPulang: log.pulang?.status || "",
          });

          ringkasan[nama] = ringkasan[nama] || {
            Nama: nama,
            Hadir: 0,
            Telat: 0,
            TotalMenit: 0,
          };
          ringkasan[nama].Hadir++;
          if (telat > 0) {
            ringkasan[nama].Telat++;
            ringkasan[nama].TotalMenit += telat;
          }
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
    XLSX.writeFile(wb, filePath);

    const media = MessageMedia.fromFilePath(filePath);
    msg.reply(media, msg.from, {
      caption: `✅ File export *${bulan}* berhasil dengan sheet Ringkasan Keterlambatan.`,
    });
  }

  // Belum absen
  if (body === "!belum absen") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const data = storage[waktu.tanggal] || {};
    const belumMasuk = [],
      belumPulang = [];

    for (const id in kontak) {
      const nomor = id.replace("@c.us", "");
      const nama = kontak[id] || nomor;
      if (!data[id]?.masuk) belumMasuk.push(`• ${nama} - ${nomor}`);
      if (!data[id]?.pulang) belumPulang.push(`• ${nama} - ${nomor}`);
    }

    let teks = "📋 Belum Absen:\n\n";
    teks += `🚫 Masuk:\n${belumMasuk.join("\n") || "✅ Semua sudah masuk"}\n\n`;
    teks += `🚫 Pulang:\n${belumPulang.join("\n") || "✅ Semua sudah pulang"}`;
    msg.reply(teks);
  }

  function cetak(id) {
    return `- ${kontak[id] || id}`;
  }
});

client.initialize();
