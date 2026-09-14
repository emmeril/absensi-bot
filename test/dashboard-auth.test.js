const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashPassword,
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  verifyPassword,
} = require("../lib/dashboard-auth");

test("username dashboard dinormalisasi dan divalidasi", () => {
  assert.equal(normalizeUsername("  Admin.Sekolah  "), "admin.sekolah");
  assert.equal(isValidUsername("wali_kelas-7a"), true);
  assert.equal(isValidUsername("ab"), false);
  assert.equal(isValidUsername("wali kelas"), false);
});

test("password dashboard disimpan sebagai hash scrypt", async () => {
  const password = "rahasia-kuat-123";
  assert.equal(isValidPassword(password), true);
  const encoded = await hashPassword(password);
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword("password-salah", encoded), false);
  assert.equal(await verifyPassword(password, "format-rusak"), false);
});
