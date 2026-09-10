const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DB_PATH = ":memory:";
const {
  Attendance,
  NotificationOutbox,
  attendanceForDate,
  attendanceStatus,
  claimNextNotification,
  closeDatabase,
  createAttendance,
  enqueueNotifications,
  initJsonStore,
  markNotificationSent,
  migrateLegacyAttendance,
  notificationOutboxStats,
  recoverNotificationOutbox,
  renameAttendanceStudent,
  renamePendingNotificationRecipient,
  withDatabaseTransaction,
} = require("../models/database");

test("migrasi absensi legacy menghasilkan baris terstruktur dan tetap idempoten", async (t) => {
  t.after(closeDatabase);
  await initJsonStore({ storage: { path: "missing-storage.json", fallback: {} } });
  const legacy = {
    "2026-09-10": {
      "621@c.us": {
        masuk: {
          waktu: "07:00:00",
          status: "Tepat Waktu",
          lokasi: { latitude: -6.7, longitude: 108.5 },
          nama: "Siswa",
          kelas: "A",
          waliKelas: "629@c.us",
        },
        pulang: { waktu: "14:00:00", status: "Sesuai Waktu" },
      },
    },
  };

  await migrateLegacyAttendance(legacy);
  await migrateLegacyAttendance(legacy);
  assert.equal(await Attendance.count(), 2);
  assert.deepEqual(await attendanceStatus("2026-09-10", "621@c.us"), {
    masuk: true,
    pulang: true,
  });
  const day = await attendanceForDate("2026-09-10");
  assert.equal(day["621@c.us"].masuk.nama, "Siswa");

  await renameAttendanceStudent("621@c.us", "622@c.us");
  assert.equal((await attendanceStatus("2026-09-10", "621@c.us")).masuk, false);
  assert.equal((await attendanceStatus("2026-09-10", "622@c.us")).masuk, true);

  await assert.rejects(
    createAttendance({
      tanggal: "2026-09-10",
      siswaId: "622@c.us",
      tipe: "masuk",
      waktu: "07:01:00",
    }),
    (error) => error.name === "SequelizeUniqueConstraintError"
  );

  await enqueueNotifications([
    {
      botKey: "wali:629",
      recipientId: "622@c.us",
      text: "konfirmasi",
      priority: 10,
      dedupeKey: "attendance:confirmation",
    },
    {
      botKey: "wali:629",
      recipientId: "629@c.us",
      text: "notifikasi",
      dedupeKey: "attendance:teacher",
    },
  ]);

  await renamePendingNotificationRecipient("622@c.us", "623@c.us");

  const first = await claimNextNotification();
  assert.equal(first.text, "konfirmasi");
  assert.equal(first.recipientId, "623@c.us");
  assert.equal(first.attempts, 1);
  await markNotificationSent(first.id);

  const interrupted = await claimNextNotification();
  assert.equal(interrupted.status, "processing");
  await recoverNotificationOutbox();
  const resumed = await claimNextNotification();
  assert.equal(resumed.id, interrupted.id);
  assert.equal(resumed.attempts, 2);

  const stats = await notificationOutboxStats();
  assert.equal(stats.sent, 1);
  assert.equal(stats.processing, 1);
  assert.equal(await NotificationOutbox.count(), 2);

  const attendanceBeforeRollback = await Attendance.count();
  const outboxBeforeRollback = await NotificationOutbox.count();
  await assert.rejects(
    withDatabaseTransaction(async (transaction) => {
      await createAttendance({
        tanggal: "2026-09-11",
        siswaId: "622@c.us",
        tipe: "masuk",
        waktu: "07:00:00",
      }, { transaction });
      await enqueueNotifications([{
        botKey: "wali:629",
        recipientId: "622@c.us",
        text: "rollback",
      }], { transaction });
      throw new Error("rollback");
    }),
    /rollback/
  );
  assert.equal(await Attendance.count(), attendanceBeforeRollback);
  assert.equal(await NotificationOutbox.count(), outboxBeforeRollback);
});
