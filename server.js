const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Cloudflare / Render reverse proxy headers for accurate IP rate-limiting
app.set('trust proxy', 1);

// Fallback keys prevent startup crashes if Render env vars are unset
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key-2026';
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || 'pioneers-prep-script-secure-2026';
const ADMIN_EMAIL = process.env.TARGET_EMAIL || 'anibanerjee699@gmail.com';

// In-memory security stores with automatic garbage collection
const pendingOtps = new Map();
const otpIpRateLimit = new Map();
const usedAuthTokens = new Map();

// --- SECURITY MIDDLEWARE & PAYLOAD LIMITS ---
app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

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

const RESERVED_JSON_NAMES = new Set([
    'submissions', 'package', 'package-lock', 'quizzes', 'notes'
]);

// --- RECURSIVE DIRECTORY SCANNER ---
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

function resolveSafeQuizPath(rawId) {
    if (!rawId || typeof rawId !== 'string') return null;
    const cleanId = path.basename(rawId.trim());
    if (!/^[a-zA-Z0-9_\-\s\(\)\.]+$/.test(cleanId)) return null;
    if (RESERVED_JSON_NAMES.has(cleanId.toLowerCase())) return null;

    const quizzesDir = path.join(__dirname, 'quizzes');
    const allJsonFiles = getAllJsonFiles(quizzesDir);
    
    const target1 = cleanId + '.json';
    const target2 = cleanId + '-questions.json';

    const matchedPath = allJsonFiles.find(filePath => {
        const fileName = path.basename(filePath);
        return fileName === target1 || fileName === target2;
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

// --- MASTER BACKEND SERVER & SINGLE FILE HTML ---
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
            color: #0f172a; box-sizing: border-box; padding: 30px;
            user-select: none; -webkit-user-select: none;
        }
        #home-dashboard {
            display: flex; gap: 40px; justify-content: center; align-items: flex-start; flex-wrap: wrap; width: 100%;
        }
        .dashboard-panel, #subject-select-screen, #ix-x-chapter-screen, #neet-unit-screen, #neet-chapter-screen, #neet-topic-screen, #name-screen, #result-screen, #notes-subject-screen, #notes-list-screen {
            background-color: rgba(255, 251, 235, 0.95);
            border-radius: 12px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            width: 600px; max-width: 100%; box-sizing: border-box; margin: 0 auto;
        }
        #result-screen { width: 90%; max-width: 800px; }

        /* Full-Screen Responsive Quiz Screen (Desktop & Mobile) */
        #quiz-screen:not(.hidden) {
            background-color: rgba(255, 251, 235, 0.98);
            border-radius: 16px;
            padding: 35px 45px;
            box-shadow: 0 15px 40px rgba(0,0,0,0.25);
            width: 96%;
            max-width: 1200px;
            min-height: calc(100vh - 60px);
            margin: 0 auto;
            box-sizing: border-box;
            display: flex !important;
            flex-direction: column;
            justify-content: space-between;
        }

        button, .card, .option-btn {
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.05) !important;
            transition: transform 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease !important;
        }
        button:hover, .card:hover, .option-btn:hover {
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -4px rgba(0, 0, 0, 0.1) !important;
            transform: translateY(-2px) !important;
        }
        button:active, .card:active, .option-btn:active {
            box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1) !important;
            transform: translateY(0) !important;
        }

        .card {
            background-color: #e8f5e9; font-size: 18px; font-weight: bold;
            text-align: center; padding: 20px; margin-bottom: 15px; border-radius: 8px;
            border: 1px solid #cbd5e1; cursor: pointer;
        }
        .card:hover { background-color: #ffffff; border-color: #4285f4; color: #4285f4; }

        .option-btn {
            display: block; width: 100%; background-color: #ffffff; color: #0f172a;
            font-size: 17px; font-weight: 500; padding: 16px 20px; margin-bottom: 15px; border-radius: 8px;
            border: 1px solid #cbd5e1; cursor: pointer; text-align: left;
        }
        .option-btn.selected { background-color: #e0f2fe; border-color: #4285f4; color: #1e40af; font-weight: 600; }

        input[type="text"], input[type="email"], input[type="number"], input[type="file"] {
            width: 100%; padding: 14px 18px; font-size: 16px; border-radius: 8px;
            border: 1px solid #cbd5e1; margin-bottom: 20px; box-sizing: border-box;
            box-shadow: inset 0 2px 4px 0 rgba(0, 0, 0, 0.03);
        }
        #first-name, #last-name { text-transform: uppercase; }
        #email-address { text-transform: lowercase; }

        .back-btn, button:not(.option-btn) {
            background-color: #4f46e5; color: white; border: none; padding: 12px 24px;
            border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 20px;
        }

        .quiz-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 15px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        #submit-btn {
            background-color: #ef4444 !important;
            margin-bottom: 0 !important;
        }
        .progress-container {
            width: 100%;
            height: 10px;
            background-color: #e2e8f0;
            border-radius: 6px;
            margin-bottom: 24px;
            overflow: hidden;
        }
        .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #4285f4, #2563eb);
            width: 0%;
            transition: width 0.35s ease;
        }

        .quiz-nav-container {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 20px;
            width: 100%;
            margin-top: 25px;
            padding-top: 15px;
            box-sizing: border-box;
        }
        .quiz-nav-container button {
            flex: 1;
            max-width: 240px;
            margin-bottom: 0 !important;
            text-align: center;
            padding: 14px 18px;
        }

        @media (max-width: 600px) {
            body { padding: 8px !important; }
            .dashboard-panel, #subject-select-screen, #ix-x-chapter-screen, #neet-unit-screen, #neet-chapter-screen, #neet-topic-screen, #name-screen, #result-screen, #notes-subject-screen, #notes-list-screen {
                width: 100% !important; padding: 20px !important;
            }
            #quiz-screen:not(.hidden) {
                width: 100% !important; max-width: 100% !important;
                min-height: calc(100vh - 16px) !important; padding: 16px !important; border-radius: 12px !important;
            }
        }
    </style>
