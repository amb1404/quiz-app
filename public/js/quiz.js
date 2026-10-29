// public/js/quiz.js
let screenHistory = [];
let dynamicQuizzes = [];
let currentQuizId = "";
let currentQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};
let skippedQuestions = new Set();
let timeRemaining = 900;
let quizDuration = 900;
let serverStartTime = 0;
let timerSignature = "";
let timerInterval;
let selectedClassName = "";
let selectedSubjectName = "";
let activeQuizTitle = "";
let selectedNotesClass = "";
let selectedNotesSubject = "";
let selectedDescriptiveClass = "";
let selectedDescriptiveSubject = "";
let selectedNeetUnit = "";
let selectedNeetChapter = "";
let isRestoringSession = false;

// Anti-Scraping DOM Lockdowns
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'C' || e.key === 'J'))) {
        e.preventDefault();
    }
});

function escapeClientHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

const neetHierarchy = {
    "XI": {
        "Unit I: Diversity in the Living World": ["The Living World", "Biological Classification", "Plant Kingdom", "Animal Kingdom"],
        "Unit II: Structural Organisation in Plants and Animals": ["Morphology of Flowering Plants", "Anatomy of Flowering Plants", "Structural Organisation in Animals"],
        "Unit III: Cell: Structure and Functions": ["Cell: The Unit of Life", "Biomolecules", "Cell Cycle and Cell Division"],
        "Unit IV: Plant Physiology": ["Photosynthesis in Higher Plants", "Respiration in Plants", "Plant Growth and Development"],
        "Unit V: Human Physiology": ["Breathing and Exchange of Gases", "Body Fluids and Circulation", "Excretory Products and their Elimination", "Locomotion and Movement", "Neural Control and Coordination", "Chemical Coordination and Integration"]
    },
    "XII": {
        "Unit VI: Reproduction": ["Sexual Reproduction in Flowering Plants", "Human Reproduction", "Reproductive Health", "Reproduction in Organisms"],
        "Unit VII: Genetics and Evolution": ["Principles of Inheritance and Variation", "Molecular Basis of Inheritance", "Evolution"],
        "Unit VIII: Biology in Human Welfare": ["Human Health and Disease", "Microbes in Human Welfare", "Strategies for Enhancement in Food Production"],
        "Unit IX: Biotechnology and its Applications": ["Biotechnology: Principles and Processes", "Biotechnology and its Applications"],
        "Unit X: Ecology and Environment": ["Organisms and Populations", "Ecosystem", "Biodiversity and Conservation", "Environmental Issues"]
    }
};

function isChapterMatch(quizChap, targetChap) {
    if (!quizChap || !targetChap) return false;
    const clean = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean(quizChap).includes(clean(targetChap)) || clean(targetChap).includes(clean(quizChap));
}

function updateState() {
    if (isRestoringSession) return;
    MainNav.saveSessionState(
        CURRENT_ROUTE, currentQuizId, activeQuizTitle, currentQuestionIndex,
        timeRemaining, quizDuration, serverStartTime, timerSignature,
        userAnswers, skippedQuestions, screenHistory,
        { selectedClassName, selectedSubjectName, selectedNotesClass, selectedNotesSubject, selectedDescriptiveClass, selectedDescriptiveSubject, selectedNeetUnit, selectedNeetChapter }
    );
}

window.addEventListener('DOMContentLoaded', async () => {
    const firstInput = document.getElementById('first-name');
    const lastInput = document.getElementById('last-name');
    const emailInput = document.getElementById('email-address');

    if (firstInput) firstInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
    if (lastInput) lastInput.addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
    if (emailInput) emailInput.addEventListener('input', e => e.target.value = e.target.value.toLowerCase());

    const normalizedRoute = MainNav.normalizeRoute(CURRENT_ROUTE);

    if (normalizedRoute === '/test-portal.html') {
        try {
            const res = await fetch('/api/quizzes');
            const data = await res.json();
            if (data.success) dynamicQuizzes = data.quizzes;
        } catch (e) {
            console.error("Failed to load quizzes");
        }
    }

    const params = new URLSearchParams(window.location.search);
    const queryClass = params.get('class');
    const savedState = MainNav.getSavedState(CURRENT_ROUTE);

    if (savedState && savedState.activeScreen !== 'home-dashboard') {
        await restoreSessionState(savedState);
    } else if (queryClass) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (normalizedRoute === '/test-portal.html') selectClass(queryClass);
        else if (normalizedRoute === '/notes.html') selectNotesClass(queryClass);
        else if (normalizedRoute === '/descriptive.html') selectDescriptiveClass(queryClass);
    }
});

