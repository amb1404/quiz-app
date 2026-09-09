let screenHistory = [];
let neetData = [];
let quizData = [];
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};

// Fetch navigation configuration files on initialization
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const neetResponse = await fetch('neet.json');
        if (neetResponse.ok) {
            neetData = await neetResponse.json();
        }

        const quizResponse = await fetch('quizzes.json');
        if (quizResponse.ok) {
            quizData = await quizResponse.json();
        }
    } catch (error) {
        console.error("Error fetching main configuration files. Make sure you are running via a local server.", error);
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

// Handles Class IX & X chapter selection and dynamically loads questions from [id]-questions.json
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
            // Dynamically fetches individual question file based on chapter ID (e.g., machine-questions.json)
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

// Handles Class XI & XII topic selection and dynamically loads questions from [id]-questions.json
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
            // Dynamically fetches individual question file using the ID with '-questions.json' suffix (e.g., cb2-questions.json)
            currentQuestions = await fetchQuestionsFile(topic.id);
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('xi-xii-topic-screen');
}

// Helper function to fetch an individual question JSON file asynchronously using the -questions.json pattern
async function fetchQuestionsFile(fileId) {
    if (!fileId) {
        console.warn("No ID provided for this item.");
        return [];
    }
    try {
        const response = await fetch(`${fileId}-questions.json`);
        if (response.ok) {
            return await response.json();
        } else {
            console.error(`Could not find file: ${fileId}-questions.json`);
            return [];
        }
    } catch (error) {
        console.error(`Error loading ${fileId}-questions.json:`, error);
        return [];
    }
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
        btn.innerText = `Option-${idx + 1}: ${opt}`;
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

function submitQuiz() {
    showScreen('result-screen');
}
