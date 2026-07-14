function isPhoneUserId(id) {
  return /^\d+@c\.us$/.test(String(id || ""));
}

async function resolveWhatsappUserId(client, rawId, cache = new Map()) {
  const id = String(rawId || "");
  if (!id.endsWith("@lid")) return id;
  if (cache.has(id)) return cache.get(id);

  try {
    const mappings = await client.getContactLidAndPhone([id]);
    const mapping = mappings.find((item) => item?.lid === id) || mappings[0];
    const resolvedId = isPhoneUserId(mapping?.pn) ? mapping.pn : id;
    if (resolvedId !== id) cache.set(id, resolvedId);
    return resolvedId;
  } catch (error) {
    console.warn(`[WhatsApp ID] Gagal mengubah ${id} ke nomor telepon:`, error.message);
    return id;
  }
}

module.exports = { resolveWhatsappUserId };
