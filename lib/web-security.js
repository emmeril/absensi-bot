function normalizedAddress(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
  key = (req) => normalizedAddress(req.ip || req.socket?.remoteAddress),
  message = "Terlalu banyak permintaan. Coba lagi nanti.",
  now = Date.now,
} = {}) {
  const entries = new Map();

  return function rateLimiter(req, res, next) {
    const currentTime = now();
    const requestKey = String(key(req) || "unknown").slice(0, 256);
    let entry = entries.get(requestKey);
    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      entries.set(requestKey, entry);
    }
    entry.count += 1;

    while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

function serializeSessionCookie(token, { secure = false, maxAge = 28_800 } = {}) {
  const attributes = [
    `absensi_session=${encodeURIComponent(token || "")}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

module.exports = {
  createRateLimiter,
  serializeSessionCookie,
};
