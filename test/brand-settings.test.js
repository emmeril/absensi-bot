const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../index.js"), "utf8");

function brandHelpers(stored, existingFiles = new Set()) {
  const context = {
    BRAND_PATH: "brand",
    BRAND_LOGO_DIR: "brand-files",
    DEFAULT_BRAND: { name: "Ruang Hadir", logoFile: "", logoMimeType: "" },
    loadJSON: () => stored,
    path,
    fs: { existsSync: (filePath) => existingFiles.has(filePath) },
  };
  vm.runInNewContext(
    source.slice(
      source.indexOf("function normalizeBrandName"),
      source.indexOf("async function updateJSON")
    ),
    context
  );
  return context;
}

test("nama brand dinormalisasi dan dibatasi", () => {
  const context = brandHelpers({});
  assert.equal(context.normalizeBrandName("  Sekolah   Hebat  "), "Sekolah Hebat");
  assert.equal(context.normalizeBrandName("A"), "");
  assert.equal(context.normalizeBrandName("A".repeat(61)), "");
});

test("logo brand hanya memakai nama file terkelola", () => {
  const valid = {
    name: "Sekolah Hebat",
    logoFile: "logo-0123456789abcdef.png",
    logoMimeType: "image/png",
  };
  const logoPath = path.join("brand-files", valid.logoFile);
  let context = brandHelpers(valid, new Set([logoPath]));
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.publicBrandSettings())),
    {
      name: "Sekolah Hebat",
      hasLogo: true,
      logoUrl: "/api/brand/logo?v=logo-0123456789abcdef",
    }
  );

  context = brandHelpers({
    name: "Sekolah Hebat",
    logoFile: "../logo.png",
    logoMimeType: "image/png",
  });
  assert.equal(context.loadBrandSettings().logoFile, "");
  assert.equal(context.publicBrandSettings().hasLogo, false);
});

test("brand publik dapat dibaca tanpa login dan perubahan dibatasi untuk admin", () => {
  const authGate = source.indexOf('app.use("/api", requireWebAuth)');
  assert.ok(source.indexOf('app.get("/api/brand"') < authGate);
  assert.ok(source.indexOf('app.get("/api/brand/logo"') < authGate);
  assert.ok(source.indexOf('app.post(\n  "/api/settings/brand"') > authGate);
  assert.match(source, /"\/api\/settings\/brand",\s+requireWebAdmin,\s+upload\.single\("logo"\)/);
  assert.match(source, /app\.delete\("\/api\/settings\/brand\/logo", requireWebAdmin/);
  assert.match(source, /await validateImageBuffer\(req\.file\.buffer\)/);
  assert.match(source, /createHash\("sha256"\)/);
});
