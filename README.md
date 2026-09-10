# Ruang Hadir - Bot Absensi WhatsApp

Ruang Hadir adalah aplikasi absensi sekolah berbasis WhatsApp dengan verifikasi wajah, validasi lokasi, pengajuan izin, notifikasi kepada pihak terkait, serta dashboard web untuk administrasi dan laporan.

## Fitur utama

- Absensi masuk/pulang otomatis dicatat setelah verifikasi wajah, lokasi, dan jadwal melalui halaman kamera.
- Verifikasi selfie dengan foto referensi siswa.
- Validasi lokasi menggunakan koordinat sekolah.
- Pengajuan izin dua tahap: selfie terverifikasi lalu unggah bukti terpisah.
- Notifikasi absensi dan izin kepada admin, wali kelas, dan orang tua.
- Dashboard web untuk mengelola siswa, kelas, wali kelas, admin, jadwal, izin, dan laporan.
- Ekspor laporan ke Excel.
- Login dashboard menggunakan OTP yang dikirim melalui WhatsApp.
- Multi-bot Baileys: satu bot utama dan satu sesi bot untuk setiap nomor wali kelas.
- Penyimpanan lokal menggunakan SQLite dengan transaksi atomik untuk pembaruan terkait.
- Ekspor Excel dibuat dalam buffer terpisah untuk setiap permintaan.

## Perintah WhatsApp aktif

| Perintah | Fungsi | Akses |
| --- | --- | --- |
| `!masuk` | Memulai absensi masuk | Siswa, melalui bot wali kelasnya |
| `!pulang` | Memulai absensi pulang | Siswa, melalui bot wali kelasnya |
| `!izin alasan` | Membuka proses izin dua tahap melalui tautan sekali pakai | Siswa, melalui bot wali kelasnya |
| `!lokasi` | Meminta pengiriman lokasi sekolah baru | Admin, melalui bot utama |
| `!bantuan` | Menampilkan perintah yang tersedia sesuai role pengirim | Semua pengguna |

Bot utama hanya menerima `!lokasi` dari admin dan mengirim OTP login dashboard. Siswa mengirim `!masuk`, `!pulang`, atau `!izin alasan` ke nomor wali kelasnya. Sistem menolak siswa yang mengirim command ke bot wali kelas lain.

Setelah mengirim `!masuk` atau `!pulang`, siswa menerima tautan sekali pakai yang berlaku selama 2 menit. Tautan membuka kamera depan dan GPS tanpa menyediakan pilihan unggah dari galeri. Setelah mengirim `!izin alasan`, siswa menerima tautan izin selama 5 menit untuk mengambil selfie langsung, mencatat GPS, lalu mengunggah surat atau bukti secara terpisah. Lokasi izin tidak dibatasi radius sekolah. Absensi masuk/pulang langsung masuk laporan setelah lolos verifikasi. Izin langsung dicatat setelah selfie terverifikasi dan bukti diunggah, tanpa konfirmasi admin/wali kelas.

## Persyaratan

- Node.js 22.12 atau lebih baru.
- npm.
- Satu nomor WhatsApp aktif untuk bot utama.
- Nomor WhatsApp setiap wali kelas yang akan dijadikan bot kelas.

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

Isi `INITIAL_ADMIN_NUMBER` pada `.env` dengan nomor admin pertama.

Gunakan kode negara tanpa tanda `+`; nomor Indonesia yang diawali `08` ditulis menjadi `628`.

Nilai tersebut hanya digunakan ketika penyimpanan role belum ada di SQLite. Tidak ada nomor admin yang ditambahkan otomatis saat restart. Pada instalasi yang sudah berjalan, pengelolaan admin dilakukan melalui dashboard.

## Konfigurasi

Template konfigurasi awal tersedia pada berkas berikut:

| Berkas | Kegunaan |
| --- | --- |
| `roles.example.json` | Contoh format admin dan peran dashboard |
| `lokasi.example.json` | Contoh koordinat lokasi sekolah |
| `jam.example.json` | Contoh jadwal masuk dan pulang |

