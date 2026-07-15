function validateLocationMessage(msg) {
  if (msg?.type !== "location" || !msg.location) {
    return { valid: false, reason: "not_location" };
  }

  if (msg.isForwarded || Number(msg.forwardingScore) > 0) {
    return { valid: false, reason: "forwarded" };
  }

  const { latitude, longitude, name, address } = msg.location;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { valid: false, reason: "invalid_coordinates" };
  }

  // WhatsApp adds place details when a searched place or map pin is shared.
  if (String(name || "").trim() || String(address || "").trim()) {
    return { valid: false, reason: "place_pin" };
  }

  return {
    valid: true,
    location: { latitude, longitude },
  };
}

function locationRejectionMessage(reason) {
  if (reason === "forwarded") {
    return "❌ Lokasi yang diteruskan tidak dapat digunakan. Kirim lokasi kamu langsung dari WhatsApp.";
  }
  if (reason === "place_pin") {
    return "❌ Pin atau lokasi tempat tidak dapat digunakan. Pilih *Kirim lokasi Anda saat ini* di WhatsApp.";
  }
  return "❌ Data lokasi tidak valid. Aktifkan GPS lalu kirim ulang lokasi kamu dari WhatsApp.";
}

module.exports = { validateLocationMessage, locationRejectionMessage };
