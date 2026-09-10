const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deleteManagedFile,
  isManagedPath,
  writePrivateFile,
} = require("../lib/private-files");

test("file sensitif ditulis privat dan hanya dihapus di dalam direktori terkelola", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "absensi-private-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "nested", "photo.jpg");
  writePrivateFile(file, Buffer.from("photo"));
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(isManagedPath(file, root), true);
  assert.equal(isManagedPath(path.join(root, "..", "outside.jpg"), root), false);
  assert.equal(deleteManagedFile(path.join(root, "..", "outside.jpg"), root), false);
  assert.equal(deleteManagedFile(file, root), true);
});
