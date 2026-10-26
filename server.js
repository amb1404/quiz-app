const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key-2026';
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || 'pioneers-prep-script-secure-2026';

const pendingOtps = new Map();       
const otpIpRateLimit = new Map();    
const usedAuthTokens = new Map();    

app.use(express.json({ limit: '50kb' }));

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

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

const RESERVED_JSON_NAMES = new Set([
    'submissions', 'package', 'package-lock', 'quizzes', 'notes'
]);

function resolveSafeQuizPath(rawId) {
    if (!rawId || typeof rawId !== 'string') return null;
    const cleanId = path.basename(rawId.trim());
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) return null;
    if (RESERVED_JSON_NAMES.has(cleanId.toLowerCase())) return null;

    const quizzesDir = path.join(__dirname, 'quizzes');
    let filePath = path.join(quizzesDir, `${cleanId}.json`);
    if (fs.existsSync(filePath)) return filePath;

    filePath = path.join(quizzesDir, `${cleanId}-questions.json`);
    if (fs.existsSync(filePath)) return filePath;

    return null;
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

// Single-file HTML template response
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pioneers Prep - Online Mock Tests & Study Notes</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
        .hidden { display: none !important; }
        html, body {
            margin: 0; padding: 0; width: 100%; min-height: 100vh;
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
            color: #0f172a; box-sizing: border-box; padding: 40px;
        }
        .dashboard-panel, #subject-select-screen, #ix-x-chapter-screen, #name-screen, #quiz-screen, #result-screen {
            background-color: rgba(255, 251, 235, 0.95);
            border-radius: 12px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            max-width: 800px; margin: 0 auto; box-sizing: border-box;
        }
        .card {
            background-color: #e8f5e9; font-size: 18px; font-weight: bold;
            text-align: center; padding: 20px; margin-bottom: 15px; border-radius: 8px;
            border: 1px solid #cbd5e1; cursor: pointer;
        }
        .card:hover { background-color: #ffffff; border-color: #4285f4; color: #4285f4; }
        .option-btn {
            display: block; width: 100%; background-color: #ffffff; color: #0f172a;
            font-size: 16px; padding: 16px 20px; margin-bottom: 15px; border-radius: 8px;
            border: 1px solid #cbd5e1; cursor: pointer; text-align: left;
        }
        .option-btn.selected { background-color: #e0f2fe; border-color: #4285f4; color: #1e40af; font-weight: 600; }
        input[type="text"], input[type="email"], input[type="number"] {
            width: 100%; padding: 14px 18px; font-size: 16px; border-radius: 8px;
            border: 1px solid #cbd5e1; margin-bottom: 20px; box-sizing: border-box;
        }
        .back-btn, button:not(.option-btn) {
            background-color: #4f46e5; color: white; border: none; padding: 12px 24px;
            border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div id="home-dashboard" class="app-screen">
        <div class="dashboard-panel">
            <h2 style="text-align: center; color: #4285f4;">Mock Tests</h2>
            <div class="card" onclick="selectClass('IX')">Class IX</div>
            <div class="card" onclick="selectClass('X')">Class X</div>
            <div class="card" onclick="selectClass('XI')">NEET Class XI</div>
            <div class="card" onclick="selectClass('XII')">NEET Class XII</div>
            <div class="card" onclick="selectClass('WB XI')">WBCHSE Class XI</div>
            <div class="card" onclick="selectClass('WB XII')">WBCHSE Class XII</div>
        </div>
    </div>

    <div id="subject-select-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goHome()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Subject</h2>
        <div class="card" onclick="selectSubject('Physics')">Physics</div>
        <div class="card" onclick="selectSubject('Chemistry')">Chemistry</div>
        <div class="card" onclick="selectSubject('Biology')">Biology</div>
    </div>

    <div id="ix-x-chapter-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goHome()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Chapter / Test</h2>
        <div id="ix-x-chapter-container"></div>
    </div>

    <div id="name-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goHome()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Candidate Verification</h2>
        <input type="text" id="first-name" placeholder="FIRST NAME">
        <input type="text" id="last-name" placeholder="LAST NAME">
        <input type="email" id="email-address" placeholder="Email Address">
        <button onclick="startQuiz()" style="width: 100%;">Verify & Start</button>
    </div>

    <div id="quiz-screen" class="app-screen hidden">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <span id="time-left" style="font-weight: bold; color: #dc2626;">Time Left: --:--</span>
            <button id="submit-btn" onclick="submitQuiz(false)" style="background-color: #ef4444;">Submit Quiz</button>
        </div>
        <h2 id="quiz-screen-heading" style="color: #4285f4;"></h2>
        <div id="question-box" style="font-size: 18px; font-weight: 600; margin-bottom: 25px;"></div>
        <div id="options-container"></div>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
            <button onclick="prevQuestion()">Previous</button>
            <button onclick="clearResponse()">Clear Response</button>
            <button onclick="nextQuestion()">Next</button>
        </div>
    </div>

    <div id="result-screen" class="app-screen hidden"></div>

    <script>
        let dynamicQuizzes = [];
        let currentQuizId = "";
        let currentQuestions = [];
        let currentQuestionIndex = 0;
        let userAnswers = {};
        let timeRemaining = 900;
        let timerInterval;
        let studentAuthToken = "";
        let selectedClassName = "";
        let activeQuizTitle = "";

        window.addEventListener('DOMContentLoaded', async () => {
            try {
                const res = await fetch('/api/quizzes');
                const data = await res.json();
                if (data.success) dynamicQuizzes = data.quizzes;
            } catch (e) {
                console.error("Failed to load quizzes", e);
            }
        });

        function showScreen(screenId) {
            document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
            document.getElementById(screenId).classList.remove('hidden');
        }

        function goHome() {
            clearInterval(timerInterval);
            showScreen('home-dashboard');
        }

        function selectClass(className) {
            selectedClassName = className;
            if (className === 'IX' || className === 'X') {
                showScreen('subject-select-screen');
            } else {
                loadDynamicChapters(className);
            }
        }

        function selectSubject(subjectName) {
            const container = document.getElementById('ix-x-chapter-container');
            container.innerHTML = '';
            const matched = dynamicQuizzes.filter(q => q.category === 'icse' && q.classLevel.toLowerCase() === selectedClassName.toLowerCase() && q.subject.toLowerCase() === subjectName.toLowerCase());
            
            if (matched.length === 0) {
                container.innerHTML = '<p style="text-align:center;">No tests found.</p>';
            } else {
                matched.forEach(q => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.innerText = q.title;
                    card.onclick = () => prepareQuiz(q);
                    container.appendChild(card);
                });
            }
            showScreen('ix-x-chapter-screen');
        }

        function loadDynamicChapters(className) {
            const container = document.getElementById('ix-x-chapter-container');
            container.innerHTML = '';
            let cat = className.startsWith('WB') ? 'wb' : 'neet';
            let lvl = className.toLowerCase().replace('wb ', '');

            const matched = dynamicQuizzes.filter(q => q.category === cat && q.classLevel.toLowerCase() === lvl);
            
            if (matched.length === 0) {
                container.innerHTML = '<p style="text-align:center;">No tests found.</p>';
            } else {
                matched.forEach(q => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.innerText = q.title;
                    card.onclick = () => prepareQuiz(q);
                    container.appendChild(card);
                });
            }
            showScreen('ix-x-chapter-screen');
        }

        function prepareQuiz(quiz) {
            currentQuizId = quiz.id;
            activeQuizTitle = quiz.title;
            timeRemaining = quiz.duration || 900;
            showScreen('name-screen');
        }

        async function startQuiz() {
            const firstName = document.getElementById('first-name').value.trim();
            const lastName = document.getElementById('last-name').value.trim();
            const email = document.getElementById('email-address').value.trim();

            if (!firstName || !lastName || !email) {
                alert('Please fill all fields.');
                return;
            }

            const otpInput = document.getElementById('otp-input');
            if (!otpInput) {
                const res = await fetch('/api/send-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ firstName, lastName, email })
                });
                if (!res.ok) { alert('Failed to send code.'); return; }
                
                const wrapper = document.createElement('div');
                wrapper.innerHTML = '<input type="number" id="otp-input" placeholder="Enter 6-digit OTP" style="text-align:center; letter-spacing:4px;">';
                document.getElementById('name-screen').insertBefore(wrapper, document.querySelector('#name-screen button'));
                return;
            }

            const otp = otpInput.value.trim();
            const vRes = await fetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otp })
            });
            const vData = await vRes.json();
            if (!vRes.ok) { alert(vData.error); return; }

            studentAuthToken = vData.authToken;
            
            const startRes = await fetch('/api/start-quiz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentAuthToken },
                body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
            });
            const startData = await startRes.json();
            if (!startRes.ok) { alert(startData.error); return; }

            const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                headers: { 'X-Requested-With': 'PioneersPrepApp', 'Authorization': 'Bearer ' + studentAuthToken }
            });
            currentQuestions = await qRes.json();

            currentQuestionIndex = 0;
            userAnswers = {};
            showScreen('quiz-screen');
            renderQuestion();
            startTimer();
        }

        function renderQuestion() {
            document.getElementById('quiz-screen-heading').innerText = activeQuizTitle;
            const q = currentQuestions[currentQuestionIndex];
            document.getElementById('question-box').innerText = 'Q.' + (currentQuestionIndex + 1) + ': ' + q.question;
            const container = document.getElementById('options-container');
            container.innerHTML = '';
            q.options.forEach((opt, idx) => {
                const btn = document.createElement('button');
                btn.className = 'option-btn' + (userAnswers[currentQuestionIndex] === idx ? ' selected' : '');
                btn.innerText = opt;
                btn.onclick = () => {
                    document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    userAnswers[currentQuestionIndex] = idx;
                };
                container.appendChild(btn);
            });
        }

        function nextQuestion() { if (currentQuestionIndex < currentQuestions.length - 1) { currentQuestionIndex++; renderQuestion(); } }
        function prevQuestion() { if (currentQuestionIndex > 0) { currentQuestionIndex--; renderQuestion(); } }
        function clearResponse() { delete userAnswers[currentQuestionIndex]; document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected')); }

        function startTimer() {
            clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                if (timeRemaining <= 0) { clearInterval(timerInterval); submitQuiz(true); return; }
                timeRemaining--;
                let m = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
                let s = (timeRemaining % 60).toString().padStart(2, '0');
                document.getElementById('time-left').innerText = 'Time Left: ' + m + ':' + s;
            }, 1000);
        }

        async function submitQuiz(isAuto = false) {
            clearInterval(timerInterval);
            const firstName = document.getElementById('first-name').value;
            const lastName = document.getElementById('last-name').value;
            const email = document.getElementById('email-address').value;

            const res = await fetch('/api/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firstName, lastName, email, quizId: currentQuizId, userAnswers, authToken: studentAuthToken, serverStartTime: Date.now(), timerSignature: 'dummy', quizDuration: 900, isAutoSubmit: isAuto })
            });
            const data = await res.json();
            if (res.ok) {
                document.getElementById('result-screen').innerHTML = \`<h2>Score: \${data.score} / \${data.total}</h2><button onclick="goHome()">Home</button>\`;
                showScreen('result-screen');
            } else {
                alert(data.error);
                goHome();
            }
        }
    </script>
</body>
</html>`);
});

