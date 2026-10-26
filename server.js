const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// SECURE & SAFE: Fallback to default keys to prevent startup crashes if environment variables are missing
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key-2026';
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || 'pioneers-prep-script-secure-2026';

const pendingOtps = {};
const activeSessions = new Set();

app.use(express.json());

// --- MASTER BACKEND SERVER: BULLETPROOF SECURITY & MOBILE RESPONSIVE APP ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pioneers Prep - Online Mock Test Platform</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');

        .hidden {
            display: none !important;
        }

        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            min-height: 100vh;
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f8fafc;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }

        body {
            display: block;
            box-sizing: border-box;
            padding: 40px;
        }

        /* PROFESSIONAL GLOBAL SHADOW EFFECT FOR ALL BUTTONS & CARDS */
        button, .card {
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
            transition: all 0.2s ease !important;
        }
        button:hover, .card:hover {
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -2px rgba(0, 0, 0, 0.1) !important;
            transform: translateY(-2px) !important;
        }
        button:active, .card:active {
            box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1) !important;
            transform: translateY(0) !important;
        }

        #class-select-screen, 
        #subject-select-screen, 
        #ix-x-chapter-screen, 
        #xi-xii-unit-screen, 
        #xi-xii-chapter-screen, 
        #xi-xii-topic-screen, 
        #name-screen,
        #download-screen {
            background-color: rgba(255, 251, 235, 0.95);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            width: 600px;
            max-width: 90%;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            box-sizing: border-box;
            margin: 0;
            color: #0f172a;
        }

        #quiz-screen,
        #result-screen {
            background-color: rgba(255, 251, 235, 0.98);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            width: 95%;
            max-width: 1200px;
            min-height: 85vh;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
            box-sizing: border-box;
            margin: 0 auto;
            color: #0f172a;
        }

        #result-screen {
            max-width: 800px;
        }

        #first-name, #last-name {
            text-transform: uppercase;
        }
        #email-address {
            text-transform: lowercase;
        }

        #name-screen input[type="text"], 
        #name-screen input[type="email"],
        #name-screen input[type="number"],
        #otp-input-field {
            width: 100%;
            padding: 14px 18px;
            font-size: 16px;
            border-radius: 8px;
            border: 1px solid #cbd5e1;
            box-sizing: border-box;
            background-color: #ffffff;
            color: #0f172a;
            margin-bottom: 20px;
            font-family: inherit;
            outline: none;
            user-select: text;
            -webkit-user-select: text;
        }

        .back-btn, 
        #name-screen button:not(.back-btn) {
            background-color: #4f46e5;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-bottom: 20px;
        }

        .card {
            background-color: #e8f5e9; 
            color: #0f172a;                    
            font-size: 18px;                    
            font-weight: bold;                   
            text-align: center;                  
            padding: 20px;                       
            margin-bottom: 15px;                 
            border-radius: 8px;                  
            border: 1px solid #cbd5e1;           
            cursor: pointer;
        }

        .card:hover {
            background-color: #ffffff;       
            border: 1px solid #4285f4; 
            color: #4285f4;      
        }

        .option-btn {
            display: block;
            width: 100%;
            background-color: #ffffff;
            color: #0f172a;
            font-size: 16px;
            font-weight: 500;
            text-align: left;
            padding: 16px 20px;
            margin-bottom: 15px;
            border-radius: 8px;
            border: 1px solid #cbd5e1;
            cursor: pointer;
        }

        .option-btn.selected {
            background-color: #e0f2fe;
            border-color: #4285f4;
            color: #1e40af;
            font-weight: 600;
        }

        .quiz-nav-container {
            display: grid;
            grid-template-columns: repeat(2, 145px);
            justify-content: center;
            gap: 12px 16px;
            margin-top: 25px;
        }

        .quiz-nav-container button:nth-child(1) {
            grid-column: 1 / 2;
            grid-row: 1;
        }

        .quiz-nav-container button:nth-child(3) {
            grid-column: 2 / 3;
            grid-row: 1;
        }

        .quiz-nav-container button:nth-child(2) {
            grid-column: 1 / 3;
            grid-row: 2;
            width: 100%;
        }

        .quiz-nav-container button {
            background-color: #ffffff;
            color: #1e293b;
            border: 1px solid #cbd5e1;
            padding: 12px 20px;
            font-size: 15px;
            font-weight: 600;
            border-radius: 8px;
            cursor: pointer;
            text-decoration: none !important;
        }

        .quiz-nav-container button:hover {
            color: #2563eb;
            border-color: #2563eb;
            background-color: #eff6ff;
        }

        .quiz-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            gap: 15px;
        }

        #submit-btn {
            background-color: #ef4444;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
        }

        .progress-container {
            width: 100%;
            height: 8px;
            background-color: #e2e8f0;
            border-radius: 4px;
            margin-bottom: 25px;
            overflow: hidden;
        }

        .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #4285f4, #2563eb);
            width: 0%;
            transition: width 0.4s ease;
        }

        @media (max-width: 600px) {
            body {
                padding: 6px !important;
            }

            #class-select-screen:not(.hidden), 
            #subject-select-screen:not(.hidden), 
            #ix-x-chapter-screen:not(.hidden), 
            #xi-xii-unit-screen:not(.hidden), 
            #xi-xii-chapter-screen:not(.hidden), 
            #xi-xii-topic-screen:not(.hidden), 
            #name-screen:not(.hidden), 
            #result-screen:not(.hidden),
            #download-screen:not(.hidden),
            #quiz-screen:not(.hidden) {
                display: block !important;
                width: 100% !important;
                max-width: 100% !important;
                min-height: calc(100vh - 12px) !important;
                min-height: calc(100dvh - 12px) !important;
                padding: 14px !important;
                border-radius: 12px !important;
                box-sizing: border-box !important;
                margin: 0 !important;
            }

            #quiz-screen:not(.hidden),
            #result-screen:not(.hidden) {
                display: flex !important;
                flex-direction: column !important;
                justify-content: space-between !important;
            }

            .quiz-header {
                flex-wrap: nowrap !important;
                margin-bottom: 8px !important;
                gap: 6px !important;
            }

            #time-left {
                font-size: 14px !important;
                white-space: nowrap !important;
            }

            #quiz-stats {
                font-size: 12px !important;
                text-align: center !important;
                white-space: nowrap !important;
            }

            #submit-btn {
                padding: 7px 12px !important;
                font-size: 12px !important;
                white-space: nowrap !important;
            }

            .progress-container {
                height: 6px !important;
                margin-bottom: 8px !important;
            }

            #quiz-screen-heading {
                font-size: 17px !important;
                margin: 0 0 8px 0 !important;
            }

            #question-box {
                font-size: 14.5px !important;
                line-height: 1.35 !important;
                margin-bottom: 10px !important;
            }

            #options-container {
                margin-bottom: 8px !important;
            }

            .option-btn {
                padding: 12px 14px !important;
                margin-bottom: 10px !important;
                font-size: 14px !important;
            }

            .quiz-nav-container {
                grid-template-columns: repeat(2, 125px) !important;
                gap: 8px 12px !important;
                margin-top: 6px !important;
            }

            .quiz-nav-container button {
                padding: 9px 14px !important;
                font-size: 13.5px !important;
            }
        }
    </style>
