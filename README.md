# Ruang Hadir - Bot Absensi WhatsApp

Ruang Hadir adalah aplikasi absensi sekolah berbasis WhatsApp dengan verifikasi wajah, validasi lokasi, pengajuan izin, notifikasi kepada pihak terkait, serta dashboard web untuk administrasi dan laporan.

## Fitur utama

- Absensi dimulai melalui WhatsApp dan diselesaikan lewat halaman kamera langsung.
- Verifikasi selfie dengan foto referensi siswa.
- Validasi lokasi menggunakan koordinat sekolah.
- Pengajuan izin dengan foto bukti; izin sakit juga memverifikasi wajah.
- Notifikasi absensi dan izin kepada admin, wali kelas, dan orang tua.
- Dashboard web untuk mengelola siswa, kelas, wali kelas, admin, jadwal, izin, dan laporan.
- Ekspor laporan ke Excel.
- Login dashboard menggunakan OTP yang dikirim melalui WhatsApp.
- Penyimpanan lokal menggunakan SQLite.

## Perintah WhatsApp aktif

| Perintah | Fungsi | Akses |
| --- | --- | --- |
| `!masuk` | Memulai absensi masuk | Siswa terdaftar |
| `!pulang` | Memulai absensi pulang | Siswa terdaftar |
| `!izin alasan` | Mengajukan izin dan meminta foto bukti | Siswa terdaftar |
| `!setlokasi` | Meminta pengiriman lokasi sekolah baru | Admin |

Setelah mengirim `!masuk` atau `!pulang`, siswa menerima tautan sekali pakai yang berlaku selama 2 menit. Tautan membuka kamera depan dan GPS tanpa menyediakan pilihan unggah dari galeri. Setelah mengirim `!izin alasan`, siswa tetap harus mengirim foto bukti melalui WhatsApp dalam waktu 2 menit.

Pengelolaan data lain sudah dipindahkan ke dashboard web. Perintah lama seperti `!setfoto` tidak tersedia.

## Persyaratan

- Node.js yang mendukung Express 5 (disarankan Node.js 20 LTS atau lebih baru).
- npm.
- Chromium atau Google Chrome untuk `whatsapp-web.js`.
- Nomor WhatsApp aktif untuk akun bot.

Pada Linux, lokasi Chromium bawaan adalah `/usr/bin/chromium`. Lokasi lain dapat diatur melalui `PUPPETEER_EXECUTABLE_PATH`.

## Instalasi

```bash
git clone <alamat-repository>
cd absensi-bot
npm install
```

Salin konfigurasi contoh menjadi `.env`, lalu sesuaikan nilainya:

```bash
cp .env.example .env
```

Pada PowerShell:

```powershell
Copy-Item .env.example .env
```

Pastikan nomor admin awal tersedia di `roles.json` dengan format WhatsApp berikut:

```json
{
  "6281234567890@c.us": "admin"
}
```

Gunakan kode negara tanpa tanda `+`; nomor Indonesia yang diawali `08` ditulis menjadi `628`.

## Konfigurasi

Konfigurasi dasar disimpan pada berkas berikut:

| Berkas | Kegunaan |
| --- | --- |
| `roles.json` | Daftar admin dan peran pengguna dashboard |
| `lokasi.json` | Koordinat lokasi sekolah |
| `jam.json` | Jadwal masuk dan pulang |
| `kontak.json` | Data awal kontak sebelum migrasi SQLite |
| `storage.json` | Data awal absensi sebelum migrasi SQLite |
| `izin.json` | Data awal izin sebelum migrasi SQLite |

Saat pertama dijalankan, data JSON awal dimasukkan ke database `data/absensi.sqlite`. Perubahan selanjutnya disimpan ke SQLite.

Variabel lingkungan opsional:

