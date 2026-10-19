const VALID_NOTIFICATION_SCOPES = new Set(["all", "student", "teacher", "none"]);

function normalizeNotificationScope(raw) {
  if (VALID_NOTIFICATION_SCOPES.has(raw)) return raw;
  if (!raw || typeof raw !== "object") return "all";

  const student = raw.student !== false;
  const teacher = raw.teacher !== false;
  if (student && teacher) return "all";
  if (student) return "student";
  if (teacher) return "teacher";
  return "none";
}

function receivesNotification(scope, unit) {
  const normalized = normalizeNotificationScope(scope);
  return normalized === "all" || normalized === unit;
}

function notificationPolicyError({ adminIds, preferences }) {
  if (!adminIds.length) return "Minimal satu Administrator harus tersedia.";

  const scopes = adminIds.map((id) => normalizeNotificationScope(preferences[id]));
  if (adminIds.length === 1 && scopes[0] === "none") {
    return "Administrator satu-satunya wajib menerima notifikasi minimal dari satu unit.";
  }

  if (adminIds.length > 1) {
    const uncovered = ["student", "teacher"].filter(
      (unit) => !scopes.some((scope) => receivesNotification(scope, unit))
    );
    if (uncovered.length) {
      const labels = uncovered.map((unit) => unit === "student" ? "Absensi Siswa" : "Absensi Guru");
      return `Setiap unit harus memiliki minimal satu Administrator penerima. Belum tercakup: ${labels.join(", ")}.`;
    }
  }

  return "";
}

module.exports = {
  VALID_NOTIFICATION_SCOPES,
  normalizeNotificationScope,
  notificationPolicyError,
  receivesNotification,
};
