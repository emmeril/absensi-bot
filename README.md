# Ruang Hadir - Bot Absensi WhatsApp

Ruang Hadir adalah aplikasi absensi sekolah berbasis WhatsApp dengan verifikasi wajah, validasi lokasi, pengajuan izin, notifikasi kepada pihak terkait, serta dashboard web untuk administrasi dan laporan.

## Fitur utama

- Absensi masuk/pulang otomatis dicatat setelah verifikasi wajah, lokasi, dan jadwal melalui halaman kamera.
- Verifikasi selfie dengan foto referensi siswa.
- Validasi lokasi menggunakan koordinat sekolah.
- Pengajuan izin dua tahap: selfie terverifikasi lalu unggah bukti terpisah.
- Notifikasi absensi dan izin kepada admin, wali kelas, dan orang tua.
- Dashboard web untuk mengelola siswa, kelas, wali kelas, admin, jadwal, izin, dan laporan.
- Pengaturan brand dashboard untuk mengganti nama aplikasi dan logo PNG/JPEG.
- Ekspor laporan ke Excel.
- Login dashboard menggunakan username dan password dengan role admin atau wali kelas.
- Multi-bot Baileys: satu sesi bot untuk setiap nomor wali kelas.
- Absensi disimpan sebagai baris SQLite terindeks; data JSON lama dimigrasikan otomatis saat startup.
- Notifikasi memakai outbox SQLite persisten, sehingga antrean dilanjutkan setelah restart.
- Ekspor Excel dibuat dalam buffer terpisah untuk setiap permintaan.

## Perintah WhatsApp aktif

### Absensi guru melalui Bot Guru

Admin membuka kelompok menu **Absen Guru**, yang berisi **Ringkasan**, **Data Guru**, **Jam Mengajar**, **Izin**, dan **Laporan Kehadiran Guru**. Koneksi nomor guru tersedia di **Pengaturan > Bot Guru**.

1. Mengatur nomor WhatsApp khusus bot guru, berbeda dari nomor guru dan bot siswa. Hubungkan nomor tersebut dengan memindai QR di **Pengaturan > Bot Guru**.
2. Menambahkan nama dan nomor guru, termasuk guru yang juga menjadi wali kelas, lalu mengunggah foto referensi wajah.
3. Menambahkan jadwal mingguan: guru, hari, kelas, mata pelajaran, jam mulai/selesai, toleransi terlambat, dan tanggal berlaku. Jam pelajaran berurutan di kelas yang sama dibuat sebagai satu sesi. Jadwal guru yang bertabrakan ditolak. Akhiri jadwal lama sebelum menggantinya, dan masukkan tanggal libur sekolah pada pengaturan guru.

Guru mengirim **`!masuk` ke Bot Guru**, lalu membuka satu tautan pribadi:

- Tahap 1: selfie terverifikasi dan GPS dalam radius 100 meter sekolah. Kehadiran langsung disimpan, terpisah dari bukti mengajar.
- Tahap 2: foto kegiatan melalui kamera belakang dan materi yang diajarkan. GPS diperiksa kembali. Bukti hanya dapat dikirim setelah sesi dimulai; tidak ada perintah `!jurnal` atau unggahan galeri.
- Tautan dapat dibuka kembali hingga sesi berakhir, termasuk setelah restart server. Tautan bersifat rahasia dan menjadi akses ke sesi guru tersebut. Mengirim `!masuk` lagi menghasilkan tautan pengganti dan membatalkan tautan sebelumnya.
- Jendela absensi dibuka 15 menit sebelum mulai sampai tepat sebelum jam selesai. Jika dua jendela sesi berdekatan sedang terbuka, bot mengirim tautan masing-masing dengan label kelas dan jam agar guru memilih sesi yang benar.
- **`!jadwal`** menampilkan jadwal hari ini. Tidak ada kewajiban absen pada hari tanpa jadwal atau tanggal libur.

