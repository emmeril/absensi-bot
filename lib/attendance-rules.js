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

module.exports = {
  getDailyStudentStatus,
  validateAttendance,
  validatePermission,
};