</head>
<body>
    <div id="home-dashboard" class="app-screen">
        <div class="dashboard-panel">
            <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Mock Tests</h2>
            <div class="card" onclick="selectClass('IX')">Class IX</div>
            <div class="card" onclick="selectClass('X')">Class X</div>
            <div class="card" onclick="selectClass('XI')">NEET Class XI</div>
            <div class="card" onclick="selectClass('XII')">NEET Class XII</div>
            <div class="card" onclick="selectClass('WB XI')">WBCHSE Class XI</div>
            <div class="card" onclick="selectClass('WB XII')">WBCHSE Class XII</div>
        </div>

        <div class="dashboard-panel">
            <h2 style="text-align: center; color: #10b981; margin-top: 0;">Study Notes</h2>
            <div class="card" onclick="selectNotesClass('IX')">Class IX</div>
            <div class="card" onclick="selectNotesClass('X')">Class X</div>
            <div class="card" onclick="selectNotesClass('XI')">Class XI</div>
            <div class="card" onclick="selectNotesClass('XII')">Class XII</div>
        </div>
    </div>

    <div id="notes-subject-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #10b981; margin-top: 0;">Select Subject</h2>
        <div id="notes-subject-container"></div>
    </div>

    <div id="notes-list-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #10b981; margin-top: 0;">Descriptive Notes</h2>
        <div id="notes-list-container"></div>
    </div>

    <div id="subject-select-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Subject</h2>
        <div class="card" onclick="selectSubject('Physics')">Physics</div>
        <div class="card" onclick="selectSubject('Chemistry')">Chemistry</div>
        <div class="card" onclick="selectSubject('Biology')">Biology</div>
    </div>

    <div id="ix-x-chapter-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Chapter / Test</h2>
        <div id="ix-x-chapter-container"></div>
    </div>

    <!-- NEET Multi-Step Hierarchy Screens -->
    <div id="neet-unit-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Unit</h2>
        <div id="neet-unit-container"></div>
    </div>

    <div id="neet-chapter-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Chapter</h2>
        <div id="neet-chapter-container"></div>
    </div>

    <div id="neet-topic-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Select Topic / Test</h2>
        <div id="neet-topic-container"></div>
    </div>

    <div id="name-screen" class="app-screen hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4;">Candidate Verification</h2>
        <input type="text" id="first-name" placeholder="FIRST NAME">
        <input type="text" id="last-name" placeholder="LAST NAME">
        <input type="email" id="email-address" placeholder="Email Address">
        <button id="verify-start-btn" onclick="startQuiz()" style="width: 100%;">Verify & Start</button>
    </div>

    <div id="quiz-screen" class="app-screen hidden">
        <div>
            <div class="quiz-header">
                <span id="time-left" style="font-size: 18px; font-weight: bold; color: #dc2626;">Time Left: --:--</span>
                <span id="quiz-stats" style="font-size: 15px; font-weight: 600; color: #334155;">Attempted: 0 / 0 | Skipped: 0</span>
                <button id="submit-btn" onclick="submitQuiz(false)">Submit Quiz</button>
            </div>
            <div class="progress-container">
                <div id="progress-bar" class="progress-bar-fill"></div>
            </div>
            <h2 id="quiz-screen-heading" style="color: #4285f4; text-align: center; margin-top: 0; margin-bottom: 20px;"></h2>
            <div id="question-box" style="font-size: 19px; font-weight: 600; margin-bottom: 25px; line-height: 1.5;"></div>
            <div id="options-container"></div>
        </div>

        <div class="quiz-nav-container">
            <button onclick="prevQuestion()">Previous</button>
            <button onclick="clearResponse()">Clear Response</button>
            <button onclick="nextQuestion()">Next</button>
        </div>
    </div>

    <div id="result-screen" class="app-screen hidden"></div>

    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js"></script>
    <script>
        let screenHistory = [];
        let dynamicQuizzes = [];
        let currentQuizId = "";
        let currentQuestions = [];
        let currentQuestionIndex = 0;
        let userAnswers = {};
        let skippedQuestions = new Set();
        let timeRemaining = 900;
        let quizDuration = 900;
        let serverStartTime = 0;
        let timerSignature = "";
        let timerInterval;
        let studentAuthToken = "";
        let selectedClassName = "";
        let activeQuizTitle = "";
        let selectedNotesClass = "";
        let selectedNeetUnit = "";
        let selectedNeetChapter = "";

        // Complete NEET XI & XII Hierarchy Structure
        const neetHierarchy = {
            "XI": {
                "Unit I: Diversity in the Living World": {
                    "The Living World": ["The Living World - Practice Test 1"],
                    "Biological Classification": ["Biological Classification - Practice Test 1"],
                    "Plant Kingdom": ["Plant Kingdom - Practice Test 1"],
                    "Animal Kingdom": ["Animal Kingdom - Practice Test 1"]
                },
                "Unit II: Structural Organisation in Plants and Animals": {
                    "Morphology of Flowering Plants": ["Morphology of Flowering Plants - Practice Test 1"],
                    "Anatomy of Flowering Plants": ["Anatomy of Flowering Plants - Practice Test 1"],
                    "Structural Organisation in Animals": ["Structural Organisation in Animals - Practice Test 1"]
                },
                "Unit III: Cell: Structure and Functions": {
                    "Cell-The Unit of Life": ["Cell-The Unit of Life - Practice Test 1"],
                    "Biomolecules": ["Biomolecules - Practice Test 1"],
                    "Cell Cycle and Cell Division": ["Cell Cycle and Cell Division - Practice Test 1"]
                },
                "Unit IV: Plant Physiology": {
                    "Photosynthesis in Higher Plants": ["Photosynthesis in Higher Plants - Practice Test 1"],
                    "Respiration in Plants": ["Respiration in Plants - Practice Test 1"],
                    "Plant Growth and Development": ["Plant Growth and Development - Practice Test 1"]
                },
                "Unit V: Human Physiology": {
                    "Breathing and Exchange of Gases": ["Breathing and Exchange of Gases - Practice Test 1"],
                    "Body Fluids and Circulation": ["Body Fluids and Circulation - Practice Test 1"],
                    "Excretory Products and their Elimination": ["Excretory Products and their Elimination - Practice Test 1"],
                    "Locomotion and Movement": ["Locomotion and Movement - Practice Test 1"],
                    "Neural Control and Coordination": ["Neural Control and Coordination - Practice Test 1"],
                    "Chemical Coordination and Integration": ["Chemical Coordination and Integration - Practice Test 1"]
                }
            },
            "XII": {
                "Unit VI: Reproduction": {
                    "Reproduction in Organisms": ["Reproduction in Organisms - Practice Test 1"],
                    "Sexual Reproduction in Flowering Plants": ["Sexual Reproduction in Flowering Plants - Practice Test 1"],
                    "Human Reproduction": ["Human Reproduction - Practice Test 1"],
                    "Reproductive Health": ["Reproductive Health - Practice Test 1"]
                },
                "Unit VII: Genetics and Evolution": {
                    "Principles of Inheritance and Variation": ["Principles of Inheritance and Variation - Practice Test 1"],
                    "Molecular Basis of Inheritance": ["Molecular Basis of Inheritance - Practice Test 1"],
                    "Evolution": ["Evolution - Practice Test 1"]
                },
                "Unit VIII: Biology in Human Welfare": {
                    "Human Health and Disease": ["Human Health and Disease - Practice Test 1"],
                    "Strategies for Enhancement in Food Production": ["Strategies for Enhancement in Food Production - Practice Test 1"],
                    "Microbes in Human Welfare": ["Microbes in Human Welfare - Practice Test 1"]
                },
                "Unit IX: Biotechnology and its Applications": {
                    "Biotechnology - Principles and Processes": ["Biotechnology - Principles and Processes - Practice Test 1"],
                    "Biotechnology and its Applications": ["Biotechnology and its Applications - Practice Test 1"]
                },
                "Unit X: Ecology and Environment": {
                    "Organisms and Populations": ["Organisms and Populations - Practice Test 1"],
                    "Ecosystem": ["Ecosystem - Practice Test 1"],
                    "Biodiversity and Conservation": ["Biodiversity and Conservation - Practice Test 1"],
                    "Environmental Issues": ["Environmental Issues - Practice Test 1"]
                }
            }
        };

        window.addEventListener('DOMContentLoaded', async () => {
            const firstInput = document.getElementById('first-name');
            const lastInput = document.getElementById('last-name');
            const emailInput = document.getElementById('email-address');

            if (firstInput) firstInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
            if (lastInput) lastInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
            if (emailInput) emailInput.addEventListener('input', e => e.target.value = e.target.value.toLowerCase());

            try {
                const res = await fetch('/api/quizzes');
                const data = await res.json();
                if (data.success) dynamicQuizzes = data.quizzes;
            } catch (e) {
                console.error("Failed to load quizzes", e);
            }

            restoreSessionState();
        });

        // --- Session State Persistence (Refresh Recovery) ---
        function saveSessionState() {
            const activeScreen = document.querySelector('.app-screen:not(.hidden)')?.id || 'home-dashboard';
            const state = {
                activeScreen,
                screenHistory,
                selectedClassName,
                selectedNotesClass,
                selectedNeetUnit,
                selectedNeetChapter,
                currentQuizId,
                activeQuizTitle,
                timeRemaining,
                quizDuration,
                serverStartTime,
                timerSignature,
                studentAuthToken,
                userAnswers: Object.fromEntries(Object.entries(userAnswers)),
                skippedQuestions: Array.from(skippedQuestions),
                firstName: document.getElementById('first-name')?.value || '',
                lastName: document.getElementById('last-name')?.value || '',
                email: document.getElementById('email-address')?.value || ''
            };
            sessionStorage.setItem('pioneers_prep_state', JSON.stringify(state));
        }

        function restoreSessionState() {
            const saved = sessionStorage.getItem('pioneers_prep_state');
            if (!saved) return;
            try {
                const state = JSON.parse(saved);
                screenHistory = state.screenHistory || [];
                selectedClassName = state.selectedClassName || '';
                selectedNotesClass = state.selectedNotesClass || '';
                selectedNeetUnit = state.selectedNeetUnit || '';
                selectedNeetChapter = state.selectedNeetChapter || '';
                currentQuizId = state.currentQuizId || '';
                activeQuizTitle = state.activeQuizTitle || '';
                timeRemaining = state.timeRemaining || 900;
                quizDuration = state.quizDuration || 900;
                serverStartTime = state.serverStartTime || 0;
                timerSignature = state.timerSignature || '';
                studentAuthToken = state.studentAuthToken || '';
                userAnswers = state.userAnswers || {};
                skippedQuestions = new Set(state.skippedQuestions || []);

                if (document.getElementById('first-name')) document.getElementById('first-name').value = state.firstName || '';
                if (document.getElementById('last-name')) document.getElementById('last-name').value = state.lastName || '';
                if (document.getElementById('email-address')) document.getElementById('email-address').value = state.email || '';

                if (state.activeScreen && state.activeScreen !== 'home-dashboard') {
                    if (state.activeScreen === 'quiz-screen' && currentQuizId) {
                        fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                            headers: { 'X-Requested-With': 'PioneersPrepApp', 'Authorization': 'Bearer ' + studentAuthToken }
                        })
                        .then(res => res.json())
                        .then(questions => {
                            currentQuestions = questions;
                            showScreen('quiz-screen');
                            renderQuestion();
                            startTimer();
                        })
                        .catch(() => goHome());
                    } else {
                        // Re-trigger the UI render for intermediate selection screens upon refresh
                        if (state.activeScreen === 'neet-chapter-screen' && selectedClassName && selectedNeetUnit) {
                            loadNeetChapters(selectedClassName, selectedNeetUnit);
                        } else if (state.activeScreen === 'neet-topic-screen' && selectedClassName && selectedNeetUnit && selectedNeetChapter) {
                            loadNeetTopics(selectedClassName, selectedNeetUnit, selectedNeetChapter);
                        } else if (state.activeScreen === 'neet-unit-screen' && selectedClassName) {
                            loadNeetUnits(selectedClassName);
                        } else if (state.activeScreen === 'ix-x-chapter-screen' && selectedClassName) {
                            // If it was ICSE or WB
                            if (selectedClassName === 'IX' || selectedClassName === 'X') {
                                // Default back to subject screen or keep container if subject is known
                                showScreen(state.activeScreen);
                            } else {
                                loadDynamicChapters(selectedClassName);
                            }
                        } else {
                            showScreen(state.activeScreen);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to restore session state", e);
            }
        }
        // Global Navigation Engine
        function showScreen(screenId) {
            const currentScreen = document.querySelector('.app-screen:not(.hidden)');
            if (currentScreen && currentScreen.id !== screenId) {
                screenHistory.push(currentScreen.id);
            }
            document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
            document.getElementById(screenId).classList.remove('hidden');
            saveSessionState();
        }

        function goBack() {
            if (screenHistory.length > 0) {
                const previousScreenId = screenHistory.pop();
                document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
                document.getElementById(previousScreenId).classList.remove('hidden');
                saveSessionState();
            } else {
                goHome();
            }
        }

        function goHome() {
            screenHistory = [];
            clearInterval(timerInterval);
            userAnswers = {};
            skippedQuestions = new Set();
            sessionStorage.removeItem('pioneers_prep_state');
            const otpWrapper = document.getElementById('otp-wrapper');
            if (otpWrapper) otpWrapper.remove();
            const verifyBtn = document.getElementById('verify-start-btn');
            if (verifyBtn) {
                verifyBtn.innerText = 'Verify & Start';
                verifyBtn.disabled = false;
            }
            document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
            document.getElementById('home-dashboard').classList.remove('hidden');
        }

        // --- Notes Portal Logic ---
        function selectNotesClass(className) {
            selectedNotesClass = className;
            const container = document.getElementById('notes-subject-container');
            container.innerHTML = '';
            let subjects = (className === 'IX' || className === 'X') ? ['Physics', 'Chemistry', 'Biology'] : ['Biology'];
            
            subjects.forEach(sub => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = sub;
                card.onclick = () => selectNotesSubject(sub);
                container.appendChild(card);
            });
            showScreen('notes-subject-screen');
        }

        async function selectNotesSubject(subjectName) {
            const container = document.getElementById('notes-list-container');
            container.innerHTML = '<p style="text-align:center;">Loading notes...</p>';
            showScreen('notes-list-screen');

            try {
                const res = await fetch('/api/notes');
                const notesList = await res.json();
                const matched = notesList.find(n => n.class === selectedNotesClass && n.subject.toLowerCase() === subjectName.toLowerCase());
                
                container.innerHTML = '';
                if (matched && matched.notes && matched.notes.length > 0) {
                    matched.notes.forEach(note => {
                        const link = document.createElement('a');
                        link.href = '/api/download-note/' + encodeURIComponent(note.fileName);
                        link.className = 'card';
                        link.style.textDecoration = 'none';
                        link.style.display = 'block';
                        link.style.color = '#0f172a';
                        link.innerText = '📚 ' + note.name;
                        container.appendChild(link);
                    });
                } else {
                    container.innerHTML = '<p style="text-align:center;">No notes available for this subject yet.</p>';
                }
            } catch (e) {
                container.innerHTML = '<p style="text-align:center; color:red;">Failed to load notes.</p>';
            }
        }

        // --- Mock Tests Logic ---
        function selectClass(className) {
            selectedClassName = className;
            if (className === 'IX' || className === 'X') {
                showScreen('subject-select-screen');
            } else if (className === 'XI' || className === 'XII') {
                loadNeetUnits(className);
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

        // NEET Hierarchy Navigation
        function loadNeetUnits(className) {
            const container = document.getElementById('neet-unit-container');
            container.innerHTML = '';
            const units = neetHierarchy[className] || {};
            
            Object.keys(units).forEach(unitName => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = unitName;
                card.onclick = () => {
                    selectedNeetUnit = unitName;
                    loadNeetChapters(className, unitName);
                };
                container.appendChild(card);
            });
            showScreen('neet-unit-screen');
        }

        function loadNeetChapters(className, unitName) {
            const container = document.getElementById('neet-chapter-container');
            container.innerHTML = '';
            const chapters = neetHierarchy[className][unitName] || {};

            Object.keys(chapters).forEach(chapName => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = chapName;
                card.onclick = () => {
                    selectedNeetChapter = chapName;
                    loadNeetTopics(className, unitName, chapName);
                };
                container.appendChild(card);
            });
            showScreen('neet-chapter-screen');
        }

        function loadNeetTopics(className, unitName, chapName) {
            const container = document.getElementById('neet-topic-container');
            container.innerHTML = '';
            const topicTitles = neetHierarchy[className][unitName][chapName] || [];

            topicTitles.forEach(title => {
                const foundQuiz = dynamicQuizzes.find(q => q.title.toLowerCase() === title.toLowerCase()) || {
                    id: title.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                    title: title,
                    category: 'neet',
                    classLevel: className.toLowerCase(),
                    subject: 'biology',
                    duration: 900
                };

                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = title;
                card.onclick = () => prepareQuiz(foundQuiz);
                container.appendChild(card);
            });
            showScreen('neet-topic-screen');
        }

        function prepareQuiz(quiz) {
            currentQuizId = quiz.id;
            activeQuizTitle = quiz.title;
            timeRemaining = quiz.duration || 900;
            quizDuration = timeRemaining;
            const otpWrapper = document.getElementById('otp-wrapper');
            if (otpWrapper) otpWrapper.remove();
            const verifyBtn = document.getElementById('verify-start-btn');
            if (verifyBtn) {
                verifyBtn.innerText = 'Verify & Start';
                verifyBtn.disabled = false;
            }
            showScreen('name-screen');
        }

        async function startQuiz() {
            const firstNameEl = document.getElementById('first-name');
            const lastNameEl = document.getElementById('last-name');
            const emailEl = document.getElementById('email-address');
            const verifyBtn = document.getElementById('verify-start-btn');

            const firstName = firstNameEl.value.trim().toUpperCase();
            const lastName = lastNameEl.value.trim().toUpperCase();
            const email = emailEl.value.trim().toLowerCase();

            firstNameEl.value = firstName;
            lastNameEl.value = lastName;
            emailEl.value = email;

            if (!firstName || !lastName || !email) {
                alert('Please fill all fields.');
                return;
            }

            const otpInput = document.getElementById('otp-input');
            if (!otpInput) {
                verifyBtn.innerText = 'Sending OTP...';
                verifyBtn.disabled = true;

                const res = await fetch('/api/send-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ firstName, lastName, email })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(data.error || 'Failed to send verification code.');
                    verifyBtn.innerText = 'Verify & Start';
                    verifyBtn.disabled = false;
                    return;
                }
                
                const wrapper = document.createElement('div');
                wrapper.id = 'otp-wrapper';
                wrapper.innerHTML = '<input type="number" id="otp-input" placeholder="Enter 6-digit OTP" style="text-align:center; letter-spacing:4px; margin-top: 5px; margin-bottom: 20px;">';
                document.getElementById('name-screen').insertBefore(wrapper, verifyBtn);
                verifyBtn.innerText = 'Start Quiz';
                verifyBtn.disabled = false;
                saveSessionState();
                return;
            }

            const otp = otpInput.value.trim();
            if (otp.length !== 6) {
                alert('Please enter the 6-digit OTP sent to your email.');
                return;
            }

            verifyBtn.innerText = 'Verifying...';
            verifyBtn.disabled = true;

            const vRes = await fetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otp })
            });
            const vData = await vRes.json();
            if (!vRes.ok) {
                alert(vData.error || 'Invalid OTP');
                verifyBtn.innerText = 'Start Quiz';
                verifyBtn.disabled = false;
                return;
            }

            studentAuthToken = vData.authToken;
            
            const startRes = await fetch('/api/start-quiz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentAuthToken },
                body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
            });
            const startData = await startRes.json();
            if (!startRes.ok) {
                alert(startData.error);
                verifyBtn.innerText = 'Start Quiz';
                verifyBtn.disabled = false;
                return;
            }

            serverStartTime = startData.startTime;
            timerSignature = startData.signature;
            quizDuration = startData.duration || timeRemaining;
            timeRemaining = quizDuration;

            const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                headers: { 'X-Requested-With': 'PioneersPrepApp', 'Authorization': 'Bearer ' + studentAuthToken }
            });
            currentQuestions = await qRes.json();

            currentQuestionIndex = 0;
            userAnswers = {};
            skippedQuestions = new Set();
            screenHistory = [];
            showScreen('quiz-screen');
            renderQuestion();
            startTimer();
        }

        function updateQuizStats() {
            const total = currentQuestions.length;
            const attemptedCount = Object.keys(userAnswers).length;
            
            let skippedCount = 0;
            skippedQuestions.forEach(idx => {
                if (userAnswers[idx] === undefined) {
                    skippedCount++;
                }
            });

            const statsEl = document.getElementById('quiz-stats');
            if (statsEl) {
                statsEl.innerText = 'Attempted: ' + attemptedCount + ' / ' + total + ' | Skipped: ' + skippedCount;
            }

            const progressBar = document.getElementById('progress-bar');
            if (progressBar && total > 0) {
                const pct = (attemptedCount / total) * 100;
                progressBar.style.width = pct + '%';
            }
            saveSessionState();
        }

        function renderQuestion() {
            document.getElementById('quiz-screen-heading').innerText = activeQuizTitle;
            const q = currentQuestions[currentQuestionIndex];
            document.getElementById('question-box').innerText = 'Q.' + (currentQuestionIndex + 1) + ': ' + q.question;
            const container = document.getElementById('options-container');
            container.innerHTML = '';

            // 1 & 2. Descriptive / Diagram / Fill in the Blanks Handling
            if (q.type === 'descriptive' || q.type === 'diagram') {
                const label = document.createElement('label');
                label.innerText = q.type === 'diagram' ? 'Upload image of your drawn diagram/copy:' : 'Upload image of your written answer copy:';
                label.style.cssText = 'display: block; font-weight: 600; margin-bottom: 8px; color: #334155;';
                
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = 'image/*';

                if (userAnswers[currentQuestionIndex] !== undefined) {
                    const preview = document.createElement('p');
                    preview.style.color = '#15803d';
                    preview.innerHTML = '✅ Image uploaded successfully for this question.';
                    container.appendChild(preview);
                }

                fileInput.onchange = e => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = event => {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            let width = img.width;
                            let height = img.height;
                            const maxDim = 800;
                            if (width > height && width > maxDim) {
                                height = Math.round((height * maxDim) / width);
                                width = maxDim;
                            } else if (height > maxDim) {
                                width = Math.round((width * maxDim) / height);
                                height = maxDim;
                            }
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);
                            const base64Img = canvas.toDataURL('image/jpeg', 0.7);

                            userAnswers[currentQuestionIndex] = base64Img;
                            skippedQuestions.delete(currentQuestionIndex);
                            updateQuizStats();
                            alert('Image attached successfully! Click Next to proceed.');
                        };
                        img.src = event.target.result;
                    };
                    reader.readAsDataURL(file);
                };

                container.appendChild(label);
                container.appendChild(fileInput);
            } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
                const input = document.createElement('input');
                input.type = 'text';
                input.placeholder = 'Type your answer here...';
                if (userAnswers[currentQuestionIndex] !== undefined) {
                    input.value = userAnswers[currentQuestionIndex];
                }
                input.addEventListener('input', e => {
                    const val = e.target.value.trim();
                    if (val === '') {
                        delete userAnswers[currentQuestionIndex];
                    } else {
                        userAnswers[currentQuestionIndex] = val;
                        skippedQuestions.delete(currentQuestionIndex);
                    }
                    updateQuizStats();
                });
                container.appendChild(input);
            } else {
                q.options.forEach((opt, idx) => {
                    const btn = document.createElement('button');
                    btn.className = 'option-btn' + (userAnswers[currentQuestionIndex] === idx ? ' selected' : '');
                    btn.innerText = opt;
                    btn.onclick = () => {
                        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                        btn.classList.add('selected');
                        userAnswers[currentQuestionIndex] = idx;
                        skippedQuestions.delete(currentQuestionIndex);
                        updateQuizStats();
                    };
                    container.appendChild(btn);
                });
            }

            updateQuizStats();
        }

        function nextQuestion() {
            if (userAnswers[currentQuestionIndex] === undefined) {
                skippedQuestions.add(currentQuestionIndex);
            }
            if (currentQuestionIndex < currentQuestions.length - 1) {
                currentQuestionIndex++;
                renderQuestion();
            } else {
                updateQuizStats();
            }
        }

        function prevQuestion() {
            if (currentQuestionIndex > 0) {
                currentQuestionIndex--;
                renderQuestion();
            }
        }

        function clearResponse() {
            delete userAnswers[currentQuestionIndex];
            document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
            const input = document.querySelector('#options-container input');
            if (input) input.value = '';
            updateQuizStats();
        }

        function startTimer() {
            clearInterval(timerInterval);
            const updateDisplay = () => {
                let m = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
                let s = (timeRemaining % 60).toString().padStart(2, '0');
                document.getElementById('time-left').innerText = 'Time Left: ' + m + ':' + s;
                saveSessionState();
            };
            updateDisplay();
            timerInterval = setInterval(() => {
                if (timeRemaining <= 0) {
                    clearInterval(timerInterval);
                    submitQuiz(true);
                    return;
                }
                timeRemaining--;
                updateDisplay();
            }, 1000);
        }

        async function submitQuiz(isAuto = false) {
            const answeredCount = Object.keys(userAnswers).length;
            const totalQuestions = currentQuestions.length;

            if (!isAuto && answeredCount < totalQuestions) {
                alert('Please answer all questions before submitting. You have answered ' + answeredCount + ' out of ' + totalQuestions + '.');
                return;
            }

            clearInterval(timerInterval);
            const submitBtn = document.getElementById('submit-btn');
            if (submitBtn) {
                submitBtn.innerText = 'Submitting...';
                submitBtn.disabled = true;
            }

            const firstName = document.getElementById('first-name').value.trim().toUpperCase();
            const lastName = document.getElementById('last-name').value.trim().toUpperCase();
            const email = document.getElementById('email-address').value.trim().toLowerCase();

            try {
                const res = await fetch('/api/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        firstName,
                        lastName,
                        email,
                        className: selectedClassName,
                        chapterTitle: activeQuizTitle,
                        quizId: currentQuizId,
                        userAnswers,
                        authToken: studentAuthToken,
                        serverStartTime,
                        timerSignature,
                        quizDuration,
                        isAutoSubmit: isAuto
                    })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    sessionStorage.removeItem('pioneers_prep_state');
                    document.getElementById('result-screen').innerHTML =
                        '<button class="back-btn" onclick="goHome()">Back to Home</button>' +
                        '<h2 style="text-align: center; color: #4285f4; margin-top: 0;">Quiz Results</h2>' +
                        '<div style="text-align: center; margin-top: 20px;">' +
                        '<p style="font-size: 18px; color: #333;">Candidate: <strong>' + firstName + ' ' + lastName + '</strong></p>' +
                        '<h1 style="color: #4285f4; font-size: 48px; margin: 10px 0;">' + data.score + ' / ' + data.total + '</h1>' +
                        '<p style="font-size: 16px; color: #64748b;">Response recorded and mailed to the administrator successfully. A copy of your response has also been mailed to your provided email id.</p>' +
                        '</div>';
                    screenHistory = [];
                    showScreen('result-screen');
                    if (typeof confetti === 'function') {
                        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
                    }
                } else {
                    alert(data.error || 'Submission failed.');
                    goHome();
                }
            } catch (err) {
                console.error('Submission error:', err);
                alert('Network error while submitting quiz.');
            } finally {
                if (submitBtn) {
                    submitBtn.innerText = 'Submit Quiz';
                    submitBtn.disabled = false;
                }
            }
        }
    </script>