async function restoreSessionState(state) {
    try {
        isRestoringSession = true;
        selectedClassName = state.selectedClassName || '';
        selectedSubjectName = state.selectedSubjectName || '';
        selectedNotesClass = state.selectedNotesClass || '';
        selectedNotesSubject = state.selectedNotesSubject || '';
        selectedDescriptiveClass = state.selectedDescriptiveClass || '';
        selectedDescriptiveSubject = state.selectedDescriptiveSubject || '';
        selectedNeetUnit = state.selectedNeetUnit || '';
        selectedNeetChapter = state.selectedNeetChapter || '';
        currentQuizId = state.currentQuizId || '';
        activeQuizTitle = state.activeQuizTitle || '';
        currentQuestionIndex = state.currentQuestionIndex || 0;
        timeRemaining = state.timeRemaining || 900;
        quizDuration = state.quizDuration || 900;
        serverStartTime = state.serverStartTime || 0;
        timerSignature = state.timerSignature || '';
        userAnswers = state.userAnswers || {};
        skippedQuestions = new Set(state.skippedQuestions || []);

        const fEl = document.getElementById('first-name');
        const lEl = document.getElementById('last-name');
        const eEl = document.getElementById('email-address');
        if (fEl) fEl.value = state.firstName || '';
        if (lEl) lEl.value = state.lastName || '';
        if (eEl) eEl.value = state.email || '';

        if (state.activeScreen === 'quiz-screen' && currentQuizId) {
            const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                credentials: 'same-origin',
                headers: { 'X-Requested-With': 'PioneersPrepApp' }
            });
            if (qRes.ok) {
                const data = await qRes.json();
                if (data.securePayload) {
                    const deobfuscated = decodeURIComponent(atob(data.securePayload.split('').reverse().join('')));
                    currentQuestions = JSON.parse(deobfuscated);
                } else {
                    currentQuestions = data;
                }
                if (serverStartTime && quizDuration) {
                    timeRemaining = Math.max(0, quizDuration - Math.floor((Date.now() - serverStartTime) / 1000));
                }
                showScreen('quiz-screen');
                renderQuestion();
                startTimer();
            } else {
                goHome();
            }
        } else if (state.activeScreen === 'neet-unit-screen' && selectedClassName) loadNeetUnits(selectedClassName);
        else if (state.activeScreen === 'neet-chapter-screen' && selectedClassName && selectedNeetUnit) loadNeetChapters(selectedClassName, selectedNeetUnit);
        else if (state.activeScreen === 'neet-topic-screen' && selectedClassName && selectedNeetUnit && selectedNeetChapter) loadNeetTopics(selectedClassName, selectedNeetUnit, selectedNeetChapter);
        else if (state.activeScreen === 'subject-select-screen') showScreen('subject-select-screen');
        else if (state.activeScreen === 'ix-x-chapter-screen' && selectedClassName) {
            if ((selectedClassName === 'IX' || selectedClassName === 'X') && selectedSubjectName) selectSubject(selectedSubjectName);
            else loadDynamicChapters(selectedClassName);
        } else if (state.activeScreen === 'notes-subject-screen' && selectedNotesClass) selectNotesClass(selectedNotesClass);
        else if (state.activeScreen === 'notes-list-screen' && selectedNotesClass && selectedNotesSubject) await selectNotesSubject(selectedNotesSubject);
        else if (state.activeScreen === 'descriptive-subject-screen' && selectedDescriptiveClass) selectDescriptiveClass(selectedDescriptiveClass);
        else if (state.activeScreen === 'descriptive-list-screen' && selectedDescriptiveClass && selectedDescriptiveSubject) await selectDescriptiveSubject(selectedDescriptiveSubject);
        else if (state.activeScreen === 'name-screen') {
            showScreen('name-screen');
            if (state.otpSent) showOtpWrapper();
        } else {
            showScreen(state.activeScreen);
        }

        screenHistory = state.screenHistory || [];
    } catch (e) {
        console.error(e);
    } finally {
        isRestoringSession = false;
        updateState();
    }
}

