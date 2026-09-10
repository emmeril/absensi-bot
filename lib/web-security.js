const crypto = require("crypto");

function normalizedAddress(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function isLoopbackAddress(value) {
  const address = normalizedAddress(value);
  return address === "127.0.0.1" || address === "::1";
}

function requestHostname(req) {
  const host = String(req.headers?.host || "").trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
}

function isLocalQrRequest(req) {
  const hostname = requestHostname(req);
  return (
    !req.headers?.["x-forwarded-for"] &&
    isLoopbackAddress(req.socket?.remoteAddress) &&
    ["localhost", "127.0.0.1", "::1"].includes(hostname)
  );
}

function timingSafeTextEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function authorizationSecret(req) {
  const authorization = String(req.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  if (!authorization.startsWith("Basic ")) return "";

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return "";
  }
}

function isQrRequestAllowed(req, configuredSecret = process.env.QR_ACCESS_TOKEN) {
  if (isLocalQrRequest(req)) return true;
  const secret = String(configuredSecret || "");
  return secret.length >= 16 && timingSafeTextEqual(authorizationSecret(req), secret);
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
  isLocalQrRequest,
  isQrRequestAllowed,
  serializeSessionCookie,
};