File JSON runtime lama tetap dapat diimpor pada instalasi yang sudah ada, tetapi semuanya diabaikan Git karena dapat berisi data pribadi. Perubahan selanjutnya disimpan ke SQLite. Foto absensi disimpan sebagai file privat di `attendance_photos`; versi lama yang masih tertanam sebagai Base64 dimigrasikan otomatis saat startup.

Variabel lingkungan opsional:

| Variabel | Nilai awal | Keterangan |
| --- | ---: | --- |
| `TZ` | `Asia/Jakarta` | Zona waktu untuk tanggal, jam absensi, dan proses aplikasi |
| `DB_PATH` | `data/absensi.sqlite` | Lokasi database SQLite |
| `PUBLIC_BASE_URL` | `http://localhost:3200` | Alamat publik HTTPS yang dibuka siswa untuk kamera absensi |
| `INITIAL_ADMIN_NUMBER` | kosong | Nomor admin pertama untuk database baru |
| `WA_MAIN_NUMBER` | kosong | Nomor akun WhatsApp bot utama yang wajib terhubung |
| `QR_ACCESS_TOKEN` | kosong | Password HTTP Basic minimal 16 karakter untuk membuka `/qr` dari jaringan |
| `TRUST_PROXY_HOPS` | `0` | Jumlah reverse proxy tepercaya di depan aplikasi |
| `SESSION_COOKIE_SECURE` | otomatis | Paksa cookie sesi hanya melalui HTTPS |
| `BAILEYS_AUTH_DATA_PATH` | `.baileys_auth` | Direktori seluruh sesi Baileys |
| `WA_LOG_LEVEL` | `silent` | Level log internal Baileys |
| `FACE_WORKER_COUNT` | `1` | Jumlah worker verifikasi wajah; tambah hanya jika RAM dan CPU mencukupi |
| `FACE_QUEUE_LIMIT` | `100` | Batas antrean verifikasi wajah |
| `FACE_TIMEOUT_MS` | `60000` | Batas waktu verifikasi wajah dalam milidetik |
| `FACE_SLOW_LOG_MS` | `10000` | Catat verifikasi yang melampaui durasi ini sebagai log performa |
| `FACE_REFERENCE_CACHE_LIMIT` | `500` | Jumlah descriptor foto referensi yang disimpan per worker |
| `FACE_TINY_INPUT_SIZE` | `320` | Resolusi detektor wajah cepat; kelipatan 32 antara 128–608 |
| `FACE_TINY_SCORE_THRESHOLD` | `0.45` | Ambang keyakinan detektor wajah cepat |
| `WA_SEND_MAX_RETRIES` | `3` | Jumlah percobaan ulang pengiriman WhatsApp setelah kegagalan |
| `WA_SEND_RETRY_BASE_DELAY_MS` | `5000` | Jeda awal retry pengiriman WhatsApp dalam milidetik |
| `WA_SEND_RETRY_MAX_DELAY_MS` | `60000` | Batas maksimum jeda retry pengiriman WhatsApp dalam milidetik |
| `WA_SEND_RETRY_JITTER_RATIO` | `0.35` | Variasi acak jeda retry (`0` sampai `1`) untuk menghindari burst |
| `NOTIFICATION_CONCURRENCY` | `2` | Jumlah notifikasi yang dikirim bersamaan |
| `NOTIFICATION_QUEUE_LIMIT` | `200` | Batas antrean notifikasi |
| `WA_SEND_SAFETY_MODE` | `automatic` | Proteksi ritme kirim otomatis: `automatic`, `conservative`, atau `off`; mode otomatis direkomendasikan |
| `WA_SEND_MIN_INTERVAL_MS` | `1000` | Jeda minimum antar pengiriman |
| `WA_SEND_MAX_INTERVAL_MS` | `2200` | Jeda maksimum antar pengiriman; jeda acak membantu mencegah burst |
| `WA_SEND_RECIPIENT_INTERVAL_MS` | `3500` | Jeda minimum ke penerima yang sama |
| `WA_SEND_MAX_PER_MINUTE` | `30` | Batas pengiriman per menit; `0` menonaktifkan batas |
| `WA_SEND_QUEUE_LIMIT` | `500` | Batas antrean pengiriman WhatsApp |
| `WA_SEND_FAILURE_THRESHOLD` | `5` | Kegagalan berulang sebelum jeda pemulihan otomatis |
| `WA_SEND_FAILURE_COOLDOWN_MS` | `120000` | Durasi jeda pemulihan setelah kegagalan berulang |

