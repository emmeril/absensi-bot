const crypto = require("crypto");
const moment = require("moment");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");

const TEACHERS_PATH = "./teachers.json";
const TEACHER_RECORDS_PATH = "./teacher_records.json";
const EMPTY_TEACHERS = { number: "", teachers: {}, schedules: {}, holidays: [], subjects: [], classes: [] };
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const validDate = (value) => typeof value === "string" && moment(value, "YYYY-MM-DD", true).isValid();
const validTime = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
function number(value) {
  let result = String(value || "").replace(/\D/g, "");
  if (result.startsWith("0")) result = `62${result.slice(1)}`;
  if (!/^62\d{8,14}$/.test(result)) throw new Error("Nomor WhatsApp tidak valid.");
  return result;
}
function text(value, max = 120) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new Error(`Teks wajib diisi, maksimal ${max} karakter.`);
  return result;
}
function catalogValues(config, key, scheduleKey) {
  const saved = Array.isArray(config[key]) ? config[key] : [];
  const scheduled = Object.values(config.schedules || {}).map((schedule) => schedule[scheduleKey]).filter(Boolean);
  return [...new Set([...saved, ...scheduled])].sort((a, b) => a.localeCompare(b, "id", { sensitivity: "base" }));
}
function normalizedConfig(value) {
  const config = { ...EMPTY_TEACHERS, ...value };
  config.subjects = catalogValues(config, "subjects", "subject");
  config.classes = catalogValues(config, "classes", "className");
  return config;
}
function catalogMatch(config, key, scheduleKey, value) {
  return catalogValues(config, key, scheduleKey).find((item) => item.localeCompare(value, "id", { sensitivity: "base" }) === 0);
}
function scheduledSessions(config, date, teacherNumber) {
  if (!validDate(date) || config.holidays.includes(date)) return [];
  const day = moment(date).day();
  return Object.values(config.schedules).filter((s) => s.day === day &&
    (!teacherNumber || s.number === teacherNumber) && config.teachers[s.number]?.active !== false &&
    config.teachers[s.number] && date >= s.from && (!s.until || date <= s.until))
    .sort((a, b) => a.start.localeCompare(b.start));
}
function windowFor(schedule, date) {
  const start = moment(`${date} ${schedule.start}`, "YYYY-MM-DD HH:mm");
  return { open: start.valueOf() - 15 * 60000, start: start.valueOf(), end: moment(`${date} ${schedule.end}`, "YYYY-MM-DD HH:mm").valueOf() };
}
function validateSchedule(body, config) {
  const subjectInput = text(body.subject);
  const classInput = text(body.className);
  const subject = catalogMatch(config, "subjects", "subject", subjectInput);
  const className = catalogMatch(config, "classes", "className", classInput);
  if (!subject || !className) throw new Error("Mata pelajaran atau kelas belum terdaftar di data master.");
  const s = { id: body.id || crypto.randomUUID(), number: number(body.number), day: Number(body.day),
    subject, className, start: body.start, end: body.end,
    tolerance: Number(body.tolerance ?? 0), from: body.from, until: body.until || "" };
  if (!/^[a-f0-9-]{36}$/.test(s.id) || !config.teachers[s.number] || !Number.isInteger(s.day) || s.day < 0 || s.day > 6 ||
      !validTime(s.start) || !validTime(s.end) || s.start >= s.end || !validDate(s.from) ||
      (s.until && (!validDate(s.until) || s.until < s.from)) || !Number.isInteger(s.tolerance) || s.tolerance < 0 || s.tolerance > 60) {
    throw new Error("Guru, hari, jam, tanggal berlaku, atau toleransi jadwal tidak valid.");
  }
  for (const other of Object.values(config.schedules)) {
    if (other.id !== s.id && other.number === s.number && other.day === s.day &&
        s.start < other.end && other.start < s.end && s.from <= (other.until || "9999-12-31") && other.from <= (s.until || "9999-12-31")) {
      throw new Error("Jadwal guru bertabrakan dengan sesi lain.");
    }
  }
  return s;
}

