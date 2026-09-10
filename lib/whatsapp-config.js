const fs = require("fs");
const path = require("path");
const { LocalAuth } = require("whatsapp-web.js");

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} harus berupa true atau false.`);
}

function envInteger(name, fallback, minimum = 0) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} harus berupa bilangan bulat minimal ${minimum}.`);
  }
  return parsed;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function getBrowserEnvironment(environment = process.env) {
  const browserEnvironment = { ...environment };

  // PM2 can be restarted from an SSH session and inherit its user-session bus.
  // Chromium then registers itself in that transient systemd session and is
  // killed when SSH disconnects, even though the PM2 service remains online.
  for (const name of [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_ID",
  ]) {
    delete browserEnvironment[name];
  }

  return browserEnvironment;
}

function findChromiumExecutable(configuredPath, platform = process.platform) {
  if (configuredPath) return configuredPath;
  if (platform !== "linux") return undefined;
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ].find((candidate) => fs.existsSync(candidate));
}

function getWhatsappConfig() {
  const clientId = optionalEnv("WA_CLIENT_ID");
  if (clientId && !/^[-_\w]+$/i.test(clientId)) {
    throw new Error(
      "WA_CLIENT_ID hanya boleh berisi huruf, angka, underscore, dan tanda hubung."
    );
  }

  const browserName = optionalEnv("WA_BROWSER_NAME") || "Chrome";
  const validBrowsers = ["Chrome", "Firefox", "IE", "Opera", "Safari", "Edge"];
  if (!validBrowsers.includes(browserName)) {
    throw new Error(`WA_BROWSER_NAME harus salah satu dari: ${validBrowsers.join(", ")}.`);
  }

  const authDataPath = path.resolve(
    optionalEnv("WA_AUTH_DATA_PATH") || "./.wwebjs_auth"
  );
  const puppeteer = {
    headless: envBoolean("WA_HEADLESS", true),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    env: getBrowserEnvironment(),
  };
  const executablePath = findChromiumExecutable(optionalEnv("PUPPETEER_EXECUTABLE_PATH"));
  if (!executablePath) {
    throw new Error(
      "Chromium/Chrome tidak ditemukan. Atur PUPPETEER_EXECUTABLE_PATH ke executable browser."
    );
  }
  puppeteer.executablePath = executablePath;

  const options = {
    authStrategy: new LocalAuth({
      clientId,
      dataPath: authDataPath,
      rmMaxRetries: envInteger("WA_AUTH_RM_MAX_RETRIES", 4),
    }),
    authTimeoutMs: envInteger("WA_AUTH_TIMEOUT_MS", 60000, 1),
    qrMaxRetries: envInteger("WA_QR_MAX_RETRIES", 0),
    takeoverOnConflict: envBoolean("WA_TAKEOVER_ON_CONFLICT", false),
    takeoverTimeoutMs: envInteger("WA_TAKEOVER_TIMEOUT_MS", 0),
    deviceName: optionalEnv("WA_DEVICE_NAME") || "Ruang Hadir",
    browserName,
    puppeteer,
  };

  const webVersion = optionalEnv("WA_WEB_VERSION");
  if (webVersion) {
    options.webVersion = webVersion;
    options.webVersionCache = {
      type: "local",
      path: optionalEnv("WA_WEB_CACHE_PATH") || "./.wwebjs_cache/",
      strict: false,
    };
  }

  const ffmpegPath = optionalEnv("WA_FFMPEG_PATH");
  if (ffmpegPath) options.ffmpegPath = ffmpegPath;

  return options;
}

module.exports = { findChromiumExecutable, getBrowserEnvironment, getWhatsappConfig };
