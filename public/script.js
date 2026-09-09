let screenHistory = [];
let neetData = {};
let quizData = {};
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};

// Fallback data structures in case JSON files are loading locally via file:// protocol
let fallbackNeetData = {
    "XI": {
        "units": [
            {
                "name": "Diversity in the Living World",
                "chapters": [
                    {
                        "name": "Biological Classification",
                        "topics": ["Protista", "Plantae", "Animalia"]
                    }
                ]
            }
        ]
    },
    "XII": {
        "units": [
            {
                "name": "Reproduction",
                "chapters": [
                    {
                        "name": "Sexual Reproduction in Flowering Plants",
                        "topics": ["Pre-fertilization", "Fertilization"]
                    }
                ]
            }
        ]
    }
};

let fallbackQuizData = {
    "Physics": [
        { name: "Chapter-1: Motion", questions: [{ question: "What is acceleration?", options: ["Rate of change of velocity", "Distance/Time", "Speed x Time", "Force x Mass"], answer: 0 }] }
    ],
    "Chemistry": [
        { name: "Chapter-1: Atomic Structure", questions: [{ question: "Who discovered the electron?", options: ["J.J. Thomson", "Rutherford", "Bohr", "Chadwick"], answer: 0 }] }
    ],
    "Biology": [
        { name: "Chapter-1: Cell", questions: [{ question: "Who coined the term cell?", options: ["Robert Hooke", "Leeuwenhoek", "Schwann", "Virchow"], answer: 0 }] }
    ],
    "Protista": [
        { question: "Which organisms are primary producers in oceans?", options: ["Diatoms", "Fungi", "Viruses", "Bacteria"], answer: 0 }
    ]
};

// Fetch configuration files on initialization
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const neetResponse = await fetch('neet.json');
        if (neetResponse.ok) {
            neetData = await neetResponse.json();
        } else {
            neetData = fallbackNeetData;
        }

        const quizResponse = await fetch('quizzes.json');
        if (quizResponse.ok) {
            quizData = await quizResponse.json();
        } else {
            quizData = fallbackQuizData;
        }
    } catch (error) {
        console.log("Using fallback configurations due to local file restrictions.");
        neetData = fallbackNeetData;
        quizData = fallbackQuizData;
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

// Class selection handler[cite: 1]
function selectClass(className) {
    if (className === 'IX' || className === 'X') {
        showScreen('subject-select-screen');
    } else if (className === 'XI' || className === 'XII') {
        loadNeetUnits(className);
        showScreen('xi-xii-unit-screen');
    }
}

// Controlled entirely by quizzes.json for Class IX & X chapters
function selectSubject(subjectName) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const chapters = quizData[subjectName] || [];

    if (chapters.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No chapters found in quizzes.json for ${subjectName}</p>`;
    }

    chapters.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = ch.name;
        card.onclick = () => {
            currentQuestions = ch.questions || [];
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('ix-x-chapter-screen');
}

// Controlled entirely by neet.json for Class XI & XII units
function loadNeetUnits(className) {
    const container = document.getElementById('xi-xii-unit-container');
    const sourceData = neetData[className] || fallbackNeetData[className];
    if (!container || !sourceData) return;
    container.innerHTML = '';
    
    sourceData.units.forEach(unit => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = unit.name;
        card.onclick = () => loadNeetChapters(className, unit.name);
        container.appendChild(card);
    });
}

// Controlled entirely by neet.json for Class XI & XII chapters
function loadNeetChapters(className, unitName) {
    const sourceData = neetData[className] || fallbackNeetData[className];
    if (!sourceData) return;
    const unit = sourceData.units.find(u => u.name === unitName);
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

// Controlled entirely by neet.json for Class XI & XII topics
function loadNeetTopics(chapter) {
    const container = document.getElementById('xi-xii-topic-container');
    if (!container) return;
    container.innerHTML = '';

    chapter.topics.forEach(topic => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = topic;
        card.onclick = () => {
            // Questions mapped from quizzes.json based on the topic name
            currentQuestions = quizData[topic] || [
                { question: `Sample question for topic: ${topic}`, options: ["Option A", "Option B", "Option C", "Option D"], answer: 0 }
            ];
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('xi-xii-topic-screen');
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
        document.getElementById('question-box').innerText = "No questions available for this selection.";
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
