const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findChromiumExecutable,
  getBrowserEnvironment,
} = require("../lib/whatsapp-config");

test("Chromium does not inherit a transient SSH desktop session", () => {
  const environment = getBrowserEnvironment({
    PATH: "/usr/bin",
    HOME: "/root",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
    XDG_RUNTIME_DIR: "/run/user/0",
    XDG_SESSION_ID: "123",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/root",
  });
});

test("konfigurasi eksplisit Chromium tetap diprioritaskan", () => {
  assert.equal(
    findChromiumExecutable("/opt/chrome/chrome", "linux"),
    "/opt/chrome/chrome"
  );
  assert.equal(findChromiumExecutable(undefined, "win32"), undefined);
});
