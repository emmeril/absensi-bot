const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const moment = require("moment");
const haversine = require("haversine-distance");
const XLSX = require("xlsx");
const axios = require("axios");
const express = require("express");
const app = express();
const PORT = 3200;

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
const SHIFT_PATH = "./shifts.json";
const IZIN_PATH = "./izin.json";

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
    const res = await axios.post("http://localhost:5000/verify-face", {
      id: userId.replace("@c.us", ""),
      photo: fotoBase64,
    });
    return res.data?.match === true;
  } catch (e) {
    console.error("[FaceVerify ERROR]", e.response?.data || e.message);
    return false;
  }
}

function loadRoles() {
  return loadJSON(ROLE_PATH, {});
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function loadShifts() {
  return loadJSON(SHIFT_PATH, {
    shift1: { masuk: "07:00", pulang: "15:00" },
    shift2: { masuk: "15:00", pulang: "23:00" },
    shift3: { masuk: "23:00", pulang: "07:00" },
  });
}

function saveShifts(obj) {
  saveJSON(SHIFT_PATH, obj);
}

function loadIzin() {
  return loadJSON(IZIN_PATH, {});
}

function saveIzin(data) {
  saveJSON(IZIN_PATH, data);
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
    saveJSON(KONTAK_PATH, kontak);
    saveRequests(requests);

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
    saveJSON(KONTAK_PATH, kontak);

    msg.reply(`🗑️ Kontak *${nama}* (${nomor}) berhasil dihapus.`);
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

  // set shift
  if (body.startsWith("!setshift")) {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");
    const [_, shift, jamMasuk, jamPulang] = body.split(" ");
    if (!shift || !jamMasuk || !jamPulang)
      return msg.reply("⚠️ Format: !setshift shift1 07:00 15:00");

    const shifts = loadShifts();
    shifts[shift.toLowerCase()] = { masuk: jamMasuk, pulang: jamPulang };
    saveShifts(shifts);

    msg.reply(
      `✅ Shift *${shift}* diatur ke\nMasuk: ${jamMasuk}\nPulang: ${jamPulang}`
    );
  }

  // Absen masuk/pulang
  if (body.startsWith("!masuk") || body.startsWith("!pulang")) {
    const tipe = body.startsWith("!masuk") ? "masuk" : "pulang";
    const shiftArg = body.split(" ")[1]?.toLowerCase();
    const shifts = loadShifts();
    const shift = shiftArg && shifts[shiftArg] ? shiftArg : null;

    pendingAbsen[sender] = {
      tipe,
      shift,
      foto: null,
      lokasi: null,
      timeout: setTimeout(() => delete pendingAbsen[sender], 60000),
    };

    return msg.reply(
      `📸 Kirim foto Selfie untuk absen *${tipe}*${
        shift ? ` (Shift: ${shift})` : ""
      }.`
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
    const izinData = loadIzin();
    if (izinData[waktu.tanggal] && izinData[waktu.tanggal][sender]) {
      return msg.reply("❌ Kamu sudah mengajukan izin hari ini.");
    }

    const dataHariIni = (storage[waktu.tanggal] = storage[waktu.tanggal] || {});
    const userLog = (dataHariIni[sender] = dataHariIni[sender] || {});

    if (userLog[tipe]) return msg.reply(`✅ Sudah absen ${tipe}.`);

    const shifts = loadShifts();
    const jamShift = absen.shift ? shifts[absen.shift] : jamResmi;

    const status =
      tipe === "masuk"
        ? waktu.jam <= jamShift.masuk
          ? "Tepat Waktu"
          : "Terlambat"
        : waktu.jam >= jamShift.pulang
        ? "Sesuai Waktu"
        : "Pulang Cepat";

    userLog[tipe] = {
      waktu: waktu.jam,
      lokasi,
      status,
      shift: absen.shift || "default",
      foto: absen.foto,
      nama: kontak[sender],
    };

    saveJSON(STORAGE_PATH, storage);
    delete pendingAbsen[sender];

    msg.reply(`✅ Absen ${tipe} dicatat (${status})`);

    // Kirim notifikasi ke semua admin
    const mediaMsg = new MessageMedia(
      absen.foto.mimetype,
      absen.foto.data,
      `${sender.replace("@c.us", "")}.jpg`
    );

    const roles = loadRoles();
    for (const id in roles) {
      if (roles[id] === "admin" && id !== sender) {
        await client.sendMessage(id, mediaMsg, {
          caption: `🕘 *${kontak[sender] || sender}* telah absen *${tipe}* ${
            absen.shift ? `(Shift: ${absen.shift})` : ""
          }\nStatus: *${status}*\nJam: ${waktu.jam}`,
        });
      }
    }
  }

  // izin
  if (body.startsWith("!izin ")) {
  const izinData = loadIzin();
  const arg = body.slice(6).trim(); // ex: "hari ini sakit"
  const alasan = arg.split(" ").slice(2).join(" ").trim();
  let tanggal;

  if (arg.startsWith("hari ini")) {
    tanggal = waktu.tanggal;
  } else if (/^\d{4}-\d{2}-\d{2}/.test(arg)) {
    tanggal = arg.split(" ")[0];
  } else {
    return msg.reply(
      "❌ Format salah. Gunakan: *!izin hari ini alasan* atau *!izin YYYY-MM-DD alasan*"
    );
  }

  if (!alasan || alasan.length < 3)
    return msg.reply("⚠️ Alasan izin terlalu singkat.");

  izinData[tanggal] = izinData[tanggal] || {};
  izinData[tanggal][sender] = {
    alasan,
    nama: kontak[sender] || sender,
  };
  saveIzin(izinData);

  msg.reply(`✅ Izin untuk tanggal ${tanggal} dicatat.\nAlasan: ${alasan}`);

  // 🔔 Kirim notifikasi ke semua admin
  const roles = loadRoles();
  for (const id in roles) {
    if (roles[id] === "admin" && id !== sender) {
      await client.sendMessage(
        id,
        `📩 *Pengajuan Izin Baru*\n👤 Nama: *${kontak[sender] || sender}*\n📅 Tanggal: ${tanggal}\n📌 Alasan: ${alasan}`
      );
    }
  }
}


  // Rekap hari ini
  if (body === "!rekap hari ini") {
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
          const jamShift = u.masuk.shift
            ? loadShifts()[u.masuk.shift] || jamResmi
            : jamResmi;
          const menit = hitungTelat(u.masuk.waktu, jamShift.masuk);
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

      if (u.masuk?.shift) {
        teks += `🏷️ Shift: ${u.masuk.shift}\n`;
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
    const shifts = loadShifts();

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
        const shift = u.masuk.shift || "default";
        const jamShift = (shifts[shift] || jamResmi).masuk;

        if (u.masuk.status === "Terlambat") {
          const menit = hitungTelat(u.masuk.waktu, jamShift);
          teks += `⏱ Telat: ${menit} menit\n`;
        }

        teks += `🏷️ Shift: ${shift}\n`;
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
    const shifts = loadShifts();
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
          const shift = log.masuk.shift || "default";
          const jamMasuk = (shifts[shift] || jamResmi).masuk;

          if (log.masuk.status === "Terlambat") {
            const menit = hitungTelat(log.masuk.waktu, jamMasuk);
            teks += `⏱ Telat: ${menit} menit\n`;
          }

          teks += `🏷️ Shift: ${shift}\n`;
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
    const shifts = loadShifts();
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
          Shift: "",
        });
        continue;
      }

      const shift = u.masuk?.shift || "default";
      const jamShift = (shifts[shift] || jamResmi).masuk;

      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamShift)
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
        Shift: shift === "default" ? "" : shift,
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
    const shifts = loadShifts();
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
          Shift: "",
        });
        continue;
      }

      const shift = u.masuk?.shift || "default";
      const jamShift = (shifts[shift] || jamResmi).masuk;

      const telat =
        u.masuk?.status === "Terlambat"
          ? hitungTelat(u.masuk.waktu, jamShift)
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
        Shift: shift === "default" ? "" : shift,
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
    const shifts = loadShifts();
    const izinData = loadIzin();

    const semuaTanggal = Object.keys(storage).filter(
      (tgl) =>
        typeof tgl === "string" &&
        tgl.length === 10 &&
        tgl.slice(5, 7) === bulan.slice(0, 2) &&
        tgl.slice(0, 4) === bulan.slice(3, 7)
    );

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
            Shift: "",
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

        const shift = u.masuk?.shift || "default";
        const jamShift = (shifts[shift] || jamResmi).masuk;

        const telat =
          u.masuk?.status === "Terlambat"
            ? hitungTelat(u.masuk.waktu, jamShift)
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
          Shift: shift === "default" ? "" : shift,
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
    XLSX.writeFile(wb, filePath);

    const media = MessageMedia.fromFilePath(filePath);
    msg.reply(media, msg.from, {
      caption: `✅ File export *${bulan}* berhasil.\nSheet: Rekap & Ringkasan`,
    });
  }

  // Belum absen
  if (body === "!belum absen") {
    if (role !== "admin") return msg.reply("❌ Hanya admin.");

    const data = storage[waktu.tanggal] || {};
    const izinData = loadIzin()[waktu.tanggal] || {};
    const belumMasuk = [],
      belumPulang = [];

    for (const id in kontak) {
      const nomor = id.replace("@c.us", "");
      const nama = kontak[id] || nomor;

      if (izinData[id]) continue; // skip yang izin

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

let qrCodeData = null;
let isReady = false;

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

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(
    qrCodeData
  )}`;
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
        <img src="${qrUrl}" />
        <p>QR akan otomatis hilang setelah login.</p>
      </div>
    </body>
  </html>
`);
});

app.listen(PORT, () => {
  console.log(`🌐 Akses QR di: http://localhost:${PORT}/qr`);
});

client.initialize();