function createTeacherAttendance(deps) {
  const { loadJSON, updateJSON, parseImageDataUrl, validateImagePayload, validateImageBuffer,
    verifyFace, writePrivateFile, requireWebAuth, requireWebAdmin, upload, publicBaseUrl, getClasses, getStudents } = deps;
  const config = () => normalizedConfig(loadJSON(TEACHERS_PATH, EMPTY_TEACHERS));
  const records = () => loadJSON(TEACHER_RECORDS_PATH, { records: {}, tokens: {} });
  const locks = new Set();
  const photoRoot = path.resolve(deps.photoRoot || "attendance_photos/teachers");
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (res.headersSent) return next(error);
      res.status(error.status || 400).json({ error: error.message || "Proses absensi guru gagal." });
    }
  };
  const keyFor = (date, id) => `${date}_${id}`;
  const permissionKey = (date, teacherNumber) => `${date}_${teacherNumber}`;
  const permissionFor = (state, date, teacherNumber) => state.permissions?.[permissionKey(date, teacherNumber)] || null;
  function getSession(token) {
    const state = records();
    const session = /^[a-f0-9]{64}$/.test(token || "") && state.tokens[hash(token)];
    if (!session || session.expiresAt <= Date.now()) throw Object.assign(new Error("Tautan sudah berakhir. Kirim !masuk ke bot guru untuk membuka sesi yang tersedia."), { status: 410 });
    const c = config();
    const schedule = scheduledSessions(c, session.date, session.number).find((s) => s.id === session.scheduleId);
    if (!schedule || c.teachers[session.number]?.active === false) throw new Error("Jadwal atau guru sudah tidak aktif.");
    if (permissionFor(state, session.date, session.number)) throw new Error("Guru sudah tercatat izin pada tanggal ini.");
    return { ...session, schedule, record: state.records[keyFor(session.date, session.scheduleId)] };
  }
  function checkLocation(body) {
    const { latitude, longitude, accuracy } = body;
    if (![latitude, longitude, accuracy].every((v) => typeof v === "number" && Number.isFinite(v)) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy <= 0 || accuracy > 100) throw new Error("GPS tidak valid atau akurasi melebihi 100 meter.");
    const school = loadJSON("./lokasi.json");
    if (!Number.isFinite(school.latitude) || !Number.isFinite(school.longitude) || haversine(school, { latitude, longitude }) > 100) throw new Error("Anda harus berada dalam radius 100 meter dari sekolah.");
    return { latitude, longitude, accuracy };
  }
  async function image(body) {
    const photo = parseImageDataUrl(body.image);
    if (!photo) throw new Error("Foto kamera wajib diambil.");
    await validateImagePayload(photo);
    return photo;
  }
  function publicRecord(record) {
    if (!record) return null;
    const { selfie, evidence, ...safe } = record;
    return { ...safe, hasSelfie: Boolean(selfie), hasEvidence: Boolean(evidence) };
  }
  async function command({ botKey, sender, body, reply }) {
    if (!botKey.startsWith("tu:")) return false;
    if (!body.startsWith("!")) return true;
    const c = config();
    const num = sender.replace("@c.us", "");
    if (botKey !== `tu:${c.number}` || !c.teachers[num] || c.teachers[num].active === false) {
      await reply("Nomor ini adalah bot guru. Nomor Anda belum terdaftar sebagai guru aktif. Hubungi admin sekolah."); return true;
    }
    const date = moment().format("YYYY-MM-DD");
    const schedules = scheduledSessions(c, date, num);
    if (body === "!jadwal") {
      await reply(schedules.length ? schedules.map((s) => `${s.start}–${s.end} · ${s.subject} · ${s.className}`).join("\n") : "Tidak ada jadwal mengajar hari ini."); return true;
    }
    if (body !== "!masuk") {
      await reply("Kirim !masuk untuk selfie, foto kegiatan, dan materi dalam satu tautan. Kirim !jadwal untuk jadwal hari ini."); return true;
    }
    const permission = permissionFor(records(), date, num);
    if (permission) {
      await reply(`Anda sudah tercatat ${permission.type.toLowerCase()} hari ini. Hubungi admin jika data tersebut perlu diperbaiki.`); return true;
    }
    const available = schedules.filter((s) => { const w = windowFor(s, date); return Date.now() >= w.open && Date.now() < w.end; });
    if (!available.length) { await reply("Tidak ada sesi yang sedang dibuka. Absensi tersedia 15 menit sebelum mulai sampai sesi berakhir. Cek !jadwal."); return true; }
    const links = [];
    await updateJSON(TEACHER_RECORDS_PATH, (draft) => {
      const state = draft[TEACHER_RECORDS_PATH];
      for (const [key, value] of Object.entries(state.tokens)) if (value.expiresAt <= Date.now()) delete state.tokens[key];
      for (const schedule of available) {
        const record = state.records[keyFor(date, schedule.id)];
        if (record?.evidence) { links.push(`✅ ${schedule.subject} · ${schedule.className}: bukti sudah lengkap.`); continue; }
        const token = crypto.randomBytes(32).toString("hex");
        for (const [key, value] of Object.entries(state.tokens)) if (value.number === num && value.scheduleId === schedule.id && value.date === date) delete state.tokens[key];
        state.tokens[hash(token)] = { number: num, date, scheduleId: schedule.id, expiresAt: windowFor(schedule, date).end };
        links.push(`${schedule.subject} · ${schedule.className} · ${schedule.start}–${schedule.end}\n${publicBaseUrl()}/teacher-camera.html#${token}`);
      }
    });
    await reply(`${links.join("\n\n")}\n\nSelfie mencatat kehadiran. Lanjutkan foto kegiatan dan materi melalui tautan yang sama sebelum sesi berakhir. Tautan bersifat pribadi; jangan dibagikan.`);
    return true;
  }

  function registerCamera(app, limiter) {
    app.use("/api/teacher-camera", limiter);
    app.get("/api/teacher-camera/:token", wrap(async (req, res) => {
      const s = getSession(req.params.token);
      res.json({ name: config().teachers[s.number].name, schedule: s.schedule, expiresAt: s.expiresAt, record: publicRecord(s.record) });
    }));
    for (const stage of ["arrival", "evidence"]) app.post(`/api/teacher-camera/:token/${stage}`, wrap(async (req, res) => {
      const s = getSession(req.params.token);
      const key = keyFor(s.date, s.scheduleId);
      if (locks.has(key)) throw new Error("Sesi sedang diproses. Tunggu sebentar.");
      locks.add(key);
      let file;
      let committed = false;
      try {
        if (stage === "arrival" && s.record?.arrival) return res.json({ ok: true, record: publicRecord(s.record) });
        if (stage === "evidence" && !s.record?.arrival) throw new Error("Selesaikan selfie kehadiran terlebih dahulu.");
        if (stage === "evidence" && s.record?.evidence) return res.json({ ok: true, record: publicRecord(s.record) });
        const capturedAt = Date.now();
        const location = checkLocation(req.body);
        const photo = await image(req.body);
        const material = stage === "evidence" ? text(req.body.material, 1000) : "";
        if (stage === "evidence" && capturedAt < windowFor(s.schedule, s.date).start) throw new Error("Foto kegiatan dikirim setelah sesi mengajar dimulai.");
        if (stage === "arrival" && !await verifyFace(`${s.number}@c.us`, photo.buffer)) throw new Error("Wajah tidak cocok dengan foto referensi guru.");
        getSession(req.params.token);
        file = path.join(photoRoot, `${crypto.randomUUID()}.${photo.mimetype === "image/png" ? "png" : "jpg"}`);
        writePrivateFile(file, photo.buffer);
        let saved;
        await updateJSON(TEACHER_RECORDS_PATH, (draft) => {
          getSession(req.params.token);
          const state = draft[TEACHER_RECORDS_PATH];
          if (stage === "arrival") {
            const elapsed = capturedAt - windowFor(s.schedule, s.date).start;
            const lateMinutes = elapsed > s.schedule.tolerance * 60000 ? Math.ceil(elapsed / 60000) : 0;
            state.records[key] = { key, date: s.date, number: s.number, name: config().teachers[s.number].name,
              schedule: s.schedule, arrival: new Date(capturedAt).toISOString(), lateMinutes, location, selfie: file };
          } else Object.assign(state.records[key], { evidence: file, material, evidenceAt: new Date(capturedAt).toISOString(), evidenceLocation: location, review: "Belum ditinjau" });
          saved = state.records[key];
        });
        committed = true;
        res.json({ ok: true, record: publicRecord(saved) });
      } finally {
        locks.delete(key);
        if (file && !committed) {
          try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") console.error("Gagal membersihkan foto guru:", error.message); }
        }
      }
    }));
  }
  function report(date) {
    if (!validDate(date)) throw new Error("Tanggal tidak valid.");
    const c = config();
    const state = records();
    const saved = Object.values(state.records).filter((r) => r.date === date);
    const rows = new Map(saved.map((r) => [r.key, publicRecord(r)]));
    for (const s of scheduledSessions(c, date)) {
      const key = keyFor(date, s.id);
      if (!rows.has(key)) rows.set(key, { key, date, number: s.number, name: c.teachers[s.number].name, schedule: s, hasEvidence: false, permission: permissionFor(state, date, s.number) });
    }
    return [...rows.values()].sort((a, b) => a.schedule.start.localeCompare(b.schedule.start) || a.name.localeCompare(b.name));
  }
  function registerAdmin(app) {
    app.use("/api/teachers", requireWebAuth, requireWebAdmin);
    app.get("/api/teachers", wrap(async (_req, res) => {
      const c = config();
      res.json({ ...c, teachers: Object.fromEntries(Object.entries(c.teachers).map(([key, t]) => [key, { ...t, hasPhoto: fs.existsSync(path.resolve("face_rec", `${key}.jpg`)) }])) });
    }));
    app.post("/api/teachers/settings", wrap(async (req, res) => {
      const num = req.body.number ? number(req.body.number) : "";
      const holidays = req.body.holidays;
      if (holidays !== undefined && (!Array.isArray(holidays) || holidays.length > 366 || holidays.some((date) => !validDate(date)))) throw new Error("Daftar tanggal libur tidak valid.");
      await updateJSON(TEACHERS_PATH, (draft) => {
        if (Object.values(getClasses()).some((c) => c.waliKelas === `${num}@c.us`) || draft[TEACHERS_PATH].teachers[num] || getStudents()[`${num}@c.us`]) throw new Error("Gunakan nomor khusus untuk Bot Guru, berbeda dari nomor siswa, guru, dan Bot Siswa.");
        draft[TEACHERS_PATH].number = num;
        if (holidays !== undefined) draft[TEACHERS_PATH].holidays = [...new Set(holidays)];
      });
      await deps.syncBots();
      res.json({ ok: true });
    }));
    app.post("/api/teachers/person", wrap(async (req, res) => {
      const num = number(req.body.number);
      const name = text(req.body.name);
      await updateJSON(TEACHERS_PATH, (draft) => {
        if (getStudents()[`${num}@c.us`] || num === draft[TEACHERS_PATH].number) throw new Error("Nomor sudah dipakai siswa atau bot guru.");
        draft[TEACHERS_PATH].teachers[num] = { name, active: req.body.active !== false };
      });
      await deps.syncBots();
      res.json({ ok: true });
    }));
    app.post("/api/teachers/catalog/:kind", wrap(async (req, res) => {
      const definition = { subjects: { key: "subjects", label: "Mata pelajaran" }, classes: { key: "classes", label: "Kelas" } }[req.params.kind];
      if (!definition) throw new Error("Jenis data master tidak valid.");
      const name = text(req.body.name);
      await updateJSON(TEACHERS_PATH, (draft) => {
        const current = draft[TEACHERS_PATH];
        current[definition.key] ||= [];
        if (current[definition.key].some((item) => item.localeCompare(name, "id", { sensitivity: "base" }) === 0)) throw new Error(`${definition.label} sudah terdaftar.`);
        current[definition.key].push(name);
        current[definition.key].sort((a, b) => a.localeCompare(b, "id", { sensitivity: "base" }));
      });
      res.json({ ok: true });
    }));
    app.delete("/api/teachers/catalog/:kind/:name", wrap(async (req, res) => {
      const definition = { subjects: { key: "subjects", scheduleKey: "subject", label: "Mata pelajaran" }, classes: { key: "classes", scheduleKey: "className", label: "Kelas" } }[req.params.kind];
      if (!definition) throw new Error("Jenis data master tidak valid.");
      const name = text(req.params.name);
      await updateJSON(TEACHERS_PATH, (draft) => {
        const current = draft[TEACHERS_PATH];
        if (Object.values(current.schedules || {}).some((schedule) => schedule[definition.scheduleKey]?.localeCompare(name, "id", { sensitivity: "base" }) === 0)) throw new Error(`${definition.label} masih digunakan pada jadwal mengajar.`);
        const values = Array.isArray(current[definition.key]) ? current[definition.key] : [];
        const index = values.findIndex((item) => item.localeCompare(name, "id", { sensitivity: "base" }) === 0);
        if (index < 0) throw Object.assign(new Error(`${definition.label} tidak ditemukan.`), { status: 404 });
        values.splice(index, 1);
      });
      res.json({ ok: true });
    }));
    app.post("/api/teachers/:number/photo", upload.single("photo"), wrap(async (req, res) => {
      const num = number(req.params.number);
      if (!config().teachers[num] || !req.file) throw new Error("Guru atau foto tidak ditemukan.");
      await validateImageBuffer(req.file.buffer);
      writePrivateFile(path.resolve("face_rec", `${num}.jpg`), req.file.buffer);
      res.json({ ok: true });
    }));
    app.post("/api/teachers/schedules", wrap(async (req, res) => {
      await updateJSON(TEACHERS_PATH, (draft) => {
        const c = draft[TEACHERS_PATH];
        const schedule = validateSchedule(req.body, c);
        if (c.schedules[schedule.id]) throw new Error("Untuk mengganti jadwal, akhiri jadwal lama lalu buat jadwal baru.");
        c.schedules[schedule.id] = schedule;
      });
      res.json({ ok: true });
    }));
    app.post("/api/teachers/schedules/:id/end", wrap(async (req, res) => {
      const until = req.body.until;
      await updateJSON(TEACHERS_PATH, (draft) => {
        const schedules = draft[TEACHERS_PATH].schedules;
        const s = Object.hasOwn(schedules, req.params.id) && schedules[req.params.id];
        if (!s || !validDate(until) || until < s.from || until < moment().format("YYYY-MM-DD")) throw new Error("Tanggal akhir minimal hari ini dan tidak sebelum tanggal mulai.");
        s.until = until;
      });
      res.json({ ok: true });
    }));
    app.get("/api/teachers/permissions", wrap(async (req, res) => {
      if (!validDate(req.query.date)) throw new Error("Tanggal tidak valid.");
      const values = Object.values(records().permissions || {}).filter((permission) => permission.date === req.query.date);
      res.json({ rows: values.sort((a, b) => a.name.localeCompare(b.name)) });
    }));
    app.post("/api/teachers/permissions", wrap(async (req, res) => {
      const num = number(req.body.number);
      const date = req.body.date;
      const type = req.body.type;
      const reason = text(req.body.reason, 1000);
      const c = config();
      if (!validDate(date) || !["Izin", "Sakit", "Tugas Luar"].includes(type) || !c.teachers[num]) throw new Error("Guru, tanggal, atau jenis izin tidak valid.");
      if (!scheduledSessions(c, date, num).length) throw new Error("Guru tidak memiliki jadwal mengajar pada tanggal tersebut.");
      await updateJSON(TEACHER_RECORDS_PATH, (draft) => {
        const state = draft[TEACHER_RECORDS_PATH];
        state.permissions ||= {};
        if (Object.values(state.records).some((record) => record.date === date && record.number === num && record.arrival)) throw new Error("Izin tidak dapat dicatat karena guru sudah melakukan absensi.");
        const key = permissionKey(date, num);
        if (state.permissions[key]) throw new Error("Izin guru pada tanggal tersebut sudah tercatat.");
        state.permissions[key] = { key, date, number: num, name: c.teachers[num].name, type, reason, createdAt: new Date().toISOString(), createdBy: req.webUser.id };
        for (const [tokenHash, session] of Object.entries(state.tokens)) if (session.date === date && session.number === num) delete state.tokens[tokenHash];
      });
      res.json({ ok: true });
    }));
    app.delete("/api/teachers/permissions/:date/:number", wrap(async (req, res) => {
      const num = number(req.params.number);
      if (!validDate(req.params.date)) throw new Error("Tanggal tidak valid.");
      await updateJSON(TEACHER_RECORDS_PATH, (draft) => {
        const permissions = draft[TEACHER_RECORDS_PATH].permissions || {};
        const key = permissionKey(req.params.date, num);
        if (!permissions[key]) throw Object.assign(new Error("Izin guru tidak ditemukan."), { status: 404 });
        delete permissions[key];
      });
      res.json({ ok: true });
    }));
    app.get("/api/teachers/report", wrap(async (req, res) => res.json({ rows: report(req.query.date) })));
    app.get("/api/teachers/report/:key/:kind", wrap(async (req, res) => {
      const r = records().records[req.params.key];
      const file = r && ["selfie", "evidence"].includes(req.params.kind) && r[req.params.kind];
      if (!file || !path.resolve(file).startsWith(`${photoRoot}${path.sep}`)) return res.sendStatus(404);
      res.sendFile(path.resolve(file));
    }));
    app.post("/api/teachers/report/:key/review", wrap(async (req, res) => {
      const review = req.body.review;
      if (!["Sudah ditinjau", "Perlu perbaikan"].includes(review)) throw new Error("Status tinjauan tidak valid.");
      const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      if (review === "Perlu perbaikan" && !note) throw new Error("Isi catatan perbaikan.");
      await updateJSON(TEACHER_RECORDS_PATH, (draft) => {
        const r = draft[TEACHER_RECORDS_PATH].records[req.params.key];
        if (!r?.evidence) throw new Error("Bukti belum tersedia.");
        r.review = review; r.reviewNote = note; r.reviewedBy = req.webUser.id; r.reviewedAt = new Date().toISOString();
      });
      res.json({ ok: true });
    }));
  }
  return { config, command, registerCamera, registerAdmin, report };
}
module.exports = { TEACHERS_PATH, TEACHER_RECORDS_PATH, EMPTY_TEACHERS, createTeacherAttendance, scheduledSessions, windowFor, validateSchedule };
