const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDailyStudentStatus,
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
