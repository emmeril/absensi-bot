const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRateLimiter,
  isQrRequestAllowed,
  serializeSessionCookie,
} = require("../lib/web-security");

function request({ address = "203.0.113.10", host = "attendance.example", authorization } = {}) {
  return {
    ip: address,
    socket: { remoteAddress: address },
    headers: { host, ...(authorization ? { authorization } : {}) },
  };
}

test("QR hanya terbuka secara lokal atau dengan bootstrap secret", () => {
  const secret = "rahasia-yang-panjang";
  assert.equal(
    isQrRequestAllowed(request({ address: "127.0.0.1", host: "localhost:3200" }), ""),
    true
  );
  const proxiedLocal = request({ address: "127.0.0.1", host: "localhost:3200" });
  proxiedLocal.headers["x-forwarded-for"] = "203.0.113.10";
  assert.equal(isQrRequestAllowed(proxiedLocal, ""), false);
  assert.equal(isQrRequestAllowed(request(), secret), false);
  const basic = `Basic ${Buffer.from(`operator:${secret}`).toString("base64")}`;
  assert.equal(isQrRequestAllowed(request({ authorization: basic }), secret), true);
  assert.equal(
    isQrRequestAllowed(request({ authorization: "Bearer salah" }), secret),
    false
  );
});

test("rate limiter membatasi jumlah request per sumber", () => {
  let currentTime = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => currentTime });
  const req = request();
  const response = () => ({
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  let nextCalls = 0;
  let res = response();
  limiter(req, res, () => { nextCalls += 1; });
  limiter(req, res, () => { nextCalls += 1; });
  res = response();
  limiter(req, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 2);
  assert.equal(res.statusCode, 429);
  currentTime += 1_001;
  limiter(req, response(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 3);
});

test("cookie sesi produksi menggunakan atribut keamanan", () => {
  const cookie = serializeSessionCookie("token value", { secure: true });
  assert.match(cookie, /absensi_session=token%20value/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});
