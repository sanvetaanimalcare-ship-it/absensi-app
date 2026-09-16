// ============================================================
// Absensi Karyawan — selfie + lokasi otomatis
// Stack: Node.js + Express, data: file JSON (SQLite-level simplicity)
// ============================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- helper ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');

// ---------- secret untuk token ----------
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SECRET = process.env.SECRET;
if (!SECRET) {
  SECRET = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim()
    : (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, s); return s; })();
}

// ---------- database (file JSON, atomic write) ----------
function saveDB() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
let db;
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} else {
  const salt = newSalt();
  db = {
    nextEmpId: 2, nextRecId: 1,
    employees: [{ id: 1, name: 'Admin', username: 'admin', salt, hash: hashPw('admin123', salt), isAdmin: true }],
    records: []
  };
  saveDB();
  console.log('>> Database dibuat. Login admin: admin / admin123 (SEGERA GANTI PASSWORD!)');
}

// ---------- auth token (stateless HMAC, cookie HttpOnly) ----------
function sign(uid) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000; // 7 hari
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verify(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(`${uid}.${exp}`).digest('hex');
  if (sig !== expect || Number(exp) < Date.now()) return null;
  return db.employees.find(e => e.id === Number(uid)) || null;
}
const auth = (req, res, next) => {
  const raw = (req.headers.cookie || '').match(/sid=([^;]+)/);
  const user = verify(raw && raw[1]);
  if (!user) return res.status(401).json({ error: 'Silakan login ulang' });
  req.user = user;
  next();
};
const adminOnly = (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: 'Khusus admin' });

const app = express();
app.use(express.json({ limit: '6mb' }));

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const emp = db.employees.find(e => e.username === String(username || '').trim());
  if (!emp || emp.hash !== hashPw(String(password || ''), emp.salt))
    return res.status(401).json({ error: 'Username / password salah' });
  res.setHeader('Set-Cookie', `sid=${sign(emp.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ ok: true, isAdmin: emp.isAdmin, name: emp.name });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) =>
  res.json({ id: req.user.id, name: req.user.name, username: req.user.username, isAdmin: req.user.isAdmin }));
app.post('/api/me/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (req.user.hash !== hashPw(String(oldPassword || ''), req.user.salt))
    return res.status(400).json({ error: 'Password lama salah' });
  if (String(newPassword || '').length < 6)
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  const emp = db.employees.find(e => e.id === req.user.id);
  emp.salt = newSalt(); emp.hash = hashPw(newPassword, emp.salt);
  saveDB();
  res.json({ ok: true });
});

// ---------- absen (punch) ----------
const DAY_MS = 24 * 3600 * 1000;
const dayKey = ts => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD (waktu server)

app.post('/api/punch', auth, (req, res) => {
  if (req.user.isAdmin) return res.status(403).json({ error: 'Akun admin tidak absen' });
  const { type, lat, lng, acc, photo } = req.body || {};
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'Tipe absen tidak valid' });
  if (typeof lat !== 'number' || typeof lng !== 'number')
    return res.status(400).json({ error: 'Lokasi belum aktif — izinkan akses lokasi' });
  if (!/^data:image\/jpe?g;base64,/.test(String(photo || '')))
    return res.status(400).json({ error: 'Foto selfie tidak terkirim' });

  const now = Date.now();
  const today = db.records.filter(r => r.empId === req.user.id && dayKey(r.ts) === dayKey(now));
  if (today.some(r => r.type === type))
    return res.status(400).json({ error: type === 'in' ? 'Sudah absen masuk hari ini' : 'Sudah absen pulang hari ini' });
  if (type === 'out' && !today.some(r => r.type === 'in'))
    return res.status(400).json({ error: 'Belum absen masuk hari ini' });
  const last = today[today.length - 1];
  if (last && now - last.ts < 60 * 1000)
    return res.status(400).json({ error: 'Terlalu cepat setelah absen terakhir' });

  // simpan foto
  const fname = `${req.user.id}_${now}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, fname), Buffer.from(photo.split(',')[1], 'base64'));

  const rec = { id: db.nextRecId++, empId: req.user.id, type, ts: now, lat, lng, acc: acc || null, photo: fname };
  db.records.push(rec);
  saveDB();
  res.json({ ok: true, record: { type, ts: now } });
});

app.get('/api/me/today', auth, (req, res) => {
  const today = db.records.filter(r => r.empId === req.user.id && dayKey(r.ts) === dayKey(Date.now()));
  res.json(today.map(r => ({ type: r.type, ts: r.ts })));
});

// ---------- admin: daftar absensi ----------
app.get('/api/records', auth, adminOnly, (req, res) => {
  const { from, to } = req.query;
  let rows = db.records.slice().sort((a, b) => b.ts - a.ts);
  if (from) rows = rows.filter(r => dayKey(r.ts) >= from);
  if (to) rows = rows.filter(r => dayKey(r.ts) <= to);
  rows = rows.slice(0, 1000).map(r => {
    const e = db.employees.find(x => x.id === r.empId);
    return { id: r.id, name: e ? e.name : '?', username: e ? e.username : '?', type: r.type, ts: r.ts, lat: r.lat, lng: r.lng, acc: r.acc, photo: '/photos/' + r.photo };
  });
  res.json(rows);
});

// ---------- admin: kelola karyawan ----------
app.get('/api/employees', auth, adminOnly, (req, res) =>
  res.json(db.employees.map(e => ({ id: e.id, name: e.name, username: e.username, isAdmin: e.isAdmin }))));
app.post('/api/employees', auth, adminOnly, (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Nama, username, dan password wajib diisi' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (db.employees.some(e => e.username === String(username).trim()))
    return res.status(400).json({ error: 'Username sudah dipakai' });
  const salt = newSalt();
  const emp = { id: db.nextEmpId++, name: String(name).trim(), username: String(username).trim(), salt, hash: hashPw(password, salt), isAdmin: false };
  db.employees.push(emp); saveDB();
  res.json({ ok: true, id: emp.id });
});
app.post('/api/employees/:id/password', auth, adminOnly, (req, res) => {
  const emp = db.employees.find(e => e.id === Number(req.params.id));
  if (!emp || emp.isAdmin) return res.status(400).json({ error: 'Karyawan tidak ditemukan' });
  if (String(req.body.password || '').length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  emp.salt = newSalt(); emp.hash = hashPw(req.body.password, emp.salt);
  saveDB();
  res.json({ ok: true });
});
app.delete('/api/employees/:id', auth, adminOnly, (req, res) => {
  const emp = db.employees.find(e => e.id === Number(req.params.id));
  if (!emp) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (emp.isAdmin) return res.status(400).json({ error: 'Tidak bisa menghapus admin' });
  db.employees = db.employees.filter(e => e.id !== emp.id);
  db.records = db.records.filter(r => r.empId !== emp.id); // hapus juga riwayatnya
  saveDB();
  res.json({ ok: true });
});

// ---------- foto (hanya user login) ----------
app.get('/photos/:file', auth, (req, res) => {
  const f = path.basename(req.params.file);
  const p = path.join(PHOTO_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ---------- halaman web ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/absen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => console.log(`>> Absensi app jalan di http://localhost:${PORT}`));
