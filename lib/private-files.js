const fs = require("fs");
const path = require("path");

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function writePrivateFile(filePath, data) {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function isManagedPath(filePath, rootPath) {
  if (!filePath) return false;
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
}

function deleteManagedFile(filePath, rootPath) {
  if (!isManagedPath(filePath, rootPath)) return false;
  try {
    fs.unlinkSync(path.resolve(filePath));
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

function moveManagedFile(oldPath, newPath, rootPath) {
  if (!isManagedPath(oldPath, rootPath) || !isManagedPath(newPath, rootPath)) {
    return false;
  }
  if (!fs.existsSync(oldPath)) return false;
  ensurePrivateDir(path.dirname(newPath));
  fs.renameSync(oldPath, newPath);
  fs.chmodSync(newPath, 0o600);
  return true;
}

function hardenPrivateTree(rootPath) {
  if (!fs.existsSync(rootPath)) return;
  ensurePrivateDir(rootPath);
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) hardenPrivateTree(entryPath);
    else if (entry.isFile()) fs.chmodSync(entryPath, 0o600);
  }
}

module.exports = {
  deleteManagedFile,
  ensurePrivateDir,
  hardenPrivateTree,
  isManagedPath,
  moveManagedFile,
  writePrivateFile,
};
