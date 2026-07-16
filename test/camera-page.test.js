const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cameraPage = fs.readFileSync(
  path.join(__dirname, "..", "public", "camera.html"),
  "utf8"
);
const permissionPage = fs.readFileSync(
  path.join(__dirname, "..", "public", "permission.html"),
  "utf8"
);

test("halaman absensi mengambil foto dari kamera tanpa input galeri", () => {
  assert.match(cameraPage, /getUserMedia/);
  assert.match(cameraPage, /facingMode:\s*"user"/);
  assert.doesNotMatch(cameraPage, /<input[^>]+type=["']file["']/i);
});

test("halaman absensi mengirim foto bersama lokasi GPS", () => {
  assert.match(cameraPage, /getCurrentPosition/);
  assert.match(cameraPage, /attendance-camera/);
  assert.match(cameraPage, /JSON\.stringify\(\{ image: imageData, \.\.\.locationData \}\)/);
});

test("halaman izin memisahkan selfie kamera dan unggahan bukti", () => {
  assert.match(permissionPage, /getUserMedia/);
  assert.match(permissionPage, /permission-camera/);
  assert.match(permissionPage, /type="file"/);
  assert.match(permissionPage, /Tahap 2 dari 2/);
});

test("halaman izin mencatat GPS tanpa pemeriksaan radius sekolah", () => {
  assert.match(permissionPage, /getCurrentPosition/);
  assert.doesNotMatch(permissionPage, /ATTENDANCE_RADIUS_METERS|haversine/);
});

test("halaman kamera dan izin menggunakan Tailwind tanpa stylesheet manual", () => {
  for (const page of [cameraPage, permissionPage]) {
    assert.match(page, /cdn\.tailwindcss\.com/);
    assert.doesNotMatch(page, /<style>/);
  }
});