</body>
</html>`);
});

app.get('/ping', (req, res) => res.status(200).send('Awake'));

// --- AUTO-DISCOVERY DESCRIPTIVE NOTES API ---
app.get('/api/notes', (req, res) => {
    const notesDir = path.join(__dirname, 'notes');
    try {
        if (!fs.existsSync(notesDir)) {
            fs.mkdirSync(notesDir, { recursive: true });
        }
        
        const files = fs.readdirSync(notesDir).filter(file => file.toLowerCase().endsWith('.pdf'));
        const groupedNotes = {
            'IX': { Physics: [], Chemistry: [], Biology: [] },
            'X': { Physics: [], Chemistry: [], Biology: [] },
            'XI': { Biology: [] },
            'XII': { Biology: [] }
        };

        files.forEach(file => {
            const lowerFile = file.toLowerCase();
            
            let cls = 'XI';
            if (lowerFile.includes('class9') || lowerFile.includes('ix')) cls = 'IX';
            else if (lowerFile.includes('class10') || lowerFile.includes('x')) cls = 'X';
            else if (lowerFile.includes('class11') || lowerFile.includes('xi')) cls = 'XI';
            else if (lowerFile.includes('class12') || lowerFile.includes('xii')) cls = 'XII';

            let subject = 'Biology';
            if (lowerFile.includes('physics')) subject = 'Physics';
            else if (lowerFile.includes('chemistry')) subject = 'Chemistry';
            else if (lowerFile.includes('biology')) subject = 'Biology';

            const title = path.basename(file, '.pdf')
                .replace(/[_]/g, ' ')
                .replace(/-/g, ' ')
                .replace(/class\s*(9|10|11|12|ix|x|xi|xii)/gi, '')
                .replace(/(physics|chemistry|biology)/gi, '')
                .trim()
                .replace(/\b\w/g, c => c.toUpperCase());

            if (groupedNotes[cls] && groupedNotes[cls][subject]) {
                groupedNotes[cls][subject].push({
                    name: title || file,
                    fileName: file
                });
            }
        });

        const formattedNotes = [];
        for (const [cls, subjects] of Object.entries(groupedNotes)) {
            for (const [sub, fileList] of Object.entries(subjects)) {
                if (fileList.length > 0) {
                    formattedNotes.push({
                        class: cls,
                        subject: sub,
                        notes: fileList
                    });
                }
            }
        }

        res.json(formattedNotes);
    } catch (err) {
        console.error("Error reading notes directory:", err);
        res.json([]);
    }
});

app.get('/api/download-note/:fileName', (req, res) => {
    const safeFileName = path.basename(req.params.fileName);
    const filePath = path.join(__dirname, 'notes', safeFileName);
    
    res.download(filePath, (err) => {
        if (err) {
            console.error("Note download error:", err);
            if (!res.headersSent) res.status(404).send("Note file not found.");
        }
    });
});

// --- AUTO-DISCOVERY QUIZZES API ---
app.get('/api/quizzes', (req, res) => {
    const quizzesDir = path.join(__dirname, 'quizzes');
    try {
        if (!fs.existsSync(quizzesDir)) fs.mkdirSync(quizzesDir, { recursive: true });
        
        const allFiles = getAllJsonFiles(quizzesDir);
        const allQuizzes = [];

        allFiles.forEach(filePath => {
            try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const fileBaseName = path.basename(filePath, '.json');
                allQuizzes.push({
                    id: fileBaseName,
                    title: content.title || fileBaseName,
                    category: content.category || 'general',
                    classLevel: content.classLevel || 'xi',
                    subject: content.subject || 'general',
                    unit: content.unit || '',
                    chapter: content.chapter || '',
                    topic: content.topic || '',
                    duration: content.duration || 900,
                    totalQuestions: content.questions ? content.questions.length : 0
                });
            } catch (e) {
                console.error('Skipping invalid quiz JSON:', filePath, e);
            }
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
    res.json((quizContent.questions || []).map(q => ({
        type: q.type || 'mcq',
        question: q.question,
        options: q.options || []
    })));
});

app.post('/api/start-quiz', (req, res) => {
    const authCheck = verifyAuthToken(req.get('Authorization')?.replace('Bearer ', ''));
    if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

    const { quizId, duration } = req.body;
    const cleanId = path.basename(String(quizId || '')).trim();
    
    if (!resolveSafeQuizPath(cleanId)) {
        return res.status(400).json({ error: "Invalid quiz ID." });
    }

    const officialDuration = getOfficialQuizDuration(cleanId, duration);
    const startTime = Date.now();
    const dataToSign = `${cleanId}:${officialDuration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');

    res.json({ startTime, duration: officialDuration, signature });
});

