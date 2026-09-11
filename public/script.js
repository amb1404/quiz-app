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

function saveState() {
    if (isRestoring) return;
    const activeScreenId = Array.from(document.querySelectorAll('body > div'))
                               .find(screen => !screen.classList.contains('hidden'))?.id || 'class-select-screen';
    
    const state = {
        activeScreenId, screenHistory, navState, currentChapterTitle, activeQuizTitle, timeRemaining,
        currentQuestions, currentQuestionIndex, userAnswers,
        skippedQuestions: Array.from(skippedQuestions),
        firstName: document.getElementById('first-name') ? document.getElementById('first-name').value : "",
        lastName: document.getElementById('last-name') ? document.getElementById('last-name').value : "",
        email: document.getElementById('email-address') ? document.getElementById('email-address').value : ""
    };
    sessionStorage.setItem('quizAppSession', JSON.stringify(state));
}

function restoreState() {
    const saved = sessionStorage.getItem('quizAppSession');
    if (!saved) return;
    isRestoring = true;
    const state = JSON.parse(saved);

    screenHistory = state.screenHistory || [];
    navState = state.navState || {};
    currentChapterTitle = state.currentChapterTitle || "General Quiz";
    activeQuizTitle = state.activeQuizTitle || "Quiz Active";
    timeRemaining = state.timeRemaining;
    currentQuestions = state.currentQuestions || [];
    currentQuestionIndex = state.currentQuestionIndex || 0;
    userAnswers = state.userAnswers || {};
    skippedQuestions = new Set(state.skippedQuestions || []);

    if (state.firstName) document.getElementById('first-name').value = state.firstName;
    if (state.lastName) document.getElementById('last-name').value = state.lastName;
    if (state.email) document.getElementById('email-address').value = state.email;

    const { classSelection, subjectSelection, unitSelection, chapterSelection } = navState;

    if (classSelection) {
        if (['IX', 'X'].includes(classSelection)) {
            if (subjectSelection) selectSubject(subjectSelection);
        } else if (['WB XI', 'WB XII'].includes(classSelection)) {
            loadWbChapters(classSelection);
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

window.addEventListener('DOMContentLoaded', async () => {
    try {
        const neetResponse = await fetch('/api/neet');
        if (neetResponse.ok) neetData = await neetResponse.json();
        
        const quizResponse = await fetch('/api/quizzes');
        if (quizResponse.ok) quizData = await quizResponse.json();

        const wbResponse = await fetch('/api/wb');
        if (wbResponse.ok) wbData = await wbResponse.json();

        restoreState();
    } catch (error) {
        console.error("Error fetching configurations:", error);
    }
});

function showScreen(screenId) {
    const screens = document.querySelectorAll('body > div');
    const activeScreen = Array.from(screens).find(screen => !screen.classList.contains('hidden'));
    
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
        showScreen('xi-xii-unit-screen');
    } else if (className === 'WB XI' || className === 'WB XII') {
        loadWbChapters(className);
    }
}

function loadWbChapters(className) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const classObj = wbData.find(c => c.className === className);
    const chapters = classObj ? classObj.chapters : [];

    if (chapters.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No chapters found.</p>`;
        showScreen('ix-x-chapter-screen');
        return;
    }

    chapters.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = ch.title;
        card.onclick = async () => {
            currentChapterTitle = `${className} - ${ch.title}`;
            activeQuizTitle = ch.title; 
            timeRemaining = ch.duration || getDefaultTimeFromHTML(); 
            currentQuestions = await fetchQuestionsFile(ch.id);
            showScreen('name-screen');
        };
        container.appendChild(card);
    });
    showScreen('ix-x-chapter-screen');
}

function selectSubject(subjectName) {
    navState.subjectSelection = subjectName;
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const subjectObj = quizData.find(s => s.subject && s.subject.toLowerCase() === subjectName.toLowerCase());
    const chapters = subjectObj ? subjectObj.chapters : [];

    if (chapters.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No chapters found.</p>`;
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
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No topics available.</p>`;
    }

    validTopics.forEach(topic => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = topic.name;
        card.onclick = async () => {
            currentChapterTitle = `${chapter.name} - ${topic.name}`;
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
        const response = await fetch(`/api/quiz/${fileId}`);
        if (response.ok) return await response.json();
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
        saveState();
    }, 1000);
}

function startQuiz() {
    const firstName = document.getElementById('first-name').value.trim();
    if (!firstName) {
        alert('Please enter your first name.');
        return;
    }
    
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

    const headingEl = document.getElementById('quiz-screen-heading');
    if (headingEl) {
        headingEl.innerText = activeQuizTitle;
    }

    const q = currentQuestions[currentQuestionIndex];
    document.getElementById('question-box').innerText = `Q.${currentQuestionIndex + 1}: ${q.question}`;
    
    const optionsContainer = document.getElementById('options-container');
    optionsContainer.innerHTML = '';
    
    const opts = q.options || [];
    opts.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        if (userAnswers[currentQuestionIndex] === idx) {
            btn.classList.add('selected');
        }
        btn.innerText = opt;
        btn.onclick = () => selectOption(btn, idx);
        optionsContainer.appendChild(btn);
    });

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
        statsEl.innerText = `Attempted: ${attemptedCount} / ${currentQuestions.length} | Skipped: ${skippedCount}`;
    }
}

async function submitQuiz() {
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
            chapterTitle: currentChapterTitle,
            quizId: currentQuizId,
            userAnswers: userAnswers 
        };

        const response = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resultData = await response.json();

        const resultContainer = document.getElementById('result-screen');
        if (resultContainer && resultData.success) {
            resultContainer.innerHTML = `
                <button class="back-btn" onclick="goHome()">Back to Home</button>
                <h2 class="screen-heading">Quiz Results</h2>
                <div style="text-align: center; margin-top: 20px;">
                    <p style="font-size: 18px; color: #333;">Candidate: <strong>${firstName} ${lastName}</strong></p>
                    <h1 style="color: #4285f4; font-size: 48px; margin: 10px 0;">${resultData.score} / ${resultData.total}</h1>
                    <p style="font-size: 16px; color: #64748b;">Response recorded and mailed to the administrator successfully.</p>
                </div>
            `;
            showScreen('result-screen');
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

// Basic UI Protection: Deter casual copying and inspecting
document.addEventListener('contextmenu', event => event.preventDefault());

document.addEventListener('keydown', event => {
    if (
        event.key === 'F12' ||
        (event.ctrlKey && event.shiftKey && (event.key === 'I' || event.key === 'J')) ||
        (event.ctrlKey && (event.key === 'U' || event.key === 'C'))
    ) {
        event.preventDefault();
    }
});

document.addEventListener('copy', event => event.preventDefault());