function showScreen(screenId) {
    const target = document.getElementById(screenId);
    if (!target) return;
    const current = document.querySelector('.app-screen:not(.hidden)');
    if (!isRestoringSession && current && current.id !== screenId) screenHistory.push(current.id);
    document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
    target.classList.remove('hidden');

    if (screenId === 'quiz-screen') MainNav.applyExamMode();
    else MainNav.clearExamMode();

    if (!isRestoringSession) updateState();
}

function goBack() {
    if (screenHistory.length > 0) {
        const prev = screenHistory.pop();
        document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
        const target = document.getElementById(prev);
        if (target) {
            target.classList.remove('hidden');
            MainNav.clearExamMode();
        } else {
            goHome();
        }
        updateState();
    } else {
        goHome();
    }
}

function goHome() {
    screenHistory = [];
    clearInterval(timerInterval);
    userAnswers = {};
    skippedQuestions = new Set();
    MainNav.clearExamMode();
    sessionStorage.removeItem('pioneers_prep_state');
    const optW = document.getElementById('otp-wrapper');
    if (optW) optW.remove();
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Verify & Start'; vBtn.disabled = false; }
    document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('home-dashboard')?.classList.remove('hidden');
}

function selectDescriptiveClass(cName) {
    selectedDescriptiveClass = cName;
    const container = document.getElementById('descriptive-subject-container');
    if (!container) return;
    container.innerHTML = '';
    const subjects = (cName === 'IX' || cName === 'X') ? ['Physics', 'Chemistry', 'Biology'] : ['Biology'];
    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card card-yellow';
        card.innerText = sub;
        card.addEventListener('click', () => selectDescriptiveSubject(sub));
        container.appendChild(card);
    });
    showScreen('descriptive-subject-screen');
}

async function selectDescriptiveSubject(subject) {
    selectedDescriptiveSubject = subject;
    const heading = document.getElementById('descriptive-screen-heading');
    if (heading) heading.innerText = `Class ${selectedDescriptiveClass} ${subject} Papers`;
    const container = document.getElementById('descriptive-list-container');
    if (!container) return;
    container.innerHTML = '<p style="text-align:center;">Loading question papers...</p>';
    showScreen('descriptive-list-screen');

    try {
        const res = await fetch('/api/descriptive-questions');
        const list = await res.json();
        const matched = list.find(n => n.class === selectedDescriptiveClass && n.subject.toLowerCase() === subject.toLowerCase());
        container.innerHTML = '';
        if (matched?.papers?.length > 0) {
            matched.papers.forEach(item => {
                const link = document.createElement('a');
                link.href = '/api/download-descriptive/' + encodeURIComponent(item.fileName);
                link.className = 'card card-yellow';
                link.innerText = '📝 ' + item.name;
                container.appendChild(link);
            });
        } else {
            container.innerHTML = `<p style="text-align:center; color:#854d0e;">No question papers available for ${escapeClientHtml(subject)} yet.</p>`;
        }
    } catch {
        container.innerHTML = '<p style="text-align:center; color:red;">Failed to load papers.</p>';
    }
    updateState();
}

function selectNotesClass(cName) {
    selectedNotesClass = cName;
    const container = document.getElementById('notes-subject-container');
    container.innerHTML = '';
    const subjects = (cName === 'IX' || cName === 'X') ? ['Physics', 'Chemistry', 'Biology'] : ['Biology'];
    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = sub;
        card.addEventListener('click', () => selectNotesSubject(sub));
        container.appendChild(card);
    });
    showScreen('notes-subject-screen');
}

async function selectNotesSubject(subject) {
    selectedNotesSubject = subject;
    const container = document.getElementById('notes-list-container');
    container.innerHTML = '<p style="text-align:center;">Loading notes...</p>';
    showScreen('notes-list-screen');

    try {
        const res = await fetch('/api/notes');
        const list = await res.json();
        const matched = list.find(n => n.class === selectedNotesClass && n.subject.toLowerCase() === subject.toLowerCase());
        container.innerHTML = '';
        if (matched?.notes?.length > 0) {
            matched.notes.forEach(note => {
                const link = document.createElement('a');
                link.href = '/api/download-note/' + encodeURIComponent(note.fileName);
                link.className = 'card';
                link.innerText = '📚 ' + note.name;
                container.appendChild(link);
            });
        } else {
            container.innerHTML = '<p style="text-align:center;">No notes available for this subject yet.</p>';
        }
    } catch {
        container.innerHTML = '<p style="text-align:center; color:red;">Failed to load notes.</p>';
    }
    updateState();
}