app.post('/api/send-otp', (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase().slice(0, 60) : '';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase().slice(0, 60) : '';
    const email = req.body.email ? req.body.email.trim().toLowerCase().slice(0, 120) : '';

    if (!firstName || !lastName || !email) {
        return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    pendingOtps.set(email, { otp, firstName, lastName, expiresAt: Date.now() + 300000, attempts: 0, lastSentAt: Date.now() });
    
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
                breakdown: '<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">' +
                         '<h2>Hello ' + escapeHtml(firstName) + ' ' + escapeHtml(lastName) + ',</h2>' +
                         '<p>Your verification code to start the mock test on <b>Pioneers Prep</b> is:</p>' +
                         '<h1 style="color: #4285f4; letter-spacing: 6px; font-size: 36px; margin: 20px 0;">' + otp + '</h1>' +
                         '<p>This code is valid for 5 minutes. Do not share this code with anyone.</p>' +
                         '</div>'
            })
        }).catch(err => console.error('Background OTP email error:', err));
    }
    
    res.json({ success: true });
});

app.post('/api/verify-otp', (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const otp = req.body.otp ? req.body.otp.trim() : '';
    const record = pendingOtps.get(email);

    if (!record || record.otp !== otp) {
        return res.status(400).json({ success: false, error: 'Invalid verification code entered.' });
    }

    pendingOtps.delete(email);
    const nonce = crypto.randomBytes(8).toString('hex');
    const tokenData = `${email}|${Date.now()}|${nonce}`;
    const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
    res.json({ success: true, authToken: `${tokenData}|||${signature}` });
});

