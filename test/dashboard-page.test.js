const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
