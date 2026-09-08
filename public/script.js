let questions = [];
let currentIndex = 0;
let userAnswers = [];
let timerInterval = null;
let timeLeft = 0;
let currentQuizId = null;
let currentChapterDuration = 300;
let currentChapterTitleText = '';
let studentFirstName = '';
let studentLastName = '';
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
    list.innerHTML = '';

    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h3>${sub.subject || sub.name}</h3><p>${sub.chapters.length} Chapters</p>`;
        card.onclick = () => showChapters(sub);
        list.appendChild(card);
    });
}

function showChapters(subject) {
    document.getElementById('subject-menu').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
    document.getElementById('selected-subject-title').innerText = subject.subject || subject.name;

    const list = document.getElementById('chapter-list');
    list.innerHTML = '';

    subject.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        const chapTitle = chap.title || chap.name;
        card.innerHTML = `<h4>${chapTitle}</h4>`;
        card.onclick = () => prepareQuiz(chap.id, chap.duration, chapTitle);
        list.appendChild(card);
    });
}

function backToSubjects() {
    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}

function prepareQuiz(quizId, duration, chapterTitle) {
    currentQuizId = quizId;
    currentChapterDuration = duration || 300;
    currentChapterTitleText = chapterTitle;

    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('name-screen').classList.remove('hidden');
    document.getElementById('selected-chapter-title').innerText = `Chapter: ${chapterTitle}`;
    document.getElementById('first-name-input').value = '';
    document.getElementById('last-name-input').value = '';
}

function backToChapters() {
    document.getElementById('name-screen').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
}

function proceedToQuiz() {
    const firstName = document.getElementById('first-name-input').value.trim();
    const lastName = document.getElementById('last-name-input').value.trim();

    if (!firstName || !lastName) {
        alert('Please enter both your first name and last name.');
        return;
    }

    studentFirstName = firstName;
    studentLastName = lastName;
    timeLeft = currentChapterDuration;
    skippedIndices.clear();
    document.getElementById('counter-stats').innerText = 'Attempted: 0 | Skipped: 0';
    document.getElementById('current-chapter-heading').innerText = currentChapterTitleText;

    fetch(`/api/quiz/${currentQuizId}`)
        .then(res => res.json())
        .then(data => {
            questions = data;
            userAnswers = new Array(questions.length).fill(null);
            currentIndex = 0;

            document.getElementById('name-screen').classList.add('hidden');
            document.getElementById('quiz-screen').classList.remove('hidden');
            startQuiz();
        })
        .catch(err => console.error('Error loading questions:', err));
}

function startQuiz() {
    clearInterval(timerInterval);
    updateTimerDisplay();

    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();

        if (timeLeft <= 0) {
            submitQuiz();
        }
    }, 1000);

    renderQuestionUI();
    refreshCounters();
}

function updateTimerDisplay() {
    let minutes = Math.floor(timeLeft / 60);
    let seconds = timeLeft % 60;
    let formatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    document.getElementById('timer-display').innerText = `Time Left: ${formatted}`;
}

function refreshCounters() {
    let attempted = userAnswers.filter(ans => ans !== null).length;
    let skipped = skippedIndices.size;
    document.getElementById('counter-stats').innerText = `Attempted: ${attempted} | Skipped: ${skipped}`;
}

function renderQuestionUI() {
    if (!questions.length) return;

    document.getElementById('prev-btn').style.display = currentIndex === 0 ? 'none' : 'block';
    document.getElementById('next-btn').style.display = currentIndex === questions.length - 1 ? 'none' : 'block';

    let q = questions[currentIndex];
    document.getElementById('question-box').innerText = `Q${currentIndex + 1}: ${q.question}`;

    let optionsBox = document.getElementById('options-box');
    optionsBox.innerHTML = '';

    const letters = ['a', 'b', 'c', 'd'];
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
    if (userAnswers[currentIndex] === null) {
        skippedIndices.add(currentIndex);
    }
    if (currentIndex < questions.length - 1) {
        currentIndex++;
        renderQuestionUI();
    }
    refreshCounters();
}

function getCorrectIndex(q) {
    return q.answer !== undefined ? q.answer : q.correctAnswer;
}

function submitQuiz() {
    clearInterval(timerInterval);

    let score = 0;
    let attempted = 0;

    questions.forEach((q, idx) => {
        if (userAnswers[idx] !== null) {
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
        chapterTitle: currentChapterTitleText,
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

    const letters = ['a', 'b', 'c', 'd'];

    questions.forEach((q, idx) => {
        const userAns = userAnswers[idx];
        const correctIdx = getCorrectIndex(q);
        const isSkipped = (userAns === null);
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
