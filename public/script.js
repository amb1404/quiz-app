// Paste your Google Apps Script Web App Deployment URL below
const GOOGLE_SCRIPT_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE';

let screenHistory = [];
let neetData = [];
let quizData = [];
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};
let skippedQuestions = new Set();
let timerInterval;
let timeRemaining = 900;
let currentChapterTitle = "General Quiz";

// Variables for session persistence
let isRestoring = false;
let navState = {
    classSelection: null,
    subjectSelection: null,
    unitSelection: null,
    chapterSelection: null
};

// SAVES THE ENTIRE STATE TO BROWSER CACHE
function saveState() {
    if (isRestoring) return;
    
    const activeScreenId = Array.from(document.querySelectorAll('body > div'))
                               .find(screen => !screen.classList.contains('hidden'))?.id || 'class-select-screen';
    
    const state = {
        activeScreenId,
        screenHistory,
        navState,
        currentChapterTitle,
        timeRemaining,
        currentQuestions,
        currentQuestionIndex,
        userAnswers,
        skippedQuestions: Array.from(skippedQuestions),
        firstName: document.getElementById('first-name') ? document.getElementById('first-name').value : "",
        lastName: document.getElementById('last-name') ? document.getElementById('last-name').value : "",
        email: document.getElementById('email-address') ? document.getElementById('email-address').value : ""
    };
    sessionStorage.setItem('quizAppSession', JSON.stringify(state));
}

