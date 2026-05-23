const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const { PDFDocument } = require('pdf-lib');

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
    const data = new Uint8Array(fs.readFileSync(pdfPath));

    const doc = await pdfjsLib.getDocument({ data }).promise;
    const totalPages = doc.numPages;

    const index = {};

    for (let i = 1; i <= totalPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      const numbers = text.match(/\b\d{4,}\b/g) || [];

      for (const num of numbers) {
        if (!index[num]) index[num] = [];
        if (!index[num].includes(i)) index[num].push(i);
      }
    }

    fs.writeFileSync(path.join(adminDir, 'index.json'), JSON.stringify(index, null, 2));

    res.json({
      success: true,
      pages: totalPages,
      indexed: Object.keys(index).length,
      message: 'PDF uploaded and indexed successfully'
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

app.post('/api/search', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Personal ID is required' });

  try {
    const uploadsRoot = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsRoot)) {
      return res.status(404).json({ error: 'No certificates uploaded yet' });
    }

    const adminDirs = fs.readdirSync(uploadsRoot);
    for (const adminName of adminDirs) {
      const indexPath = path.join(uploadsRoot, adminName, 'index.json');
      const pdfPath = path.join(uploadsRoot, adminName, 'certificates.pdf');
      if (!fs.existsSync(indexPath) || !fs.existsSync(pdfPath)) continue;

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const pages = index[id];
      if (!pages || pages.length === 0) continue;

      const originalPdf = await PDFDocument.load(fs.readFileSync(pdfPath));
      const newPdf = await PDFDocument.create();

      for (const pageNum of pages) {
        const [copiedPage] = await newPdf.copyPages(originalPdf, [pageNum - 1]);
        newPdf.addPage(copiedPage);
      }

      const pdfBytes = await newPdf.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="certificate-${id}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }

    res.status(404).json({ error: 'لم يتم العثور على شهادة بهذا الرقم' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
