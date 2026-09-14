const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dashboardPage = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8"
);

test("dashboard hanya memuat aset lokal", () => {
  assert.match(dashboardPage, /\/dashboard\.css/);
  assert.match(dashboardPage, /\/vendor\/alpine\.min\.js/);
  assert.doesNotMatch(dashboardPage, /https?:\/\/|cdn\.|jsdelivr|cdnjs/);
});

test("form edit mengirim identitas asli siswa dan kelas", () => {
  assert.match(dashboardPage, /originalNomor:s\.nomor/);
  assert.match(dashboardPage, /originalNama:k\.nama/);
});

test("dashboard login memakai username dan password tanpa OTP", () => {
  assert.match(dashboardPage, /loginDashboard/);
  assert.match(dashboardPage, /login\.username/);
  assert.match(dashboardPage, /login\.password/);
  assert.doesNotMatch(dashboardPage, /request-otp|Kode OTP|verifyOtp/);
});

test("form admin dan wali kelas mengelola akun dashboard", () => {
  assert.match(dashboardPage, /classForm\.username/);
  assert.match(dashboardPage, /classForm\.password/);
  assert.match(dashboardPage, /adminForm\.username/);
  assert.match(dashboardPage, /adminForm\.password/);
});

test("semua input password memiliki placeholder dan tombol tampilkan password", () => {
  assert.match(dashboardPage, /placeholder="Masukkan password"/);
  assert.match(dashboardPage, /Minimal 10 karakter/);
  assert.match(dashboardPage, /showLoginPassword \? 'text' : 'password'/);
  assert.match(dashboardPage, /showClassPassword \? 'text' : 'password'/);
  assert.match(dashboardPage, /showAdminPassword \? 'text' : 'password'/);
  assert.match(dashboardPage, /fa-eye-slash/);
  assert.match(dashboardPage, /aria-label/);
});

test("koneksi WhatsApp tersedia untuk admin dan wali kelas", () => {
  assert.match(dashboardPage, /id:"whatsapp",label:"WhatsApp"/);
  assert.match(dashboardPage, /\["ringkasan","siswa","whatsapp"\]/);
  assert.match(dashboardPage, /tab === 'whatsapp'/);
  assert.match(dashboardPage, /\/api\/whatsapp\/\$\{encodeURIComponent\(bot\.key\)\}\/qr\.svg/);
  assert.match(dashboardPage, /resetWhatsapp\(bot\)/);
  assert.doesNotMatch(dashboardPage, /href="\/qr"/);
});

test("semua tabel data memiliki filter dan tombol reset", () => {
  assert.match(dashboardPage, /display: flex; flex-wrap: nowrap; align-items: center; overflow-x: auto/);

  for (const table of ["report", "students", "classes", "permissions", "admins"]) {
    assert.match(dashboardPage, new RegExp(`hasTableFilters\\('${table}'\\)`));
    assert.match(dashboardPage, new RegExp(`resetTableFilters\\('${table}'\\)`));
  }

  for (const filter of [
    "report.classFilter",
    "report.statusFilter",
    "students.classFilter",
    "students.photoFilter",
    "classes.accountFilter",
    "classes.studentFilter",
    "permissions.classFilter",
    "permissions.evidenceFilter",
    "admins.accountFilter",
    "admins.ownerFilter",
  ]) {
    assert.match(dashboardPage, new RegExp(`tables\\.${filter}`));
  }
});

test("filter tabel dapat dikombinasikan dan direset", () => {
  const script = dashboardPage.match(
    /<script>\s*(function dashboard\(\)[\s\S]*?)\s*<\/script>/
  );
  assert.ok(script, "fungsi dashboard ditemukan");
  const createDashboard = vm.runInNewContext(`${script[1]}; dashboard;`);
  const state = createDashboard();

  state.user = { nomor: "6281" };
  state.data.siswa = [
    { nama: "Ani", nomor: "1", kelas: "7A", orangTua: "11", punyaFoto: true },
    { nama: "Budi", nomor: "2", kelas: "7A", orangTua: "22", punyaFoto: false },
  ];
  state.tables.students.classFilter = "7A";
  state.tables.students.photoFilter = "missing";
  assert.deepEqual(Array.from(state.filteredStudents, (row) => row.nama), ["Budi"]);

  state.report.rows = [
    { nama: "Ani", nomor: "1", kelas: "7A", masuk: "07:00", statusMasuk: "Tepat Waktu", statusPulang: "-", izin: "", buktiIzin: false },
    { nama: "Budi", nomor: "2", kelas: "7A", masuk: "-", statusMasuk: "-", statusPulang: "-", izin: "Sakit", buktiIzin: true },
  ];
  state.tables.report.statusFilter = "permission";
  assert.deepEqual(Array.from(state.filteredReport, (row) => row.nama), ["Budi"]);
  state.tables.permissions.evidenceFilter = "available";
  assert.deepEqual(Array.from(state.filteredPermissions, (row) => row.nama), ["Budi"]);

  state.data.kelas = [
    { nama: "7A", namaWali: "Wati", waliKelas: "6283", username: "wali.7a", jumlahSiswa: 2 },
    { nama: "7B", namaWali: "Dodi", waliKelas: "6284", username: "", jumlahSiswa: 0 },
  ];
  state.tables.classes.accountFilter = "missing";
  state.tables.classes.studentFilter = "empty";
  assert.deepEqual(Array.from(state.filteredClasses, (row) => row.nama), ["7B"]);

  state.data.admins = [
    { nama: "Admin Utama", nomor: "6281", username: "admin" },
    { nama: "Admin Lama", nomor: "6282", username: "" },
  ];
  state.tables.admins.accountFilter = "available";
  state.tables.admins.ownerFilter = "current";
  assert.deepEqual(Array.from(state.filteredAdmins, (row) => row.nama), ["Admin Utama"]);

  state.resetTableFilters("students");
  assert.equal(state.tables.students.classFilter, "");
  assert.equal(state.tables.students.photoFilter, "");
  assert.equal(state.tables.students.page, 1);
});
