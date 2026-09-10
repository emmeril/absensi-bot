const fs = require("fs");
const path = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");

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

const Attendance = sequelize.define(
  "Attendance",
  {
    tanggal: { type: DataTypes.STRING(10), allowNull: false },
    siswaId: { type: DataTypes.STRING, allowNull: false },
    tipe: { type: DataTypes.STRING(10), allowNull: false },
    waktu: { type: DataTypes.STRING(8), allowNull: false },
    lokasi: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    fotoPath: { type: DataTypes.STRING, allowNull: true },
    fotoMimeType: { type: DataTypes.STRING, allowNull: true },
    fotoSize: { type: DataTypes.INTEGER, allowNull: true },
    nama: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    kelas: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    waliKelas: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
  },
  {
    tableName: "attendance_records",
    indexes: [
      { unique: true, fields: ["tanggal", "siswaId", "tipe"] },
      { fields: ["tanggal"] },
      { fields: ["siswaId"] },
    ],
  }
);

const NotificationOutbox = sequelize.define(
  "NotificationOutbox",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    botKey: { type: DataTypes.STRING, allowNull: false },
    recipientId: { type: DataTypes.STRING, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "text" },
    text: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    mediaPath: { type: DataTypes.STRING, allowNull: true },
    mimetype: { type: DataTypes.STRING, allowNull: true },
    filename: { type: DataTypes.STRING, allowNull: true },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    availableAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    dedupeKey: { type: DataTypes.STRING, allowNull: true, unique: true },
  },
  {
    tableName: "notification_outbox",
    indexes: [
      { fields: ["status", "availableAt", "priority"] },
      { fields: ["createdAt"] },
    ],
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
  if (DB_PATH !== ":memory:") await sequelize.query("PRAGMA journal_mode=WAL");
  await sequelize.query("PRAGMA busy_timeout=5000");
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

async function saveJsonBatch(values, options = {}) {
  const save = async (transaction) => {
    for (const [key, value] of Object.entries(values)) {
      await JsonStore.upsert({ key, value }, { transaction });
    }
  };
  if (options.transaction) await save(options.transaction);
  else await sequelize.transaction(save);
  hardenDatabaseFiles();
}

function attendanceRow(record) {
  return {
    tanggal: record.tanggal,
    siswaId: record.siswaId,
    tipe: record.tipe,
    waktu: record.waktu,
    lokasi: record.lokasi || {},
    status: record.status || "",
    fotoPath: record.fotoPath || null,
    fotoMimeType: record.fotoMimeType || null,
    fotoSize: Number.isFinite(record.fotoSize) ? record.fotoSize : null,
    nama: record.nama || "",
    kelas: record.kelas || "",
    waliKelas: record.waliKelas || "",
  };
}

function attendanceRecord(row) {
  const value = row.get ? row.get({ plain: true }) : row;
  return {
    waktu: value.waktu,
    lokasi: value.lokasi || {},
    status: value.status || "",
    fotoPath: value.fotoPath || undefined,
    fotoMimeType: value.fotoMimeType || undefined,
    fotoSize: value.fotoSize ?? undefined,
    nama: value.nama || "",
    kelas: value.kelas || "",
    waliKelas: value.waliKelas || "",
  };
}

async function attendanceForDate(tanggal, options = {}) {
  const rows = await Attendance.findAll({
    where: { tanggal },
    transaction: options.transaction,
    order: [["siswaId", "ASC"], ["tipe", "ASC"]],
  });
  const result = {};
  for (const row of rows) {
    result[row.siswaId] ||= {};
    result[row.siswaId][row.tipe] = attendanceRecord(row);
  }
  return result;
}

async function attendanceStatus(tanggal, siswaId, options = {}) {
  const rows = await Attendance.findAll({
    attributes: ["tipe"],
    where: { tanggal, siswaId },
    transaction: options.transaction,
  });
  return {
    masuk: rows.some((row) => row.tipe === "masuk"),
    pulang: rows.some((row) => row.tipe === "pulang"),
  };
}

async function createAttendance(record, options = {}) {
  return Attendance.create(attendanceRow(record), {
    transaction: options.transaction,
  });
}

async function renameAttendanceStudent(oldId, newId, options = {}) {
  if (!oldId || oldId === newId) return 0;
  const [affected] = await Attendance.update(
    { siswaId: newId },
    { where: { siswaId: oldId }, transaction: options.transaction }
  );
  return affected;
}

async function renamePendingNotificationRecipient(oldId, newId, options = {}) {
  if (!oldId || oldId === newId) return 0;
  const [affected] = await NotificationOutbox.update(
    { recipientId: newId },
    {
      where: { recipientId: oldId, status: "pending" },
      transaction: options.transaction,
    }
  );
  return affected;
}

async function fillAttendanceSnapshot(siswaId, snapshot, options = {}) {
  let affected = 0;
  for (const field of ["nama", "kelas", "waliKelas"]) {
    if (!snapshot?.[field]) continue;
    const [count] = await Attendance.update(
      { [field]: snapshot[field] },
      {
        where: { siswaId, [field]: "" },
        transaction: options.transaction,
      }
    );
    affected += count;
  }
  return affected;
}

async function migrateLegacyAttendance(storage) {
  const rows = [];
  for (const [tanggal, students] of Object.entries(storage || {})) {
    for (const [siswaId, attendance] of Object.entries(students || {})) {
      for (const tipe of ["masuk", "pulang"]) {
        const record = attendance?.[tipe];
        if (!record?.waktu) continue;
        rows.push(attendanceRow({ tanggal, siswaId, tipe, ...record }));
      }
    }
  }
  if (!rows.length) return 0;
  const migrated = await sequelize.transaction(async (transaction) => {
    await Attendance.bulkCreate(rows, { ignoreDuplicates: true, transaction });
    const dates = [...new Set(rows.map((row) => row.tanggal))];
    const persisted = await Attendance.findAll({
      attributes: ["tanggal", "siswaId", "tipe"],
      where: { tanggal: { [Op.in]: dates } },
      raw: true,
      transaction,
    });
    const persistedKeys = new Set(
      persisted.map((row) => `${row.tanggal}\u0000${row.siswaId}\u0000${row.tipe}`)
    );
    return rows.filter((row) =>
      persistedKeys.has(`${row.tanggal}\u0000${row.siswaId}\u0000${row.tipe}`)
    ).length;
  });
  hardenDatabaseFiles();
  return migrated;
}

function normalizeOutboxJob(job) {
  return {
    botKey: String(job.botKey || ""),
    recipientId: String(job.recipientId || ""),
    kind: job.kind === "image" ? "image" : "text",
    text: String(job.text || ""),
    mediaPath: job.mediaPath || null,
    mimetype: job.mimetype || null,
    filename: job.filename || null,
    priority: Number(job.priority) || 0,
    status: "pending",
    attempts: 0,
    availableAt: job.availableAt || new Date(),
    dedupeKey: job.dedupeKey || null,
  };
}

async function enqueueNotifications(jobs, options = {}) {
  const values = (jobs || [])
    .filter((job) => job?.botKey && job?.recipientId)
    .map(normalizeOutboxJob);
  if (!values.length) return [];
  return NotificationOutbox.bulkCreate(values, {
    transaction: options.transaction,
    ignoreDuplicates: true,
  });
}

async function recoverNotificationOutbox() {
  await NotificationOutbox.update(
    { status: "pending", availableAt: new Date() },
    { where: { status: "processing" } }
  );
}

async function claimNextNotification() {
  return sequelize.transaction(async (transaction) => {
    const job = await NotificationOutbox.findOne({
      where: { status: "pending", availableAt: { [Op.lte]: new Date() } },
      order: [["priority", "DESC"], ["createdAt", "ASC"]],
      transaction,
    });
    if (!job) return null;
    const [claimed] = await NotificationOutbox.update(
      { status: "processing", attempts: job.attempts + 1 },
      { where: { id: job.id, status: "pending" }, transaction }
    );
    if (!claimed) return null;
    job.status = "processing";
    job.attempts += 1;
    return job.get({ plain: true });
  });
}

async function markNotificationSent(id) {
  await NotificationOutbox.update(
    { status: "sent", lastError: null },
    { where: { id } }
  );
}

async function rescheduleNotification(id, { error, availableAt, failed = false }) {
  await NotificationOutbox.update(
    {
      status: failed ? "failed" : "pending",
      lastError: String(error?.message || error || "Gagal mengirim").slice(0, 2000),
      availableAt,
    },
    { where: { id } }
  );
}

async function notificationOutboxStats() {
  const rows = await NotificationOutbox.findAll({
    attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
    group: ["status"],
    raw: true,
  });
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function cancelNotificationsForMediaPaths(paths, options = {}) {
  if (!paths?.length) return 0;
  return NotificationOutbox.destroy({
    where: {
      mediaPath: { [Op.in]: paths },
      status: { [Op.in]: ["pending", "processing"] },
    },
    transaction: options.transaction,
  });
}

async function purgeSentNotifications(before) {
  return NotificationOutbox.destroy({
    where: { status: "sent", updatedAt: { [Op.lt]: before } },
  });
}

async function withDatabaseTransaction(work) {
  return sequelize.transaction(work);
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
  Attendance,
  JsonStore,
  NotificationOutbox,
  attendanceForDate,
  attendanceStatus,
  cancelNotificationsForMediaPaths,
  claimNextNotification,
  closeDatabase,
  compactDatabase,
  createAttendance,
  enqueueNotifications,
  fillAttendanceSnapshot,
  initJsonStore,
  markNotificationSent,
  migrateLegacyAttendance,
  notificationOutboxStats,
  purgeSentNotifications,
  recoverNotificationOutbox,
  renameAttendanceStudent,
  renamePendingNotificationRecipient,
  rescheduleNotification,
  saveJsonBatch,
  sequelize,
  withDatabaseTransaction,
};