// RESTORES THE ENTIRE STATE FROM BROWSER CACHE ON LOAD
function restoreState() {
    const saved = sessionStorage.getItem('quizAppSession');
    if (!saved) return;

    isRestoring = true;
    const state = JSON.parse(saved);

    screenHistory = state.screenHistory || [];
    navState = state.navState || {};
    currentChapterTitle = state.currentChapterTitle || "General Quiz";
    timeRemaining = state.timeRemaining;
    currentQuestions = state.currentQuestions || [];
    currentQuestionIndex = state.currentQuestionIndex || 0;
    userAnswers = state.userAnswers || {};
    skippedQuestions = new Set(state.skippedQuestions || []);

    if (state.firstName) document.getElementById('first-name').value = state.firstName;
    if (state.lastName) document.getElementById('last-name').value = state.lastName;
    if (state.email) document.getElementById('email-address').value = state.email;

    // Destructure navState to safely rebuild dynamic elements
    const { classSelection, subjectSelection, unitSelection, chapterSelection } = navState;

    if (classSelection) {
        if (['IX', 'X'].includes(classSelection)) {
            if (subjectSelection) selectSubject(subjectSelection);
        } else {
            loadNeetUnits(classSelection);
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
    
    // Ensure accurate navState post-rebuild
    navState = { classSelection, subjectSelection, unitSelection, chapterSelection };

    const activeScreenId = state.activeScreenId || 'class-select-screen';
    
    // If refreshed on result screen, just kick to home to prevent anomalies
    if (activeScreenId === 'result-screen') {
        goHome();
        isRestoring = false;
        return;
    }
    
    // Display the correct screen
    document.querySelectorAll('body > div').forEach(s => s.classList.add('hidden'));
    const targetScreen = document.getElementById(activeScreenId);
    if (targetScreen) targetScreen.classList.remove('hidden');

    // Resume logic if refreshed inside the quiz
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

window.addEventListener('DOMContentLoaded', async () => {
    try {
        const neetResponse = await fetch('/api/neet');
        if (neetResponse.ok) neetData = await neetResponse.json();

        const quizResponse = await fetch('/api/quizzes');
        if (quizResponse.ok) quizData = await quizResponse.json();
        
        // Restore State After Configuration is Fetched
        restoreState();
    } catch (error) {
        console.error("Error fetching configurations:", error);
    }
});

function showScreen(screenId) {
    const screens = document.querySelectorAll('body > div');
    const activeScreen = Array.from(screens).find(screen => !screen.classList.contains('hidden'));
    
    // Only push to history if we are NOT restoring from a refresh
    if (!isRestoring && activeScreen && activeScreen.id !== screenId) {
        screenHistory.push(activeScreen.id);
    }

    screens.forEach(screen => screen.classList.add('hidden'));
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) targetScreen.classList.remove('hidden');
    
    saveState();
}

function goBack() {
    if (screenHistory.length > 0) {
        const previousScreenId = screenHistory.pop();
        const screens = document.querySelectorAll('body > div');
        screens.forEach(screen => screen.classList.add('hidden'));
        
        const prevScreen = document.getElementById(previousScreenId);
        if (prevScreen) prevScreen.classList.remove('hidden');
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
    
    document.getElementById('first-name').value = '';
    document.getElementById('last-name').value = '';
    document.getElementById('email-address').value = '';

    const screens = document.querySelectorAll('body > div');
    screens.forEach(screen => screen.classList.add('hidden'));
    document.getElementById('class-select-screen').classList.remove('hidden');
    
    sessionStorage.removeItem('quizAppSession'); // Reset completely
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
        showScreen('xi-xii-unit-screen');
    }
}

function selectSubject(subjectName) {
    navState.subjectSelection = subjectName;
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const subjectObj = quizData.find(s => s.subject && s.subject.toLowerCase() === subjectName.toLowerCase());
    const chapters = subjectObj ? subjectObj.chapters : [];

    if (chapters.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No chapters found for ${subjectName}</p>`;
        showScreen('ix-x-chapter-screen');
        return;
    }

    chapters.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = ch.title;
        card.onclick = async () => {
            currentChapterTitle = ch.title;
            timeRemaining = getDefaultTimeFromHTML(); 
            currentQuestions = await fetchQuestionsFile(ch.id);
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('ix-x-chapter-screen');
}

function loadNeetUnits(className) {
    const container = document.getElementById('xi-xii-unit-container');
    if (!container) return;
    container.innerHTML = '';
    
    const targetClassObj = neetData.find(c => c.name && c.name.toLowerCase().includes(className.toLowerCase()));
    if (!targetClassObj || !targetClassObj.units) return;

    targetClassObj.units.forEach(unit => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = unit.name;
        card.onclick = () => loadNeetChapters(targetClassObj, unit.name);
        container.appendChild(card);
    });
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
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No topics available for this chapter.</p>`;
    }

    validTopics.forEach(topic => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = topic.name;
        card.onclick = async () => {
            currentChapterTitle = `${chapter.name} - ${topic.name}`;
            timeRemaining = getDefaultTimeFromHTML(); 
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
        const response = await fetch(`/api/quiz/${fileId}`);
        if (response.ok) return await response.json();
        console.error(`Question file missing for ID: ${fileId}`);
        return [];
    } catch (error) {
        console.error(`Error loading API for ${fileId}:`, error);
        return [];
    }
}

function startTimer() {
    clearInterval(timerInterval);
    const timeDisplay = document.getElementById('time-left');
    
    const updateDisplay = () => {
        const initMin = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
        const initSec = (timeRemaining % 60).toString().padStart(2, '0');
        timeDisplay.innerText = `${initMin}:${initSec}`;
    };
    
    updateDisplay();

    timerInterval = setInterval(() => {
        if (timeRemaining <= 0) {
            clearInterval(timerInterval);
            submitQuiz();
            return;
        }
        timeRemaining--;
        updateDisplay();
        saveState(); // Continually save timer state
    }, 1000);
}

function startQuiz() {
    const firstName = document.getElementById('first-name').value.trim();
    if (!firstName) {
        alert('Please enter your first name.');
        return;
    }
    
    // Check if we are resuming an active quiz or starting a fresh one
    if (currentQuestionIndex === 0 && Object.keys(userAnswers).length === 0) {
        skippedQuestions = new Set();
    }
    
    showScreen('quiz-screen');
    startTimer();
    renderQuestion();
}

function renderQuestion() {
    if (currentQuestions.length === 0) {
        document.getElementById('question-box').innerText = "No questions available.";
        document.getElementById('options-container').innerHTML = '';
        return;
    }

    const q = currentQuestions[currentQuestionIndex];
    document.getElementById('question-box').innerText = `Q.${currentQuestionIndex + 1}: ${q.question}`;
    
    const optionsContainer = document.getElementById('options-container');
    optionsContainer.innerHTML = '';
    
    q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        if (userAnswers[currentQuestionIndex] === idx) {
            btn.classList.add('selected');
        }
        btn.innerText = opt;
        btn.onclick = () => selectOption(btn, idx);
        optionsContainer.appendChild(btn);
    });

    updateQuizStats();
}

function selectOption(button, optionIndex) {
    const buttons = document.querySelectorAll('#options-container .option-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
    button.classList.add('selected');
    
    userAnswers[currentQuestionIndex] = optionIndex;
    skippedQuestions.delete(currentQuestionIndex);
    
    updateQuizStats();
    saveState(); // Save answer
}

function clearResponse() {
    delete userAnswers[currentQuestionIndex];
    const buttons = document.querySelectorAll('#options-container .option-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
    
    updateQuizStats();
    saveState();
}

function nextQuestion() {
    if (userAnswers[currentQuestionIndex] === undefined) {
        skippedQuestions.add(currentQuestionIndex);
    }

    if (currentQuestionIndex < currentQuestions.length - 1) {
        currentQuestionIndex++;
        renderQuestion();
        saveState();
    }
}

function prevQuestion() {
    if (userAnswers[currentQuestionIndex] === undefined) {
        skippedQuestions.add(currentQuestionIndex);
    }

    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderQuestion();
        saveState();
    }
}

function updateQuizStats() {
    const attemptedCount = Object.keys(userAnswers).length;
    const skippedCount = skippedQuestions.size;
    const statsEl = document.getElementById('quiz-stats');
    if (statsEl) {
        statsEl.innerText = `Attempted: ${attemptedCount} / ${currentQuestions.length} | Skipped: ${skippedCount}`;
    }
}

async function submitQuiz() {
    clearInterval(timerInterval);
    
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.innerText = "Submitting...";
    submitBtn.disabled = true;

    const firstName = document.getElementById('first-name').value.trim();
    const lastName = document.getElementById('last-name').value.trim();
    const email = document.getElementById('email-address').value.trim();
    
    let correctCount = 0;
    let incorrectCount = 0;

    let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 16px;">` +
        `<tr style="background-color: #f1f5f9; text-align: left;">` +
        `<th style="width: 5%;">#</th>` +
        `<th style="width: 40%;">Question</th>` +
        `<th style="width: 25%;">Student's Selection</th>` +
        `<th style="width: 20%;">Correct Option</th>` +
        `<th style="width: 10%; text-align: center;">Status</th>` +
        `</tr>`;

    currentQuestions.forEach((q, index) => {
        const studentSelectionIndex = userAnswers[index];
        const isAttempted = studentSelectionIndex !== undefined;
        const isCorrect = isAttempted && studentSelectionIndex === q.answer;
        
        if (isCorrect) correctCount++;
        else if (isAttempted) incorrectCount++;

        const studentSelectionText = isAttempted ? q.options[studentSelectionIndex] : "Skipped";
        const correctOptionText = q.options[q.answer];
        const statusText = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");

        breakdownHtml += `<tr>` +
            `<td>${index + 1}</td>` +
            `<td>${q.question}</td>` +
            `<td>${studentSelectionText}</td>` +
            `<td>${correctOptionText}</td>` +
            `<td style="text-align: center;">` +
            `<span style="background-color: lightyellow; padding: 4px 8px; border-radius: 4px; font-weight: bold; border: 1px solid #eab308; color: #854d0e; display: inline-block;">` +
            `${statusText}` +
            `</span>` +
            `</td>` +
            `</tr>`;
    });

    breakdownHtml += `</table>`;

    const payload = {
        firstName: firstName,
        lastName: lastName,
        email: email,
        chapterTitle: currentChapterTitle,
        score: correctCount,
        total: currentQuestions.length,
        attempted: Object.keys(userAnswers).length,
        skipped: skippedQuestions.size,
        correct: correctCount,
        incorrect: incorrectCount,
        breakdown: breakdownHtml
    };

    try {
        if (GOOGLE_SCRIPT_URL && !GOOGLE_SCRIPT_URL.includes('PASTE_YOUR')) {
            await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload)
            });
        }
    } catch (error) {
        console.error("Failed sending to Google Apps Script:", error);
    }

    try {
        await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error("Failed saving to local server:", error);
    }

    submitBtn.innerText = "Submit Quiz";
    submitBtn.disabled = false;

    const resultContainer = document.getElementById('result-screen');
    resultContainer.innerHTML = `
        <button class="back-btn" onclick="goHome()">Back to Home</button>
        <h2 class="screen-heading">Quiz Results</h2>
        <div style="text-align: center; margin-top: 20px;">
            <p style="font-size: 18px; color: #333;">Candidate: <strong>${firstName} ${lastName}</strong></p>
            <h1 style="color: #4285f4; font-size: 48px; margin: 10px 0;">${correctCount} / ${currentQuestions.length}</h1>
            <p style="font-size: 16px; color: #64748b;">Response recorded and emailed successfully.</p>
        </div>
    `;
    
    showScreen('result-screen');
    
    // Erase the session storage so refreshing on the result screen doesn't break the flow
    sessionStorage.removeItem('quizAppSession');
}