</head>
<body>

    <div id="class-select-screen">
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Class</h2>
        <div class="card" onclick="selectClass('IX')">IX</div>
        <div class="card" onclick="selectClass('X')">X</div>
        <div class="card" onclick="selectClass('XI')">XI</div>
        <div class="card" onclick="selectClass('XII')">XII</div>
        <div class="card" onclick="selectClass('WB XI')">WB XI</div>
        <div class="card" onclick="selectClass('WB XII')">WB XII</div>
    </div>

    <div id="subject-select-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Subject</h2>
        <div class="card" onclick="selectSubject('Physics')">Physics</div>
        <div class="card" onclick="selectSubject('Chemistry')">Chemistry</div>
        <div class="card" onclick="selectSubject('Biology')">Biology</div>
    </div>

    <div id="ix-x-chapter-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Chapter</h2>
        <div id="ix-x-chapter-container"></div>
    </div>

    <div id="xi-xii-unit-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Unit</h2>
        <div id="xi-xii-unit-container"></div>
    </div>

    <div id="xi-xii-chapter-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Chapter</h2>
        <div id="xi-xii-chapter-container"></div>
    </div>

    <div id="xi-xii-topic-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Select Topic</h2>
        <div id="xi-xii-topic-container"></div>
    </div>

    <div id="name-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Enter Details</h2>
        <p style="font-weight: bold; color: #333; margin-bottom: 15px;">Candidate Information</p>
        <input type="text" id="first-name" placeholder="FIRST NAME">
        <input type="text" id="last-name" placeholder="LAST NAME">
        <input type="email" id="email-address" placeholder="Email Address">
        <button onclick="startQuiz()" style="width: 100%; margin-top: 10px;">Verify</button>
    </div>

    <div id="quiz-screen" class="hidden">
        <div class="quiz-header">
            <span id="time-left" style="font-size: 18px; font-weight: bold; color: #dc2626;">Time Left: --:--</span>
            <span id="quiz-stats" style="font-size: 16px; font-weight: 600; color: #334155;">Attempted: 0 / 0 | Skipped: 0</span>
            <button id="submit-btn" onclick="submitQuiz(false)">Submit Quiz</button>
        </div>
        
        <div class="progress-container">
            <div id="progress-bar" class="progress-bar-fill"></div>
        </div>

        <h2 id="quiz-screen-heading" style="text-align: center; color: #4285f4; margin-bottom: 25px;">Current test</h2>
        
        <div id="question-box" style="font-size: 18px; font-weight: 600; color: #0f172a; margin-bottom: 25px; line-height: 1.5;">
            Loading question...
        </div>

        <div id="options-container" style="margin-bottom: 30px;"></div>

        <div class="quiz-nav-container">
            <button onclick="prevQuestion()">Previous</button>
            <button onclick="clearResponse()">Clear Response</button>
            <button onclick="nextQuestion()">Next</button>
        </div>
    </div>

    <div id="result-screen" class="hidden"></div>

    <div id="download-screen" class="hidden">
        <button class="back-btn" onclick="goBack()">Back</button>
        <h2 style="text-align: center; color: #4285f4; margin-top: 0;">Download Study Papers</h2>
        <div id="download-container"></div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js"></script>
    <script>
        let screenHistory = [];
        let currentQuizId = "";
        let neetData = [];
        let quizData = [];
        let wbData = [];
        let currentQuestions = [];
        let currentQuestionIndex = 0;
        let userAnswers = {};
        let skippedQuestions = new Set();
        let timerInterval;
        let timeRemaining = 900;
        let currentChapterTitle = "General Quiz";
        let activeQuizTitle = "Quiz Active";
        let isRestoring = false;
        let navState = { classSelection: null, subjectSelection: null, unitSelection: null, chapterSelection: null };

        let serverStartTime = 0;
        let timerSignature = "";
        let quizDuration = 0;
        let clientStartTime = 0;
        let studentAuthToken = "";

        function syncNameScreenButtons() {
            const backBtn = document.querySelector('#name-screen .back-btn');
            if (backBtn) backBtn.innerText = 'Back';

            const actionBtn = document.querySelector('#name-screen button:not(.back-btn)');
            const otpInput = document.getElementById('otp-input-field');
            if (actionBtn) {
                actionBtn.innerText = otpInput ? 'Start Quiz' : 'Verify';
                actionBtn.disabled = false;
            }
        }

        window.addEventListener('DOMContentLoaded', async () => {
            syncNameScreenButtons();

            const firstNameInput = document.getElementById('first-name');
            const lastNameInput = document.getElementById('last-name');
            const emailInput = document.getElementById('email-address');

            if (firstNameInput) {
                firstNameInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toUpperCase();
                });
            }
            if (lastNameInput) {
                lastNameInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toUpperCase();
                });
            }
            if (emailInput) {
                emailInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toLowerCase();
                });
            }

            try {
                const neetResponse = await fetch('/api/neet');
                if (neetResponse.ok) neetData = await neetResponse.json();
                
                const quizResponse = await fetch('/api/quizzes');
                if (quizResponse.ok) quizData = await quizResponse.json();

                const wbResponse = await fetch('/api/wb');
                if (wbResponse.ok) wbData = await wbResponse.json();

                await restoreState(); 
            } catch (error) {
                console.error("Error fetching configurations:", error);
            }
        });

        function saveState() {
            if (isRestoring) return;
            const activeScreenId = Array.from(document.querySelectorAll('body > div'))
                                       .find(screen => !screen.classList.contains('hidden'))?.id || 'class-select-screen';
            
            const state = {
                activeScreenId, screenHistory, navState, currentQuizId, currentChapterTitle, activeQuizTitle, timeRemaining,
                currentQuestions, currentQuestionIndex, userAnswers,
                skippedQuestions: Array.from(skippedQuestions),
                firstName: document.getElementById('first-name') ? document.getElementById('first-name').value : "",
                lastName: document.getElementById('last-name') ? document.getElementById('last-name').value : "",
                email: document.getElementById('email-address') ? document.getElementById('email-address').value : "",
                serverStartTime, timerSignature, quizDuration, clientStartTime, studentAuthToken
            };
            sessionStorage.setItem('quizAppSession', JSON.stringify(state));
        }

        async function restoreState() {
            const saved = sessionStorage.getItem('quizAppSession');
            if (!saved) return;
            isRestoring = true;
            const state = JSON.parse(saved);

            screenHistory = state.screenHistory || [];
            navState = state.navState || {};
            currentQuizId = state.currentQuizId || "";
            currentChapterTitle = state.currentChapterTitle || "General Quiz";
            activeQuizTitle = state.activeQuizTitle || "Quiz Active";
            timeRemaining = state.timeRemaining;
            currentQuestionIndex = state.currentQuestionIndex || 0;
            userAnswers = state.userAnswers || {};
            skippedQuestions = new Set(state.skippedQuestions || []);
            
            serverStartTime = state.serverStartTime || 0;
            timerSignature = state.timerSignature || "";
            quizDuration = state.quizDuration || 0;
            clientStartTime = state.clientStartTime || 0;
            studentAuthToken = state.studentAuthToken || "";

            if (state.firstName) document.getElementById('first-name').value = state.firstName;
            if (state.lastName) document.getElementById('last-name').value = state.lastName;
            if (state.email) document.getElementById('email-address').value = state.email;

            if (currentQuizId && state.activeScreenId === 'quiz-screen') {
                try {
                    const freshQuestions = await fetch('/api/quiz/' + currentQuizId, { headers: { 'X-Requested-With': 'PioneersPrepApp' }});
                    if (freshQuestions.ok) {
                        const qs = await freshQuestions.json();
                        currentQuestions = qs.length > 0 ? qs : (state.currentQuestions || []);
                    } else {
                        currentQuestions = state.currentQuestions || [];
                    }
                } catch (e) {
                    currentQuestions = state.currentQuestions || [];
                }
            } else {
                currentQuestions = state.currentQuestions || [];
            }

            const { classSelection, subjectSelection, unitSelection, chapterSelection } = navState;

            if (classSelection) {
                if (['IX', 'X'].includes(classSelection)) {
                    if (subjectSelection) await selectSubject(subjectSelection);
                } else if (['WB XI', 'WB XII'].includes(classSelection)) {
                    await loadWbChapters(classSelection);
                } else {
                    await loadNeetUnits(classSelection);
                    if (unitSelection) {
                        const classObj = neetData.find(c => c.name && c.name.toLowerCase().includes(classSelection.toLowerCase()));
                        if (classObj) {
                            loadNeetChapters(classObj, unitSelection);
                            if (chapterSelection) {
                                const unit = classObj.units.find(u => u.name === unitSelection);
                                if (unit) {
                                    const chapter = unit.chapters.find(c => c.name === chapterSelection);
                                    if (chapter) loadNeetTopics(chapter);
                                }
                            }
                        }
                    }
                }
            }
            
            navState = { classSelection, subjectSelection, unitSelection, chapterSelection };
            const activeScreenId = state.activeScreenId || 'class-select-screen';
            
            if (activeScreenId === 'result-screen') {
                goHome();
                isRestoring = false;
                return;
            }
            
            document.querySelectorAll('body > div').forEach(s => s.classList.add('hidden'));
            const targetScreen = document.getElementById(activeScreenId);
            if (targetScreen) targetScreen.classList.remove('hidden');

            if (activeScreenId === 'quiz-screen') {
                renderQuestion();
                startTimer();
            }
            
            isRestoring = false; 
        }

        function getDefaultTimeFromHTML() {
            const timeDisplay = document.getElementById('time-left');
            if (!timeDisplay) return 900;
            const parts = timeDisplay.innerText.trim().split(':');
            if (parts.length === 2) {
                return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
            }
            return 900;
        }

        function showScreen(screenId) {
            if (isRestoring) return; 

            const screens = document.querySelectorAll('body > div');
            const activeScreen = Array.from(screens).find(screen => !screen.classList.contains('hidden'));
            
            if (activeScreen && activeScreen.id !== screenId) {
                screenHistory.push(activeScreen.id);
            }
            screens.forEach(screen => {
                screen.classList.add('hidden');
                screen.classList.remove('fade-in'); 
            });
            const targetScreen = document.getElementById(screenId);
            if (targetScreen) {
                targetScreen.classList.remove('hidden');
                targetScreen.classList.add('fade-in'); 
            }
            saveState();
        }

        function goBack() {
            if (screenHistory.length > 0) {
                const previousScreenId = screenHistory.pop();
                const screens = document.querySelectorAll('body > div');
                screens.forEach(screen => {
                    screen.classList.add('hidden');
                    screen.classList.remove('fade-in');
                });
                
                const prevScreen = document.getElementById(previousScreenId);
                if (prevScreen) {
                    prevScreen.classList.remove('hidden');
                    prevScreen.classList.add('fade-in');
                }
                saveState();
            } else {
                goHome();
            }
        }

        function goHome() {
            screenHistory = [];
            navState = { classSelection: null, subjectSelection: null, unitSelection: null, chapterSelection: null };
            currentQuestions = [];
            userAnswers = {};
            skippedQuestions = new Set();
            clearInterval(timerInterval);
            
            serverStartTime = 0;
            timerSignature = "";
            quizDuration = 0;
            clientStartTime = 0;
            studentAuthToken = "";
            
            document.getElementById('first-name').value = '';
            document.getElementById('last-name').value = '';
            document.getElementById('email-address').value = '';

            const existingOtpWrapper = document.getElementById('otp-wrapper-container');
            if (existingOtpWrapper) existingOtpWrapper.remove();

            syncNameScreenButtons();

            const screens = document.querySelectorAll('body > div');
            screens.forEach(screen => {
                screen.classList.add('hidden');
                screen.classList.remove('fade-in');
            });
            const classScreen = document.getElementById('class-select-screen');
            if (classScreen) {
                classScreen.classList.remove('hidden');
                classScreen.classList.add('fade-in');
            }
            sessionStorage.removeItem('quizAppSession');
        }

        function selectClass(className) {
            navState.classSelection = className;
            navState.subjectSelection = null;
            navState.unitSelection = null;
            navState.chapterSelection = null;

            if (className === 'IX' || className === 'X') {
                showScreen('subject-select-screen');
            } else if (className === 'XI' || className === 'XII') {
                loadNeetUnits(className);
            } else if (className === 'WB XI' || className === 'WB XII') {
                loadWbChapters(className);
            }
        }

        async function loadWbChapters(className) {
            const container = document.getElementById('ix-x-chapter-container');
            if (!container) return;
            container.innerHTML = '';

            try {
                const response = await fetch('/api/papers/' + className);
                const data = await response.json();
                
                if (data.success && data.papers && data.papers.length > 0) {
                    const downloadBtn = document.createElement('button');
                    downloadBtn.type = 'button';
                    downloadBtn.innerText = "📄 Download Papers";
                    downloadBtn.style.cssText = "display: block; width: 100%; max-width: 300px; margin: 0 auto 20px; padding: 12px; background-color: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;";
                    downloadBtn.onclick = () => openDownloadScreen(data.papers);
                    container.appendChild(downloadBtn);
                }
            } catch (error) {
                console.error("Error fetching papers:", error);
            }

            const classObj = wbData.find(c => c.className === className);
            const chapters = classObj ? classObj.chapters : [];

            if (chapters.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#64748b;">No chapters found.</p>';
                showScreen('ix-x-chapter-screen');
                return;
            }

            chapters.forEach(ch => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = ch.title;
                card.onclick = async () => {
                    currentChapterTitle = className + ' - ' + ch.title;
                    activeQuizTitle = ch.title; 
                    timeRemaining = ch.duration || getDefaultTimeFromHTML(); 
                    currentQuestions = await fetchQuestionsFile(ch.id);
                    showScreen('name-screen');
                };
                container.appendChild(card);
            });
            showScreen('ix-x-chapter-screen');
        }

        async function selectSubject(subjectName) {
            navState.subjectSelection = subjectName;
            const container = document.getElementById('ix-x-chapter-container');
            if (!container) return;
            container.innerHTML = '';

            try {
                const response = await fetch('/api/papers/' + navState.classSelection + '/' + subjectName);
                const data = await response.json();
                
                if (data.success && data.papers && data.papers.length > 0) {
                    const downloadBtn = document.createElement('button');
                    downloadBtn.type = 'button';
                    downloadBtn.innerText = "📄 Download Papers";
                    downloadBtn.style.cssText = "display: block; width: 100%; max-width: 300px; margin: 0 auto 20px; padding: 12px; background-color: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;";
                    downloadBtn.onclick = () => openDownloadScreen(data.papers);
                    container.appendChild(downloadBtn);
                }
            } catch (error) {
                console.error("Error fetching papers:", error);
            }

            const classObj = quizData.find(c => c.name === navState.classSelection || c.name === ('Class ' + navState.classSelection));
            const subjectObj = classObj && classObj.subjects ? classObj.subjects.find(s => s.name.toLowerCase() === subjectName.toLowerCase()) : null;
            const chapters = subjectObj ? subjectObj.chapters : [];

            if (chapters.length === 0) {
                const msg = document.createElement('p');
                msg.style.cssText = "text-align:center; color:#64748b; width: 100%;";
                msg.innerText = "No chapters found.";
                container.appendChild(msg);
                showScreen('ix-x-chapter-screen');
                return;
            }

            chapters.forEach(ch => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = ch.title;
                card.onclick = async () => {
                    currentChapterTitle = ch.title;
                    activeQuizTitle = ch.title; 
                    timeRemaining = ch.duration || getDefaultTimeFromHTML(); 
                    currentQuestions = await fetchQuestionsFile(ch.id);
                    showScreen('name-screen');
                };
                container.appendChild(card);
            });
            showScreen('ix-x-chapter-screen');
        }

        function openDownloadScreen(papers) {
            const container = document.getElementById('download-container');
            if (!container) return;
            container.innerHTML = '';

            papers.forEach(paper => {
                const link = document.createElement('a');
                link.href = '/api/download/' + paper.fileName; 
                link.className = 'card';
                link.style.textDecoration = 'none';
                link.style.display = 'block';
                link.style.color = '#333';
                link.innerText = '📥 ' + paper.name;
                container.appendChild(link);
            });

            showScreen('download-screen');
        }

        async function loadNeetUnits(className) {
            const container = document.getElementById('xi-xii-unit-container');
            if (!container) return;
            container.innerHTML = '';
            
            try {
                const response = await fetch('/api/papers/' + className);
                const data = await response.json();
                
                if (data.success && data.papers && data.papers.length > 0) {
                    const downloadBtn = document.createElement('button');
                    downloadBtn.type = 'button';
                    downloadBtn.innerText = "📄 Download Papers";
                    downloadBtn.style.cssText = "display: block; width: 100%; max-width: 300px; margin: 0 auto 20px; padding: 12px; background-color: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;";
                    downloadBtn.onclick = () => openDownloadScreen(data.papers);
                    container.appendChild(downloadBtn);
                }
            } catch (error) {
                console.error("Error fetching papers:", error);
            }

            const targetClassObj = neetData.find(c => c.name && c.name.toLowerCase().includes(className.toLowerCase()));
            
            if (!targetClassObj || !targetClassObj.units) {
                const msg = document.createElement('p');
                msg.style.cssText = "text-align:center; color:#64748b; width: 100%;";
                msg.innerText = "No units found.";
                container.appendChild(msg);
                showScreen('xi-xii-unit-screen');
                return;
            }

            targetClassObj.units.forEach(unit => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = unit.name;
                card.onclick = () => loadNeetChapters(targetClassObj, unit.name);
                container.appendChild(card);
            });
            showScreen('xi-xii-unit-screen');
        }

        function loadNeetChapters(classObj, unitName) {
            navState.unitSelection = unitName;
            navState.chapterSelection = null;
            const unit = classObj.units.find(u => u.name === unitName);
            const container = document.getElementById('xi-xii-chapter-container');
            if (!container || !unit) return;
            container.innerHTML = '';

            unit.chapters.forEach(chap => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = chap.name;
                card.onclick = () => loadNeetTopics(chap);
                container.appendChild(card);
            });
            showScreen('xi-xii-chapter-screen');
        }

        function loadNeetTopics(chapter) {
            navState.chapterSelection = chapter.name;
            const container = document.getElementById('xi-xii-topic-container');
            if (!container) return;
            container.innerHTML = '';

            const validTopics = chapter.topics.filter(t => t.name && t.name.trim() !== "");

            if (validTopics.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#64748b;">No topics available.</p>';
            }

            validTopics.forEach(topic => {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerText = topic.name;
                card.onclick = async () => {
                    currentChapterTitle = chapter.name + ' - ' + topic.name;
                    activeQuizTitle = topic.name; 
                    timeRemaining = topic.duration || getDefaultTimeFromHTML(); 
                    currentQuestions = await fetchQuestionsFile(topic.id);
                    showScreen('name-screen');
                };
                container.appendChild(card);
            });
            showScreen('xi-xii-topic-screen');
        }

        async function fetchQuestionsFile(fileId) {
            if (!fileId) return [];
            try {
                currentQuizId = fileId; 
                const response = await fetch('/api/quiz/' + fileId, {
                    headers: { 'X-Requested-With': 'PioneersPrepApp' }
                });
                if (response.ok) return await response.json();
                return [];
            } catch (error) {
                console.error('Error loading API for ' + fileId + ':', error);
                return [];
            }
        }

        function startTimer() {
            clearInterval(timerInterval);
            const timeDisplay = document.getElementById('time-left');
            
            const updateDisplay = () => {
                let displayTime = timeRemaining > 0 ? timeRemaining : 0;
                const initMin = Math.floor(displayTime / 60).toString().padStart(2, '0');
                const initSec = (displayTime % 60).toString().padStart(2, '0');
                timeDisplay.innerText = initMin + ':' + initSec;
            };
            
            if (clientStartTime > 0 && quizDuration > 0) {
                const elapsed = Math.floor((Date.now() - clientStartTime) / 1000);
                timeRemaining = quizDuration - elapsed;
            }
            
            updateDisplay();

            timerInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - clientStartTime) / 1000);
                timeRemaining = quizDuration - elapsed;

                if (timeRemaining <= 0) {
                    clearInterval(timerInterval);
                    timeRemaining = 0;
                    updateDisplay();
                    submitQuiz(true);
                    return;
                }
                updateDisplay();
                saveState();
            }, 1000);
        }

        async function startQuiz() {
            const firstNameEl = document.getElementById('first-name');
            const lastNameEl = document.getElementById('last-name');
            const emailEl = document.getElementById('email-address');

            if (firstNameEl) firstNameEl.value = firstNameEl.value.trim().toUpperCase();
            if (lastNameEl) lastNameEl.value = lastNameEl.value.trim().toUpperCase();
            if (emailEl) emailEl.value = emailEl.value.trim().toLowerCase();

            const firstName = firstNameEl?.value || '';
            const lastName = lastNameEl?.value || '';
            const email = emailEl?.value || '';

            if (!firstName || !lastName || !email) {
                alert('Please fill in all fields (First Name, Last Name, and Email Address) to start.');
                return;
            }

            const emailPattern = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
            if (!emailPattern.test(email)) {
                alert('Please enter a valid email address.');
                return;
            }

            const submitBtn = document.querySelector('#name-screen button:not(.back-btn)');
            let otpInput = document.getElementById('otp-input-field');

            if (!otpInput) {
                if (submitBtn) {
                    submitBtn.innerText = 'Sending Code...';
                    submitBtn.disabled = true;
                }

                try {
                    const response = await fetch('/api/send-otp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ firstName, lastName, email })
                    });
                    const data = await response.json();

                    if (!response.ok) {
                        alert(data.error || 'Failed to send verification code.');
                        if (submitBtn) {
                            submitBtn.innerText = 'Verify';
                            submitBtn.disabled = false;
                        }
                        return;
                    }

                    const nameScreenContainer = document.getElementById('name-screen');
                    if (nameScreenContainer) {
                        const otpWrapper = document.createElement('div');
                        otpWrapper.id = 'otp-wrapper-container';
                        otpWrapper.style.cssText = 'margin-top: 15px;';
                        otpWrapper.innerHTML = '<label style="display: block; font-weight: bold; margin-bottom: 5px; color: #333; text-align: left;">Enter 6-Digit Verification Code:</label><input type="number" id="otp-input-field" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="123456" style="width: 100%; padding: 12px; font-size: 18px; text-align: center; letter-spacing: 4px; border-radius: 8px; border: 1px solid #cbd5e1; box-sizing: border-box; margin-bottom: 12px;" />';

                        if (submitBtn && submitBtn.parentNode === nameScreenContainer) {
                            nameScreenContainer.insertBefore(otpWrapper, submitBtn);
                        } else {
                            nameScreenContainer.appendChild(otpWrapper);
                        }

                        if (submitBtn) {
                            submitBtn.innerText = 'Start Quiz';
                            submitBtn.disabled = false;
                        }
                    }
                } catch (error) {
                    console.error('OTP request error:', error);
                    alert('Network error connecting to authentication server.');
                    if (submitBtn) {
                        submitBtn.innerText = 'Verify';
                        submitBtn.disabled = false;
                    }
                }
                return;
            }

            const enteredOtp = otpInput.value.trim();
            if (enteredOtp.length !== 6) {
                alert('Please enter the complete 6-digit verification code.');
                return;
            }

            try {
                const verifyResponse = await fetch('/api/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, otp: enteredOtp })
                });
                const verifyData = await verifyResponse.json();

                if (!verifyResponse.ok) {
                    alert(verifyData.error || 'Invalid verification code.');
                    return;
                }

                studentAuthToken = verifyData.authToken;

                const tokenResponse = await fetch('/api/start-quiz', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
                });
                const tokenData = await tokenResponse.json();
                
                serverStartTime = tokenData.startTime;
                timerSignature = tokenData.signature;
                quizDuration = timeRemaining;
                clientStartTime = Date.now(); 
                
                if (currentQuestionIndex === 0 && Object.keys(userAnswers).length === 0) {
                    skippedQuestions = new Set();
                }

                showScreen('quiz-screen');
                startTimer();
                renderQuestion();
                saveState();

            } catch (error) {
                console.error('Verification error:', error);
                alert('Authentication failed. Please try again.');
            }
        }

        function renderQuestion() {
            const headingEl = document.getElementById('quiz-screen-heading');
            if (headingEl) {
                headingEl.innerText = activeQuizTitle;
            }

            if (currentQuestions.length === 0) {
                document.getElementById('question-box').innerText = "No questions available.";
                document.getElementById('options-container').innerHTML = '';
                return;
            }

            const q = currentQuestions[currentQuestionIndex];
            document.getElementById('question-box').innerText = 'Q.' + (currentQuestionIndex + 1) + ': ' + q.question;
            
            const optionsContainer = document.getElementById('options-container');
            optionsContainer.innerHTML = '';
            
            if (q.type === 'descriptive') {
                const textarea = document.createElement('textarea');
                textarea.placeholder = 'Type your detailed answer here...';
                textarea.rows = 4;
                textarea.style.cssText = "width: 100%; padding: 12px 14px; font-size: 15px; border-radius: 8px; border: 1px solid #cbd5e1; box-sizing: border-box; font-family: inherit; resize: vertical; margin-bottom: 10px; color: #0f172a;";
                
                if (userAnswers[currentQuestionIndex] !== undefined) {
                    textarea.value = userAnswers[currentQuestionIndex];
                }
                
                textarea.addEventListener('input', (e) => {
                    const val = e.target.value.trim();
                    if (val === "") {
                        delete userAnswers[currentQuestionIndex];
                    } else {
                        userAnswers[currentQuestionIndex] = val;
                    }
                    updateQuizStats();
                    saveState();
                });
                
                optionsContainer.appendChild(textarea);
            } else {
                const opts = q.options || [];
                opts.forEach((opt, idx) => {
                    const btn = document.createElement('button');
                    btn.type = 'button'; 
                    btn.className = 'option-btn';
                    if (userAnswers[currentQuestionIndex] === idx) {
                        btn.classList.add('selected');
                    }
                    btn.innerText = opt;
                    btn.onclick = () => selectOption(btn, idx);
                    optionsContainer.appendChild(btn);
                });
            }

            skippedQuestions.add(currentQuestionIndex);
            updateQuizStats();
        }

        function selectOption(button, optionIndex) {
            const buttons = document.querySelectorAll('#options-container .option-btn');
            buttons.forEach(btn => btn.classList.remove('selected'));
            button.classList.add('selected');
            
            userAnswers[currentQuestionIndex] = optionIndex;
            
            updateQuizStats();
            saveState();
        }

        function clearResponse() {
            delete userAnswers[currentQuestionIndex];
            
            const buttons = document.querySelectorAll('#options-container .option-btn');
            buttons.forEach(btn => btn.classList.remove('selected'));
            
            const textarea = document.querySelector('#options-container textarea');
            if (textarea) textarea.value = "";
            
            updateQuizStats();
            saveState();
        }

        function nextQuestion() {
            if (currentQuestionIndex < currentQuestions.length - 1) {
                currentQuestionIndex++;
                renderQuestion();
                saveState();
            }
        }

        function prevQuestion() {
            if (currentQuestionIndex > 0) {
                currentQuestionIndex--;
                renderQuestion();
                saveState();
            }
        }

        function updateQuizStats() {
            const attemptedCount = Object.keys(userAnswers).length;
            
            let skippedCount = 0;
            skippedQuestions.forEach(qIndex => {
                if (userAnswers[qIndex] === undefined && qIndex !== currentQuestionIndex) {
                    skippedCount++;
                }
            });

            const statsEl = document.getElementById('quiz-stats');
            if (statsEl) {
                statsEl.innerText = 'Attempted: ' + attemptedCount + ' / ' + currentQuestions.length + ' | Skipped: ' + skippedCount;
            }

            const progressBar = document.getElementById('progress-bar');
            if (progressBar && currentQuestions.length > 0) {
                const percentage = (attemptedCount / currentQuestions.length) * 100;
                progressBar.style.width = percentage + '%';
            }
        }

        async function submitQuiz(isAutoSubmit = false) { 
            const answeredCount = Object.keys(userAnswers).length;
            const totalQuestions = currentQuestions.length;

            if (!isAutoSubmit && answeredCount < totalQuestions) {
                alert('Please answer all questions before submitting. You have answered ' + answeredCount + ' out of ' + totalQuestions + '.');
                return; 
            }
            
            clearInterval(timerInterval);
            
            const submitBtn = document.getElementById('submit-btn');
            if (submitBtn) {
                submitBtn.innerText = "Submitting...";
                submitBtn.disabled = true;
            }

            const firstName = document.getElementById('first-name')?.value.trim() || "Unknown";
            const lastName = document.getElementById('last-name')?.value.trim() || "Name";
            const email = document.getElementById('email-address')?.value.trim() || "No Email";

            try {
                const payload = {
                    firstName,
                    lastName,
                    email,
                    className: navState.classSelection || "", 
                    chapterTitle: activeQuizTitle,
                    quizId: currentQuizId,
                    userAnswers: userAnswers,
                    isAutoSubmit: isAutoSubmit,
                    serverStartTime: serverStartTime,
                    timerSignature: timerSignature,
                    quizDuration: quizDuration,
                    authToken: studentAuthToken
                };

                const response = await fetch('/api/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const resultData = await response.json();

                if (!response.ok) {
                    alert(resultData.error || "Submission rejected by server.");
                    goHome();
                    return;
                }

                const resultContainer = document.getElementById('result-screen');
                if (resultContainer && resultData.success) {
                    resultContainer.innerHTML = '<button class="back-btn" onclick="goHome()">Back to Home</button><h2 class="screen-heading">Quiz Results</h2><div style="text-align: center; margin-top: 20px;"><p style="font-size: 18px; color: #333;">Candidate: <strong>' + firstName + ' ' + lastName + '</strong></p><h1 style="color: #4285f4; font-size: 48px; margin: 10px 0;">' + resultData.score + ' / ' + resultData.total + '</h1><p style="font-size: 16px; color: #64748b;">Response recorded and mailed to the administrator successfully. A copy of your response has also been mailed to your provided email id.</p></div>';
                    showScreen('result-screen');
                    
                    if (typeof confetti === 'function') {
                        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
                    }
                }

            } catch (error) {
                console.error("Critical submission error:", error);
            } finally {
                if (submitBtn) {
                    submitBtn.innerText = "Submit Quiz";
                    submitBtn.disabled = false;
                }
                sessionStorage.removeItem('quizAppSession');
            }
        }
    </script>
</body>
</html>`);
});

app.get('/ping', (req, res) => {
    res.status(200).send('Awake');
});

app.get('/api/quizzes', (req, res) => {
    const quizListPath = path.join(__dirname, 'quizzes.json');
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'quizzes.json configuration file not found' });
    }
});

app.get('/api/neet', (req, res) => {
    const neetListPath = path.join(__dirname, 'neet.json');
    if (fs.existsSync(neetListPath)) {
        res.json(JSON.parse(fs.readFileSync(neetListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'neet.json configuration file not found' });
    }
});

app.get('/api/wb', (req, res) => {
    const wbListPath = path.join(__dirname, 'wb.json');
    if (fs.existsSync(wbListPath)) {
        res.json(JSON.parse(fs.readFileSync(wbListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'wb.json configuration file not found' });
    }
});

app.get('/api/papers/:className/:subjectName', (req, res) => {
    const { className, subjectName } = req.params;
    let papers = [];

    try {
        if (fs.existsSync(path.join(__dirname, 'quizzes.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'quizzes.json'), 'utf8'));
            const classObj = data.find(c => c.name === className || c.name === `Class ${className}`);
            const subjectObj = classObj?.subjects?.find(s => s.name.toLowerCase() === subjectName.toLowerCase());
            if (subjectObj && subjectObj.papers) papers = papers.concat(subjectObj.papers);
        }

        if (papers.length === 0 && fs.existsSync(path.join(__dirname, 'neet.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'neet.json'), 'utf8'));
            const classObj = data.find(c => c.name === className || c.name === `Class ${className}`);
            const unitObj = classObj?.units?.find(u => u.name.toLowerCase() === subjectName.toLowerCase());
            if (unitObj && unitObj.papers) papers = papers.concat(unitObj.papers);
        }

        res.json({ success: true, papers });
    } catch (error) {
        console.error("Error fetching papers:", error);
        res.json({ success: false, papers: [] });
    }
});

app.get('/api/papers/:className', (req, res) => {
    const { className } = req.params;
    let papers = [];

    try {
        if (fs.existsSync(path.join(__dirname, 'wb.json'))) {
            const wbData = JSON.parse(fs.readFileSync(path.join(__dirname, 'wb.json'), 'utf8'));
            const wbClass = wbData.find(c => c.className === className || c.className === `WB ${className}`);
            if (wbClass && wbClass.papers) papers = papers.concat(wbClass.papers);
        }

        if (papers.length === 0 && fs.existsSync(path.join(__dirname, 'neet.json'))) {
            const neetData = JSON.parse(fs.readFileSync(path.join(__dirname, 'neet.json'), 'utf8'));
            const neetClass = neetData.find(c => c.name === className || c.name === `Class ${className}`);
            if (neetClass && neetClass.papers) papers = papers.concat(neetClass.papers);
        }

        res.json({ success: true, papers });
    } catch (error) {
        console.error("Error fetching papers:", error);
        res.json({ success: false, papers: [] });
    }
});

app.get('/api/download/:fileName', (req, res) => {
    const safeFileName = path.basename(req.params.fileName);
    const filePath = path.join(__dirname, 'secure_papers', safeFileName); 
    
    res.download(filePath, (err) => {
        if (err) {
            console.error("File download error:", err);
            if (!res.headersSent) res.status(404).send("File not found.");
        }
    });
});

app.get('/api/quiz/:id', (req, res) => {
    const requestSource = req.get('X-Requested-With');
    if (requestSource !== 'PioneersPrepApp') {
        return res.status(403).json({ error: "Security Alert: Direct API access is forbidden." });
    }

    try {
        const id = req.params.id;
        let filePath = path.join(__dirname, `${id}.json`);

        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, `${id}-questions.json`);
        }

        const rawData = fs.readFileSync(filePath, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        const safeQuestions = realQuestions.map(q => {
            return {
                type: q.type || 'mcq',
                question: q.question,
                options: q.options || []
            };
        });

        res.json(safeQuestions);
    } catch (error) {
        console.error("Error fetching quiz:", error);
        res.status(500).json({ error: "Failed to load quiz" });
    }
});

app.post('/api/start-quiz', (req, res) => {
    const { quizId, duration } = req.body;
    const startTime = Date.now();
    const dataToSign = `${quizId}:${duration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');
    res.json({ startTime, signature });
});

