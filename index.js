const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const { PDFDocument } = require('pdf-lib');

let createCanvas;
try {
  createCanvas = require('canvas').createCanvas;
} catch (e) {
  createCanvas = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
const adminsPath = path.join(dataDir, 'admins.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(adminsPath)) {
  fs.writeFileSync(adminsPath, JSON.stringify([
    { username: 'admin', password: 'admin123' }
  ], null, 2));
}

function getAdmins() {
  return JSON.parse(fs.readFileSync(adminsPath, 'utf8'));
}

function saveAdmins(admins) {
  fs.writeFileSync(adminsPath, JSON.stringify(admins, null, 2));
}

function getAdminDir(username) {
  const dir = path.join(__dirname, 'uploads', username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, getAdminDir(req.session.username));
    },
    filename: (req, file, cb) => cb(null, 'certificates.pdf')
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('PDF files only'), false);
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'certificate-search-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist')));

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const admins = getAdmins();
  const admin = admins.find(a => a.username === username && a.password === password);
  if (admin) {
    req.session.isAdmin = true;
    req.session.username = username;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, username });
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  res.json({
    isAdmin: !!(req.session && req.session.isAdmin),
    username: req.session?.username || null
  });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل' });
  }
  const admins = getAdmins();
  const admin = admins.find(a => a.username === req.session.username);
  if (!admin || admin.password !== currentPassword) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  admin.password = newPassword;
  saveAdmins(admins);
  res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
});

app.post('/api/upload', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const adminDir = getAdminDir(req.session.username);
    const pdfPath = path.join(adminDir, 'certificates.pdf');
    const indexPath = path.join(adminDir, 'index.json');
    const uploadedBytes = fs.readFileSync(req.file.path);

    let existingIndex = {};
    let existingPageCount = 0;
    let mergedPdf = await PDFDocument.create();

    if (fs.existsSync(pdfPath)) {
      const existingPdf = await PDFDocument.load(fs.readFileSync(pdfPath));
      const existingPages = await mergedPdf.copyPages(existingPdf, existingPdf.getPageIndices());
      existingPages.forEach(p => mergedPdf.addPage(p));
      existingPageCount = existingPdf.getPageCount();
      if (fs.existsSync(indexPath)) {
        existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      }
    }

    const newPdf = await PDFDocument.load(uploadedBytes);
    const newPages = await mergedPdf.copyPages(newPdf, newPdf.getPageIndices());
    newPages.forEach(p => mergedPdf.addPage(p));

    const mergedBytes = await mergedPdf.save();
    fs.writeFileSync(pdfPath, Buffer.from(mergedBytes));

    const data = new Uint8Array(uploadedBytes);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const newTotalPages = doc.numPages;
    const newIndex = {};

    for (let i = 1; i <= newTotalPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      const numbers = text.match(/\b\d{4,}\b/g) || [];

      for (const num of numbers) {
        if (!newIndex[num]) newIndex[num] = [];
        if (!newIndex[num].includes(i + existingPageCount)) newIndex[num].push(i + existingPageCount);
      }
    }

    for (const [key, pages] of Object.entries(existingIndex)) {
      if (!newIndex[key]) newIndex[key] = [];
      for (const p of pages) {
        if (!newIndex[key].includes(p)) newIndex[key].push(p);
      }
    }

    fs.writeFileSync(indexPath, JSON.stringify(newIndex, null, 2));

    res.json({
      success: true,
      pages: existingPageCount + newTotalPages,
      indexed: Object.keys(newIndex).length,
      newIndexed: Object.keys(newIndex).length - Object.keys(existingIndex).length,
      message: 'تم إضافة الشهادات بنجاح'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

app.post('/api/delete-certificates', requireAuth, (req, res) => {
  const adminDir = getAdminDir(req.session.username);
  const pdfPath = path.join(adminDir, 'certificates.pdf');
  const indexPath = path.join(adminDir, 'index.json');

  let deleted = false;
  if (fs.existsSync(pdfPath)) { fs.unlinkSync(pdfPath); deleted = true; }
  if (fs.existsSync(indexPath)) { fs.unlinkSync(indexPath); deleted = true; }

  res.json({ success: true, deleted, message: deleted ? 'تم مسح جميع الشهادات' : 'لا توجد شهادات للمسح' });
});

app.post('/api/add-admin', requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
  }

  const admins = getAdmins();
  if (admins.find(a => a.username === username)) {
    return res.json({ success: false, error: 'اسم المستخدم موجود بالفعل' });
  }

  admins.push({ username, password });
  saveAdmins(admins);
  getAdminDir(username);

  res.json({ success: true, message: `تم إضافة الأدمن "${username}" بنجاح` });
});

app.get('/api/status', requireAuth, (req, res) => {
  const adminDir = getAdminDir(req.session.username);
  const pdfPath = path.join(adminDir, 'certificates.pdf');
  const indexPath = path.join(adminDir, 'index.json');
  const hasPdf = fs.existsSync(pdfPath);
  let indexedCount = 0;
  if (hasPdf && fs.existsSync(indexPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      indexedCount = Object.keys(idx).length;
    } catch (e) {}
  }
  res.json({ hasPdf, indexedCount });
});

app.get('/api/pdf/:admin', (req, res) => {
  const pdfPath = path.join(__dirname, 'uploads', req.params.admin, 'certificates.pdf');
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });
  const stat = fs.statSync(pdfPath);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(pdfPath).pipe(res);
});

