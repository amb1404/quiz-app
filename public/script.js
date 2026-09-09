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

// Context tracking variables for seamless refreshing
let activeSubject = null;
let activeNeetClass = null;
let activeNeetUnit = null;
let activeNeetChapter = null;

document.addEventListener('DOMContentLoaded', () => {
    
    // Check if user reloaded the page or navigated here fresh
    const navType = performance.getEntriesByType("navigation")[0]?.type;
    const isReload = navType === 'reload' || performance.navigation?.type === 1;

    // If fresh login, clear the session storage
    if (!isReload) {
        sessionStorage.removeItem('quizAppSession');
    }

    // Save keystrokes in real-time
    document.getElementById('first-name-input').addEventListener('input', persistState);
    document.getElementById('last-name-input').addEventListener('input', persistState);
    document.getElementById('email-input').addEventListener('input', persistState);

    // Fetch both datasets simultaneously
    Promise.all([
        fetch('/api/quizzes').then(res => res.json().catch(() => [])),
        fetch('/api/neet').then(res => res.json().catch(() => []))
    ]).then(([subjData, neetData]) => {
        const subjectsList = Array.isArray(subjData) ? subjData : (subjData.subjects || []);
        renderSubjects(subjectsList);
        renderNeetClasses(neetData);
        restoreState(); 
    });
});

function hideAllScreens() {
    const screens = [
        'home-menus', 'neet-unit-menu', 'neet-chapter-menu', 'neet-topic-menu',
        'chapter-menu', 'name-screen', 'quiz-screen', 'result-screen'
    ];
    screens.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function getCurrentScreen() {
    const screens = [
        'home-menus', 'neet-unit-menu', 'neet-chapter-menu', 'neet-topic-menu',
        'chapter-menu', 'name-screen', 'quiz-screen', 'result-screen'
    ];
    for (let id of screens) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) return id;
    }
    return 'home-menus';
}

function persistState() {
    if (getCurrentScreen() === 'name-screen') {
        const fNameInput = document.getElementById('first-name-input');
        if(fNameInput) studentFirstName = fNameInput.value.trim().toUpperCase();
        
        const lNameInput = document.getElementById('last-name-input');
        if(lNameInput) studentLastName = lNameInput.value.trim().toUpperCase();
        
        const emailInput = document.getElementById('email-input');
        if(emailInput) studentEmail = emailInput.value.trim().toLowerCase();
    }

    const state = {
        activeScreen: getCurrentScreen(),
        isNeetPath, activeSubject, activeNeetClass, activeNeetUnit, activeNeetChapter,
        quizData: {
            currentQuizId, currentChapterDuration, currentChapterTitleText,
            studentFirstName, studentLastName, studentEmail,
            questions, currentIndex, userAnswers, timeLeft,
            skippedIndices: Array.from(skippedIndices)
        }
    };
    sessionStorage.setItem('quizAppSession', JSON.stringify(state));
}

function restoreState() {
    const saved = sessionStorage.getItem('quizAppSession');
    if (!saved) return false;
    
    try {
        const state = JSON.parse(saved);
        
        isNeetPath = state.isNeetPath;
        activeSubject = state.activeSubject;
        activeNeetClass = state.activeNeetClass;
        activeNeetUnit = state.activeNeetUnit;
        activeNeetChapter = state.activeNeetChapter;
        
        const qd = state.quizData;
        if (qd) {
            currentQuizId = qd.currentQuizId;
            currentChapterDuration = qd.currentChapterDuration;
            currentChapterTitleText = qd.currentChapterTitleText;
            studentFirstName = qd.studentFirstName;
            studentLastName = qd.studentLastName;
            studentEmail = qd.studentEmail;
            questions = qd.questions || [];
            currentIndex = qd.currentIndex || 0;
            userAnswers = qd.userAnswers || [];
            timeLeft = qd.timeLeft || 0;
            skippedIndices = new Set(qd.skippedIndices || []);
        }

        hideAllScreens();
        
        if (activeSubject) showChapters(activeSubject);
        if (activeNeetClass) showNeetUnits(activeNeetClass);
        if (activeNeetUnit) showNeetChapters(activeNeetUnit);
        if (activeNeetChapter) showNeetTopics(activeNeetChapter);
        
        const active = state.activeScreen;
        hideAllScreens(); 
        document.getElementById(active).classList.remove('hidden');
        
        document.getElementById('first-name-input').value = studentFirstName || '';
        document.getElementById('last-name-input').value = studentLastName || '';
        document.getElementById('email-input').value = studentEmail || '';

        if (active === 'name-screen') {
            document.getElementById('selected-chapter-title').innerText = `Title: ${currentChapterTitleText}`;
        } else if (active === 'quiz-screen') {
            document.getElementById('current-chapter-heading').innerText = currentChapterTitleText;
            startQuiz(); 
        } else if (active === 'result-screen') {
            rebuildResultScreen();
        }
        
        return true;
    } catch(e) {
        sessionStorage.removeItem('quizAppSession');
        return false;
    }
}

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
    activeSubject = subject;
    isNeetPath = false; 
    hideAllScreens();
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
    persistState();
}

function backToSubjects() {
    activeSubject = null;
    hideAllScreens();
    document.getElementById('home-menus').classList.remove('hidden');
    persistState();
}

