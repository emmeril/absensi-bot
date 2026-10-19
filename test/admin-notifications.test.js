const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNotificationScope,
  notificationPolicyError,
  receivesNotification,
} = require("../lib/admin-notifications");

test("Administrator lama menerima notifikasi semua unit", () => {
  assert.equal(normalizeNotificationScope(undefined), "all");
  assert.equal(receivesNotification(undefined, "student"), true);
  assert.equal(receivesNotification(undefined, "teacher"), true);
});

test("cakupan notifikasi lama berbentuk boolean tetap didukung", () => {
  assert.equal(normalizeNotificationScope({ student: false, teacher: false }), "none");
  assert.equal(normalizeNotificationScope({ student: true, teacher: false }), "student");
  assert.equal(normalizeNotificationScope({ student: false, teacher: true }), "teacher");
});

test("Administrator tunggal tidak boleh menonaktifkan semua notifikasi", () => {
  assert.match(
    notificationPolicyError({ adminIds: ["admin-1"], preferences: { "admin-1": "none" } }),
    /satu-satunya/
  );
  assert.equal(
    notificationPolicyError({ adminIds: ["admin-1"], preferences: { "admin-1": "student" } }),
    ""
  );
});

test("satu dari beberapa Administrator boleh tidak menerima notifikasi", () => {
  assert.equal(
    notificationPolicyError({
      adminIds: ["admin-1", "admin-2"],
      preferences: { "admin-1": "none", "admin-2": "all" },
    }),
    ""
  );
});

test("setiap unit tetap memiliki minimal satu Administrator penerima", () => {
  assert.match(
    notificationPolicyError({
      adminIds: ["admin-1", "admin-2"],
      preferences: { "admin-1": "student", "admin-2": "none" },
    }),
    /Absensi Guru/
  );
});
