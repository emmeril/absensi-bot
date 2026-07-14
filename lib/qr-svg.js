const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

function qrToSvg(value, scale = 8, margin = 4) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(String(value));
  qr.make();

  const moduleCount = qr.getModuleCount();
  const size = (moduleCount + margin * 2) * scale;
  const cells = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        cells.push(
          `<rect x="${(column + margin) * scale}" y="${
            (row + margin) * scale
          }" width="${scale}" height="${scale}"/>`
        );
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" role="img" aria-label="QR WhatsApp">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<g fill="#000">${cells.join("")}</g></svg>`
  );
}

module.exports = { qrToSvg };
