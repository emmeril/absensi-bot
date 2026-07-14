const test = require("node:test");
const assert = require("node:assert/strict");
const { qrToSvg } = require("../lib/qr-svg");

test("renders QR data locally as an SVG", () => {
  const svg = qrToSvg("private-pairing-token");

  assert.match(svg, /^<svg /);
  assert.match(svg, /<rect /);
  assert.doesNotMatch(svg, /private-pairing-token/);
  assert.doesNotMatch(svg, /api\.qrserver\.com/);
});