app.get('/api/certificate-page/:admin/:page', async (req, res) => {
  try {
    const { admin, page } = req.params;
    const pageNum = parseInt(page);
    const pdfPath = path.join(__dirname, 'uploads', admin, 'certificates.pdf');
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });

    const existingPdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    if (pageNum < 1 || pageNum > pdfDoc.getPageCount()) {
      return res.status(400).json({ error: 'Invalid page number' });
    }

    const newPdf = await PDFDocument.create();
    const [copied] = await newPdf.copyPages(pdfDoc, [pageNum - 1]);
    newPdf.addPage(copied);

    const pdfBytes = await newPdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extract page: ' + err.message });
  }
});

const searchRateMap = new Map();

app.post('/api/search', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Personal ID is required' });

  const ip = req.ip;
  const now = Date.now();
  if (searchRateMap.has(ip)) {
    const timestamps = searchRateMap.get(ip).filter(t => now - t < 60000);
    if (timestamps.length >= 3) {
      return res.status(429).json({ error: 'طلبات البحث كثيرة جداً. انتظر دقيقة' });
    }
    timestamps.push(now);
    searchRateMap.set(ip, timestamps);
  } else {
    searchRateMap.set(ip, [now]);
  }

  const logEntry = { id, ip, time: new Date().toISOString(), found: false };

  try {
    const uploadsRoot = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsRoot)) {
      logEntry.found = false;
      return res.status(404).json({ error: 'No certificates uploaded yet' });
    }

    const adminDirs = fs.readdirSync(uploadsRoot);
    for (const adminName of adminDirs) {
      const indexPath = path.join(uploadsRoot, adminName, 'index.json');
      const pdfPath = path.join(uploadsRoot, adminName, 'certificates.pdf');
      if (!fs.existsSync(indexPath) || !fs.existsSync(pdfPath)) continue;

      const isNumeric = /^\d+$/.test(id);
      if (isNumeric && id.length >= 4) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const pages = index[id];
        if (pages && pages.length > 0) {
          logEntry.found = true; return res.json({ success: true, pages, pdfUrl: `/api/pdf/${adminName}`, admin: adminName });
        }
      } else {
        const data = new Uint8Array(fs.readFileSync(pdfPath));
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const matchedPages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const text = textContent.items.map(item => item.str).join(' ');
          if (text.includes(id)) matchedPages.push(i);
        }
        if (matchedPages.length > 0) {
          logEntry.found = true; return res.json({ success: true, pages: matchedPages, pdfUrl: `/api/pdf/${adminName}`, admin: adminName });
        }
      }
    }

    res.status(404).json({ error: 'لم يتم العثور على شهادة بهذا الرقم' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  } finally {
    try {
      const logs = JSON.parse(fs.readFileSync(searchLogPath, 'utf8'));
      logs.push(logEntry);
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      fs.writeFileSync(searchLogPath, JSON.stringify(logs));
    } catch (e) {}
  }
});

