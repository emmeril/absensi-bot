function isPhoneUserId(id) {
  return /^\d+@c\.us$/.test(String(id || ""));
}

function isLidUserId(id) {
  return /^\d+@lid$/.test(String(id || ""));
}

function serializedId(value) {
  if (typeof value === "string") return value;
  return value?._serialized || value?.id?._serialized || "";
}

const DEFAULT_TIMEOUT_MS = 4000;

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
      else {
        cache.set(id, resolvedId);
        cache.set(resolvedId, id);
      }
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

async function resolveWhatsappRecipientId(
  client,
  rawId,
  cache = new Map(),
  {
    pending = new Map(),
    failures = new Map(),
    timeoutMs = 5000,
    failureTtlMs = 5 * 60_000,
  } = {}
) {
  const id = String(rawId || "");
  if (!isPhoneUserId(id)) return id;

  const cached = cache.get(id);
  if (isLidUserId(cached)) return cached;

  const failure = failures.get(id);
  if (failure?.expiresAt > Date.now()) {
    if (failure.code === "WA_RECIPIENT_NOT_REGISTERED") {
      const error = new Error("Nomor tidak terdaftar di WhatsApp");
      error.code = failure.code;
      throw error;
    }
    return id;
  }
  failures.delete(id);

  const pendingKey = `recipient:${id}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey);

  let timeout;
  const lookupOperation = (async () => {
    const registered = await client.getNumberId(id);
    const registeredId = serializedId(registered);
    if (!registeredId) {
      const error = new Error("Nomor tidak terdaftar di WhatsApp");
      error.code = "WA_RECIPIENT_NOT_REGISTERED";
      throw error;
    }

    if (isLidUserId(registeredId)) {
      cache.set(id, registeredId);
      cache.set(registeredId, id);
      return registeredId;
    }

    try {
      const mappings = await client.getContactLidAndPhone([registeredId]);
      const mapping = Array.isArray(mappings) ? mappings[0] : null;
      if (isLidUserId(mapping?.lid)) {
        cache.set(id, mapping.lid);
        cache.set(mapping.lid, id);
        return mapping.lid;
      }
    } catch {
      // Some valid numbers do not expose an LID until the first chat exists.
    }

    return registeredId;
  })();
  const lookup = Promise.race([
    lookupOperation,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`lookup recipient melebihi ${timeoutMs} ms`);
        error.code = "WA_RECIPIENT_LOOKUP_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ])
    .catch((error) => {
      failures.set(id, {
        code: error.code || "WA_RECIPIENT_LOOKUP_FAILED",
        expiresAt: Date.now() + failureTtlMs,
      });
      if (error.code === "WA_RECIPIENT_NOT_REGISTERED") throw error;
      console.warn(`[WhatsApp ID] Gagal mencari recipient ${id}:`, error.message);
      return id;
    })
    .finally(() => {
      clearTimeout(timeout);
      pending.delete(pendingKey);
    });

  pending.set(pendingKey, lookup);
  return lookup;
}

module.exports = { resolveWhatsappRecipientId, resolveWhatsappUserId };
