# Absensi Karyawan — Selfie + Lokasi

Aplikasi absensi sederhana: karyawan login → klik Absen Masuk/Pulang → selfie otomatis (kamera depan, countdown 3 detik) + lokasi GPS otomatis + timestamp. Admin melihat daftar absensi lengkap dengan foto & link peta.

**Stack:** Node.js + Express. Data: file JSON di `data/` (tidak perlu install database). Foto: `data/photos/`.

## Akun bawaan
- Admin: `admin` / `admin123` → **SEGERA ganti** via menu di `/admin` (Ganti Password di halaman karyawan → tombol profil). 
  Atau lewat API: `POST /api/me/password {oldPassword, newPassword}`.
- Karyawan ditambahkan oleh admin di halaman `/admin`.

## Deploy di VPS (Ubuntu + nginx)

```bash
# 1. clone & install
cd /opt
git clone <URL_REPO> absensi-app
cd absensi-app
npm install --omit=dev

# 2. jalankan dengan pm2 (auto-restart)
npm i -g pm2
pm2 start server.js --name absensi
pm2 save && pm2 startup

# 3. nginx reverse proxy
cat > /etc/nginx/sites-available/absensi <<'EOF'
server {
    listen 80;
    server_name absensi.DOMAIN_ANDA.com;   # <-- GANTI
    client_max_body_size 10M;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF
ln -sf /etc/nginx/sites-available/absensi /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 4. SSL (WAJIB — kamera & GPS browser hanya aktif di HTTPS!)
apt install -y certbot python3-certbot-nginx
certbot --nginx -d absensi.DOMAIN_ANDA.com
```

Tanpa domain? Bisa juga akses via `https://IP` dengan self-signed cert (browser akan warning, tapi kamera tetap jalan setelah diizinkan):
```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/absensi.key -out /etc/ssl/certs/absensi.crt \
  -subj "/CN=absensi"
# lalu ubah nginx: listen 443 ssl; ssl_certificate ...; ssl_certificate_key ...;
```

## Update versi baru
```bash
cd /opt/absensi-app && git pull && npm install --omit=dev && pm2 restart absensi
```

## Catatan penting
- **HTTPS wajib** agar browser mengizinkan kamera + GPS.
- Folder `data/` berisi seluruh data (db.json + foto) — **backup folder ini** (`tar czf absensi-backup-$(date +%F).tgz data/`).
- Port default 3000, ubah via `PORT=8080 pm2 start server.js`.
