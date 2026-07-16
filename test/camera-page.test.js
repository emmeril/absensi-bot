const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cameraPage = fs.readFileSync(
  path.join(__dirname, "..", "public", "camera.html"),
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
