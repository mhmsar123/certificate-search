const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, 'certificates.pdf')
});
const upload = multer({
  storage,
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
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true });
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
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.post('/api/upload', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const pdfPath = path.join(__dirname, 'uploads', 'certificates.pdf');
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

    fs.writeFileSync(
      path.join(__dirname, 'uploads', 'index.json'),
      JSON.stringify(index, null, 2)
    );

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

app.get('/api/status', (req, res) => {
  const pdfPath = path.join(__dirname, 'uploads', 'certificates.pdf');
  const indexPath = path.join(__dirname, 'uploads', 'index.json');
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
    const indexPath = path.join(__dirname, 'uploads', 'index.json');
    const pdfPath = path.join(__dirname, 'uploads', 'certificates.pdf');

    if (!fs.existsSync(indexPath) || !fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: 'No certificates uploaded yet' });
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const pages = index[id];

    if (!pages || pages.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على شهادة بهذا الرقم' });
    }

    const originalPdf = await PDFDocument.load(fs.readFileSync(pdfPath));
    const newPdf = await PDFDocument.create();

    for (const pageNum of pages) {
      const [copiedPage] = await newPdf.copyPages(originalPdf, [pageNum - 1]);
      newPdf.addPage(copiedPage);
    }

    const pdfBytes = await newPdf.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificate-${id}.pdf"`);
    res.send(Buffer.from(pdfBytes));
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
