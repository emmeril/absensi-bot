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
