const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidUsername(value) {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

function isValidPassword(value) {
  const length = String(value || "").length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

function encodeHash(salt, derivedKey) {
  return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

async function hashPassword(password) {
  if (!isValidPassword(password)) {
    throw new Error(
      `Password harus ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} karakter.`
    );
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(String(password), salt, 64);
  return encodeHash(salt, derivedKey);
}

function hashPasswordSync(password) {
  if (!isValidPassword(password)) {
    throw new Error(
      `Password harus ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} karakter.`
    );
  }
  const salt = crypto.randomBytes(16);
  return encodeHash(salt, crypto.scryptSync(String(password), salt, 64));
}

async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex, extra] = String(encoded || "").split("$");
  if (
    algorithm !== "scrypt" ||
    extra !== undefined ||
    !/^[a-f0-9]{32}$/i.test(saltHex || "") ||
    !/^[a-f0-9]{128}$/i.test(hashHex || "")
  ) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(String(password || ""), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  hashPasswordSync,
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  verifyPassword,
};