function selectClass(cName) {
    selectedClassName = cName;
    if (cName === 'IX' || cName === 'X') showScreen('subject-select-screen');
    else if (cName === 'XI' || cName === 'XII') loadNeetUnits(cName);
    else loadDynamicChapters(cName);
}

function selectSubject(sub) {
    selectedSubjectName = sub;
    const container = document.getElementById('ix-x-chapter-container');
    container.innerHTML = '';
    const matched = dynamicQuizzes.filter(q => q.category === 'icse' && q.classLevel.toLowerCase() === selectedClassName.toLowerCase() && q.subject.toLowerCase() === sub.toLowerCase());
    if (matched.length === 0) {
        container.innerHTML = `<p style="text-align:center;">No tests found for ${escapeClientHtml(sub)} yet.</p>`;
    } else {
        matched.forEach(q => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerText = q.title;
            card.addEventListener('click', () => prepareQuiz(q));
            container.appendChild(card);
        });
    }
    showScreen('ix-x-chapter-screen');
}

function loadDynamicChapters(cName) {
    const container = document.getElementById('ix-x-chapter-container');
    container.innerHTML = '';
    const matched = dynamicQuizzes.filter(q => (q.category || '').toLowerCase() === (cName.startsWith('WB') ? 'wb' : 'neet') && (q.classLevel || '').toLowerCase() === cName.toLowerCase().replace('wb ', ''));
    if (matched.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No tests found.</p>';
    } else {
        matched.forEach(q => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerText = q.title;
            card.addEventListener('click', () => prepareQuiz(q));
            container.appendChild(card);
        });
    }
    showScreen('ix-x-chapter-screen');
}

function loadNeetUnits(cName) {
    const container = document.getElementById('neet-unit-container');
    container.innerHTML = '';
    const units = neetHierarchy[cName] || {};
    Object.keys(units).forEach(uName => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = uName;
        card.addEventListener('click', () => { selectedNeetUnit = uName; loadNeetChapters(cName, uName); });
        container.appendChild(card);
    });
    showScreen('neet-unit-screen');
}

function loadNeetChapters(cName, uName) {
    const container = document.getElementById('neet-chapter-container');
    container.innerHTML = '';
    const chapters = neetHierarchy[cName]?.[uName] || [];
    if (chapters.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No chapters found.</p>';
    } else {
        chapters.forEach(chap => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerText = chap;
            card.addEventListener('click', () => { selectedNeetChapter = chap; loadNeetTopics(cName, uName, chap); });
            container.appendChild(card);
        });
    }
    showScreen('neet-chapter-screen');
}

function loadNeetTopics(cName, uName, chap) {
    const container = document.getElementById('neet-topic-container');
    container.innerHTML = '';
    const matched = dynamicQuizzes.filter(q => (q.category || '').toLowerCase() === 'neet' && (q.classLevel || '').toLowerCase() === cName.toLowerCase() && isChapterMatch(q.chapter, chap));
    if (matched.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No tests found for this chapter yet.</p>';
    } else {
        matched.forEach(q => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerText = q.title || q.topic || q.id;
            card.addEventListener('click', () => prepareQuiz(q));
            container.appendChild(card);
        });
    }
    showScreen('neet-topic-screen');
}

function prepareQuiz(quiz) {
    currentQuizId = quiz.id;
    activeQuizTitle = quiz.title;
    timeRemaining = quiz.duration || 900;
    quizDuration = timeRemaining;
    const optW = document.getElementById('otp-wrapper');
    if (optW) optW.remove();
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Verify & Start'; vBtn.disabled = false; }
    showScreen('name-screen');
}

function showOtpWrapper() {
    const vBtn = document.getElementById('verify-start-btn');
    const existing = document.getElementById('otp-wrapper');
    if (!existing && vBtn) {
        const wrapper = document.createElement('div');
        wrapper.id = 'otp-wrapper';
        wrapper.innerHTML = '<input type="number" id="otp-input" placeholder="Enter 6-digit OTP" style="text-align:center;letter-spacing:4px;margin-top:5px;margin-bottom:20px;">';
        document.getElementById('name-screen').insertBefore(wrapper, vBtn);
        vBtn.innerText = 'Start Quiz';
        vBtn.disabled = false;
    }
}