app.get('/ping', (req, res) => res.status(200).send('Awake'));

app.get('/api/notes', (req, res) => {
    const notesPath = path.join(__dirname, 'notes.json');
    if (fs.existsSync(notesPath)) res.json(JSON.parse(fs.readFileSync(notesPath, 'utf8')));
    else res.json([]);
});

app.get('/api/download-note/:fileName', (req, res) => {
    res.download(path.join(__dirname, 'secure_notes', path.basename(req.params.fileName)));
});

app.get('/api/quizzes', (req, res) => {
    const quizzesDir = path.join(__dirname, 'quizzes');
    try {
        if (!fs.existsSync(quizzesDir)) fs.mkdirSync(quizzesDir, { recursive: true });
        const files = fs.readdirSync(quizzesDir).filter(file => file.endsWith('.json'));
        const allQuizzes = files.map(file => {
            const content = JSON.parse(fs.readFileSync(path.join(quizzesDir, file), 'utf8'));
            return {
                id: path.basename(file, '.json'),
                title: content.title || file,
                category: content.category || 'general',
                classLevel: content.classLevel || 'xi',
                subject: content.subject || 'general',
                unit: content.unit || '',
                chapter: content.chapter || '',
                topic: content.topic || '',
                duration: content.duration || 900,
                totalQuestions: content.questions ? content.questions.length : 0
            };
        });
        res.json({ success: true, quizzes: allQuizzes });
    } catch (err) {
        res.status(500).json({ success: false, message: "Could not load quizzes." });
    }
});