// --- ASYNCHRONOUS NON-BLOCKING OTP DISPATCH ---
app.post('/api/send-otp', async (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase() : '';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase() : '';
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';

    if (!firstName || !lastName || !email) {
        return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    pendingOtps[email] = {
        otp,
        firstName,
        lastName,
        expiresAt: Date.now() + 5 * 60 * 1000
    };

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
                           '<h2>Hello ' + firstName + ' ' + lastName + ',</h2>' +
                           '<p>Your verification code to start the mock test on <b>Pioneers Prep</b> is:</p>' +
                           '<h1 style="color: #4285f4; letter-spacing: 6px; font-size: 36px; margin: 20px 0;">' + otp + '</h1>' +
                           '<p>This code is valid for 5 minutes. Do not share this code with anyone.</p>' +
                           '</div>'
            })
        }).catch(err => console.error('Background email error:', err));

        res.json({ success: true, message: 'OTP sent successfully.', firstName, lastName, email });
    } else {
        res.status(500).json({ success: false, error: 'Email service URL not configured on server.' });
    }
});

app.post('/api/verify-otp', (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const otp = req.body.otp ? req.body.otp.trim() : '';
    const record = pendingOtps[email];

    if (!record) {
        return res.status(400).json({ success: false, error: 'No pending verification found. Please request a new code.' });
    }
    if (Date.now() > record.expiresAt) {
        delete pendingOtps[email];
        return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
    }
    if (record.otp !== otp) {
        return res.status(400).json({ success: false, error: 'Invalid verification code entered.' });
    }

    delete pendingOtps[email];
    
    const authToken = crypto.createHmac('sha256', SECRET).update(`${email}:${Date.now()}`).digest('hex');
    activeSessions.add(authToken);

    res.json({ 
        success: true, 
        authToken, 
        firstName: record.firstName, 
        lastName: record.lastName,
        email
    });
});

