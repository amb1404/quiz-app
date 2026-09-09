let screenHistory = [];
let neetData = [];
let quizData = [];
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};
let timerInterval;
let timeRemaining = 900; // Default 15 minutes (900 seconds)

// Fetch configuration files using the backend API
window.addEventListener('DOMContentLoaded', async () => {
    try {
        // Fetched from your updated server.js API for NEET data
        const neetResponse = await fetch('/api/neet');
        if (neetResponse.ok) {
            neetData = await neetResponse.json();
        }

        // Fetched from your updated server.js API for Quizzes data
        const quizResponse = await fetch('/api/quizzes');
        if (quizResponse.ok) {
            quizData = await quizResponse.json();
        }
    } catch (error) {
        console.error("Error fetching configurations from server:", error);
    }
});

function showScreen(screenId) {
    const screens = document.querySelectorAll('body > div');
    const activeScreen = Array.from(screens).find(screen => !screen.classList.contains('hidden'));
    if (activeScreen && activeScreen.id !== screenId) {
        screenHistory.push(activeScreen.id);
    }

    screens.forEach(screen => screen.classList.add('hidden'));
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
    }
}

function goBack() {
    if (screenHistory.length > 0) {
        const previousScreenId = screenHistory.pop();
        const screens = document.querySelectorAll('body > div');
        screens.forEach(screen => screen.classList.add('hidden'));
        
        const prevScreen = document.getElementById(previousScreenId);
        if (prevScreen) {
            prevScreen.classList.remove('hidden');
        }
    } else {
        goHome();
    }
}

function goHome() {
    screenHistory = [];
    const screens = document.querySelectorAll('body > div');
    screens.forEach(screen => screen.classList.add('hidden'));
    document.getElementById('class-select-screen').classList.remove('hidden');
}

function selectClass(className) {
    if (className === 'IX' || className === 'X') {
        showScreen('subject-select-screen');
    } else if (className === 'XI' || className === 'XII') {
        loadNeetUnits(className);
        showScreen('xi-xii-unit-screen');
    }
}

// Loads chapters for IX & X from quizzes.json
function selectSubject(subjectName) {
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
            timeRemaining = ch.duration || 900;
            currentQuestions = await fetchQuestionsFile(ch.id);
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('ix-x-chapter-screen');
}

// Loads Units for XI & XII from neet.json
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

// Loads Chapters inside a selected Unit for XI & XII
function loadNeetChapters(classObj, unitName) {
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

// Loads Topics inside a selected Chapter for XI & XII
function loadNeetTopics(chapter) {
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
            timeRemaining = topic.duration || 900;
            currentQuestions = await fetchQuestionsFile(topic.id);
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('xi-xii-topic-screen');
}

// Calls your backend server.js via API to fetch the specific questions file dynamically
async function fetchQuestionsFile(fileId) {
    if (!fileId) return [];
    try {
        const response = await fetch(`/api/quiz/${fileId}`);
        if (response.ok) {
            return await response.json();
        } else {
            console.error(`Could not find quiz for ID: ${fileId} in backend.`);
            return [];
        }
    } catch (error) {
        console.error(`Error loading API for ${fileId}:`, error);
        return [];
    }
}

// Timer Logic
function startTimer() {
    clearInterval(timerInterval);
    const timeDisplay = document.getElementById('time-left');
    
    timerInterval = setInterval(() => {
        if (timeRemaining <= 0) {
            clearInterval(timerInterval);
            submitQuiz(); // Auto-submit when time runs out
            return;
        }
        timeRemaining--;
        const minutes = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
        const seconds = (timeRemaining % 60).toString().padStart(2, '0');
        timeDisplay.innerText = `${minutes}:${seconds}`;
    }, 1000);
}

function startQuiz() {
    const firstName = document.getElementById('first-name').value.trim();
    if (!firstName) {
        alert('Please enter your first name to start the quiz.');
        return;
    }
    currentQuestionIndex = 0;
    userAnswers = {};
    showScreen('quiz-screen');
    startTimer();
    renderQuestion();
}

function renderQuestion() {
    if (currentQuestions.length === 0) {
        document.getElementById('question-box').innerText = "No questions available for this file or selection.";
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
    updateQuizStats();
}

function clearResponse() {
    delete userAnswers[currentQuestionIndex];
    const buttons = document.querySelectorAll('#options-container .option-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
    updateQuizStats();
}

function nextQuestion() {
    if (currentQuestionIndex < currentQuestions.length - 1) {
        currentQuestionIndex++;
        renderQuestion();
    }
}

function prevQuestion() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderQuestion();
    }
}

function updateQuizStats() {
    const attemptedCount = Object.keys(userAnswers).length;
    const skippedCount = currentQuestions.length - attemptedCount;
    const statsEl = document.getElementById('quiz-stats');
    if (statsEl) {
        statsEl.innerText = `Attempted: ${attemptedCount} / ${currentQuestions.length} | Skipped: ${skippedCount}`;
    }
}

// Submits the result payload to the backend server.js
async function submitQuiz() {
    clearInterval(timerInterval);
    
    const firstName = document.getElementById('first-name').value.trim();
    const lastName = document.getElementById('last-name').value.trim();
    const email = document.getElementById('email-address').value.trim();
    
    // Calculate Score
    let correctCount = 0;
    currentQuestions.forEach((q, index) => {
        if (userAnswers[index] === q.answer) {
            correctCount++;
        }
    });

    const payload = {
        firstName,
        lastName,
        email,
        score: correctCount,
        totalQuestions: currentQuestions.length,
        answers: userAnswers
    };

    try {
        const response = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        console.log(result.message);
    } catch (error) {
        console.error("Failed to submit results:", error);
    }

    // Display Result Screen
    const resultContainer = document.getElementById('result-screen');
    resultContainer.innerHTML = `
        <button class="back-btn" onclick="goHome()">Back to Home</button>
        <h2 class="screen-heading">Quiz Results</h2>
        <div style="text-align: center; margin-top: 20px;">
            <p style="font-size: 18px; color: #333;">Candidate: <strong>${firstName} ${lastName}</strong></p>
            <h1 style="color: #4285f4; font-size: 48px; margin: 10px 0;">${correctCount} / ${currentQuestions.length}</h1>
            <p style="font-size: 16px; color: #64748b;">Response successfully recorded on server.</p>
        </div>
    `;
    
    showScreen('result-screen');
}