| Variabel | Nilai awal | Keterangan |
| --- | ---: | --- |
| `DB_PATH` | `data/absensi.sqlite` | Lokasi database SQLite |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Lokasi executable Chromium/Chrome |
| `PUBLIC_BASE_URL` | `http://localhost:3200` | Alamat publik HTTPS yang dibuka siswa untuk kamera absensi |
| `FACE_WORKER_COUNT` | `2` | Jumlah worker verifikasi wajah |
| `FACE_QUEUE_LIMIT` | `100` | Batas antrean verifikasi wajah |
| `FACE_TIMEOUT_MS` | `60000` | Batas waktu verifikasi wajah dalam milidetik |
| `NOTIFICATION_CONCURRENCY` | `2` | Jumlah notifikasi yang dikirim bersamaan |
| `NOTIFICATION_QUEUE_LIMIT` | `200` | Batas antrean notifikasi |

Nilai tersebut dapat disimpan di `.env`. Alternatifnya, atur langsung melalui PowerShell:

```powershell
$env:PUPPETEER_EXECUTABLE_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:PUBLIC_BASE_URL = "https://absensi.sekolah.example"
node index.js
```

## Menjalankan aplikasi

```bash
node index.js
```

Pada proses pertama, pindai QR WhatsApp yang tampil di terminal atau buka:

- Dashboard: `http://localhost:3200`
- Status/QR WhatsApp: `http://localhost:3200/qr`

Sesi WhatsApp disimpan di `.wwebjs_auth`, sehingga pemindaian QR biasanya hanya diperlukan sekali.

Untuk produksi menggunakan PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

## Alur penggunaan

1. Admin menjalankan bot dan menghubungkan akun WhatsApp.
2. Admin masuk ke dashboard dengan nomor yang tercatat sebagai admin.
3. OTP enam digit dikirim ke WhatsApp dan berlaku selama 5 menit.
4. Admin membuat kelas, menetapkan wali kelas, dan menambahkan siswa serta nomor orang tua.
5. Admin atau wali kelas mengunggah foto referensi wajah siswa melalui dashboard.
6. Siswa mengirim `!masuk` atau `!pulang`, membuka tautan sekali pakai, lalu mengambil selfie langsung dan mengizinkan GPS.
7. Untuk izin, siswa mengirim `!izin alasan` lalu mengirim foto bukti melalui WhatsApp.

Wali kelas hanya dapat mengakses dan mengunggah foto siswa pada kelas yang menjadi tanggung jawabnya.

## Menjalankan pengujian

```bash
npm test
```

Pengujian mencakup aturan absensi, validasi lokasi, QR SVG, antrean tugas, dan normalisasi ID WhatsApp.

## Struktur proyek

```text
index.js                 Server, bot WhatsApp, dan API dashboard
public/index.html        Antarmuka dashboard web
models/database.js       Penyimpanan SQLite melalui Sequelize
lib/                     Aturan dan utilitas aplikasi
services/                Pool worker dan layanan verifikasi wajah
workers/face-worker.js   Worker pemrosesan wajah
test/                    Pengujian otomatis
ecosystem.config.js      Konfigurasi PM2
exports/                 Hasil ekspor laporan Excel
```

Direktori seperti `.wwebjs_auth`, `data`, `face_db`, `face_rec`, dan `izin_bukti` berisi data lokal atau sensitif. Jangan memasukkannya ke repository publik atau membagikannya tanpa pemeriksaan terlebih dahulu.

## Catatan keamanan

- Jangan membagikan direktori sesi `.wwebjs_auth`.
- Batasi akses jaringan ke dashboard karena aplikasi saat ini berjalan melalui HTTP.
- Gunakan HTTPS pada `PUBLIC_BASE_URL`; browser ponsel memblokir kamera pada alamat HTTP biasa.
- Ganti nomor admin bawaan sebelum digunakan di lingkungan lain.
- Cadangkan database SQLite dan foto referensi secara berkala.
- Gunakan reverse proxy HTTPS apabila dashboard diakses di luar jaringan lokal.
