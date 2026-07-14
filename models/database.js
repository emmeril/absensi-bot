const fs = require("fs");
const path = require("path");
const { Sequelize, DataTypes } = require("sequelize");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "absensi.sqlite");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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

async function saveJsonData(key, value) {
  await JsonStore.upsert({ key, value });
}

async function closeDatabase() {
  await sequelize.close();
}

module.exports = {
  DB_PATH,
  JsonStore,
  closeDatabase,
  initJsonStore,
  saveJsonData,
  sequelize,
};
