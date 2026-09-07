let questions = [];
let currentIndex = 0;
let userAnswers = [];
let timerInterval = null;
let timeLeft = 0;
let isPaused = false;
let currentQuizId = null;
let skippedIndices = new Set();

document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/quizzes')
        .then(res => res.json())
        .then(data => {
            const subjectsList = Array.isArray(data) ? data : data.subjects;
            renderSubjects(subjectsList);
        })
        .catch(err => console.error('Error fetching quiz list:', err));
});

function renderSubjects(subjects) {
    const list = document.getElementById('subject-list');
    if (!list || !subjects) return;
    list.innerHTML = '';

    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        const subName = sub.subject || sub.name;
        card.innerHTML = `<h3>${subName}</h3><p>${sub.description || ''}</p>`;
        card.onclick = () => showChapters(sub);
        list.appendChild(card);
    });
}

function showChapters(subject) {
    document.getElementById('subject-menu').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
    document.getElementById('selected-subject-title').innerText = subject.subject || subject.name;

    const list = document.getElementById('chapter-list');
    if (!list) return;
    list.innerHTML = '';

    subject.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        const chapTitle = chap.title || chap.name;
        card.innerHTML = `<h4>${chapTitle}</h4><p>Duration: ${chap.duration / 60} mins</p>`;
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

    skippedIndices.clear();

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
    renderQuestionUI();
    refreshCounters();
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
    const timerEl = document.getElementById('timer-display');
    if (timerEl) {
        timerEl.innerText = `Time Left: ${formatted}`;
    }
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

function refreshCounters() {
    let attempted = 0;
    for (let i = 0; i < userAnswers.length; i++) {
        if (userAnswers[i] !== null && userAnswers[i] !== undefined) {
            attempted++;
        }
    }

    let skipped = skippedIndices.size;

    const statsEl = document.getElementById('counter-stats');
    if (statsEl) {
        statsEl.innerText = `Attempted: ${attempted} | Skipped: ${skipped}`;
    }
}

function renderQuestionUI() {
    if (isPaused || !questions.length) return;

    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    if (prevBtn) prevBtn.style.display = currentIndex === 0 ? 'none' : 'block';
    if (nextBtn) nextBtn.style.display = currentIndex === questions.length - 1 ? 'none' : 'block';

    let q = questions[currentIndex];
    const qBox = document.getElementById('question-box');
    if (qBox) {
        qBox.innerText = `Q${currentIndex + 1}: ${q.question}`;
    }

    let optionsBox = document.getElementById('options-box');
    if (!optionsBox) return;
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
        btn.onclick = () => selectOption(idx);
        optionsBox.appendChild(btn);
    });
}

function selectOption(idx) {
    if (isPaused) return;

    userAnswers[currentIndex] = idx;
    skippedIndices.delete(currentIndex);

    renderQuestionUI();
    refreshCounters();
}

function prevQuestion() {
    if (isPaused) return;
    if (currentIndex > 0) {
        currentIndex--;
        renderQuestionUI();
        refreshCounters();
    }
}

function nextQuestion() {
    if (isPaused) return;

    if (userAnswers[currentIndex] === null || userAnswers[currentIndex] === undefined) {
        skippedIndices.add(currentIndex);
    }

    if (currentIndex < questions.length - 1) {
        currentIndex++;
        renderQuestionUI();
    }
    refreshCounters();
}

function skipQuestion() {
    if (isPaused) return;

    if (userAnswers[currentIndex] === null || userAnswers[currentIndex] === undefined) {
        skippedIndices.add(currentIndex);
    }

    if (currentIndex < questions.length - 1) {
        currentIndex++;
        renderQuestionUI();
    } else {
        alert("This is the last question. You can use 'Submit Quiz' when you are ready.");
    }
    refreshCounters();
}

function submitQuiz() {
    clearInterval(timerInterval);

    let score = 0;
    let attempted = 0;

    questions.forEach((q, idx) => {
        const userAns = userAnswers[idx]; // 0-based index of clicked option (0, 1, 2, 3)
        
        if (userAns !== null && userAns !== undefined) {
            attempted++;
            
            // Evaluates JSON files using 'answer' (supporting numbers like 1, 2, 3... or 0, 1, 2...)
            let rawCorrect = q.answer !== undefined ? q.answer : 
                             (q.correctAnswer !== undefined ? q.correctAnswer : q.correct);

            let isCorrect = false;

            if (typeof rawCorrect === 'number') {
                if (userAns === rawCorrect || userAns === rawCorrect - 1) {
                    isCorrect = true;
                }
            } else if (typeof rawCorrect === 'string') {
                let trimmed = rawCorrect.trim();
                let parsedNum = parseInt(trimmed, 10);

                if (!isNaN(parsedNum)) {
                    if (userAns === parsedNum || userAns === parsedNum - 1) {
                        isCorrect = true;
                    }
                } else if (trimmed.length === 1) {
                    let correctIdx = trimmed.toUpperCase().charCodeAt(0) - 65;
                    if (userAns === correctIdx) {
                        isCorrect = true;
                    }
                } else {
                    let correctIdx = q.options.indexOf(trimmed);
                    if (userAns === correctIdx) {
                        isCorrect = true;
                    }
                }
            }

            if (isCorrect) {
                score++;
            }
        }
    });

    let incorrect = attempted - score;
    let skipped = questions.length - attempted;

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
    }).catch(err => console.error('Error submitting answers:', err));

    displayResults(score, attempted, incorrect, skipped, questions.length);
}

function displayResults(score, attempted, incorrect, skipped, total) {
    document.getElementById('quiz-screen').classList.add('hidden');
    document.getElementById('result-screen').classList.remove('hidden');

    document.getElementById('final-score').innerText = `Score: ${score} / ${total}`;
    document.getElementById('final-breakdown').innerText = `Attempted: ${attempted} | Skipped: ${skipped} | Correct: ${score} | Incorrect: ${incorrect}`;
}

function returnToMenu() {
    document.getElementById('result-screen').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}
