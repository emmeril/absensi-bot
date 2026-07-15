const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDailyStudentStatus,
  getArrivalStatus,
  isWithinAttendanceWindow,
  validateAttendance,
  validatePermission,
} = require("../lib/attendance-rules");

const tanggal = "2026-07-15";
const siswaId = "628123456789@c.us";

test("absen masuk dan pulang masing-masing hanya dapat dilakukan sekali", () => {
  const status = getDailyStudentStatus(
    { [tanggal]: { [siswaId]: { masuk: {}, pulang: {} } } },
    {},
    tanggal,
    siswaId
  );

  assert.match(validateAttendance(status, "masuk"), /satu kali/);
  assert.match(validateAttendance(status, "pulang"), /satu kali/);
});

test("toleransi masuk memperpanjang batas status tepat waktu", () => {
  assert.equal(getArrivalStatus("07:10:00", "07:00:00", 10), "Tepat Waktu");
  assert.equal(getArrivalStatus("07:10:01", "07:00:00", 10), "Terlambat");
  assert.equal(getArrivalStatus("07:00:01", "07:00:00"), "Terlambat");
});

test("absensi hanya diterima di dalam rentang waktu yang diatur", () => {
  assert.equal(isWithinAttendanceWindow("06:00:00", "06:00", "07:00"), true);
  assert.equal(isWithinAttendanceWindow("07:00:00", "06:00", "07:00"), true);
  assert.equal(isWithinAttendanceWindow("05:59:59", "06:00", "07:00"), false);
  assert.equal(isWithinAttendanceWindow("07:00:01", "06:00", "07:00"), false);
  assert.equal(isWithinAttendanceWindow("16:00:00", "15:00", "17:00"), true);
});

test("siswa yang sudah izin tidak dapat absen masuk atau pulang", () => {
  const status = getDailyStudentStatus(
    {},
    { [tanggal]: { [siswaId]: { alasan: "Sakit" } } },
    tanggal,
    siswaId
  );

  assert.match(validateAttendance(status, "masuk"), /sudah mengajukan izin/);
  assert.match(validateAttendance(status, "pulang"), /sudah mengajukan izin/);
});

test("izin hanya sekali dan tidak dapat diajukan setelah melakukan absensi", () => {
  const sudahIzin = { masuk: false, pulang: false, izin: true };
  const sudahAbsen = { masuk: true, pulang: false, izin: false };

  assert.match(validatePermission(sudahIzin), /satu kali/);
  assert.match(validatePermission(sudahAbsen), /sudah melakukan absensi/);
});

test("status kosong mengizinkan absensi dan izin", () => {
  const status = getDailyStudentStatus({}, {}, tanggal, siswaId);

  assert.equal(validateAttendance(status, "masuk"), null);
  assert.equal(validateAttendance(status, "pulang"), null);
  assert.equal(validatePermission(status), null);
});
