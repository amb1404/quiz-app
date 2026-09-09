let screenHistory = [];
let neetData = [];
let quizData = [];
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};

// Fallback data matching your exact array-based structures for both neet.json and quizzes.json
let fallbackNeetData = [
    {
        "name": "Class XI",
        "units": [
            {
                "name": "Diversity in the Living World",
                "chapters": [
                    {
                        "name": "Biological Classification",
                        "topics": [
                            { "id": "cb2", "name": "COMBINED", "duration": 3000 },
                            { "id": "prt", "name": "PROTISTA", "duration": 3000 },
                            { "id": "plant", "name": "PLANTAE", "duration": 3000 }
                        ]
                    }
                ]
            }
        ]
    },
    {
        "name": "Class XII",
        "units": [
            {
                "name": "Genetics and Evolution",
                "chapters": [
                    {
                        "name": "Molecular Basis of Inheritance",
                        "topics": [
                            { "id": "combined", "name": "COMBINED", "duration": 3000 }
                        ]
                    }
                ]
            }
        ]
    }
];

let fallbackQuizData = [
    {
        "subject": "Physics",
        "chapters": [
            { 
                "id": "machine", 
                "title": "Machines", 
                "duration": 900, 
                "questions": [{ question: "What is mechanical advantage?", options: ["Load/Effort", "Effort/Load", "Work/Time", "None"], answer: 0 }] 
            },
            { 
                "id": "energy", 
                "title": "Work Energy Power", 
                "duration": 950, 
                "questions": [{ question: "Work done is equal to:", options: ["F x s", "mgh", "1/2 mv^2", "All of these"], answer: 3 }] 
            },
            { 
                "id": "force", 
                "title": "Force", 
                "duration": 900, 
                "questions": [{ question: "Moment of force depends on:", options: ["Magnitude of force", "Perpendicular distance", "Both", "None"], answer: 2 }] 
            }
        ]
    },
    {
        "subject": "Chemistry",
        "chapters": [
            { 
                "id": "bonding", 
                "title": "Chemical Bonding", 
                "duration": 900, 
                "questions": [{ question: "Electrovalent bond is formed by:", options: ["Sharing of electrons", "Transfer of electrons", "Delocalized electrons", "None"], answer: 1 }] 
            },
            { 
                "id": "HCl", 
                "title": "HCl", 
                "duration": 900, 
                "questions": [{ question: "Hydrogen chloride gas is prepared in the lab by reacting sodium chloride with:", options: ["Conc. H2SO4", "Dil. HCl", "Conc. HNO3", "Water"], answer: 0 }] 
            },
            { 
                "id": "analytical", 
                "title": "Analytical", 
                "duration": 900, 
                "questions": [{ question: "Action of ammonium hydroxide on calcium salt gives:", options: ["White ppt", "No ppt", "Blue ppt", "Green ppt"], answer: 1 }] 
            }
        ]
    },
    {
        "subject": "Biology",
        "chapters": [
            { 
                "id": "nervous", 
                "title": "Nervous System", 
                "duration": 900, 
                "questions": [{ question: "The functional unit of the nervous system is:", options: ["Nephron", "Neuron", "Axon", "Dendrite"], answer: 1 }] 
            },
            { 
                "id": "genetics", 
                "title": "Genetics", 
                "duration": 900, 
                "questions": [{ question: "Who is known as the father of genetics?", options: ["Darwin", "Mendel", "Lamarck", "Watson"], answer: 1 }] 
            },
            { 
                "id": "excretory", 
                "title": "Excretory System", 
                "duration": 900, 
                "questions": [{ question: "The structural and functional unit of the kidney is:", options: ["Neuron", "Nephron", "Alveoli", "Ureter"], answer: 1 }] 
            },
            { 
                "id": "circulation", 
                "title": "Circulatory System", 
                "duration": 900, 
                "questions": [{ question: "Which blood vessel carries oxygenated blood?", options: ["Pulmonary artery", "Pulmonary vein", "Vena cava", "Right ventricle"], answer: 1 }] 
            }
        ]
    }
];

// Fetch configuration files automatically on initialization
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

function selectClass(className) {
    if (className === 'IX' || className === 'X') {
        showScreen('subject-select-screen');
    } else if (className === 'XI' || className === 'XII') {
        loadNeetUnits(className);
        showScreen('xi-xii-unit-screen');
    }
}

// Automatically pulls chapters for Class IX and X from the array-based quizzes.json structure
function selectSubject(subjectName) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';

    const sourceQuizData = Array.isArray(quizData) && quizData.length > 0 ? quizData : fallbackQuizData;
    const subjectObj = sourceQuizData.find(s => s.subject.toLowerCase() === subjectName.toLowerCase());
    const chapters = subjectObj ? subjectObj.chapters : [];

    if (chapters.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#64748b;">No chapters found in quizzes.json for ${subjectName}</p>`;
        showScreen('ix-x-chapter-screen');
        return;
    }

    chapters.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = ch.title;
        card.onclick = () => {
            currentQuestions = ch.questions || [
                { question: `Sample question for ${ch.title}`, options: ["Option A", "Option B", "Option C", "Option D"], answer: 0 }
            ];
            showScreen('name-screen');
        };
        container.appendChild(card);
    });

    showScreen('ix-x-chapter-screen');
}

// Automatically pulls units for Class XI and XII from neet.json
function loadNeetUnits(className) {
    const container = document.getElementById('xi-xii-unit-container');
    const sourceNeetData = Array.isArray(neetData) && neetData.length > 0 ? neetData : fallbackNeetData;
    if (!container) return;
    container.innerHTML = '';
    
    const targetClassObj = sourceNeetData.find(c => c.name.toLowerCase().includes(className.toLowerCase()));
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
        card.onclick = () => {
            // Check if questions are stored in quizData dictionary or fallback
            currentQuestions = (quizData && quizData[topic.name]) || (quizData && quizData[topic.id]) || [
                { question: `Sample question for topic: ${topic.name}`, options: ["Option A", "Option B", "Option C", "Option D"], answer: 0 }
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
