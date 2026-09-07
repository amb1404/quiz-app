let questions = [];
let currentIndex = 0;
let userAnswers = [];
let timerInterval = null;
let timeLeft = 0;
let isPaused = false;
let currentQuizId = null;
let skippedSet = new Set();

// Fetch subjects and build main menu
document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/quizzes')
        .then(res => res.json())
        .then(data => {
            renderSubjects(data.subjects);
        })
        .catch(err => console.error('Error fetching quiz list:', err));
});

function renderSubjects(subjects) {
    const list = document.getElementById('subject-list');
    list.innerHTML = '';

    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h3>${sub.name}</h3><p>${sub.description || ''}</p>`;
        card.onclick = () => showChapters(sub);
        list.appendChild(card);
    });
}

function showChapters(subject) {
    document.getElementById('subject-menu').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
    document.getElementById('selected-subject-title').innerText = subject.name;

    const list = document.getElementById('chapter-list');
    list.innerHTML = '';

    subject.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h4>${chap.name}</h4><p>Duration: ${chap.duration / 60} mins</p>`;
        card.onclick = () => loadQuiz(chap.id, chap.duration);
        list.appendChild(card);
    });
}

function backToSubjects() {
    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}

function loadQuiz(quizId, duration) {
    currentQuizId = quizId;
    timeLeft = duration || 300;
    isPaused = false;
    
    // Explicitly reset the set and counter UI on quiz entry
    skippedSet = new Set();
    const statsEl = document.getElementById('counter-stats');
    if (statsEl) {
        statsEl.innerText = 'Attempted: 0 | Skipped: 0';
    }

    document.getElementById('pause-overlay').classList.add('hidden');
    document.getElementById('pause-btn').innerText = 'Pause';

    fetch(`/api/quiz/${quizId}`)
        .then(res => res.json())
        .then(data => {
            questions = data;
            userAnswers = new Array(questions.length).fill(null);
            currentIndex = 0;

            document.getElementById('chapter-menu').classList.add('hidden');
            document.getElementById('quiz-screen').classList.remove('hidden');
            startQuiz();
        })
        .catch(err => console.error('Error loading questions:', err));
}

function startQuiz() {
    startTimer();
    showQuestion();
}

function startTimer() {
    clearInterval(timerInterval);
    updateTimerDisplay();

    timerInterval = setInterval(() => {
        if (!isPaused) {
            timeLeft--;
            updateTimerDisplay();

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                submitQuiz();
            }
        }
    }, 1000);
}

function updateTimerDisplay() {
    let minutes = Math.floor(timeLeft / 60);
    let seconds = timeLeft % 60;
    let formatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    document.getElementById('timer-display').innerText = `Time Left: ${formatted}`;
}

function togglePause() {
    isPaused = !isPaused;
    const overlay = document.getElementById('pause-overlay');
    const pauseBtn = document.getElementById('pause-btn');

    if (isPaused) {
        overlay.classList.remove('hidden');
        pauseBtn.innerText = 'Resume';
    } else {
        overlay.classList.add('hidden');
        pauseBtn.innerText = 'Pause';
    }
}

function updateStats() {
    let attempted = userAnswers.filter(ans => ans !== null).length;
    let skipped = skippedSet.size;
    const statsEl = document.getElementById('counter-stats');
    if (statsEl) {
        statsEl.innerText = `Attempted: ${attempted} | Skipped: ${skipped}`;
    }
}

function showQuestion() {
    if (isPaused) return;
    updateStats();

    document.getElementById('prev-btn').style.display = currentIndex === 0 ? 'none' : 'block';

    if (currentIndex === questions.length - 1) {
        document.getElementById('next-btn').style.display = 'none';
    } else {
        document.getElementById('next-btn').style.display = 'block';
    }

    let q = questions[currentIndex];
    document.getElementById('question-box').innerText = `Q${currentIndex + 1}: ${q.question}`;

    let optionsBox = document.getElementById('options-box');
    optionsBox.innerHTML = '';

    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    q.options.forEach((opt, idx) => {
        let btn = document.createElement('button');
        let prefix = letters[idx] ? `${letters[idx]}. ` : '';
        btn.innerText = prefix + opt;
        btn.className = 'option-btn';
        if (userAnswers[currentIndex] === idx) {
            btn.classList.add('selected');
        }
        btn.onclick = () => selectAnswer(idx);
        optionsBox.appendChild(btn);
    });
}

function selectAnswer(idx) {
    if (isPaused) return;
    userAnswers[currentIndex] = idx;
    skippedSet.delete(currentIndex);
    showQuestion();
}

function prevQuestion() {
    if (isPaused) return;
    if (currentIndex > 0) {
        currentIndex--;
        showQuestion();
    }
}

function nextQuestion() {
    if (isPaused) return;

    // Only add to skipped if moving forward without selecting an answer
    if (userAnswers[currentIndex] === null) {
        skippedSet.add(currentIndex);
    }

    if (currentIndex < questions.length - 1) {
        currentIndex++;
        showQuestion();
    }
}

function skipQuestion() {
    if (isPaused) return;

    if (userAnswers[currentIndex] === null) {
        skippedSet.add(currentIndex);
    }

    if (currentIndex < questions.length - 1) {
        currentIndex++;
        showQuestion();
    } else {
        updateStats();
        alert("This is the last question. You can use 'Submit Quiz' at the top when ready.");
    }
}

function submitQuiz() {
    clearInterval(timerInterval);

    let score = 0;
    questions.forEach((q, idx) => {
        if (userAnswers[idx] === q.correctAnswer) {
            score++;
        }
    });

    const payload = {
        quizId: currentQuizId,
        score: score,
        total: questions.length,
        answers: userAnswers
    };

    fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .catch(err => console.error('Error submitting answers:', err));

    displayResults(score, questions.length);
}

function displayResults(score, total) {
    document.getElementById('quiz-screen').classList.add('hidden');
    document.getElementById('result-screen').classList.remove('hidden');

    let attempted = userAnswers.filter(ans => ans !== null).length;
    let skipped = total - attempted;

    document.getElementById('final-score').innerText = `Score: ${score} / ${total}`;
    document.getElementById('final-breakdown').innerText = `Attempted: ${attempted} | Skipped: ${skipped} | Correct: ${score} | Incorrect: ${attempted - score}`;
}

function returnToMenu() {
    document.getElementById('result-screen').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}