// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://pioneersprep.in';

// Trust Cloudflare / Render reverse proxy headers for accurate IP rate-limiting
app.set('trust proxy', 1);

// FIX 4: Cryptographically random fallback secret prevents token forgery if env var is unset
const SECRET = process.env.TIMER_SECRET || crypto.randomBytes(32).toString('hex');
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || 'pioneers-prep-script-secure-2026';
const ADMIN_EMAIL = process.env.TARGET_EMAIL || 'anibanerjee699@gmail.com';

// In-memory security stores with automatic garbage collection
const pendingOtps = new Map();
const otpIpRateLimit = new Map();
const usedAuthTokens = new Map();

// FIX 7: In-memory cache to avoid blocking synchronous disk reads on every request
const CACHE_TTL_MS = 60 * 1000;
const fsCache = {
    quizzesList: { data: null, expiresAt: 0 },
    quizPaths: { data: null, expiresAt: 0 },
    notesList: { data: null, expiresAt: 0 },
    notePaths: { data: null, expiresAt: 0 },
    descList: { data: null, expiresAt: 0 },
    descPaths: { data: null, expiresAt: 0 }
};

// FIX 5: Strict 50kb global JSON payload limit (15mb is applied only on /api/submit)
const defaultJsonParser = express.json({ limit: '50kb' });
const submitJsonParser = express.json({ limit: '15mb' });

app.use((req, res, next) => {
    if (req.path === '/api/submit') return next();
    return defaultJsonParser(req, res, next);
});

// Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Serve static website files from public/
// Serve static website files with automatic cache-busting
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        // Forces mobile browsers to immediately apply updates to JS, CSS, and HTML files
        if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// --- SECURITY HELPER FUNCTIONS ---
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeCompareHex(sigA, sigB) {
    if (typeof sigA !== 'string' || typeof sigB !== 'string') return false;
    if (sigA.length !== sigB.length) return false;
    try {
        const bufA = Buffer.from(sigA, 'hex');
        const bufB = Buffer.from(sigB, 'hex');
        if (bufA.length !== bufB.length || bufA.length === 0) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

function safeCompareStrings(strA, strB) {
    if (typeof strA !== 'string' || typeof strB !== 'string') return false;
    const bufA = Buffer.from(strA, 'utf8');
    const bufB = Buffer.from(strB, 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// FIX 1: Strict validation for base64 raster images (blocks XSS attribute breakout)
function isSafeBase64Image(str) {
    if (typeof str !== 'string') return false;
    return /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(str.trim());
}

const RESERVED_JSON_NAMES = new Set([
    'submissions', 'package', 'package-lock', 'quizzes', 'notes', 'descriptive'
]);

// --- CACHED FILE SYSTEM UTILITIES ---
function getAllJsonFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            getAllJsonFiles(filePath, fileList);
        } else if (file.toLowerCase().endsWith('.json')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

function getCachedQuizFiles() {
    const now = Date.now();
    if (fsCache.quizPaths.data && now < fsCache.quizPaths.expiresAt) {
        return fsCache.quizPaths.data;
    }
    const quizzesDir = path.join(__dirname, 'quizzes');
    if (!fs.existsSync(quizzesDir)) fs.mkdirSync(quizzesDir, { recursive: true });
    const files = getAllJsonFiles(quizzesDir);
    fsCache.quizPaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function resolveSafeQuizPath(rawId) {
    if (!rawId || typeof rawId !== 'string') return null;
    const cleanId = path.basename(rawId.trim());
    if (!/^[a-zA-Z0-9_\-\s\(\)\.]+$/.test(cleanId)) return null;
    if (RESERVED_JSON_NAMES.has(cleanId.toLowerCase())) return null;

    const allJsonFiles = getCachedQuizFiles();
    const target1 = cleanId + '.json';
    const target2 = cleanId + '-questions.json';
    const target3 = cleanId;

    const matchedPath = allJsonFiles.find(filePath => {
        const fileName = path.basename(filePath);
        return fileName === target1 || fileName === target2 || fileName === target3;
    });

    return matchedPath || null;
}

function getOfficialQuizDuration(quizId, clientFallback) {
    const cleanId = path.basename(String(quizId || '')).trim();
    const filePath = resolveSafeQuizPath(cleanId);
    if (filePath && fs.existsSync(filePath)) {
        try {
            const quizContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Number(quizContent.duration) > 0) {
                return Number(quizContent.duration);
            }
        } catch (err) {
            console.error('Error reading quiz duration from file:', err);
        }
    }
    const parsed = parseInt(clientFallback, 10);
    if (!isNaN(parsed) && parsed >= 60 && parsed <= 10800) return parsed;
    return 900;
}

function getAllPdfFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            getAllPdfFiles(filePath, fileList);
        } else if (file.toLowerCase().endsWith('.pdf')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

function getCachedNoteFiles() {
    const now = Date.now();
    if (fsCache.notePaths.data && now < fsCache.notePaths.expiresAt) {
        return fsCache.notePaths.data;
    }
    const notesDir = path.join(__dirname, 'notes');
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
    const files = getAllPdfFiles(notesDir);
    fsCache.notePaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function getCachedDescFiles() {
    const now = Date.now();
    if (fsCache.descPaths.data && now < fsCache.descPaths.expiresAt) {
        return fsCache.descPaths.data;
    }
    const descDir = path.join(__dirname, 'descriptive');
    if (!fs.existsSync(descDir)) fs.mkdirSync(descDir, { recursive: true });
    ['IX', 'X', 'XI', 'XII'].forEach(c => {
        const cDir = path.join(descDir, c);
        if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
    });
    const files = getAllPdfFiles(descDir);
    fsCache.descPaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function resolveSafeNotePath(rawFileName) {
    if (!rawFileName || typeof rawFileName !== 'string') return null;
    const cleanName = path.basename(rawFileName.trim());
    const allPdfFiles = getCachedNoteFiles();
    return allPdfFiles.find(filePath => path.basename(filePath).toLowerCase() === cleanName.toLowerCase()) || null;
}

function resolveSafeDescriptivePath(rawFileName) {
    if (!rawFileName || typeof rawFileName !== 'string') return null;
    const cleanName = path.basename(rawFileName.trim());
    const allPdfFiles = getCachedDescFiles();
    return allPdfFiles.find(filePath => path.basename(filePath).toLowerCase() === cleanName.toLowerCase()) || null;
}

const TOKEN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function verifyAuthToken(authToken, expectedEmail = null, checkReplay = false) {
    if (!authToken || typeof authToken !== 'string' || !authToken.includes('|||')) {
        return { valid: false, error: 'Security Alert: Invalid submission token.' };
    }
    const parts = authToken.split('|||');
    if (parts.length !== 2) {
        return { valid: false, error: 'Security Alert: Malformed token.' };
    }
    const [tokenData, authSignature] = parts;
    const expectedAuthSig = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');

    if (!safeCompareHex(authSignature, expectedAuthSig)) {
        return { valid: false, error: 'Security Alert: Unauthorized or tampered session.' };
    }

    const dataParts = tokenData.split('|');
    if (dataParts.length < 2) {
        return { valid: false, error: 'Security Alert: Outdated session token.' };
    }
    const tokenEmail = dataParts[0];
    const issuedAt = parseInt(dataParts[1], 10);

    if (isNaN(issuedAt) || (Date.now() - issuedAt) > TOKEN_MAX_AGE_MS) {
        return { valid: false, error: 'Session expired. Please verify your email again.' };
    }

    if (expectedEmail && tokenEmail !== expectedEmail.trim().toLowerCase()) {
        return { valid: false, error: 'Security Alert: Token email mismatch.' };
    }

    if (checkReplay && usedAuthTokens.has(authSignature)) {
        return { valid: false, error: 'This quiz session has already been submitted.' };
    }

    return { valid: true, email: tokenEmail, signature: authSignature };
}

let submissionWritePromise = Promise.resolve();
function queueSubmissionBackup(entry) {
    submissionWritePromise = submissionWritePromise.then(async () => {
        try {
            const submissionsFile = path.join(__dirname, 'submissions.json');
            let allSubmissions = [];
            if (fs.existsSync(submissionsFile)) {
                const fileData = await fs.promises.readFile(submissionsFile, 'utf8');
                allSubmissions = JSON.parse(fileData);
            }
            allSubmissions.push(entry);
            await fs.promises.writeFile(submissionsFile, JSON.stringify(allSubmissions, null, 2));
        } catch (err) {
            console.error('Local backup failed:', err);
        }
    });
    return submissionWritePromise;
}

// Memory Garbage Collection Loop
setInterval(() => {
    const now = Date.now();
    for (const [email, record] of pendingOtps.entries()) {
        if (now > record.expiresAt) pendingOtps.delete(email);
    }
    for (const [ip, record] of otpIpRateLimit.entries()) {
        if (now > record.resetAt) otpIpRateLimit.delete(ip);
    }
    for (const [sig, expiresAt] of usedAuthTokens.entries()) {
        if (now > expiresAt) usedAuthTokens.delete(sig);
    }
}, 5 * 60 * 1000);

// --- MULTI-PAGE WEBSITE ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get(['/notes', '/study-notes'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'notes.html'));
});
app.get(['/descriptive', '/descriptive-papers'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'descriptive.html'));
});
app.get('/mock-tests', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test-portal.html'));
});

// Sitemap and Robot Directives
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const urls = [
        { loc: '/', priority: '1.0' },
        { loc: '/test-portal.html', priority: '0.9' },
        { loc: '/notes.html', priority: '0.9' },
        { loc: '/descriptive.html', priority: '0.8' }
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url>\n    <loc>${SITE_URL}${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
        `\n</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
});

app.get('/ping', (req, res) => res.status(200).send('Awake'));

// --- API ENDPOINTS ---
app.get('/api/descriptive-questions', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.descList.data && now < fsCache.descList.expiresAt) {
            return res.json({ success: true, files: fsCache.descList.data });
        }

        const allFiles = getCachedDescFiles();
        const grouped = { 'IX': [], 'X': [], 'XI': [], 'XII': [] };

        allFiles.forEach(fullPath => {
            const fileName = path.basename(fullPath);
            const lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
            let mClass = null;
            if (lowerPath.includes('/descriptive/ix/') || lowerPath.includes('/descriptive/class 9/') || lowerPath.includes('/descriptive/class9/')) mClass = 'IX';
            else if (lowerPath.includes('/descriptive/x/') || lowerPath.includes('/descriptive/class 10/') || lowerPath.includes('/descriptive/class10/')) mClass = 'X';
            else if (lowerPath.includes('/descriptive/xi/') || lowerPath.includes('/descriptive/class 11/') || lowerPath.includes('/descriptive/class11/')) mClass = 'XI';
            else if (lowerPath.includes('/descriptive/xii/') || lowerPath.includes('/descriptive/class 12/') || lowerPath.includes('/descriptive/class12/')) mClass = 'XII';
            else {
                const parent = path.basename(path.dirname(fullPath)).toUpperCase();
                if (['IX', 'X', 'XI', 'XII'].includes(parent)) mClass = parent;
            }

            if (mClass && grouped[mClass]) {
                grouped[mClass].push({
                    name: path.basename(fileName, '.pdf').replace(/[_]/g, ' ').replace(/-/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()),
                    fileName
                });
            }
        });

        fsCache.descList = { data: grouped, expiresAt: now + CACHE_TTL_MS };
        res.json({ success: true, files: grouped });
    } catch (err) {
        console.error('Error reading descriptive questions:', err);
        res.status(500).json({ success: false, files: { 'IX': [], 'X': [], 'XI': [], 'XII': [] } });
    }
});

app.get('/api/download-descriptive/:fileName', (req, res) => {
    const filePath = resolveSafeDescriptivePath(req.params.fileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Descriptive paper not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download file.");
    });
});

app.get('/api/notes', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.notesList.data && now < fsCache.notesList.expiresAt) {
            return res.json(fsCache.notesList.data);
        }

        const files = getCachedNoteFiles();
        const grouped = {
            'IX': { Physics: [], Chemistry: [], Biology: [] },
            'X': { Physics: [], Chemistry: [], Biology: [] },
            'XI': { Biology: [] },
            'XII': { Biology: [] }
        };

        files.forEach(fullPath => {
            const fileName = path.basename(fullPath);
            const lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
            let cls = 'XI';
            if (lowerPath.includes('/ix/') || lowerPath.includes('/class9/') || lowerPath.includes('/class 9/') || lowerPath.includes('class9') || lowerPath.includes('class_9') || lowerPath.includes('class-9')) cls = 'IX';
            else if (lowerPath.includes('/x/') || lowerPath.includes('/class10/') || lowerPath.includes('/class 10/') || lowerPath.includes('class10') || lowerPath.includes('class_10') || lowerPath.includes('class-10')) cls = 'X';
            else if (lowerPath.includes('/xi/') || lowerPath.includes('/class11/') || lowerPath.includes('/class 11/') || lowerPath.includes('class11') || lowerPath.includes('class_11') || lowerPath.includes('class-11')) cls = 'XI';
            else if (lowerPath.includes('/xii/') || lowerPath.includes('/class12/') || lowerPath.includes('/class 12/') || lowerPath.includes('class12') || lowerPath.includes('class_12') || lowerPath.includes('class-12')) cls = 'XII';

            let subject = 'Biology';
            if (lowerPath.includes('physics')) subject = 'Physics';
            else if (lowerPath.includes('chemistry')) subject = 'Chemistry';
            else if (lowerPath.includes('biology')) subject = 'Biology';

            const title = path.basename(fileName, '.pdf')
                .replace(/[_]/g, ' ')
                .replace(/-/g, ' ')
                .replace(/class\s*(9|10|11|12|ix|x|xi|xii)/gi, '')
                .replace(/(physics|chemistry|biology)/gi, '')
                .trim()
                .replace(/\b\w/g, c => c.toUpperCase());

            if (grouped[cls] && grouped[cls][subject]) {
                grouped[cls][subject].push({
                    name: title || fileName,
                    fileName
                });
            }
        });

        const formatted = [];
        for (const [cls, subjects] of Object.entries(grouped)) {
            for (const [sub, list] of Object.entries(subjects)) {
                if (list.length > 0) formatted.push({ class: cls, subject: sub, notes: list });
            }
        }

        fsCache.notesList = { data: formatted, expiresAt: now + CACHE_TTL_MS };
        res.json(formatted);
    } catch (err) {
        console.error('Error reading notes directory:', err);
        res.status(500).json([]);
    }
});

app.get('/api/download-note/:fileName', (req, res) => {
    const filePath = resolveSafeNotePath(req.params.fileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Note file not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download note.");
    });
});

app.get('/api/quizzes', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.quizzesList.data && now < fsCache.quizzesList.expiresAt) {
            return res.json({ success: true, quizzes: fsCache.quizzesList.data });
        }

        const allFiles = getCachedQuizFiles();
        const list = allFiles.map(fp => {
            try {
                const c = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                const fileBase = path.basename(fp, '.json');
                return {
                    id: fileBase,
                    title: c.title || fileBase,
                    category: c.category || 'general',
                    classLevel: c.classLevel || 'xi',
                    subject: c.subject || 'general',
                    unit: c.unit || '',
                    chapter: c.chapter || '',
                    topic: c.topic || '',
                    duration: c.duration || 900,
                    totalQuestions: c.questions ? c.questions.length : 0
                };
            } catch {
                return null;
            }
        }).filter(Boolean);

        fsCache.quizzesList = { data: list, expiresAt: now + CACHE_TTL_MS };
        res.json({ success: true, quizzes: list });
    } catch {
        res.status(500).json({ success: false, quizzes: [] });
    }
});

app.get('/api/quiz/:id', (req, res) => {
    if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
    const authCheck = verifyAuthToken(req.get('Authorization')?.replace('Bearer ', ''));
    if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

    const filePath = resolveSafeQuizPath(req.params.id);
    if (!filePath) return res.status(404).json({ error: "Not found" });

    try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json((content.questions || []).map(q => ({
            type: q.type || 'mcq',
            question: q.question,
            options: q.options || []
        })));
    } catch {
        res.status(500).json({ error: "Failed to read quiz file." });
    }
});

app.post('/api/start-quiz', (req, res) => {
    const authCheck = verifyAuthToken(req.get('Authorization')?.replace('Bearer ', ''));
    if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

    const { quizId, duration } = req.body;
    const cleanId = path.basename(String(quizId || '')).trim();
    if (!resolveSafeQuizPath(cleanId)) return res.status(400).json({ error: "Invalid quiz ID." });

    const officialDuration = getOfficialQuizDuration(cleanId, duration);
    const startTime = Date.now();
    const dataToSign = `${cleanId}:${officialDuration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');

    res.json({ startTime, duration: officialDuration, signature });
});

// FIX 2: Per-IP rate limiting and per-email cooldown on /api/send-otp
app.post('/api/send-otp', (req, res) => {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    // Enforce IP rate limit: Max 10 OTP requests per 15 minutes
    const ipRecord = otpIpRateLimit.get(clientIp) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (now > ipRecord.resetAt) {
        ipRecord.count = 0;
        ipRecord.resetAt = now + 15 * 60 * 1000;
    }
    ipRecord.count += 1;
    otpIpRateLimit.set(clientIp, ipRecord);

    if (ipRecord.count > 10) {
        return res.status(429).json({ success: false, error: 'Too many OTP requests from this network. Please wait 15 minutes.' });
    }

    const firstName = req.body.firstName ? String(req.body.firstName).trim().toUpperCase().slice(0, 60) : '';
    const lastName = req.body.lastName ? String(req.body.lastName).trim().toUpperCase().slice(0, 60) : '';
    const email = req.body.email ? String(req.body.email).trim().toLowerCase().slice(0, 120) : '';

    if (!firstName || !lastName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'Valid First Name, Last Name, and Email are required.' });
    }

    // Enforce 60-second resend cooldown per email address
    const existingOtp = pendingOtps.get(email);
    if (existingOtp && (now - existingOtp.lastSentAt) < 60 * 1000) {
        return res.status(429).json({ success: false, error: 'Please wait 60 seconds before requesting another OTP.' });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    pendingOtps.set(email, {
        otp,
        firstName,
        lastName,
        expiresAt: now + 5 * 60 * 1000,
        attempts: 0,
        lastSentAt: now
    });
    
    console.log(`[OTP for ${email}]: ${otp}`);
    
    const scriptURL = process.env.APP_SCRIPT_URL;
    if (scriptURL) {
        fetch(scriptURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'otp',
                targetEmail: email,
                subject: 'Pioneers Prep - Verification Code',
                secretKey: APPS_SECRET,
                breakdown: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">` +
                           `<h2>Hello ${escapeHtml(firstName)} ${escapeHtml(lastName)},</h2>` +
                           `<p>Your verification code to start the mock test on <b>Pioneers Prep</b> is:</p>` +
                           `<h1 style="color: #4285f4; letter-spacing: 6px; font-size: 36px; margin: 20px 0;">${otp}</h1>` +
                           `<p>This code is valid for 5 minutes. Do not share this code with anyone.</p>` +
                           `</div>`
            })
        }).catch(err => console.error('Background OTP email error:', err));
    }
    res.json({ success: true });
});