function renderNeetClasses(classes) {
    const list = document.getElementById('neet-class-list');
    list.innerHTML = '';
    classes.forEach(cls => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h3>${cls.name}</h3><p>${cls.units ? cls.units.length : 0} Units</p>`;
        card.onclick = () => showNeetUnits(cls);
        list.appendChild(card);
    });
}

function showNeetUnits(cls) {
    activeNeetClass = cls;
    hideAllScreens();
    document.getElementById('neet-unit-menu').classList.remove('hidden');
    document.getElementById('selected-neet-class-title').innerText = cls.name;

    const list = document.getElementById('neet-unit-list');
    list.innerHTML = '';
    cls.units.forEach(unit => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h4>${unit.name}</h4><p>${unit.chapters ? unit.chapters.length : 0} Chapters</p>`;
        card.onclick = () => showNeetChapters(unit);
        list.appendChild(card);
    });
    persistState();
}

function showNeetChapters(unit) {
    isNeetPath = true; 
    activeNeetUnit = unit;
    hideAllScreens();
    document.getElementById('neet-chapter-menu').classList.remove('hidden');
    document.getElementById('selected-neet-unit-title').innerText = unit.name;

    const list = document.getElementById('neet-chapter-list');
    list.innerHTML = '';
    unit.chapters.forEach(chap => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `<h4>${chap.name}</h4><p>${chap.topics ? chap.topics.length : 0} Topics</p>`;
        card.onclick = () => showNeetTopics(chap);
        list.appendChild(card);
    });
    persistState();
}

function showNeetTopics(chap) {
    isNeetPath = true; 
    activeNeetChapter = chap;
    hideAllScreens();
    document.getElementById('neet-topic-menu').classList.remove('hidden');
    document.getElementById('selected-neet-chapter-title').innerText = chap.name;

    const list = document.getElementById('neet-topic-list');
    list.innerHTML = '';
    chap.topics.forEach(top => {
        if (!top.id) return; 
        const card = document.createElement('div');
        card.className = 'card';
        const title = top.title || top.name;
        card.innerHTML = `<h4>${title}</h4>`;
        card.onclick = () => prepareQuiz(top.id, top.duration, title);
        list.appendChild(card);
    });
    persistState();
}

function backToHomeMenus() {
    activeNeetClass = null;
    hideAllScreens();
    document.getElementById('home-menus').classList.remove('hidden');
    persistState();
}

function backToNeetUnits() {
    activeNeetUnit = null;
    hideAllScreens();
    document.getElementById('neet-unit-menu').classList.remove('hidden');
    persistState();
}

function backToNeetChapters() {
    activeNeetChapter = null;
    hideAllScreens();
    document.getElementById('neet-chapter-menu').classList.remove('hidden');
    persistState();
}

function prepareQuiz(quizId, duration, chapterTitle) {
    currentQuizId = quizId;
    currentChapterDuration = duration || 300;
    currentChapterTitleText = chapterTitle;

    hideAllScreens();
    document.getElementById('name-screen').classList.remove('hidden');
    document.getElementById('selected-chapter-title').innerText = `Title: ${chapterTitle}`;
    document.getElementById('first-name-input').value = studentFirstName || '';
    document.getElementById('last-name-input').value = studentLastName || '';
    document.getElementById('email-input').value = studentEmail || '';
    persistState();
}

function backToChapters() {
    hideAllScreens();
    if (isNeetPath) {
        document.getElementById('neet-topic-menu').classList.remove('hidden');
    } else {
        document.getElementById('chapter-menu').classList.remove('hidden');
    }
    persistState();
}

function proceedToQuiz() {
    const firstName = document.getElementById('first-name-input').value.trim().toUpperCase();
    const lastName = document.getElementById('last-name-input').value.trim().toUpperCase();
    const email = document.getElementById('email-input').value.trim().toLowerCase();

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
    persistState();

    fetch(`/api/quiz/${currentQuizId}`)
        .then(res => res.json())
        .then(data => {
            questions = data;
            userAnswers = new Array(questions.length).fill(null);
            currentIndex = 0;

            hideAllScreens();
            document.getElementById('quiz-screen').classList.remove('hidden');
            
            persistState();
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
        persistState(); 

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
    persistState();
}

function clearResponse() {
    userAnswers[currentIndex] = null;
    skippedIndices.add(currentIndex);
    renderQuestionUI();
    refreshCounters();
    persistState();
}

function prevQuestion() {
    if (currentIndex > 0) {
        currentIndex--;
        renderQuestionUI();
        refreshCounters();
        persistState();
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
    persistState();
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

    hideAllScreens();
    document.getElementById('result-screen').classList.remove('hidden');
    rebuildResultScreen();
    persistState();
}

function rebuildResultScreen() {
    let score = 0;
    let attempted = 0;

    questions.forEach((q, idx) => {
        if (userAnswers[idx] !== null) {
            attempted++;
            if (userAnswers[idx] === getCorrectIndex(q)) score++;
        }
    });

    let incorrect = attempted - score;
    let skipped = questions.length - attempted;
    
    document.getElementById('final-score').innerText = `Score: ${score} / ${questions.length}`;
    document.getElementById('final-breakdown').innerText = `Student: ${studentFirstName} ${studentLastName} (${studentEmail}) | Attempted: ${attempted} | Skipped: ${skipped} | Correct: ${score} | Incorrect: ${incorrect}`;
}

function returnToMenu() {
    sessionStorage.removeItem('quizAppSession');
    location.reload(); 
}
