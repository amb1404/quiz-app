let screenHistory = [];

// Fallback data structure so everything renders instantly even without external JSON files
let neetData = {
    "XI": {
        "units": [
            {
                "name": "Diversity in the Living World",
                "chapters": [
                    {
                        "name": "Biological Classification",
                        "topics": ["Protista", "Plantae", "Animalia", "Fungi", "Combined"]
                    }
                ]
            },
            {
                "name": "Structural Organisation in Plants and Animals",
                "chapters": [
                    {
                        "name": "Morphology of Flowering Plants",
                        "topics": ["Root", "Stem", "Leaf", "Inflorescence"]
                    }
                ]
            },
            {
                "name": "Cell: Structure and Function",
                "chapters": [
                    {
                        "name": "Cell The Unit of Life",
                        "topics": ["Prokaryotic", "Eukaryotic", "Organelles"]
                    }
                ]
            },
            {
                "name": "Plant Physiology",
                "chapters": [
                    {
                        "name": "Photosynthesis",
                        "topics": ["Light Reaction", "Dark Reaction", "C4 Pathway"]
                    }
                ]
            },
            {
                "name": "Human Physiology",
                "chapters": [
                    {
                        "name": "Digestion and Absorption",
                        "topics": ["Alimentary Canal", "Digestive Glands", "Disorders"]
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
                        "topics": ["Pre-fertilization", "Fertilization", "Post-fertilization"]
                    }
                ]
            },
            {
                "name": "Genetics and Evolution",
                "chapters": [
                    {
                        "name": "Principles of Inheritance and Variation",
                        "topics": ["Mendel's Laws", "Linkage", "Disorders"]
                    }
                ]
            },
            {
                "name": "Biology in Human Welfare",
                "chapters": [
                    {
                        "name": "Human Health and Disease",
                        "topics": ["Pathogens", "Immunity", "AIDS and Cancer"]
                    }
                ]
            },
            {
                "name": "Biotechnology",
                "chapters": [
                    {
                        "name": "Biotechnology Principles and Processes",
                        "topics": ["Recombinant DNA", "Processes of rDNA"]
                    }
                ]
            },
            {
                "name": "Ecology",
                "chapters": [
                    {
                        "name": "Organisms and Populations",
                        "topics": ["Population Attributes", "Interactions"]
                    }
                ]
            }
        ]
    }
};

let quizData = {
    "Protista": [
        { question: "Which of the following organisms are known as chief producers in the oceans?", options: ["Dinoflagellates", "Diatoms", "Euglenoids", "Slime moulds"], answer: 1 },
        { question: "Chrysophytes include:", options: ["Diatoms and golden algae", "Desmids and diatoms", "Both 1 and 2", "Slime moulds and protozoans"], answer: 2 }
    ],
    "Plantae": [
        { question: "The algal components of lichen is known as:", options: ["Phycobiont", "Mycobiont", "Bacteriobiont", "Symbiont"], answer: 0 }
    ],
    "Physics": [
        { name: "Chapter-1", questions: [{ question: "What is the SI unit of force?", options: ["Joule", "Newton", "Pascal", "Watt"], answer: 1 }] },
        { name: "Chapter-2", questions: [{ question: "Work done is equal to:", options: ["F x s", "m x g x h", "1/2 mv^2", "None of these"], answer: 0 }] }
    ]
};

// Attempt to load external files if hosted via a server, otherwise fallback data takes over
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
        console.log("Using built-in fallback configurations (Running locally).");
    }
});

let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};

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

// Handles class selection workflow[cite: 1]
function selectClass(className) {
    if (className === 'IX' || className === 'X') {
        showScreen('subject-select-screen');
    } else if (className === 'XI' || className === 'XII') {
        loadNeetUnits(className);
        showScreen('xi-xii-unit-screen');
    }
}

function loadNeetUnits(className) {
    const container = document.getElementById('xi-xii-unit-container');
    if (!container || !neetData[className]) return;
    container.innerHTML = '';
    
    neetData[className].units.forEach(unit => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = unit.name;
        card.onclick = () => loadNeetChapters(className, unit.name);
        container.appendChild(card);
    });
}

function loadNeetChapters(className, unitName) {
    const classObj = neetData[className];
    if (!classObj) return;
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
    const container = document.getElementById('xi-xii-topic-container');
    if (!container) return;
    container.innerHTML = '';

    chapter.topics.forEach(topic => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = topic;
        card.onclick = () => {
            currentQuestions = quizData[topic] || [
                { question: `Sample question for ${topic}`, options: ["Option A", "Option B", "Option C", "Option D"], answer: 0 }
            ];
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('xi-xii-topic-screen');
}

// Handler for Class IX and X chapter selections[cite: 1]
function selectSubject(subjectName) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const chapters = quizData[subjectName] || [
        { name: "Chapter-1", questions: [{ question: "Sample IX/X Question 1", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4"], answer: 0 }] },
        { name: "Chapter-2", questions: [{ question: "Sample IX/X Question 2", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4"], answer: 0 }] },
        { name: "Chapter-3", questions: [{ question: "Sample IX/X Question 3", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4"], answer: 0 }] },
        { name: "Chapter-4", questions: [{ question: "Sample IX/X Question 4", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4"], answer: 0 }] },
        { name: "Chapter-5", questions: [{ question: "Sample IX/X Question 5", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4"], answer: 0 }] }
    ];

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