// FIX 2: Immediate expiration check, 5-attempt brute-force lockout & timing-safe OTP check
app.post('/api/verify-otp', (req, res) => {
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : '';
    const otp = req.body.otp ? String(req.body.otp).trim() : '';
    const record = pendingOtps.get(email);

    if (!record || Date.now() > record.expiresAt) {
        pendingOtps.delete(email);
        return res.status(400).json({ success: false, error: 'Verification code expired or not found. Please request a new OTP.' });
    }

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) {
        pendingOtps.delete(email);
        return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    if (!safeCompareStrings(record.otp, otp)) {
        return res.status(400).json({ success: false, error: 'Invalid verification code entered.' });
    }

    pendingOtps.delete(email);
    const nonce = crypto.randomBytes(8).toString('hex');
    const tokenData = `${email}|${Date.now()}|${nonce}`;
    const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
    res.json({ success: true, authToken: `${tokenData}|||${signature}` });
});

// FIX 1, 3, 5: Scoped 15mb parser, mandatory timer signature & elapsed duration enforcement, safe base64 image validation
app.post('/api/submit', submitJsonParser, async (req, res) => {
    const firstName = req.body.firstName ? String(req.body.firstName).trim().toUpperCase().slice(0, 60) : 'UNKNOWN';
    const lastName = req.body.lastName ? String(req.body.lastName).trim().toUpperCase().slice(0, 60) : 'NAME';
    const email = req.body.email ? String(req.body.email).trim().toLowerCase().slice(0, 120) : 'no-email';
    
    const { className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration, authToken } = req.body;

    const authCheck = verifyAuthToken(authToken, email, true);
    if (!authCheck.valid) return res.status(403).json({ success: false, error: authCheck.error });

    const cleanQuizId = path.basename(String(quizId || '')).trim();
    const filePath = resolveSafeQuizPath(cleanQuizId);
    if (!filePath) return res.status(400).json({ success: false, error: 'Security Alert: Invalid quiz identifier.' });

    // FIX 3: Mandatory timer verification and server-side elapsed time check
    if (!serverStartTime || !timerSignature || !quizDuration) {
        return res.status(400).json({ success: false, error: 'Security Alert: Missing quiz timer credentials.' });
    }

    const expectedTimerSig = crypto
        .createHmac('sha256', SECRET)
        .update(`${cleanQuizId}:${quizDuration}:${serverStartTime}`)
        .digest('hex');

    if (!safeCompareHex(timerSignature, expectedTimerSig)) {
        return res.status(400).json({ success: false, error: 'Security Alert: Tampered timer token detected.' });
    }

    const elapsedSeconds = (Date.now() - Number(serverStartTime)) / 1000;
    const allowedSeconds = Number(quizDuration) + 120; // 120s grace period for network latency
    if (elapsedSeconds < 0 || elapsedSeconds > allowedSeconds) {
        return res.status(400).json({ success: false, error: 'Submission rejected: Quiz time limit exceeded.' });
    }

    try {
        const safeUserAnswers = (userAnswers && typeof userAnswers === 'object') ? userAnswers : {};
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const realQuestions = content.questions || [];

        let correctCount = 0;
        let incorrectCount = 0;
        const totalCount = realQuestions.length;
        const attemptedCount = Object.keys(safeUserAnswers).length;
        const skippedCount = totalCount - attemptedCount;

        if (!isAutoSubmit && attemptedCount < totalCount) {
            return res.status(400).json({
                success: false,
                error: `Submission rejected. Only ${attemptedCount} out of ${totalCount} questions were answered.`
            });
        }

        usedAuthTokens.set(authCheck.signature, Date.now() + TOKEN_MAX_AGE_MS);

        let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 16px;">` +
            `<tr style="background-color: #f1f5f9; text-align: left;">` +
            `<th style="width: 5%;">#</th><th style="width: 40%;">Question</th><th style="width: 25%;">Student's Selection</th><th style="width: 20%;">Correct Option</th><th style="width: 10%; text-align: center;">Status</th></tr>`;

        realQuestions.forEach((q, index) => {
            const response = safeUserAnswers[index.toString()] !== undefined ? safeUserAnswers[index.toString()] : safeUserAnswers[index];
            const attempted = response !== undefined && response !== "";
            let isCorrect = false, selText = "Skipped", corrText = "N/A", rawStatus = "Skipped", statusColor = "yellow";

            if (q.type === 'descriptive' || q.type === 'diagram') {
                // FIX 1: Strict regex check on base64 image before embedding into <img> src
                if (attempted && isSafeBase64Image(response)) {
                    selText = `<img src="${response.trim()}" style="max-width: 200px; border-radius: 4px;" />`;
                } else {
                    selText = attempted ? escapeHtml(response) : "Skipped";
                }
                corrText = escapeHtml(q.model_answer || "Refer to marking scheme");
                if (attempted) {
                    rawStatus = "Needs Review";
                    statusColor = "orange";
                }
            } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
                selText = attempted ? escapeHtml(response) : "Skipped";
                corrText = escapeHtml(q.answer_text || q.model_answer || "Refer to marking scheme");
                isCorrect = attempted && String(response).trim().toLowerCase() === String(q.answer_text || q.model_answer || '').trim().toLowerCase();
                if (isCorrect) correctCount++;
                else if (attempted) incorrectCount++;
                rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
            } else {
                const idx = parseInt(response, 10);
                isCorrect = attempted && idx === q.answer;
                if (isCorrect) correctCount++;
                else if (attempted) incorrectCount++;
                selText = attempted ? escapeHtml(q.options?.[idx] || "Unknown") : "Skipped";
                corrText = q.options?.[q.answer] !== undefined ? escapeHtml(q.options[q.answer]) : "N/A";
                rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
            }

            const statusText = `<span style="background-color: ${statusColor}; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            const safeQuestionText = escapeHtml(q.question || "N/A");
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${escapeHtml(q.explanation)}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${safeQuestionText}${explanationHtml}</td><td>${selText}</td><td>${corrText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const cleanClassName = String(className || '').trim().slice(0, 40);
        const cleanChapterTitle = String(chapterTitle || content.title || 'Quiz').trim().slice(0, 120);
        const fullTitle = (cleanClassName && !cleanChapterTitle.startsWith(cleanClassName))
            ? `${cleanClassName} - ${cleanChapterTitle}`
            : cleanChapterTitle;
        const studentName = `${firstName} ${lastName}`.trim();

        const payload = {
            firstName: escapeHtml(firstName),
            lastName: escapeHtml(lastName),
            email: escapeHtml(email),
            className: escapeHtml(cleanClassName),
            chapterTitle: escapeHtml(fullTitle),
            subject: `New Quiz Submission - ${fullTitle} - ${studentName}`,
            score: correctCount,
            total: totalCount,
            attempted: attemptedCount,
            skipped: skippedCount,
            correct: correctCount,
            incorrect: incorrectCount,
            breakdown: breakdownHtml,
            targetEmail: ADMIN_EMAIL,
            secretKey: APPS_SECRET
        };

        await queueSubmissionBackup({ timestamp: new Date().toISOString(), ...payload });
        res.json({ success: true, score: correctCount, total: totalCount });

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (scriptURL) {
            fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(err => console.error('Background submission email error:', err));
        }
    } catch (err) {
        console.error('Submission error:', err);
        res.status(500).json({ success: false, error: 'Grading failed.' });
    }
});

const PING_INTERVAL = 14 * 60 * 1000;
const PING_URL = process.env.PING_URL || 'https://pioneersprep.in/ping';

setInterval(() => {
    const handler = PING_URL.startsWith('https') ? https : http;
    handler.get(PING_URL, (res) => console.log(`[Keep-Awake] Ping Status: ${res.statusCode} at ${new Date().toISOString()}`))
           .on('error', (err) => console.warn(`[Keep-Awake] Ping failed: ${err.message}`));
}, PING_INTERVAL);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
