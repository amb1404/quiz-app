// public/js/quiz.js
let screenHistory = [];
let dynamicQuizzes = [];
let currentQuizId = "";
let currentQuestionsCount = 0; // Replaced currentQuestions array
let questionCache = {}; // Caches JIT downloaded questions
let currentQuestionIndex = 0;
let userAnswers = {};
let skippedQuestions = new Set();
let timeRemaining = 900;
let quizDuration = 900;
let serverStartTime = 0;
let timerSignature = "";
let timerInterval;
// ... (keep your existing class and subject state variables below this)

function updateState() {
    if (isRestoringSession) return;
    MainNav.saveSessionState(
        CURRENT_ROUTE, currentQuizId, activeQuizTitle, currentQuestionIndex,
        timeRemaining, quizDuration, serverStartTime, timerSignature,
        userAnswers, skippedQuestions, screenHistory,
        { selectedClassName, selectedSubjectName, currentQuestionsCount, questionCache, selectedNotesClass, selectedNotesSubject, selectedDescriptiveClass, selectedDescriptiveSubject, selectedNeetUnit, selectedNeetChapter }
    );
}

async function restoreSessionState(state) {
    try {
        isRestoringSession = true;
        // ... (keep existing class restoration logic)
        currentQuizId = state.currentQuizId || '';
        activeQuizTitle = state.activeQuizTitle || '';
        currentQuestionIndex = state.currentQuestionIndex || 0;
        timeRemaining = state.timeRemaining || 900;
        quizDuration = state.quizDuration || 900;
        serverStartTime = state.serverStartTime || 0;
        timerSignature = state.timerSignature || '';
        currentQuestionsCount = state.currentQuestionsCount || 0;
        questionCache = state.questionCache || {};
        userAnswers = state.userAnswers || {};
        skippedQuestions = new Set(state.skippedQuestions || []);

        if (state.activeScreen === 'quiz-screen' && currentQuizId) {
            if (serverStartTime && quizDuration) {
                timeRemaining = Math.max(0, quizDuration - Math.floor((Date.now() - serverStartTime) / 1000));
            }
            showScreen('quiz-screen');
            await renderQuestion();
            startTimer();
        } 
        // ... (keep the rest of the existing restoreSessionState routing logic)
    } catch (e) {
        console.error(e);
    } finally {
        isRestoringSession = false;
        updateState();
    }
}

async function attemptQuizStart(first, last, email) {
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) vBtn.innerText = 'Starting...';

    const startRes = await fetch('/api/start-quiz', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
    });
    const startData = await startRes.json();

    if (startRes.status === 402) {
        const qz = dynamicQuizzes.find(q => q.id === currentQuizId);
        const price = qz ? qz.price : 49;
        initiateRazorpayPayment(currentQuizId, price, email, first, last, () => attemptQuizStart(first, last, email));
        return;
    }

    if (!startRes.ok) {
        alert(startData.error || 'Verification Error.');
        if (vBtn) { vBtn.innerText = 'Start Quiz'; vBtn.disabled = false; }
        return;
    }

    serverStartTime = startData.startTime;
    timerSignature = startData.signature;
    quizDuration = startData.duration || timeRemaining;
    timeRemaining = quizDuration;

    // Get Total Count Only
    const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'PioneersPrepApp' }
    });
    const metaData = await qRes.json();
    currentQuestionsCount = metaData.totalQuestions;

    currentQuestionIndex = 0; userAnswers = {}; skippedQuestions = new Set(); screenHistory = []; questionCache = {};

    showScreen('quiz-screen');
    await renderQuestion();
    startTimer();
}

function updateQuizStats() {
    const total = currentQuestionsCount;
    const attemptedCount = Object.keys(userAnswers).length;
    let skipped = 0;
    skippedQuestions.forEach(idx => { if (userAnswers[idx] === undefined) skipped++; });

    const statsEl = document.getElementById('quiz-stats');
    if (statsEl) statsEl.innerText = `Attempted: ${attemptedCount} / ${total} | Skipped: ${skipped}`;
    const bar = document.getElementById('progress-bar');
    if (bar && total > 0) bar.style.width = `${(attemptedCount / total) * 100}%`;
    updateState();
}

async function renderQuestion() {
    document.getElementById('quiz-screen-heading').innerText = activeQuizTitle;
    const container = document.getElementById('options-container');
    const questionBox = document.getElementById('question-box');

    // JIT Fetching & Caching
    if (!questionCache[currentQuestionIndex]) {
        questionBox.innerText = `Loading Question ${currentQuestionIndex + 1}...`;
        container.innerHTML = '';
        try {
            const res = await fetch(`/api/quiz/${encodeURIComponent(currentQuizId)}/question/${currentQuestionIndex}`, {
                credentials: 'same-origin',
                headers: { 'X-Requested-With': 'PioneersPrepApp' }
            });
            const data = await res.json();
            if (data.payload && data.key) {
                questionCache[currentQuestionIndex] = JSON.parse(xorDecipher(data.payload, data.key));
            } else {
                throw new Error("Invalid payload");
            }
        } catch (e) {
            questionBox.innerText = "Connection error. Please check your internet and try again.";
            return;
        }
    }

    const q = questionCache[currentQuestionIndex];
    questionBox.innerText = `Q.${currentQuestionIndex + 1}: ${q.question}`;
    container.innerHTML = '';

    // ... (Keep ALL your existing rendering logic for Descriptive/FIB/Options below this point exactly as it was)