const bannerPath = path.join(dataDir, 'banner.json');
const visitorPath = path.join(dataDir, 'visitors.json');
const searchLogPath = path.join(dataDir, 'search-log.json');
if (!fs.existsSync(visitorPath)) fs.writeFileSync(visitorPath, '0');
if (!fs.existsSync(searchLogPath)) fs.writeFileSync(searchLogPath, '[]');

app.get('/api/total-certificates', (req, res) => {
  let total = 0;
  const uploadsRoot = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadsRoot)) {
    const dirs = fs.readdirSync(uploadsRoot);
    for (const d of dirs) {
      const ip = path.join(uploadsRoot, d, 'index.json');
      if (fs.existsSync(ip)) {
        try { total += Object.keys(JSON.parse(fs.readFileSync(ip, 'utf8'))).length; } catch (e) {}
      }
    }
  }
  res.json({ total });
});

app.get('/api/last-update', (req, res) => {
  let latest = 0;
  const uploadsRoot = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadsRoot)) {
    const dirs = fs.readdirSync(uploadsRoot);
    for (const d of dirs) {
      const pdfPath = path.join(uploadsRoot, d, 'certificates.pdf');
      if (fs.existsSync(pdfPath)) {
        const mtime = fs.statSync(pdfPath).mtimeMs;
        if (mtime > latest) latest = mtime;
      }
    }
  }
  res.json({ timestamp: latest });
});

app.get('/api/visitors', (req, res) => {
  let count = parseInt(fs.readFileSync(visitorPath, 'utf8')) || 0;
  count++;
  fs.writeFileSync(visitorPath, String(count));
  res.json({ count });
});

app.get('/api/banner', (req, res) => {
  let text = '';
  if (fs.existsSync(bannerPath)) {
    try {
      const banner = JSON.parse(fs.readFileSync(bannerPath, 'utf8'));
      if (banner.text) text = banner.text;
    } catch (e) {}
  }
  res.json({ text });
});

app.post('/api/banner', requireAuth, (req, res) => {
  const { text } = req.body;
  fs.writeFileSync(bannerPath, JSON.stringify({ text: text || '' }));
  const exec = require('child_process').exec;
  exec('git add -A && git commit --allow-empty -m "update banner" && git push', { cwd: __dirname }, (err) => {
    if (err) console.log('Git push failed (expected on Render):', err.message);
  });
  res.json({ success: true, message: 'تم تحديث البانر' });
});

app.get('/api/search-log', requireAuth, (req, res) => {
  const logs = JSON.parse(fs.readFileSync(searchLogPath, 'utf8'));
  res.json(logs.reverse().slice(0, 50));
});

app.get('/api/search-log/export', requireAuth, (req, res) => {
  const logs = JSON.parse(fs.readFileSync(searchLogPath, 'utf8'));
  const csv = 'الرقم,التاريخ,العنوان,النتيجة\n' + logs.reverse().map(l => `"${l.id}","${l.time}","${l.ip}","${l.found ? 'موجود' : 'غير موجود'}"`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="search-log.csv"');
  res.send('\uFEFF' + csv);
});

app.get('/api/stats', requireAuth, (req, res) => {
  const adminDir = getAdminDir(req.session.username);
  const indexPath = path.join(adminDir, 'index.json');
  let certificates = 0;
  if (fs.existsSync(indexPath)) {
    try { certificates = Object.keys(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).length; } catch (e) {}
  }
  const visitors = parseInt(fs.readFileSync(visitorPath, 'utf8')) || 0;
  const logs = JSON.parse(fs.readFileSync(searchLogPath, 'utf8'));
  res.json({ certificates, visitors, searches: logs.length });
});

app.get('/admin-mhm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin', (req, res) => {
  res.status(404).send('الصفحة غير موجودة');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
