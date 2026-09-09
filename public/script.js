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
let studentEmail = '';
let skippedIndices = new Set();
let isNeetPath = false; 
let currentNeetClass = null;

document.addEventListener('DOMContentLoaded', () => {
    // Fetch Regular Subjects
    fetch('/api/quizzes')
        .then(res => res.json())
        .then(data => {
            const subjectsList = Array.isArray(data) ? data : data.subjects;
            renderSubjects(subjectsList);
        })
        .catch(err => console.error('Error fetching quiz list:', err));

    // Fetch NEET Content
    fetch('/api/neet')
        .then(res => res.json())
        .then(data => renderNeetClasses(data))
        .catch(err => console.error('Error fetching NEET list:', err));
});

// --- REGULAR SUBJECTS LOGIC ---
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
    isNeetPath = false; 
    document.getElementById('home-menus').classList.add('hidden');
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
    document.getElementById('home-menus').classList.remove('hidden');
}

// --- NEET LOGIC ---
function renderNeetClasses(classes) {
    const list = document.getElementById('neet-class-list');
    list.innerHTML = '';
    classes.forEach(cls => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h3>${cls.name}</h3><p>${cls.chapters.length} Chapters</p>`;
        card.onclick = () => showNeetChapters(cls);
        list.appendChild(card);
    });
}

function showNeetChapters(cls) {
    currentNeetClass = cls;
    document.getElementById('home-menus').classList.add('hidden');
    document.getElementById('neet-chapter-menu').classList.remove('hidden');
    document.getElementById('selected-neet-class-title').innerText = cls.name;

    const list = document.getElementById('neet-chapter-list');
    list.innerHTML = '';
    cls.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h4>${chap.name}</h4><p>${chap.topics.length} Topics</p>`;
        card.onclick = () => showNeetTopics(chap);
        list.appendChild(card);
    });
}

function showNeetTopics(chap) {
    isNeetPath = true; 
    document.getElementById('neet-chapter-menu').classList.add('hidden');
    document.getElementById('neet-topic-menu').classList.remove('hidden');
    document.getElementById('selected-neet-chapter-title').innerText = chap.name;

    const list = document.getElementById('neet-topic-list');
    list.innerHTML = '';
    chap.topics.forEach(top => {
        const card = document.createElement('div');
        card.className = 'card';
        const title = top.title || top.name;
        card.innerHTML = `<h4>${title}</h4>`;
        // Navigate down to the Subtopics layer instead of starting the quiz
        card.onclick = () => showNeetSubtopics(top);
        list.appendChild(card);
    });
}

function showNeetSubtopics(top) {
    isNeetPath = true; 
    document.getElementById('neet-topic-menu').classList.add('hidden');
    document.getElementById('neet-subtopic-menu').classList.remove('hidden');
    document.getElementById('selected-neet-subtopic-title').innerText = top.title || top.name;

    const list = document.getElementById('neet-subtopic-list');
    list.innerHTML = '';
    top.subtopics.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        const title = sub.title || sub.name;
        card.innerHTML = `<h4>${title}</h4>`;
        // The quiz starts from this final subtopic layer
        card.onclick = () => prepareQuiz(sub.id, sub.duration, title);
        list.appendChild(card);
    });
}

function backToHomeMenus() {
    document.getElementById('neet-chapter-menu').classList.add('hidden');
    document.getElementById('home-menus').classList.remove('hidden');
}

function backToNeetChapters() {
    document.getElementById('neet-topic-menu').classList.add('hidden');
    document.getElementById('neet-chapter-menu').classList.remove('hidden');
}

function backToNeetTopics() {
    document.getElementById('neet-subtopic-menu').classList.add('hidden');
    document.getElementById('neet-topic-menu').classList.remove('hidden');
}

// --- SHARED QUIZ PREPARATION LOGIC ---
function prepareQuiz(quizId, duration, chapterTitle) {
    currentQuizId = quizId;
    currentChapterDuration = duration || 300;
    currentChapterTitleText = chapterTitle;

    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('neet-topic-menu').classList.add('hidden');
    document.getElementById('neet-subtopic-menu').classList.add('hidden');
    document.getElementById('name-screen').classList.remove('hidden');
    document.getElementById('selected-chapter-title').innerText = `Title: ${chapterTitle}`;
    document.getElementById('first-name-input').value = '';
    document.getElementById('last-name-input').value = '';
    document.getElementById('email-input').value = '';
}

function backToChapters() {
    document.getElementById('name-screen').classList.add('hidden');
    // Direct back to Subtopics if in NEET path, else regular Chapters
    if (isNeetPath) {
        document.getElementById('neet-subtopic-menu').classList.remove('hidden');
    } else {
        document.getElementById('chapter-menu').classList.remove('hidden');
    }
}

function proceedToQuiz() {
    const firstName = document.getElementById('first-name-input').value.trim();
    const lastName = document.getElementById('last-name-input').value.trim();
    const email = document.getElementById('email-input').value.trim();

    if (!firstName || !lastName || !email) {
        alert('Please enter your first name, last name, and a valid email ID.');
        return;
    }

    studentFirstName = firstName;
    studentLastName = lastName;
    studentEmail = email;
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

// --- ACTIVE QUIZ LOGIC ---
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

function clearResponse() {
    userAnswers[currentIndex] = null;
    skippedIndices.add(currentIndex);
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

// --- QUIZ SUBMISSION LOGIC ---
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
        email: studentEmail,
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
    document.getElementById('final-breakdown').innerText = `Student: ${studentFirstName} ${studentLastName} (${studentEmail}) | Attempted: ${attempted} | Skipped: ${skipped} | Correct: ${score} | Incorrect: ${incorrect}`;
}

function returnToMenu() {
    document.getElementById('result-screen').classList.add('hidden');
    document.getElementById('home-menus').classList.remove('hidden');
}
