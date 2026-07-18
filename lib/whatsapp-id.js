function isPhoneUserId(id) {
  return /^\d+@c\.us$/.test(String(id || ""));
}

const DEFAULT_TIMEOUT_MS = 1500;

async function resolveWhatsappUserId(
  client,
  rawId,
  cache = new Map(),
  {
    pending = new Map(),
    failures = new Map(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    failureTtlMs = 30_000,
  } = {}
) {
  const id = String(rawId || "");
  if (!id.endsWith("@lid")) return id;
  if (cache.has(id)) return cache.get(id);
  if ((failures.get(id) || 0) > Date.now()) return id;
  failures.delete(id);
  if (pending.has(id)) return pending.get(id);

  let timeout;
  const lookup = Promise.race([
    client.getContactLidAndPhone([id]),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`lookup melebihi ${timeoutMs} ms`);
        error.code = "LID_LOOKUP_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ])
    .then((mappings) => {
      const items = Array.isArray(mappings) ? mappings : [];
      const mapping = items.find((item) => item?.lid === id) || items[0];
      const resolvedId = isPhoneUserId(mapping?.pn) ? mapping.pn : id;
      if (resolvedId === id) failures.set(id, Date.now() + failureTtlMs);
      else cache.set(id, resolvedId);
      return resolvedId;
    })
    .catch((error) => {
      console.warn(`[WhatsApp ID] Gagal mengubah ${id} ke nomor telepon:`, error.message);
      failures.set(id, Date.now() + failureTtlMs);
      return id;
    })
    .finally(() => {
      clearTimeout(timeout);
      pending.delete(id);
    });

  pending.set(id, lookup);
  return lookup;
}

module.exports = { resolveWhatsappUserId };