app.get('/api/quiz/:id', (req, res) => {
    if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
    const authCheck = verifyAuthToken(req.get('Authorization')?.replace('Bearer ', ''));
    if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

    const filePath = resolveSafeQuizPath(req.params.id);
    if (!filePath) return res.status(404).json({ error: "Not found" });

    const quizContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json((quizContent.questions || []).map(q => ({ type: q.type || 'mcq', question: q.question, options: q.options || [] })));
});

app.post('/api/start-quiz', (req, res) => {
    const authCheck = verifyAuthToken(req.get('Authorization')?.replace('Bearer ', ''));
    if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
    res.json({ startTime: Date.now(), duration: 900, signature: 'dummy' });
});

app.post('/api/send-otp', (req, res) => {
    const { firstName, lastName, email } = req.body;
    if (!firstName || !lastName || !email) return res.status(400).json({ success: false });
    const otp = crypto.randomInt(100000, 1000000).toString();
    pendingOtps.set(email, { otp, firstName, lastName, expiresAt: Date.now() + 300000, attempts: 0, lastSentAt: Date.now() });
    console.log(`[OTP for ${email}]: ${otp}`); // Check Render logs for code testing
    res.json({ success: true });
});

app.post('/api/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    const record = pendingOtps.get(email);
    if (!record || record.otp !== otp) return res.status(400).json({ success: false, error: 'Invalid OTP' });
    pendingOtps.delete(email);
    const tokenData = `${email}|${Date.now()}`;
    const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
    res.json({ success: true, authToken: `${tokenData}|||${signature}` });
});

app.post('/api/submit', async (req, res) => {
    const { email, quizId, userAnswers, authToken } = req.body;
    const authCheck = verifyAuthToken(authToken, email, true);
    if (!authCheck.valid) return res.status(403).json({ success: false, error: authCheck.error });

    const filePath = resolveSafeQuizPath(quizId);
    const quizContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const realQuestions = quizContent.questions || [];

    let correctCount = 0;
    realQuestions.forEach((q, idx) => {
        if (userAnswers[idx] === q.answer) correctCount++;
    });

    res.json({ success: true, score: correctCount, total: realQuestions.length });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