async function startQuiz() {
    const fEl = document.getElementById('first-name'), lEl = document.getElementById('last-name'), eEl = document.getElementById('email-address'), vBtn = document.getElementById('verify-start-btn');
    const first = fEl.value.trim().toUpperCase(), last = lEl.value.trim().toUpperCase(), email = eEl.value.trim().toLowerCase();

    fEl.value = first; lEl.value = last; eEl.value = email;
    if (!first || !last || !email) { alert('Please fill all fields.'); return; }

    const otpInput = document.getElementById('otp-input');
    if (!otpInput) {
        vBtn.innerText = 'Sending OTP...'; vBtn.disabled = true;
        const res = await fetch('/api/send-otp', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName: first, lastName: last, email })
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Failed to send verification.');
            vBtn.innerText = 'Verify & Start'; vBtn.disabled = false;
            return;
        }
        showOtpWrapper();
        updateState();
        return;
    }

    const otp = otpInput.value.trim();
    if (otp.length !== 6) { alert('Enter the 6-digit OTP.'); return; }

    vBtn.innerText = 'Verifying...'; vBtn.disabled = true;
    const vRes = await fetch('/api/verify-otp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp })
    });
    const vData = await vRes.json();
    if (!vRes.ok) {
        alert(vData.error || 'Invalid OTP');
        vBtn.innerText = 'Start Quiz'; vBtn.disabled = false;
        return;
    }

    const startRes = await fetch('/api/start-quiz', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
    });
    const startData = await startRes.json();
    if (!startRes.ok) {
        alert(startData.error || 'Verification Error.');
        vBtn.innerText = 'Start Quiz'; vBtn.disabled = false;
        return;
    }

    serverStartTime = startData.startTime;
    timerSignature = startData.signature;
    quizDuration = startData.duration || timeRemaining;
    timeRemaining = quizDuration;

    // Secure payload fetch with deobfuscation
    const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'PioneersPrepApp' }
    });
    
    if (qRes.ok) {
        const qData = await qRes.json();
        if (qData.securePayload) {
            const deobfuscated = decodeURIComponent(atob(qData.securePayload.split('').reverse().join('')));
            currentQuestions = JSON.parse(deobfuscated);
        } else {
            currentQuestions = qData;
        }
    } else {
        alert("Failed to load secure quiz payload.");
        return;
    }
    
    currentQuestionIndex = 0; userAnswers = {}; skippedQuestions = new Set(); screenHistory = [];

    showScreen('quiz-screen');
    renderQuestion();
    startTimer();
}

function updateQuizStats() {
    const total = currentQuestions.length;
    const attemptedCount = Object.keys(userAnswers).length;
    let skipped = 0;
    skippedQuestions.forEach(idx => { if (userAnswers[idx] === undefined) skipped++; });

    const statsEl = document.getElementById('quiz-stats');
    if (statsEl) statsEl.innerText = `Attempted: ${attemptedCount} / ${total} | Skipped: ${skipped}`;
    const bar = document.getElementById('progress-bar');
    if (bar && total > 0) bar.style.width = `${(attemptedCount / total) * 100}%`;
    updateState();
}

function renderQuestion() {
    document.getElementById('quiz-screen-heading').innerText = activeQuizTitle;
    const q = currentQuestions[currentQuestionIndex];
    document.getElementById('question-box').innerText = `Q.${currentQuestionIndex + 1}: ${q.question}`;
    const container = document.getElementById('options-container');
    container.innerHTML = '';

    if (q.type === 'descriptive' || q.type === 'diagram') {
        const label = document.createElement('label');
        label.innerText = q.type === 'diagram' ? 'Upload image of your drawn diagram/copy:' : 'Upload image of your written answer copy:';
        label.style.cssText = 'display:block;font-weight:600;margin-bottom:8px;color:#334155;';

        const fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.accept = 'image/*';

        if (userAnswers[currentQuestionIndex] !== undefined) {
            const preview = document.createElement('p');
            preview.style.color = '#15803d';