app.post('/api/submit', async (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase() : 'UNKNOWN';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase() : 'NAME';
    const email = req.body.email ? req.body.email.trim().toLowerCase() : 'no-email';
    
    const { className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration, authToken } = req.body;

    if (!authToken || !activeSessions.has(authToken)) {
        return res.status(403).json({ success: false, error: 'Security Alert: Unauthorized submission. Please verify your email first.' });
    }
    activeSessions.delete(authToken);

    if (!serverStartTime || !timerSignature || !quizDuration) {
        return res.status(400).json({ success: false, error: 'Security Alert: Missing timer tokens. Submission rejected.' });
    }

    const expectedSignature = crypto.createHmac('sha256', SECRET).update(`${quizId}:${quizDuration}:${serverStartTime}`).digest('hex');
    if (expectedSignature !== timerSignature) {
        return res.status(400).json({ success: false, error: 'Security Alert: Tampered timer token detected.' });
    }

    const elapsedSeconds = (Date.now() - serverStartTime) / 1000;
    const gracePeriod = 45; 
    if (elapsedSeconds > quizDuration + gracePeriod) {
        return res.status(400).json({ success: false, error: 'Time limit exceeded. Submission blocked by server.' });
    }

    try {
        const safeUserAnswers = userAnswers || {};
        let filePath = path.join(__dirname, `${quizId}.json`);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, `${quizId}-questions.json`);
        }
        const rawData = fs.readFileSync(filePath, 'utf-8');
        const realQuestions = JSON.parse(rawData);

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

        let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 16px;">` +
            `<tr style="background-color: #f1f5f9; text-align: left;">` +
            `<th style="width: 5%;">#</th><th style="width: 40%;">Question</th><th style="width: 25%;">Student's Selection</th><th style="width: 20%;">Correct Option</th><th style="width: 10%; text-align: center;">Status</th></tr>`;

        realQuestions.forEach((q, index) => {
            const studentResponse = safeUserAnswers[index.toString()]; 
            const isAttempted = studentResponse !== undefined && studentResponse !== "";

            let isCorrect = false;
            let studentSelectionText = "Skipped";
            let correctOptionText = "N/A";
            let rawStatus = "Skipped";
            let statusColor = "yellow";

            if (q.type === 'descriptive') {
                studentSelectionText = isAttempted ? studentResponse : "Skipped";
                correctOptionText = q.model_answer || "Refer to marking scheme";
                if (isAttempted) {
                    rawStatus = "Needs Review";
                    statusColor = "orange";
                }
            } else {
                isCorrect = isAttempted && parseInt(studentResponse) === q.answer;
                if (isCorrect) correctCount++;
                else if (isAttempted) incorrectCount++;

                studentSelectionText = isAttempted ? (q.options[studentResponse] || "Unknown") : "Skipped";
                correctOptionText = q.options[q.answer] !== undefined ? q.options[q.answer] : "N/A";
                rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (isAttempted ? "lightcoral" : "yellow");
            }
            
            const statusText = `<span style="background-color: ${statusColor}; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${q.explanation}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${q.question || "N/A"}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const fullTitle = (className && !chapterTitle.startsWith(className))
            ? `${className} - ${chapterTitle}`
            : chapterTitle;

        const studentName = `${firstName} ${lastName}`.trim();

        const securePayload = {
            firstName, lastName, email,
            className: className || "",
            chapterTitle: fullTitle,
            subject: `New Quiz Submission - ${fullTitle} - ${studentName}`,
            score: correctCount, total: totalCount,
            attempted: attemptedCount, skipped: skippedCount,
            correct: correctCount, incorrect: incorrectCount,
            breakdown: breakdownHtml,
            targetEmail: process.env.TARGET_EMAIL,
            secretKey: APPS_SECRET
        };

        try {
            const submissionsFile = path.join(__dirname, 'submissions.json');
            let allSubmissions = [];
            
            if (fs.existsSync(submissionsFile)) {
                const fileData = await fs.promises.readFile(submissionsFile, 'utf8');
                allSubmissions = JSON.parse(fileData);
            }
            
            allSubmissions.push({
                timestamp: new Date().toISOString(),
                ...securePayload
            });
            
            await fs.promises.writeFile(submissionsFile, JSON.stringify(allSubmissions, null, 2));
        } catch (err) {
            console.error("Local backup failed:", err);
        }

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

// --- KEEP-AWAKE PING SYSTEM (14 MINUTES) ---
const PING_INTERVAL = 14 * 60 * 1000; 
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

setInterval(() => {
    fetch(`${SELF_URL}/ping`)
        .then(res => console.log(`[Keep-Awake] Pinged successfully at ${new Date().toISOString()}`))
        .catch(err => console.error('[Keep-Awake] Ping failed:', err.message));
}, PING_INTERVAL);

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
