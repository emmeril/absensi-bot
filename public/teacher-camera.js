/* The fragment keeps the private token out of page URLs sent to the server. */
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
let session, stream, image, stage, busy = false;
function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function stop() { stream?.getTracks().forEach((track) => track.stop()); stream = null; }
async function request(suffix = "", body) {
  const response = await fetch(`/api/teacher-camera/${encodeURIComponent(token)}${suffix}`, {
    method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Permintaan gagal. Silakan coba lagi.");
  return data;
}
function locationNow() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS tidak tersedia."));
    navigator.geolocation.getCurrentPosition((p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => reject(new Error("Izinkan lokasi GPS lalu coba lagi.")), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });
}
function render() {
  stop(); image = null;
  const r = session.record;
  stage = r?.arrival ? "evidence" : "arrival";
  $("session").textContent = `${session.name} · ${session.schedule.subject} · ${session.schedule.className} · ${session.schedule.start}–${session.schedule.end}`;
  $("deadline").textContent = `Lengkapi bukti sebelum ${session.schedule.end}. Tautan yang sama dapat dibuka kembali sampai sesi berakhir.`;
  $("capturePanel").hidden = Boolean(r?.hasEvidence);
  $("done").hidden = !r?.hasEvidence;
  $("materialPanel").hidden = stage !== "evidence";
  $("heading").textContent = stage === "arrival" ? "1. Selfie kehadiran" : "2. Foto kegiatan & materi";
  $("hint").textContent = stage === "arrival" ? "Gunakan kamera depan. Waktu hadir disimpan setelah verifikasi berhasil." : "Ambil foto kegiatan belajar, papan tulis, atau materi. Wajah siswa tidak perlu terlihat jelas. Jika kegiatan belum dimulai, lanjutkan lewat tautan ini saat mengajar.";
  $("openCamera").hidden = false;
  for (const id of ["video", "canvas", "capture", "retake", "submit"]) $(id).hidden = true;
  if (r?.hasEvidence) status("Kehadiran, foto kegiatan, dan materi berhasil tersimpan.");
  else if (r?.arrival) status(`Kehadiran tersimpan pukul ${new Date(r.arrival).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}.\nSelanjutnya lengkapi bukti mengajar.`);
  else status("Mulai dengan selfie dan lokasi sekolah.");
}
async function openCamera() {
  stop(); image = null;
  $("openCamera").disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Buka tautan melalui HTTPS di browser dengan akses kamera.");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: stage === "arrival" ? "user" : "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    $("video").srcObject = stream; $("video").hidden = false;
    $("video").style.transform = stage === "arrival" ? "scaleX(-1)" : "none";
    await $("video").play();
    $("canvas").hidden = true; $("capture").hidden = false;
    $("openCamera").hidden = true; $("retake").hidden = true; $("submit").hidden = true;
    status(stage === "arrival" ? "Posisikan wajah dengan jelas, lalu ambil selfie." : "Arahkan kamera ke kegiatan belajar, lalu ambil foto.");
  } catch (error) { stop(); status(error.message || "Izinkan kamera lalu coba lagi.", true); }
  finally { $("openCamera").disabled = false; }
}
$("openCamera").onclick = openCamera;
$("retake").onclick = openCamera;
$("capture").onclick = () => {
  const video = $("video"), canvas = $("canvas");
  if (!video.videoWidth) return status("Kamera belum siap.", true);
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  image = canvas.toDataURL("image/jpeg", .86);
  stop(); video.hidden = true; canvas.hidden = false; $("capture").hidden = true;
  $("retake").hidden = false; $("submit").hidden = false;
  status("Periksa foto, lalu kirim. GPS akan diperiksa saat pengiriman.");
};
$("submit").onclick = async () => {
  if (busy || !image) return;
  const material = $("material").value.trim();
  if (stage === "evidence" && !material) return status("Isi materi yang diajarkan terlebih dahulu.", true);
  busy = true; $("submit").disabled = true; $("retake").disabled = true;
  try {
    status("Memeriksa lokasi dan menyimpan. Jangan tutup halaman…");
    const gps = await locationNow();
    const result = await request(`/${stage}`, { image, material, ...gps });
    session.record = result.record; render();
  } catch (error) { status(error.message, true); }
  finally { busy = false; $("submit").disabled = false; $("retake").disabled = false; }
};
window.addEventListener("pagehide", stop);
(async () => {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Buka tautan pribadi yang dikirim bot TU.");
    session = await request(); render();
  } catch (error) { status(error.message, true); }
})();
