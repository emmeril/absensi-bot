const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const express = require("express");
const ExcelJS = require("exceljs");
const { safeAsyncListener } = require("../lib/safe-async-listener");

const source = fs.readFileSync(require.resolve("../index.js"), "utf8");

test("OTP cooldown survives invalid guesses and failed delivery", async () => {
  let now = 100000;
  let sends = 0;
  let failSend = false;
  const routes = {};
  const context = {
    app: { post: (route, handler) => { routes[route] = handler; } },
    Date: { now: () => now }, crypto,
    normalizeNomor: (value) => value,
    loadRoles: () => ({ "621234567890@c.us": "admin" }),
    loginOtps: new Map(), otpCooldowns: new Map(),
    sendWhatsappWithRetry: async (send) => send(),
    whatsapp: {
      isReady: () => true,
      sendText: async () => { sends++; if (failSend) throw Error("offline"); },
    },
    webSessions: new Map(), resolveDashboardUserName: async () => "Admin",
  };
  vm.runInNewContext(source.slice(source.indexOf('app.post("/api/auth/request-otp"'), source.indexOf('app.get("/api/auth/me"')), context);
  const request = { body: { nomor: "621234567890", code: "invalid" } };
  function response() {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() {}, setHeader() {} };
  }
  await routes["/api/auth/request-otp"](request, response());
  for (let i = 0; i < 6; i++) await routes["/api/auth/verify"](request, response());
  let res = response();
  await routes["/api/auth/request-otp"](request, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sends, 1);
  now += 60000;
  failSend = true;
  await routes["/api/auth/request-otp"](request, response());
  await new Promise(setImmediate);
  res = response();
  await routes["/api/auth/request-otp"](request, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sends, 2);
});

