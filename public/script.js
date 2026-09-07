let questions = [];
let currentIndex = 0;
let userAnswers = [];
let timerInterval = null;
let timeLeft = 0;
let currentQuizId = null;
let skippedIndices = new Set();
let pendingQuizId = null;
let pendingDuration = 0;
let studentFirstName = "";
let studentLastName = "";

// ... keep existing DOMContentLoaded, renderSubjects, backToSubjects functions ...

function showChapters(subject) {
    document.getElementById('subject-menu').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
    document.getElementById('selected-subject-title').innerText = subject.subject || subject.name;

    const list = document.getElementById('chapter-list');
    list.innerHTML = '';

    subject.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h4>${chap.title || chap.name}</h4>`;
        // Instead of loading quiz directly, prompt for name first
        card.onclick = () => promptForName(chap.id, chap.duration);
        list.appendChild(card);
    });
}

function promptForName(quizId, duration) {
    pendingQuizId = quizId;
    pendingDuration = duration;
    
    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('name-screen').classList.remove('hidden');
}

function backToChapters() {
    document.getElementById('name-screen').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
}

function startQuizFromDetails() {
    const fNameInput = document.getElementById('first-name').value.trim();
    const lNameInput = document.getElementById('last-name').value.trim();

    if (!fNameInput || !lNameInput) {
        alert("Please enter both your first and last name.");
        return;
    }

    studentFirstName = fNameInput;
    studentLastName = lNameInput;

    document.getElementById('name-screen').classList.add('hidden');
    loadQuiz(pendingQuizId, pendingDuration);
}

function loadQuiz(quizId, duration) {
    currentQuizId = quizId;
    timeLeft = duration || 300;
    skippedIndices.clear();
    document.getElementById('counter-stats').innerText = 'Attempted: 0 | Skipped: 0';

    fetch(`/api/quiz/${quizId}`)
        .then(res => res.json())
        .then(data => {
            questions = data;
            userAnswers = new Array(questions.length).fill(null);
            currentIndex = 0;

            document.getElementById('quiz-screen').classList.remove('hidden');
            startQuiz();
        })
        .catch(err => console.error('Error loading questions:', err));
}

// ... keep updateTimerDisplay, startTimer logic as configured previously ...

function submitQuiz() {
    clearInterval(timerInterval);

    let score = 0;
    let attempted = 0;

    questions.forEach((q, idx) => {
        if (userAnswers[idx] !== null && userAnswers[idx] !== undefined) {
            attempted++;
            if (userAnswers[idx] === getCorrectIndex(q)) {
                score++;
            }
        }
    });

    let incorrect = attempted - score;
    let skipped = questions.length - attempted;

    const payload = {
        firstName: studentFirstName,
        lastName: studentLastName,
        quizId: currentQuizId,
        score: score,
        total: questions.length,
        answers: userAnswers
    };

    fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(err => console.error('Error submitting answers:', err));

    document.getElementById('quiz-screen').classList.add('hidden');
    document.getElementById('result-screen').classList.remove('hidden');
    document.getElementById('final-score').innerText = `Score: ${score} / ${questions.length}`;
    document.getElementById('final-breakdown').innerText = `Student: ${studentFirstName} ${studentLastName} | Attempted: ${attempted} | Skipped: ${skipped} | Correct: ${score} | Incorrect: ${incorrect}`;
}
