window.mountTeacherPanel = function mountTeacherPanel(root, notify, initialTab = "guru", refreshWhatsapp = async () => {}) {
const $ = (id) => root.querySelector(`#${id}`);
const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
let config, reportRows = [], summaryRows = [], permissionRows = [], teacherRows = [];
const teacherTable = { search: "", statusFilter: "", photoFilter: "", sortKey: "", sortDirection: "asc", page: 1, size: 10 };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function message(text, error = false) {
  if (!root.isConnected) return;
  $("message").textContent = text;
  $("message").hidden = !error;
  $("message").className = "mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700";
  notify(text, error ? "error" : "ok");
}
async function api(url, body, method = body ? "POST" : "GET") {
  const multipart = body instanceof FormData;
  const response = await fetch(`/api/teachers${url}`, { method, headers: body && !multipart ? { "Content-Type": "application/json" } : {}, body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Permintaan gagal.");
  return data;
}
async function action(fn) { try { await fn(); } catch (error) { message(error.message, true); } }
function cell(row, value) { const td = document.createElement("td"); td.textContent = value ?? "—"; row.append(td); return td; }
function button(parent, label, fn, style = "primary") { const b = document.createElement("button"); b.type = "button"; b.className = style === "warning" ? "rounded bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 disabled:opacity-50" : "rounded bg-blue-50 px-2.5 py-1.5 text-xs text-blue-700 disabled:opacity-50"; b.textContent = label; b.onclick = () => action(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); parent.append(b); return b; }
function teacherAction(parent, label, icon, className, fn) { const b = document.createElement("button"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.className = `rounded px-2.5 py-1.5 disabled:opacity-50 ${className}`; b.innerHTML = `<i class="fa-solid ${icon}"></i>`; b.onclick = () => action(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); parent.append(b); return b; }
function emptyRow(body, columns, text) { const row = body.insertRow(); const td = cell(row, text); td.colSpan = columns; td.className = "py-10 text-center text-slate-400"; }
function photoLink(parent, key, kind, label) { const a = document.createElement("a"); a.href = `/api/teachers/report/${encodeURIComponent(key)}/${kind}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; a.className = "block text-[#3c8dbc] hover:underline"; parent.append(a); }
function closeTeacherModal() { $("teacherModal").hidden = true; $("teacherForm").reset(); $("teacherNumber").disabled = false; }
function openTeacherModal(number = "") {
  const teacher = number ? config.teachers[number] : null;
  $("teacherModalTitle").textContent = teacher ? "Edit Guru" : "Tambah Guru";
  $("teacherName").value = teacher?.name || "";
  $("teacherNumber").value = number;
  $("teacherNumber").disabled = Boolean(teacher);
  $("teacherActive").value = String(teacher?.active ?? true);
  $("teacherModal").hidden = false;
  $("teacherName").focus();
}
function filteredTeachers() {
  const query = teacherTable.search.toLocaleLowerCase("id");
  return teacherRows.filter((teacher) => {
    const matchesSearch = `${teacher.name} ${teacher.number}`.toLocaleLowerCase("id").includes(query);
    const matchesStatus = !teacherTable.statusFilter || (teacherTable.statusFilter === "active" ? teacher.active : !teacher.active);
    const matchesPhoto = !teacherTable.photoFilter || (teacherTable.photoFilter === "available" ? teacher.hasPhoto : !teacher.hasPhoto);
    return matchesSearch && matchesStatus && matchesPhoto;
  });
}
function sortedTeachers(rows) {
  if (!teacherTable.sortKey) return rows;
  const getters = { name: (teacher) => teacher.name, number: (teacher) => teacher.number, status: (teacher) => Number(teacher.active), photo: (teacher) => Number(teacher.hasPhoto) };
  const valueFor = getters[teacherTable.sortKey];
  const direction = teacherTable.sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => String(valueFor(left)).localeCompare(String(valueFor(right)), "id", { numeric: true, sensitivity: "base" }) * direction);
}
function renderTeachers() {
  const filtered = sortedTeachers(filteredTeachers());
  const pages = Math.max(1, Math.ceil(filtered.length / teacherTable.size));
  teacherTable.page = Math.min(teacherTable.page, pages);
  const start = (teacherTable.page - 1) * teacherTable.size;
  const visible = filtered.slice(start, start + teacherTable.size);
  $("teachers").replaceChildren();
  for (const [index, teacher] of visible.entries()) {
    const row = $("teachers").insertRow(); cell(row, start + index + 1); cell(row, teacher.name); cell(row, teacher.number); cell(row, teacher.active ? "Aktif" : "Nonaktif"); cell(row, teacher.hasPhoto ? "Tersedia" : "Belum ada");
    const actions = document.createElement("div"); actions.className = "flex justify-center gap-1"; cell(row, "").append(actions);
    const input = document.createElement("input"); input.type = "file"; input.accept = "image/jpeg,image/png"; input.hidden = true;
    input.onchange = () => action(async () => { if (!input.files[0]) return; const data = new FormData(); data.append("photo", input.files[0]); await api(`/${teacher.number}/photo`, data); message("Foto referensi guru tersimpan."); await reload(); });
    actions.append(input);
    teacherAction(actions, "Unggah foto", "fa-camera", "bg-emerald-50 text-emerald-700", () => input.click());
    teacherAction(actions, "Edit", "fa-pen-to-square", "bg-amber-50 text-amber-700", () => openTeacherModal(teacher.number));
  }
  if (!visible.length) emptyRow($("teachers"), 6, "Data tidak ditemukan");
  $("teacherCurrentPage").textContent = teacherTable.page;
  $("teacherPrevPage").disabled = teacherTable.page <= 1;
  $("teacherNextPage").disabled = teacherTable.page >= pages;
  $("teacherPageInfo").textContent = filtered.length ? `Menampilkan ${start + 1}-${Math.min(start + teacherTable.size, filtered.length)} dari ${filtered.length} data` : "Menampilkan 0 data";
  $("resetTeacherFilters").hidden = !(teacherTable.search || teacherTable.statusFilter || teacherTable.photoFilter);
  for (const sortButton of root.querySelectorAll("[data-teacher-sort]")) {
    const active = teacherTable.sortKey === sortButton.dataset.teacherSort;
    sortButton.closest("th").setAttribute("aria-sort", active ? (teacherTable.sortDirection === "asc" ? "ascending" : "descending") : "none");
    sortButton.querySelector("i").className = `fa-solid ${active ? (teacherTable.sortDirection === "asc" ? "fa-sort-up" : "fa-sort-down") : "fa-sort"}`;
  }
}
async function reload() {
  config = await api("");
  $("tuNumber").value = config.number;
  $("holidays").value = config.holidays.join("\n");
  teacherRows = Object.entries(config.teachers).map(([number, teacher]) => ({ number, ...teacher }));
  renderTeachers(); $("scheduleTeacher").replaceChildren(); $("permissionTeacher").replaceChildren();
  for (const [number, t] of Object.entries(config.teachers)) {
    if (t.active) {
      for (const select of [$("scheduleTeacher"), $("permissionTeacher")]) { const option = document.createElement("option"); option.value = number; option.textContent = t.name; select.append(option); }
    }
  }
  $("schedules").replaceChildren();
  for (const s of Object.values(config.schedules).sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))) {
    const row = $("schedules").insertRow(); cell(row, config.teachers[s.number]?.name || s.number); cell(row, `${days[s.day]} ${s.start}–${s.end}`); cell(row, `${s.className} · ${s.subject}`); cell(row, `${s.from} → ${s.until || "seterusnya"}`);
    const actions = cell(row, "");
    if (!s.until || s.until >= today) button(actions, "Akhiri jadwal", async () => { const until = prompt("Tanggal terakhir jadwal berlaku (YYYY-MM-DD), minimal hari ini:", today); if (!until) return; await api(`/schedules/${encodeURIComponent(s.id)}/end`, { until }); await reload(); await loadReport(); message("Tanggal akhir jadwal disimpan. Riwayat absensi tetap tersedia."); });
  }
  if (!Object.keys(config.schedules).length) emptyRow($("schedules"), 5, "Belum ada jadwal mengajar.");
}
function attendanceStatus(r) { return r.permission ? `${r.permission.type}: ${r.permission.reason}` : !r.arrival ? "Belum hadir" : r.hasEvidence ? "Bukti lengkap" : "Hadir · bukti belum lengkap"; }
async function loadReport() {
  reportRows = (await api(`/report?date=${encodeURIComponent($("teacherReportDate").value)}`)).rows;
  $("teacherReport").replaceChildren();
  for (const r of reportRows) {
    const row = $("teacherReport").insertRow(); cell(row, r.name); cell(row, `${r.schedule.start}–${r.schedule.end} · ${r.schedule.className} · ${r.schedule.subject}`);
    cell(row, r.arrival ? `${new Date(r.arrival).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}${r.lateMinutes ? ` (terlambat ${r.lateMinutes} menit)` : ""}` : "—");
    cell(row, attendanceStatus(r)); cell(row, r.material);
    const photos = cell(row, ""); if (r.hasSelfie) photoLink(photos, r.key, "selfie", "Selfie"); if (r.hasEvidence) photoLink(photos, r.key, "evidence", "Kegiatan");
    const review = cell(row, r.review || "—");
    if (r.reviewNote) { const note = document.createElement("p"); note.className = "mt-2 text-xs text-slate-500"; note.textContent = r.reviewNote; review.append(note); }
    if (r.hasEvidence) {
      const controls = document.createElement("div"); controls.className = "mt-2 flex flex-wrap gap-2"; review.append(controls);
      button(controls, "Tandai ditinjau", async () => { await api(`/report/${encodeURIComponent(r.key)}/review`, { review: "Sudah ditinjau", note: "" }); await loadReport(); message("Tinjauan disimpan."); });
      button(controls, "Catat perbaikan", async () => { const note = prompt("Catatan perbaikan untuk tindak lanjut TU:"); if (!note) return; await api(`/report/${encodeURIComponent(r.key)}/review`, { review: "Perlu perbaikan", note }); await loadReport(); message("Catatan tersimpan. Sampaikan tindak lanjut kepada guru."); }, "warning");
    }
  }
  if (!reportRows.length) emptyRow($("teacherReport"), 7, "Tidak ada jadwal atau catatan absensi pada tanggal ini.");
}
async function loadSummary() {
  summaryRows = (await api(`/report?date=${encodeURIComponent($("teacherSummaryDate").value)}`)).rows;
  $("summaryActive").textContent = Object.values(config.teachers).filter((teacher) => teacher.active).length;
  $("summaryScheduled").textContent = summaryRows.length;
  $("summaryPresent").textContent = summaryRows.filter((row) => row.arrival).length;
  $("summaryPermissions").textContent = new Set(summaryRows.filter((row) => row.permission).map((row) => row.number)).size;
  $("teacherSummary").replaceChildren();
  for (const item of summaryRows) {
    const row = $("teacherSummary").insertRow(); cell(row, item.name); cell(row, `${item.schedule.start}–${item.schedule.end}`);
    cell(row, `${item.schedule.className} · ${item.schedule.subject}`); cell(row, attendanceStatus(item));
  }
  if (!summaryRows.length) emptyRow($("teacherSummary"), 4, "Tidak ada sesi mengajar pada tanggal ini.");
}
async function loadPermissions() {
  permissionRows = (await api(`/permissions?date=${encodeURIComponent($("teacherPermissionDate").value)}`)).rows;
  $("teacherPermissions").replaceChildren();
  for (const item of permissionRows) {
    const row = $("teacherPermissions").insertRow(); cell(row, item.name); cell(row, item.type); cell(row, item.reason); cell(row, item.date);
    const actions = cell(row, "");
    button(actions, "Hapus", async () => {
      if (!confirm(`Hapus ${item.type.toLowerCase()} ${item.name}?`)) return;
      await api(`/permissions/${encodeURIComponent(item.date)}/${encodeURIComponent(item.number)}`, undefined, "DELETE");
      await Promise.all([loadPermissions(), loadSummary(), loadReport()]); message("Izin guru dihapus.");
    }, "warning");
  }
  if (!permissionRows.length) emptyRow($("teacherPermissions"), 5, "Belum ada izin guru pada tanggal ini.");
}
$("addTeacher").onclick = () => openTeacherModal();
$("closeTeacherModal").onclick = closeTeacherModal;
$("cancelTeacherModal").onclick = closeTeacherModal;
$("teacherModal").onclick = (event) => { if (event.target === $("teacherModal")) closeTeacherModal(); };
$("teacherModal").onkeydown = (event) => { if (event.key === "Escape") closeTeacherModal(); };
$("teacherSearch").oninput = (event) => { teacherTable.search = event.target.value; teacherTable.page = 1; renderTeachers(); };
$("teacherStatusFilter").onchange = (event) => { teacherTable.statusFilter = event.target.value; teacherTable.page = 1; renderTeachers(); };
$("teacherPhotoFilter").onchange = (event) => { teacherTable.photoFilter = event.target.value; teacherTable.page = 1; renderTeachers(); };
$("teacherPageSize").onchange = (event) => { teacherTable.size = Number(event.target.value); teacherTable.page = 1; renderTeachers(); };
$("resetTeacherFilters").onclick = () => {
  teacherTable.search = ""; teacherTable.statusFilter = ""; teacherTable.photoFilter = ""; teacherTable.page = 1;
  $("teacherSearch").value = ""; $("teacherStatusFilter").value = ""; $("teacherPhotoFilter").value = ""; renderTeachers();
};
$("teacherPrevPage").onclick = () => { if (teacherTable.page > 1) { teacherTable.page--; renderTeachers(); } };
$("teacherNextPage").onclick = () => { const pages = Math.ceil(filteredTeachers().length / teacherTable.size); if (teacherTable.page < pages) { teacherTable.page++; renderTeachers(); } };
for (const sortButton of root.querySelectorAll("[data-teacher-sort]")) sortButton.onclick = () => {
  const key = sortButton.dataset.teacherSort;
  if (teacherTable.sortKey === key) teacherTable.sortDirection = teacherTable.sortDirection === "asc" ? "desc" : "asc";
  else { teacherTable.sortKey = key; teacherTable.sortDirection = "asc"; }
  teacherTable.page = 1; renderTeachers();
};
for (const id of ["settingsForm", "teacherForm", "scheduleForm"]) $(id).onsubmit = (event) => {
  event.preventDefault(); const submit = event.submitter;
  action(async () => {
    submit.disabled = true;
    try {
      if (id === "settingsForm") await api("/settings", { number: $("tuNumber").value, holidays: $("holidays").value.split(/\s+/).filter(Boolean) });
      if (id === "teacherForm") await api("/person", { number: $("teacherNumber").value, name: $("teacherName").value, active: $("teacherActive").value === "true" });
      if (id === "scheduleForm") await api("/schedules", { number: $("scheduleTeacher").value, day: Number($("day").value), subject: $("subject").value, className: $("className").value, start: $("start").value, end: $("end").value, tolerance: Number($("tolerance").value), from: $("from").value, until: $("until").value });
      await reload(); await loadReport(); message(id === "settingsForm" ? "Pengaturan disimpan. Hubungkan nomor melalui menu Bot Guru." : "Data tersimpan.");
      if (id === "settingsForm") await refreshWhatsapp();
      if (id === "teacherForm") closeTeacherModal();
      if (id === "scheduleForm") $("scheduleEditor").open = false;
    } finally { submit.disabled = false; }
  });
};
$("teacherPermissionForm").onsubmit = (event) => {
  event.preventDefault(); const submit = event.submitter;
  action(async () => {
    submit.disabled = true;
    try {
      await api("/permissions", { number: $("permissionTeacher").value, date: $("teacherPermissionDate").value, type: $("permissionType").value, reason: $("permissionReason").value });
      $("permissionEditor").open = false; $("permissionReason").value = "";
      await Promise.all([loadPermissions(), loadSummary(), loadReport()]); message("Izin guru tersimpan.");
    } finally { submit.disabled = false; }
  });
};
$("teacherReportDate").value = today; $("teacherSummaryDate").value = today; $("teacherPermissionDate").value = today; $("from").value = today;
$("teacherReportDate").onchange = () => action(loadReport); $("refreshReport").onclick = () => action(loadReport);
$("teacherSummaryDate").onchange = () => action(loadSummary);
$("teacherPermissionDate").onchange = () => action(loadPermissions);
$("exportReport").onclick = () => {
  const values = [["Tanggal", "Guru", "Nomor", "Kelas", "Pelajaran", "Mulai", "Selesai", "Hadir", "Terlambat (menit)", "Status", "Materi", "Tinjauan", "Catatan"], ...reportRows.map((r) => [r.date, r.name, r.number, r.schedule.className, r.schedule.subject, r.schedule.start, r.schedule.end, r.arrival ? new Date(r.arrival).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) : "", r.lateMinutes || 0, attendanceStatus(r), r.material, r.review, r.reviewNote])];
  const csv = values.map((row) => row.map((v) => { let value = String(v ?? ""); if (/^[\s]*[=+@-]/.test(value)) value = `'${value}`; return `"${value.replace(/"/g, '""')}"`; }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `absensi-guru-${$("teacherReportDate").value}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function showPanel(id) {
  for (const panel of root.querySelectorAll("[data-teacher-panel]")) panel.hidden = panel.id !== id;
}
let currentTab;
root.setTeacherView = (tab) => {
  if (tab === currentTab) return;
  currentTab = tab;
  showPanel(({ "ringkasan-guru": "teacherSummaryPanel", guru: "peoplePanel", "jam-guru": "schedulePanel", "izin-guru": "teacherPermissionPanel", "laporan-guru": "reportPanel", "bot-tu": "settingsPanel" })[tab] || "teacherSummaryPanel");
};
root.setTeacherView(initialTab);
async function initialize() {
  $("retryTeachers").hidden = true;
  try { await reload(); await Promise.all([loadReport(), loadSummary(), loadPermissions()]); $("content").hidden = false; $("message").hidden = true; }
  catch (error) { message(error.message, true); $("retryTeachers").hidden = false; }
}
$("retryTeachers").onclick = initialize;
void initialize();
};