Ringkasan guru menampilkan jumlah guru aktif, sesi terjadwal, sesi hadir, dan guru izin untuk tanggal pilihan. Admin dapat mencatat Izin, Sakit, atau Tugas Luar per hari; izin berlaku untuk seluruh sesi pada tanggal itu, membatalkan tautan yang masih aktif, dan tidak dapat ditambahkan setelah guru mulai absen. Laporan harian menyediakan selfie/foto kegiatan privat, tinjauan beserta catatan, dan ekspor CSV. Status membedakan belum hadir, izin, hadir dengan bukti belum lengkap, dan bukti lengkap. Foto kegiatan merupakan bahan tinjauan, bukan verifikasi otomatis bahwa guru mengajar sepanjang sesi.

Data guru, jadwal, token yang di-hash, dan catatan sesi disimpan di SQLite melalui penyimpanan JSON aplikasi. Foto disimpan privat di `attendance_photos/teachers`; hanya admin dapat membuka bukti lewat API. Jadwal dan identitas disalin ke catatan kehadiran untuk mempertahankan riwayat. Absensi siswa tetap menggunakan bot wali kelas dan aturan yang sudah ada.

### Absensi siswa dan pengaturan lokasi

| Perintah | Fungsi | Akses |
| --- | --- | --- |
| `!masuk` | Memulai absensi masuk | Siswa, melalui bot wali kelasnya |
| `!pulang` | Memulai absensi pulang | Siswa, melalui bot wali kelasnya |
| `!izin alasan` | Membuka proses izin dua tahap melalui tautan sekali pakai | Siswa, melalui bot wali kelasnya |
| `!lokasi` | Meminta pengiriman lokasi sekolah baru | Admin, melalui salah satu bot wali kelas |
| `!bantuan` | Menampilkan perintah yang tersedia sesuai role pengirim | Semua pengguna |

Seluruh perintah dikirim ke nomor bot wali kelas. Admin dapat mengirim `!lokasi` ke salah satu bot wali, sedangkan siswa mengirim `!masuk`, `!pulang`, atau `!izin alasan` ke nomor wali kelasnya. Sistem menolak siswa yang mengirim command ke bot wali kelas lain.

Setelah mengirim `!masuk` atau `!pulang`, siswa menerima tautan sekali pakai yang berlaku selama 2 menit. Tautan membuka kamera depan dan GPS tanpa menyediakan pilihan unggah dari galeri. Setelah mengirim `!izin alasan`, siswa menerima tautan izin selama 5 menit untuk mengambil selfie langsung, mencatat GPS, lalu mengunggah surat atau bukti secara terpisah. Lokasi izin tidak dibatasi radius sekolah. Absensi masuk/pulang langsung masuk laporan setelah lolos verifikasi. Izin langsung dicatat setelah selfie terverifikasi dan bukti diunggah, tanpa konfirmasi admin/wali kelas.

## Persyaratan

- Node.js 22.12 atau lebih baru.
- npm.
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

Isi `INITIAL_ADMIN_NUMBER`, `INITIAL_ADMIN_USERNAME`, dan `INITIAL_ADMIN_PASSWORD` pada `.env` untuk akun admin pertama.

Gunakan kode negara tanpa tanda `+`; nomor Indonesia yang diawali `08` ditulis menjadi `628`.

Nilai tersebut hanya digunakan ketika penyimpanan role belum ada di SQLite. Tidak ada nomor admin yang ditambahkan otomatis saat restart. Pada instalasi yang sudah berjalan, pengelolaan admin dilakukan melalui dashboard.

## Konfigurasi

Template konfigurasi awal tersedia pada berkas berikut:

| Berkas | Kegunaan |
| --- | --- |
| `roles.example.json` | Contoh format admin dan peran dashboard |
| `lokasi.example.json` | Contoh koordinat lokasi sekolah |
| `jam.example.json` | Contoh jadwal masuk dan pulang |

File JSON runtime lama tetap dapat diimpor pada instalasi yang sudah ada, tetapi semuanya diabaikan Git karena dapat berisi data pribadi. Perubahan selanjutnya, termasuk pengaturan brand, disimpan ke SQLite. `brand.json` hanya dipakai sebagai sumber impor awal jika tersedia, sedangkan logo disimpan sebagai file privat di direktori `brand`. Foto absensi disimpan sebagai file privat di `attendance_photos`; versi lama yang masih tertanam sebagai Base64 dimigrasikan otomatis saat startup.