Nilai tersebut dapat disimpan di `.env`. Alternatifnya, atur langsung melalui PowerShell:

```powershell
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

Halaman `/qr` menampilkan satu kartu untuk bot utama dan satu kartu untuk setiap nomor wali kelas yang tersimpan di dashboard. Pindai masing-masing QR memakai nomor yang tertulis pada kartu. Satu wali yang menangani beberapa kelas tetap memakai satu sesi. Sesi disimpan di `.baileys_auth`, sehingga pemindaian biasanya hanya diperlukan sekali. Jika akun salah atau sudah logout, tombol pada kartu dapat menghapus sesi tersebut dan menampilkan QR baru.

Untuk produksi menggunakan PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

## Alur penggunaan

1. Admin menjalankan aplikasi lalu menghubungkan bot utama dan semua bot wali melalui `/qr`.
2. Admin masuk ke dashboard dengan nomor yang tercatat sebagai admin.
3. OTP enam digit dikirim ke WhatsApp dan berlaku selama 5 menit.
4. Admin membuat kelas, menetapkan wali kelas, dan menambahkan siswa serta nomor orang tua.
5. Admin atau wali kelas mengunggah foto referensi wajah siswa melalui dashboard.
6. Siswa mengirim `!masuk` atau `!pulang` ke nomor wali kelasnya, membuka tautan sekali pakai, lalu mengambil selfie langsung dan mengizinkan GPS.
7. Untuk izin, siswa mengirim `!izin alasan` ke nomor wali kelasnya, memverifikasi selfie dan GPS melalui tautan, lalu mengunggah surat atau bukti pada tahap kedua.
8. Absensi masuk/pulang dan izin yang memenuhi persyaratan langsung dicatat dan dikirimkan sebagai notifikasi kepada pihak terkait. Tidak ada tahap persetujuan admin/wali kelas.

Wali kelas hanya dapat mengakses dan mengunggah foto siswa pada kelas yang menjadi tanggung jawabnya.

## Menjalankan pengujian

```bash
npm test
```

Setelah mengubah kelas CSS dashboard, bangun ulang stylesheet lokal:

```bash
npm run build:css
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
attendance_photos/       Foto absensi privat di luar blob SQLite
exports/                 Arsip ekspor lokal; diabaikan Git
```

Direktori seperti `.baileys_auth`, `data`, `face_db`, `face_rec`, `attendance_photos`, `izin_bukti`, dan `exports` berisi data lokal atau sensitif dan telah diabaikan Git.

## Catatan keamanan

- Jangan membagikan direktori sesi `.baileys_auth`.
- Isi `WA_MAIN_NUMBER` dan `QR_ACCESS_TOKEN` pada produksi. `/qr` tanpa token hanya dapat dibuka langsung melalui localhost; akses jaringan akan meminta HTTP Basic dengan token sebagai password.
- Batasi akses jaringan ke dashboard karena aplikasi saat ini berjalan melalui HTTP.
- Gunakan HTTPS pada `PUBLIC_BASE_URL`; browser ponsel memblokir kamera pada alamat HTTP biasa.
- Ganti nomor admin bawaan sebelum digunakan di lingkungan lain.
- Cadangkan database SQLite dan foto referensi secara berkala.
- Gunakan reverse proxy HTTPS apabila dashboard diakses di luar jaringan lokal.

### Batas verifikasi foto dan lokasi

Absensi masuk/pulang dan izin diproses otomatis tanpa konfirmasi admin/wali kelas. Pencocokan wajah, pemeriksaan koordinat dan radius sekolah untuk absensi, jadwal, serta larangan pencatatan ganda tetap berlaku. Izin memerlukan selfie terverifikasi dan unggahan bukti; lokasinya tidak dibatasi radius sekolah.

Browser mengirim gambar dan koordinat yang dapat dimanipulasi. Pencocokan wajah bukan pemeriksaan liveness dan tidak membuktikan bahwa foto baru diambil. Alur otomatis ini tidak menjamin pencegahan foto lama atau GPS palsu.
