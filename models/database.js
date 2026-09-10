const fs = require("fs");
const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "absensi.sqlite");
const DB_DIR = DB_PATH === ":memory:" ? null : path.dirname(path.resolve(DB_PATH));

if (DB_DIR) {
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DB_DIR, 0o700);
}

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: DB_PATH,
  logging: false,
});

const JsonStore = sequelize.define(
  "JsonStore",
  {
    key: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    value: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
  },
  {
    tableName: "json_store",
  }
);

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[DB] Gagal baca ${filePath}:`, error.message);
    return fallback;
  }
}

async function initJsonStore(stores) {
  await sequelize.authenticate();
  hardenDatabaseFiles();
  await sequelize.sync();

  for (const [key, config] of Object.entries(stores)) {
    const existing = await JsonStore.findByPk(key);
    if (existing) continue;

    await JsonStore.create({
      key,
      value: readJsonFile(config.path, config.fallback),
    });
  }

  const rows = await JsonStore.findAll();
  return rows.reduce((cache, row) => {
    cache[row.key] = row.value;
    return cache;
  }, {});
}

async function saveJsonBatch(values) {
  await sequelize.transaction(async (transaction) => {
    for (const [key, value] of Object.entries(values)) {
      await JsonStore.upsert({ key, value }, { transaction });
    }
  });
  hardenDatabaseFiles();
}

function hardenDatabaseFiles() {
  for (const filePath of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (filePath !== ":memory:" && fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  }
}

async function closeDatabase() {
  await sequelize.close();
}

async function compactDatabase() {
  if (DB_PATH === ":memory:") return;
  await sequelize.query("PRAGMA wal_checkpoint(TRUNCATE)");
  await sequelize.query("VACUUM");
  hardenDatabaseFiles();
}

module.exports = {
  DB_PATH,
  JsonStore,
  closeDatabase,
  compactDatabase,
  initJsonStore,
  saveJsonBatch,
  sequelize,
};