Variabel lingkungan opsional:

| Variabel | Nilai awal | Keterangan |
| --- | ---: | --- |
| `TZ` | `Asia/Jakarta` | Zona waktu untuk tanggal, jam absensi, dan proses aplikasi |
| `DB_PATH` | `data/absensi.sqlite` | Lokasi database SQLite |
| `PUBLIC_BASE_URL` | `http://localhost:3200` | Alamat publik HTTPS yang dibuka siswa untuk kamera absensi |
| `INITIAL_ADMIN_NUMBER` | kosong | Nomor admin pertama untuk database baru |
| `INITIAL_ADMIN_USERNAME` | kosong | Username admin pertama, 3–32 karakter |
| `INITIAL_ADMIN_PASSWORD` | kosong | Password admin pertama, minimal 10 karakter |
| `TRUST_PROXY_HOPS` | `0` | Jumlah reverse proxy tepercaya di depan aplikasi |
| `SESSION_COOKIE_SECURE` | otomatis | Paksa cookie sesi hanya melalui HTTPS |
| `BAILEYS_AUTH_DATA_PATH` | `.baileys_auth` | Direktori seluruh sesi Baileys |
| `WA_LOG_LEVEL` | `silent` | Level log internal Baileys |
| `WA_WEB_VERSION` | otomatis | Versi protokol WhatsApp Web; biarkan kosong agar mengikuti versi terbaru |
| `FACE_WORKER_COUNT` | `1` | Jumlah worker verifikasi wajah; tambah hanya jika RAM dan CPU mencukupi |
| `FACE_QUEUE_LIMIT` | `100` | Batas antrean verifikasi wajah |
| `FACE_ESTIMATED_JOB_MS` | `2500` | Estimasi awal durasi verifikasi untuk admission control; disesuaikan otomatis saat runtime |
| `FACE_TIMEOUT_MS` | `60000` | Deadline total verifikasi sejak request masuk, termasuk waktu antre |
| `FACE_SLOW_LOG_MS` | `10000` | Catat verifikasi yang melampaui durasi ini sebagai log performa |
| `FACE_REFERENCE_CACHE_LIMIT` | `500` | Jumlah descriptor foto referensi yang disimpan per worker |
| `FACE_TINY_INPUT_SIZE` | `320` | Resolusi detektor wajah cepat; kelipatan 32 antara 128–608 |
| `FACE_TINY_SCORE_THRESHOLD` | `0.45` | Ambang keyakinan detektor wajah cepat |
| `WA_SEND_MAX_RETRIES` | `3` | Jumlah percobaan ulang pengiriman WhatsApp setelah kegagalan |
| `WA_SEND_RETRY_BASE_DELAY_MS` | `5000` | Jeda awal retry pengiriman WhatsApp dalam milidetik |
| `WA_SEND_RETRY_MAX_DELAY_MS` | `60000` | Batas maksimum jeda retry pengiriman WhatsApp dalam milidetik |
| `WA_SEND_RETRY_JITTER_RATIO` | `0.35` | Variasi acak jeda retry (`0` sampai `1`) untuk menghindari burst |
| `NOTIFICATION_OUTBOX_CONCURRENCY` | `4` | Jumlah pekerjaan outbox yang dapat berjalan paralel; ritme tiap akun bot tetap dibatasi |
| `NOTIFICATION_OUTBOX_POLL_MS` | `2000` | Interval pemeriksaan pekerjaan notifikasi di SQLite |
| `NOTIFICATION_RETRY_BASE_DELAY_MS` | `15000` | Jeda awal retry outbox setelah seluruh retry pengiriman gagal |
| `NOTIFICATION_RETRY_MAX_DELAY_MS` | `900000` | Jeda maksimum retry outbox |
| `NOTIFICATION_MAX_ATTEMPTS` | `12` | Batas percobaan outbox sebelum ditandai gagal |
| `NOTIFICATION_SENT_RETENTION_MS` | `604800000` | Lama riwayat notifikasi berhasil dipertahankan |
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

Pada proses pertama, masuk ke dashboard lalu buka **Pengaturan > Bot Siswa** untuk nomor wali kelas dan **Pengaturan > Bot Guru** untuk nomor khusus guru:

- Dashboard: `http://localhost:3200`

Submenu Bot Siswa dan Bot Guru di Pengaturan tersedia untuk pengguna yang sudah login tanpa password koneksi terpisah. Administrator dapat melihat keduanya, sedangkan wali kelas hanya dapat melihat dan mengelola Bot Siswa yang nomornya sesuai dengan akun wali tersebut. Pindai QR memakai nomor yang tertulis pada kartu. Satu wali yang menangani beberapa kelas tetap memakai satu sesi. Sesi disimpan di `.baileys_auth`, sehingga pemindaian biasanya hanya diperlukan sekali. Jika akun salah atau sudah logout, tombol pada kartu dapat menghapus sesi tersebut dan menampilkan QR baru.

Untuk produksi menggunakan PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

## Alur penggunaan

1. Admin menjalankan aplikasi lalu masuk ke dashboard memakai username dan password.
2. Admin membuat kelas, menetapkan wali kelas beserta akun dashboard-nya, dan menambahkan siswa serta nomor orang tua.
3. Admin menghubungkan semua bot wali melalui **Pengaturan > Bot Siswa** dan nomor guru melalui **Pengaturan > Bot Guru**; wali kelas juga dapat menghubungkan bot siswa miliknya sendiri.
4. Admin atau wali kelas mengunggah foto referensi wajah siswa melalui dashboard.
5. Siswa mengirim `!masuk` atau `!pulang` ke nomor wali kelasnya, membuka tautan sekali pakai, lalu mengambil selfie langsung dan mengizinkan GPS.
6. Untuk izin, siswa mengirim `!izin alasan` ke nomor wali kelasnya, memverifikasi selfie dan GPS melalui tautan, lalu mengunggah surat atau bukti pada tahap kedua.
7. Absensi masuk/pulang dan izin yang memenuhi persyaratan langsung dicatat dan dikirimkan sebagai notifikasi kepada pihak terkait. Tidak ada tahap persetujuan admin/wali kelas.

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
models/database.js       Tabel absensi, outbox notifikasi, dan konfigurasi SQLite
lib/                     Aturan dan utilitas aplikasi
services/                Pool worker dan layanan verifikasi wajah
workers/face-worker.js   Worker pemrosesan wajah
test/                    Pengujian otomatis
ecosystem.config.js      Konfigurasi PM2
attendance_photos/       Foto absensi privat di luar blob SQLite
exports/                 Arsip ekspor lokal; diabaikan Git
```

Direktori seperti `.baileys_auth`, `data`, `face_db`, `face_rec`, `attendance_photos`, `izin_bukti`, `brand`, dan `exports` berisi data lokal atau sensitif dan telah diabaikan Git.

## Catatan keamanan

- Jangan membagikan direktori sesi `.baileys_auth`.
- Menu WhatsApp dan QR memerlukan login dashboard. Administrator dapat mengakses semua bot; wali kelas hanya dapat mengakses bot miliknya.
- Batasi akses jaringan ke dashboard karena aplikasi saat ini berjalan melalui HTTP.
- Gunakan HTTPS pada `PUBLIC_BASE_URL`; browser ponsel memblokir kamera pada alamat HTTP biasa.
- Ganti username dan password admin awal sebelum digunakan di lingkungan lain.
- Cadangkan database SQLite dan foto referensi secara berkala.
- Gunakan reverse proxy HTTPS apabila dashboard diakses di luar jaringan lokal.

### Batas verifikasi foto dan lokasi

Absensi masuk/pulang dan izin diproses otomatis tanpa konfirmasi admin/wali kelas. Pencocokan wajah, pemeriksaan koordinat dan radius sekolah untuk absensi, jadwal, serta larangan pencatatan ganda tetap berlaku. Izin memerlukan selfie terverifikasi dan unggahan bukti; lokasinya tidak dibatasi radius sekolah.

Browser mengirim gambar dan koordinat yang dapat dimanipulasi. Pencocokan wajah bukan pemeriksaan liveness dan tidak membuktikan bahwa foto baru diambil. Alur otomatis ini tidak menjamin pencegahan foto lama atau GPS palsu.
