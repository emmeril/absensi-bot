const $ = (id) => document.getElementById(id);
const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
let config, reportRows = [];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function message(text, error = false) { $("message").textContent = text; $("message").className = `alert ${error ? "alert-danger" : "alert-success"} notice mt-3`; }
async function api(url, body) {
  const multipart = body instanceof FormData;
  const response = await fetch(`/api/teachers${url}`, { method: body ? "POST" : "GET", headers: body && !multipart ? { "Content-Type": "application/json" } : {}, body: body ? (multipart ? body : JSON.stringify(body)) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Permintaan gagal.");
  return data;
}
async function action(fn) { try { await fn(); } catch (error) { message(error.message, true); } }
function cell(row, value) { const td = document.createElement("td"); td.textContent = value ?? "—"; row.append(td); return td; }
function button(parent, label, fn, style = "outline-primary") { const b = document.createElement("button"); b.type = "button"; b.className = `btn btn-sm btn-${style}`; b.textContent = label; b.onclick = () => action(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); parent.append(b); return b; }
function emptyRow(body, columns, text) { const row = body.insertRow(); const td = cell(row, text); td.colSpan = columns; td.className = "text-center text-secondary py-4"; }
function photoLink(parent, key, kind, label) { const a = document.createElement("a"); a.href = `/api/teachers/report/${encodeURIComponent(key)}/${kind}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; a.className = "d-block"; parent.append(a); }
async function reload() {
  config = await api("");
  $("tuNumber").value = config.number;
  $("holidays").value = config.holidays.join("\n");
  $("teachers").replaceChildren(); $("scheduleTeacher").replaceChildren();
  for (const [number, t] of Object.entries(config.teachers)) {
    const row = $("teachers").insertRow(); cell(row, t.name); cell(row, number); cell(row, t.active ? "Aktif" : "Nonaktif"); cell(row, t.hasPhoto ? "Tersedia" : "Belum diunggah");
    const actions = cell(row, ""); actions.className = "actions";
    button(actions, "Edit", () => { $("teacherName").value = t.name; $("teacherNumber").value = number; $("teacherActive").value = String(t.active); $("teacherName").focus(); });
    const input = document.createElement("input"); input.type = "file"; input.accept = "image/jpeg,image/png"; input.hidden = true;
    input.onchange = () => action(async () => { if (!input.files[0]) return; const data = new FormData(); data.append("photo", input.files[0]); await api(`/${number}/photo`, data); message("Foto referensi guru tersimpan."); await reload(); });
    actions.append(input); button(actions, "Unggah foto", () => input.click());
    if (t.active) { const option = document.createElement("option"); option.value = number; option.textContent = t.name; $("scheduleTeacher").append(option); }
  }
  if (!Object.keys(config.teachers).length) emptyRow($("teachers"), 5, "Tambahkan guru pertama untuk mulai mengatur jadwal.");
  $("schedules").replaceChildren();
  for (const s of Object.values(config.schedules).sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))) {
    const row = $("schedules").insertRow(); cell(row, config.teachers[s.number]?.name || s.number); cell(row, `${days[s.day]} ${s.start}–${s.end}`); cell(row, `${s.className} · ${s.subject}`); cell(row, `${s.from} → ${s.until || "seterusnya"}`);
    const actions = cell(row, "");
    if (!s.until || s.until >= today) button(actions, "Akhiri jadwal", async () => { const until = prompt("Tanggal terakhir jadwal berlaku (YYYY-MM-DD), minimal hari ini:", today); if (!until) return; await api(`/schedules/${encodeURIComponent(s.id)}/end`, { until }); await reload(); await loadReport(); message("Tanggal akhir jadwal disimpan. Riwayat absensi tetap tersedia."); });
  }
  if (!Object.keys(config.schedules).length) emptyRow($("schedules"), 5, "Belum ada jadwal mengajar.");
}
function attendanceStatus(r) { return !r.arrival ? "Belum hadir" : r.hasEvidence ? "Bukti lengkap" : "Hadir · bukti belum lengkap"; }
async function loadReport() {
  reportRows = (await api(`/report?date=${encodeURIComponent($("reportDate").value)}`)).rows;
  $("report").replaceChildren();
  for (const r of reportRows) {
    const row = $("report").insertRow(); cell(row, r.name); cell(row, `${r.schedule.start}–${r.schedule.end} · ${r.schedule.className} · ${r.schedule.subject}`);
    cell(row, r.arrival ? `${new Date(r.arrival).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}${r.lateMinutes ? ` (terlambat ${r.lateMinutes} menit)` : ""}` : "—");
    cell(row, attendanceStatus(r)); cell(row, r.material);
    const photos = cell(row, ""); if (r.hasSelfie) photoLink(photos, r.key, "selfie", "Selfie"); if (r.hasEvidence) photoLink(photos, r.key, "evidence", "Kegiatan");
    const review = cell(row, r.review || "—");
    if (r.reviewNote) { const note = document.createElement("p"); note.className = "small mt-2"; note.textContent = r.reviewNote; review.append(note); }
    if (r.hasEvidence) {
      const controls = document.createElement("div"); controls.className = "actions mt-2"; review.append(controls);
      button(controls, "Tandai ditinjau", async () => { await api(`/report/${encodeURIComponent(r.key)}/review`, { review: "Sudah ditinjau", note: "" }); await loadReport(); message("Tinjauan disimpan."); });
      button(controls, "Catat perbaikan", async () => { const note = prompt("Catatan perbaikan untuk tindak lanjut TU:"); if (!note) return; await api(`/report/${encodeURIComponent(r.key)}/review`, { review: "Perlu perbaikan", note }); await loadReport(); message("Catatan tersimpan. Sampaikan tindak lanjut kepada guru."); }, "outline-warning");
    }
  }
  if (!reportRows.length) emptyRow($("report"), 7, "Tidak ada jadwal atau catatan absensi pada tanggal ini.");
}
for (const id of ["settingsForm", "teacherForm", "scheduleForm"]) $(id).onsubmit = (event) => {
  event.preventDefault(); const submit = event.submitter;
  action(async () => {
    submit.disabled = true;
    try {
      if (id === "settingsForm") await api("/settings", { number: $("tuNumber").value, holidays: $("holidays").value.split(/\s+/).filter(Boolean) });
      if (id === "teacherForm") await api("/person", { number: $("teacherNumber").value, name: $("teacherName").value, active: $("teacherActive").value === "true" });
      if (id === "scheduleForm") await api("/schedules", { number: $("scheduleTeacher").value, day: Number($("day").value), subject: $("subject").value, className: $("className").value, start: $("start").value, end: $("end").value, tolerance: Number($("tolerance").value), from: $("from").value, until: $("until").value });
      await reload(); await loadReport(); message(id === "settingsForm" ? "Pengaturan disimpan. Buka menu WhatsApp untuk menghubungkan nomor bot TU." : "Data tersimpan.");
    } finally { submit.disabled = false; }
  });
};
$("reportDate").value = today; $("from").value = today;
$("reportDate").onchange = () => action(loadReport); $("refreshReport").onclick = () => action(loadReport);
$("exportReport").onclick = () => {
  const values = [["Tanggal", "Guru", "Nomor", "Kelas", "Pelajaran", "Mulai", "Selesai", "Hadir", "Terlambat (menit)", "Status", "Materi", "Tinjauan", "Catatan"], ...reportRows.map((r) => [r.date, r.name, r.number, r.schedule.className, r.schedule.subject, r.schedule.start, r.schedule.end, r.arrival ? new Date(r.arrival).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) : "", r.lateMinutes || 0, attendanceStatus(r), r.material, r.review, r.reviewNote])];
  const csv = values.map((row) => row.map((v) => { let value = String(v ?? ""); if (/^[\s]*[=+@-]/.test(value)) value = `'${value}`; return `"${value.replace(/"/g, '""')}"`; }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `absensi-guru-${$("reportDate").value}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
action(async () => { await reload(); $("content").hidden = false; await loadReport(); message("Kelola guru, jadwal, dan laporan mengajar di sini."); });