test("simultaneous exports retain each user's filtered report", async (t) => {
  const app = express();
  const ids = { a: "62111@c.us", b: "62222@c.us", deleted: "62333@c.us" };
  app.use((req, res, next) => {
    req.webUser = { id: req.query.user, role: req.query.user === "admin" ? "admin" : "wali_kelas" };
    next();
  });
  const context = {
    app, ExcelJS, Buffer, KONTAK_PATH: "contacts", STORAGE_PATH: "attendance", IZIN_PATH: "permissions",
    loadJSON: (key) => key === "contacts" ? { [ids.a]: "Student A", [ids.b]: "Student B" } : {},
    loadJSONSelected: (key, select) => select(
      key === "attendance"
        ? { "2026-09-09": { [ids.deleted]: { masuk: { waktu: "07:01:00", status: "Tepat Waktu", nama: "Former Student", kelas: "A", waliKelas: "teacher" } } } }
        : {}
    ),
    loadIzin: () => ({}), getWaktu: () => ({ tanggal: "2026-09-09" }),
    isValidDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ""),
    loadKelas: () => ({ A: { waliKelas: "teacher", siswa: { [ids.a]: {} } }, B: { waliKelas: "other", siswa: { [ids.b]: {} } } }),
  };
  for (const [start, end] of [
    ["async function exportExcel(", "function ensureDir"],
    ["function findKelasSiswa(", "async function kirimPesanAman"],
    ["function kelasUntukWali(", "function removeUnusedWaliRole"],
    ["function buildReportRows(", 'function requireQrAccess'],
  ]) vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/export`;
  const results = await Promise.all(["teacher", "admin"].map(async (user) => {
    const response = await fetch(`${url}?user=${user}`);
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const worksheet = workbook.getWorksheet("Rekap");
    const headers = worksheet.getRow(1).values.slice(1);
    return worksheet.getRows(2, worksheet.rowCount - 1).map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row.getCell(index + 1).value]))
    );
  }));
  assert.deepEqual(results[0].map((row) => row.Nama), ["Student A", "Former Student"]);
  assert.deepEqual(results[1].map((row) => row.Nama), ["Student A", "Student B", "Former Student"]);
});

test("message listener catches both synchronous and asynchronous failures and keeps running", async () => {
  const errors = [];
  const listener = safeAsyncListener((mode) => {
    if (mode === "sync") throw Error("sync");
    if (mode === "async") return Promise.reject(Error("async"));
    return "ok";
  }, (error) => errors.push(error.message));
  await listener("sync");
  await listener("async");
  assert.equal(await listener("success"), "ok");
  assert.deepEqual(errors, ["sync", "async"]);
});

function automaticFlowFixture() {
  const { JsonState } = require("../lib/json-state");
  const state = new JsonState({
    initial: { contacts: { student: "Siswa" }, storage: {}, permissions: {} },
    writeBatch: async () => {},
  });
  const routes = {}, files = new Map(), sessions = new Map();
  const context = {
    ...require("../lib/attendance-rules"), crypto, Buffer,
    STORAGE_PATH: "storage", IZIN_PATH: "permissions", KONTAK_PATH: "contacts",
    JAM_PATH: "time", LOKASI_PATH: "location", IZIN_BUKTI_DIR: "evidence",
    loadJSON: (key, fallback) => state.read(key, fallback),
    updateJSON: (keys, mutate) => state.update(keys, mutate),
    getWaktu: () => ({ tanggal: "2026-09-09", jam: "07:00:00" }),
    getAttendanceStatus: () => "Tepat Waktu",
    getAttendanceWindow: () => ({ mulai: "00:00", selesai: "23:59" }),
    haversine: () => 0, ATTENDANCE_RADIUS_METERS: 100,
    findKelasSiswa: () => null, loadKelas: () => ({}),
    getStudentNotificationRecipients: () => [],
    antreNotifikasi: () => {}, kirimPesanAman: async () => {},
    app: { post: (route, handler) => { routes[route] = handler; } },
    permissionSessions: sessions, getPermissionSession: (token) => sessions.get(token),
    parseImageDataUrl: (image) => image ? { mimetype: "image/jpeg", data: "dGVzdA==", buffer: Buffer.from("test") } : null,
    validateImagePayload: async (image) => image,
    imageExtension: () => "jpg",
    attendancePhotoPath: () => "attendance/photo.jpg",
    writePrivateFile: (name, data) => files.set(name, data),
    deleteManagedFile: (name) => files.delete(name),
    deletePrivateFileSafely: (name) => files.delete(name),
    ensureDir: () => {}, console: { error() {} },
    fs: { existsSync: (name) => files.has(name) },
  };
  vm.runInNewContext(source.slice(source.indexOf("async function catatAbsensiKamera"), source.indexOf("const whatsapp = new BaileysManager")), context);
  vm.runInNewContext(source.slice(source.indexOf('app.post("/api/permission-camera/:token/evidence"'), source.indexOf('app.get("/api/attendance-camera/:token"')), context);
  return { context, state, routes, files, sessions };
}

function fakeResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
}

test("masuk and pulang record automatically; concurrent duplicates commit once", async () => {
  const { context, state } = automaticFlowFixture();
  const foto = { mimetype: "image/jpeg", data: "dGVzdA==", buffer: Buffer.from("test") };
  for (const tipe of ["masuk", "pulang"]) {
    const results = await Promise.allSettled([
      context.catatAbsensiKamera("student", tipe, {}, foto),
      context.catatAbsensiKamera("student", tipe, {}, foto),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const result = results.find((item) => item.status === "fulfilled").value;
    assert.equal(result.status, "Tepat Waktu");
    assert.equal(result.pending, undefined);
    const record = state.read("storage")["2026-09-09"].student[tipe];
    assert.equal(record.waktu, "07:00:00");
    assert.equal(record.foto, undefined);
    assert.equal(record.fotoPath, "attendance/photo.jpg");
  }
});

test("automatic attendance still rejects permission conflicts, outside location, and closed schedule", async () => {
  for (const mode of ["permission", "location", "schedule", "removed"]) {
    const { context, state } = automaticFlowFixture();
    if (mode === "permission") await state.update("permissions", (draft) => { draft.permissions["2026-09-09"] = { student: { alasan: "sakit" } }; });
    if (mode === "location") context.haversine = () => 101;
    if (mode === "schedule") context.getAttendanceWindow = () => ({ mulai: "08:00", selesai: "09:00" });
    if (mode === "removed") await state.update("contacts", (draft) => { delete draft.contacts.student; });
    await assert.rejects(context.catatAbsensiKamera("student", "masuk", {}, {}));
    assert.deepEqual(state.read("storage"), {});
  }
});

test("izin records automatically after verified selfie and evidence; duplicate and unverified submissions fail", async () => {
  const { routes, sessions, state, files } = automaticFlowFixture();
  const handler = routes["/api/permission-camera/:token/evidence"];
  const makeSession = (verified = true) => ({ userId: "student", tanggal: "2026-09-09", alasan: "sakit", verified, processing: false, selfie: { mimetype: "image/jpeg", data: "dGVzdA==", buffer: Buffer.from("test") }, lokasi: {} });
  sessions.set("unverified", makeSession(false));
  let res = fakeResponse();
  await handler({ params: { token: "unverified" }, body: { image: "proof" } }, res);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(state.read("permissions"), {});
  sessions.set("valid", makeSession());
  res = fakeResponse();
  await handler({ params: { token: "valid" }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(files.size, 0);
  res = fakeResponse();
  await handler({ params: { token: "valid" }, body: { image: "proof" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pending, undefined);
  const permission = state.read("permissions")["2026-09-09"].student;
  assert.equal(permission.alasan, "sakit");
  assert.equal(permission.terverifikasiWajah, true);
  assert.ok(files.has(permission.bukti));
  assert.equal(sessions.has("valid"), false);
  sessions.set("duplicate", makeSession());
  res = fakeResponse();
  await handler({ params: { token: "duplicate" }, body: { image: "proof" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(files.size, 2);
  assert.deepEqual(state.read("permissions")["2026-09-09"].student, permission);
});
