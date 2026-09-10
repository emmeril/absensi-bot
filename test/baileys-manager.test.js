const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adaptIncomingMessage,
  sessionDefinitions,
  toAppUserId,
  toBaileysJid,
} = require("../lib/baileys-manager");

test("converts IDs between application and Baileys formats", () => {
  assert.equal(toAppUserId("628123456789:4@s.whatsapp.net"), "628123456789@c.us");
  assert.equal(toBaileysJid("628123456789@c.us"), "628123456789@s.whatsapp.net");
  assert.equal(toAppUserId("12345@lid"), "12345@lid");
});

test("creates one main session and one session per unique wali number", () => {
  const definitions = sessionDefinitions({
    "7A": {
      waliKelas: "628111@c.us",
      namaWali: "Bu Ana",
      siswa: { "628201@c.us": {} },
    },
    "7B": {
      waliKelas: "628111@c.us",
      namaWali: "Bu Ana",
      siswa: { "628202@c.us": {} },
    },
    "8A": {
      waliKelas: "628112@c.us",
      namaWali: "Pak Budi",
      siswa: {},
    },
  }, "628999");

  assert.deepEqual([...definitions.keys()], ["main", "wali:628111", "wali:628112"]);
  assert.deepEqual(definitions.get("wali:628111").classNames, ["7A", "7B"]);
  assert.deepEqual(definitions.get("wali:628111").studentNumbers, ["628201", "628202"]);
});

test("adapts text, location, forwarding metadata, and LID mapping", async () => {
  const sends = [];
  const socket = { sendMessage: async (...args) => sends.push(args) };
  const message = adaptIncomingMessage({
    key: { remoteJid: "12345@lid", fromMe: false },
    pushName: "Siswa",
    message: {
      locationMessage: {
        degreesLatitude: -6.7,
        degreesLongitude: 108.5,
        contextInfo: { isForwarded: true, forwardingScore: 1 },
      },
    },
  }, socket, new Map([["12345@lid", "628123456789@s.whatsapp.net"]]));

  assert.equal(message.from, "628123456789@c.us");
  assert.equal(message.type, "location");
  assert.deepEqual(message.location, {
    latitude: -6.7,
    longitude: 108.5,
    name: "",
    address: "",
  });
  assert.equal(message.isForwarded, true);
  await message.reply("ok");
  assert.deepEqual(sends, [["628123456789@s.whatsapp.net", { text: "ok" }]]);
});
