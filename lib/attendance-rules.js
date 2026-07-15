function getDailyStudentStatus(storage, izin, tanggal, siswaId) {
  const attendance = storage[tanggal]?.[siswaId] || {};

  return {
    masuk: Boolean(attendance.masuk),
    pulang: Boolean(attendance.pulang),
    izin: Boolean(izin[tanggal]?.[siswaId]),
  };
}

function validateAttendance(status, tipe) {
  if (status.izin) {
    return "Kamu sudah mengajukan izin hari ini, jadi tidak bisa absen masuk atau pulang.";
  }
  if (status[tipe]) {
    return `Kamu sudah absen ${tipe} hari ini. Absen ${tipe} hanya bisa dilakukan satu kali.`;
  }
  return null;
}

function validatePermission(status) {
  if (status.izin) {
    return "Kamu sudah mengajukan izin hari ini. Izin hanya bisa dilakukan satu kali.";
  }
  if (status.masuk || status.pulang) {
    return "Kamu sudah melakukan absensi hari ini, jadi tidak bisa mengajukan izin.";
  }
  return null;
}

function getArrivalStatus(waktu, jamMasuk, toleransiMenit = 0) {
  const toSeconds = (value) => {
    const [hours = 0, minutes = 0, seconds = 0] = String(value)
      .split(":")
      .map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  };
  const tolerance = Math.max(0, Number(toleransiMenit) || 0) * 60;

  return toSeconds(waktu) <= toSeconds(jamMasuk) + tolerance
    ? "Tepat Waktu"
    : "Terlambat";
}

function isWithinAttendanceWindow(waktu, mulai, selesai) {
  const normalize = (value, fallback) => {
    const time = String(value || fallback);
    return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time.slice(0, 8);
  };
  const normalizedTime = normalize(waktu, "00:00:00");
  const normalizedStart = normalize(mulai, "00:00:00");
  const normalizedEnd = normalize(selesai, "23:59:59");

  return normalizedTime >= normalizedStart && normalizedTime <= normalizedEnd;
}

module.exports = {
  getDailyStudentStatus,
  getArrivalStatus,
  isWithinAttendanceWindow,
  validateAttendance,
  validatePermission,
};
