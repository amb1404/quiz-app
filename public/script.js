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
        card.innerHTML = `<h3>${subName}</h3><p>${sub.chapters ? sub.chapters.length : 0} Chapters</p>`;
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
        card.innerHTML = `<h4>${chap.title || chap.name}</h4>`;
        card.onclick = () => promptForName(chap.id, chap.duration);
        list.appendChild(card);
    });
}

function backToSubjects() {
    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}

function promptForName(quizId, duration) {
    pendingQuizId = quizId;
    pendingDuration = duration;
    
    // Clear the input text boxes to blank every time
    document.getElementById('first-name').value = '';
    document.getElementById('last-name').value = '';
    
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
    
    const statsEl = document.getElementById('counter-stats');
    if (statsEl) {
        statsEl.innerText = 'Attempted: 0 | Skipped: 0';
    }

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

function startQuiz() {
    startTimer();
    renderQuestionUI();
    refreshCounters();
}

function startTimer() {
    clearInterval(timerInterval);
    updateTimerDisplay();

    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            submitQuiz();
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
    if (!questions.length) return;

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

    const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
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
    userAnswers[currentIndex] = idx;
    skippedIndices.delete(currentIndex);
    renderQuestionUI();
    refreshCounters();
}

function prevQuestion() {
    if (currentIndex > 0) {
        currentIndex--;
        renderQuestionUI();
        refreshCounters();
    }
}

function nextQuestion() {
    if (userAnswers[currentIndex] === null || userAnswers[currentIndex] === undefined) {
        skippedIndices.add(currentIndex);
    }
    if (currentIndex < questions.length - 1) {
        currentIndex++;
        renderQuestionUI();
    }
    refreshCounters();
}

function getCorrectIndex(q) {
    let rawCorrect = q.answer !== undefined ? q.answer : 
                     (q.correctAnswer !== undefined ? q.correctAnswer : q.correct);

    if (typeof rawCorrect === 'number') {
        return rawCorrect; 
    } else if (typeof rawCorrect === 'string') {
        let trimmed = rawCorrect.trim();
        let parsedNum = parseInt(trimmed, 10);
        if (!isNaN(parsedNum)) {
            return parsedNum;
        } else if (trimmed.length === 1) {
            return trimmed.toUpperCase().charCodeAt(0) - 65;
        } else {
            return q.options.indexOf(trimmed);
        }
    }
    return -1;
}

function submitQuiz() {
    clearInterval(timerInterval);

    let score = 0;
    let attempted = 0;

    questions.forEach((q, idx) => {
        if (userAnswers[idx] !== null && userAnswers[idx] !== undefined) {
            attempted++;
            let correctIdx = getCorrectIndex(q);
            if (userAnswers[idx] === correctIdx) {
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

function showReview() {
    document.getElementById('result-screen').classList.add('hidden');
    document.getElementById('review-screen').classList.remove('hidden');

    const container = document.getElementById('review-container');
    container.innerHTML = '';

    const letters = ['a', 'b', 'c', 'd', 'e', 'f'];

    questions.forEach((q, idx) => {
        const userAns = userAnswers[idx];
        const correctIdx = getCorrectIndex(q);
        const isSkipped = (userAns === null || userAns === undefined);
        const isCorrect = (!isSkipped && userAns === correctIdx);

        let statusText = isSkipped ? '<span style="color: #f59e0b; font-weight: bold;">Skipped</span>' :
                         isCorrect ? '<span style="color: #10b981; font-weight: bold;">Correct</span>' : 
                         '<span style="color: #ef4444; font-weight: bold;">Incorrect</span>';

        let card = document.createElement('div');
        card.style.cssText = "background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; margin-bottom: 12px;";

        let html = `<p style="font-weight: bold; margin-bottom: 8px;">Q${idx + 1}: ${q.question} [${statusText}]</p>`;
        html += `<ul style="list-style-type: none; padding-left: 0; margin-bottom: 8px;">`;
        
        q.options.forEach((opt, optIdx) => {
            let prefix = letters[optIdx] ? `${letters[optIdx]}. ` : '';
            let style = "padding: 4px 8px; border-radius: 4px; margin-bottom: 4px; font-size: 14px;";
            
            if (optIdx === correctIdx) {
                style += " background: #d1fae5; color: #065f46; font-weight: 500;"; 
            } else if (optIdx === userAns && !isCorrect) {
                style += " background: #fee2e2; color: #991b1b; text-decoration: line-through;"; 
            }

            html += `<li style="${style}">${prefix}${opt}</li>`;
        });
        html += `</ul>`;

        if (q.explanation) {
            html += `<p style="font-size: 13px; color: #475569; background: #f1f5f9; padding: 8px; border-radius: 4px; margin-top: 6px;"><strong>Explanation:</strong> ${q.explanation}</p>`;
        }

        card.innerHTML = html;
        container.appendChild(card);
    });
}

function returnToMenu() {
    document.getElementById('result-screen').classList.add('hidden');
    document.getElementById('review-screen').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}