// --- FULL QUIZ SUBMISSION, GRADING & DUAL EMAIL DELIVERY ---
app.post('/api/submit', async (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase().slice(0, 60) : 'UNKNOWN';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase().slice(0, 60) : 'NAME';
    const email = req.body.email ? req.body.email.trim().toLowerCase().slice(0, 120) : 'no-email';
    
    const { className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration, authToken } = req.body;

    const authCheck = verifyAuthToken(authToken, email, true);
    if (!authCheck.valid) {
        return res.status(403).json({ success: false, error: authCheck.error });
    }

    const cleanQuizId = path.basename(String(quizId || '')).trim();
    const filePath = resolveSafeQuizPath(cleanQuizId);
    if (!filePath) {
        return res.status(400).json({ success: false, error: 'Security Alert: Invalid quiz identifier.' });
    }

    if (serverStartTime && timerSignature && quizDuration) {
        const expectedTimerSig = crypto
            .createHmac('sha256', SECRET)
            .update(`${cleanQuizId}:${quizDuration}:${serverStartTime}`)
            .digest('hex');

        if (!safeCompareHex(timerSignature, expectedTimerSig)) {
            return res.status(400).json({ success: false, error: 'Security Alert: Tampered timer token detected.' });
        }
    }

    try {
        const safeUserAnswers = (userAnswers && typeof userAnswers === 'object') ? userAnswers : {};
        const rawData = fs.readFileSync(filePath, 'utf-8');
        const quizContent = JSON.parse(rawData);
        const realQuestions = quizContent.questions || [];

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
            const studentResponse = safeUserAnswers[index.toString()] !== undefined ? safeUserAnswers[index.toString()] : safeUserAnswers[index];
            const isAttempted = studentResponse !== undefined && studentResponse !== "";

            let isCorrect = false;
            let studentSelectionText = "Skipped";
            let correctOptionText = "N/A";
            let rawStatus = "Skipped";
            let statusColor = "yellow";

            if (q.type === 'descriptive' || q.type === 'diagram') {
                if (isAttempted && typeof studentResponse === 'string' && studentResponse.startsWith('data:image')) {
                    studentSelectionText = `<img src="${studentResponse}" style="max-width: 200px; border-radius: 4px;" />`;
                } else {
                    studentSelectionText = isAttempted ? escapeHtml(studentResponse) : "Skipped";
                }
                correctOptionText = escapeHtml(q.model_answer || "Refer to marking scheme");
                if (isAttempted) {
                    rawStatus = "Needs Review";
                    statusColor = "orange";
                }
            } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
                studentSelectionText = isAttempted ? escapeHtml(studentResponse) : "Skipped";
                correctOptionText = escapeHtml(q.answer_text || q.model_answer || "Refer to marking scheme");
                const studentAnsClean = String(studentResponse || '').trim().toLowerCase();
                const correctAnsClean = String(q.answer_text || q.model_answer || '').trim().toLowerCase();
                isCorrect = isAttempted && studentAnsClean === correctAnsClean;
                if (isCorrect) correctCount++;
                else if (isAttempted) incorrectCount++;
                rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (isAttempted ? "lightcoral" : "yellow");
            } else {
                const selectedIdx = parseInt(studentResponse, 10);
                isCorrect = isAttempted && selectedIdx === q.answer;
                if (isCorrect) correctCount++;
                else if (isAttempted) incorrectCount++;

                studentSelectionText = isAttempted ? escapeHtml(q.options?.[selectedIdx] || "Unknown") : "Skipped";
                correctOptionText = q.options?.[q.answer] !== undefined ? escapeHtml(q.options[q.answer]) : "N/A";
                rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (isAttempted ? "lightcoral" : "yellow");
            }

            const statusText = `<span style="background-color: ${statusColor}; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            const safeQuestionText = escapeHtml(q.question || "N/A");
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${escapeHtml(q.explanation)}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${safeQuestionText}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const cleanClassName = String(className || '').trim().slice(0, 40);
        const cleanChapterTitle = String(chapterTitle || quizContent.title || 'Quiz').trim().slice(0, 120);
        const fullTitle = (cleanClassName && !cleanChapterTitle.startsWith(cleanClassName))
            ? `${cleanClassName} - ${cleanChapterTitle}`
            : cleanChapterTitle;

        const studentName = `${firstName} ${lastName}`.trim();

        const securePayload = {
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

        await queueSubmissionBackup({
            timestamp: new Date().toISOString(),
            ...securePayload
        });

        res.json({ success: true, score: correctCount, total: totalCount });

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (scriptURL) {
            fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(securePayload)
            }).catch(err => console.error('Background submission email error:', err));
        }
    } catch (error) {
        console.error("Submission error:", error);
        res.status(500).json({ success: false, error: "Grading failed" });
    }
});

const PING_INTERVAL = 14 * 60 * 1000;
const PING_URL = process.env.PING_URL || 'https://pioneersprep.in/ping';

setInterval(() => {
    if (PING_URL.startsWith('https')) {
        https.get(PING_URL, (res) => console.log(`[Keep-Awake] Secure Ping successful: ${res.statusCode} at ${new Date().toISOString()}`))
             .on('error', (err) => console.warn(`[Keep-Awake] Ping failed: ${err.message}`));
    } else {
        http.get(PING_URL, (res) => console.log(`[Keep-Awake] Local Ping successful: ${res.statusCode} at ${new Date().toISOString()}`))
             .on('error', (err) => console.warn(`[Keep-Awake] Local Ping failed: ${err.message}`));
    }
}, PING_INTERVAL);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
