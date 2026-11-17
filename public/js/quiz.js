// public/js/quiz.js
let screenHistory = [];
let dynamicQuizzes = [];
let currentQuizId = "";
let currentQuestionsCount = 0;
let questionCache = {};
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

// Variables for Premium/Ultra PDF Interception
let activePremiumPdf = null;
let activePremiumType = null;

function escapeClientHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function handleExpiredSession() {
    localStorage.clear();
    sessionStorage.removeItem('pioneers_prep_state');
    sessionStorage.setItem('force_login_open', 'true');
    alert('Session expired or account deregistered. Please sign in again.');
    window.location.replace('/');
}

// ANTI-SCRAPING: Client-Side XOR Decipher
function xorDecipher(b64Str, key) {
    const raw = atob(b64Str);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const k = new TextEncoder().encode(key);
    for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
    return new TextDecoder().decode(buf);
}

// DOM PROTECTION: Disable Right-Click and Copy Shortcuts during exams
document.addEventListener('contextmenu', e => {
    if (document.body.classList.contains('exam-mode')) e.preventDefault();
});
document.addEventListener('keydown', e => {
    if (document.body.classList.contains('exam-mode')) {
        if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) e.preventDefault();
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C' || e.key === 'p' || e.key === 'P')) e.preventDefault();
    }
});

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

function getBackupStorageKey() {
    const norm = MainNav.normalizeRoute(CURRENT_ROUTE);
    return `pioneers_backup_state_${norm}`;
}

function updateState() {
    if (isRestoringSession) return;
    const extraData = {
        selectedClassName,
        selectedSubjectName,
        currentQuestionsCount,
        questionCache,
        selectedNotesClass,
        selectedNotesSubject,
        selectedDescriptiveClass,
        selectedDescriptiveSubject,
        selectedNeetUnit,
        selectedNeetChapter
    };
    MainNav.saveSessionState(
        CURRENT_ROUTE, currentQuizId, activeQuizTitle, currentQuestionIndex,
        timeRemaining, quizDuration, serverStartTime, timerSignature,
        userAnswers, skippedQuestions, screenHistory,
        extraData
    );
    try {
        const activeScr = document.querySelector('.app-screen:not(.hidden)')?.id || 'home-dashboard';
        localStorage.setItem(getBackupStorageKey(), JSON.stringify({
            route: MainNav.normalizeRoute(CURRENT_ROUTE),
            activeScreen: activeScr,
            currentQuizId,
            activeQuizTitle,
            quizDuration,
            ...extraData
        }));
    } catch (e) {}
}

// Resolve target screen directly from the browser URL pathname
function getScreenFromUrlPath(normalizedRoute) {
    const path = window.location.pathname.toLowerCase().replace(/\/+$/, '');
    if (normalizedRoute === '/descriptive.html') {
        if (path.endsWith('/select-subject')) return 'descriptive-subject-screen';
        if (path.endsWith('/question-papers')) return 'descriptive-list-screen';
        if (path.endsWith('/live-assessment')) return 'quiz-screen';
        if (path.endsWith('/scorecard')) return 'result-screen';
        return null;
    }
    if (normalizedRoute === '/notes.html') {
        if (path.endsWith('/select-subject')) return 'notes-subject-screen';
        if (path.endsWith('/study-materials')) return 'notes-list-screen';
        return null;
    }
    if (normalizedRoute === '/test-portal.html') {
        if (path.endsWith('/select-subject')) return 'subject-select-screen';
        if (path.endsWith('/select-unit')) return 'neet-unit-screen';
        if (path.endsWith('/select-chapter')) return 'SELECT_CHAPTER_SCREEN';
        if (path.endsWith('/select-topic')) return 'neet-topic-screen';
        if (path.endsWith('/live-assessment')) return 'quiz-screen';
        if (path.endsWith('/scorecard')) return 'result-screen';
        return null;
    }
    return null;
}

window.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('pp_id_token');
    if (!token) {
        handleExpiredSession();
        return;
    }

    const normalizedRoute = MainNav.normalizeRoute(CURRENT_ROUTE);

    if (normalizedRoute === '/test-portal.html') {
        try {
            const res = await fetch('/api/quizzes', {
                credentials: 'same-origin',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.status === 401) {
                handleExpiredSession();
                return;
            }
            const data = await res.json();
            if (data.success) dynamicQuizzes = data.quizzes;
        } catch (e) {}
    }

    const params = new URLSearchParams(window.location.search);
    const queryClass = params.get('class');
    const querySubject = params.get('subject');
    const queryUnit = params.get('unit');
    const queryChapter = params.get('chapter');
    const queryQuiz = params.get('quiz');

    const urlScreen = getScreenFromUrlPath(normalizedRoute);
    let savedState = MainNav.getSavedState(CURRENT_ROUTE);

    // Fallback to cross-tab localStorage backup if pasting a deep URL in a new tab
    if (!savedState) {
        try {
            const rawBackup = localStorage.getItem(getBackupStorageKey());
            if (rawBackup) savedState = JSON.parse(rawBackup);
        } catch (e) {}
    }

    const navEntries = window.performance?.getEntriesByType?.('navigation') || [];
    const isReload = (navEntries[0]?.type === 'reload');

    // If user directly visited or pasted a deep sub-route URL (e.g. /descriptive-papers/question-papers)
    if (urlScreen) {
        const stateToRestore = Object.assign({}, savedState || {});
        if (queryClass) {
            stateToRestore.selectedClassName = queryClass;
            stateToRestore.selectedNotesClass = queryClass;
            stateToRestore.selectedDescriptiveClass = queryClass;
        }
        if (querySubject) {
            stateToRestore.selectedSubjectName = querySubject;
            stateToRestore.selectedNotesSubject = querySubject;
            stateToRestore.selectedDescriptiveSubject = querySubject;
        }
        if (queryUnit) stateToRestore.selectedNeetUnit = queryUnit;
        if (queryChapter) stateToRestore.selectedNeetChapter = queryChapter;
        if (queryQuiz) stateToRestore.currentQuizId = queryQuiz;

        if (urlScreen === 'SELECT_CHAPTER_SCREEN') {
            const cls = stateToRestore.selectedClassName || 'IX';
            const isNeetOrIsc = ['XI', 'XII', 'ISC XI', 'ISC XII'].includes(cls);
            stateToRestore.activeScreen = isNeetOrIsc ? 'neet-chapter-screen' : 'ix-x-chapter-screen';
        } else {
            stateToRestore.activeScreen = urlScreen;
        }

        await restoreSessionState(stateToRestore);
        return;
    }

    // If user visited a URL with ?class=... query param
    if (queryClass) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (normalizedRoute === '/test-portal.html') selectClass(queryClass);
        else if (normalizedRoute === '/notes.html') selectNotesClass(queryClass);
        else if (normalizedRoute === '/descriptive.html') selectDescriptiveClass(queryClass);
        return;
    }

    // If user hit F5 refresh on the base route with active state
    if (isReload && savedState && savedState.activeScreen && savedState.activeScreen !== 'home-dashboard') {
        await restoreSessionState(savedState);
        return;
    }

    // Otherwise show the root dashboard for the portal
    showScreen('home-dashboard');
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
        currentQuestionsCount = state.currentQuestionsCount || 0;
        questionCache = state.questionCache || {};
        userAnswers = state.userAnswers || {};
        skippedQuestions = new Set(state.skippedQuestions || []);

        const targetScreen = state.activeScreen || 'home-dashboard';

        // 1. DESCRIPTIVE PORTAL DEEP-URL & STATE RESTORATION
        if (targetScreen === 'descriptive-subject-screen') {
            if (!selectedDescriptiveClass) selectedDescriptiveClass = 'IX';
            buildDescriptiveSubjectDOM(selectedDescriptiveClass);
            screenHistory = ['home-dashboard'];
            showScreen('descriptive-subject-screen');
            return;
        }
        if (targetScreen === 'descriptive-list-screen') {
            if (!selectedDescriptiveClass) selectedDescriptiveClass = 'IX';
            if (!selectedDescriptiveSubject) {
                selectedDescriptiveSubject = (selectedDescriptiveClass === 'XI' || selectedDescriptiveClass === 'XII') ? 'Biology' : 'Physics';
            }
            buildDescriptiveSubjectDOM(selectedDescriptiveClass);
            const heading = document.getElementById('descriptive-screen-heading');
            if (heading) heading.innerText = `Class ${selectedDescriptiveClass} ${selectedDescriptiveSubject} Papers`;
            screenHistory = ['home-dashboard', 'descriptive-subject-screen'];
            showScreen('descriptive-list-screen');
            await populateDescriptiveList(selectedDescriptiveClass, selectedDescriptiveSubject);
            return;
        }

        // 2. STUDY NOTES PORTAL DEEP-URL & STATE RESTORATION
        if (targetScreen === 'notes-subject-screen') {
            if (!selectedNotesClass) selectedNotesClass = 'IX';
            buildNotesSubjectDOM(selectedNotesClass);
            screenHistory = ['home-dashboard'];
            showScreen('notes-subject-screen');
            return;
        }
        if (targetScreen === 'notes-list-screen') {
            if (!selectedNotesClass) selectedNotesClass = 'IX';
            if (!selectedNotesSubject) {
                selectedNotesSubject = (selectedNotesClass === 'XI' || selectedNotesClass === 'XII') ? 'Biology' : 'Physics';
            }
            buildNotesSubjectDOM(selectedNotesClass);
            screenHistory = ['home-dashboard', 'notes-subject-screen'];
            showScreen('notes-list-screen');
            await populateNotesList(selectedNotesClass, selectedNotesSubject);
            return;
        }

        // 3. MOCK TESTS PORTAL DEEP-URL & STATE RESTORATION
        if (targetScreen === 'subject-select-screen') {
            if (selectedClassName !== 'IX' && selectedClassName !== 'X') selectedClassName = 'IX';
            screenHistory = ['home-dashboard'];
            showScreen('subject-select-screen');
            return;
        }
        if (targetScreen === 'neet-unit-screen') {
            if (!['XI', 'XII', 'ISC XI', 'ISC XII'].includes(selectedClassName)) selectedClassName = 'XI';
            buildNeetUnitsDOM(selectedClassName);
            screenHistory = ['home-dashboard'];
            showScreen('neet-unit-screen');
            return;
        }
        if (targetScreen === 'neet-chapter-screen') {
            if (!['XI', 'XII', 'ISC XI', 'ISC XII'].includes(selectedClassName)) selectedClassName = 'XI';
            const baseClass = selectedClassName.includes('XII') ? 'XII' : 'XI';
            if (!selectedNeetUnit || !neetHierarchy[baseClass]?.[selectedNeetUnit]) {
                selectedNeetUnit = Object.keys(neetHierarchy[baseClass])[0];
            }
            buildNeetUnitsDOM(selectedClassName);
            buildNeetChaptersDOM(selectedClassName, selectedNeetUnit);
            screenHistory = ['home-dashboard', 'neet-unit-screen'];
            showScreen('neet-chapter-screen');
            return;
        }
        if (targetScreen === 'neet-topic-screen') {
            if (!['XI', 'XII', 'ISC XI', 'ISC XII'].includes(selectedClassName)) selectedClassName = 'XI';
            const baseClass = selectedClassName.includes('XII') ? 'XII' : 'XI';
            if (!selectedNeetUnit || !neetHierarchy[baseClass]?.[selectedNeetUnit]) {
                selectedNeetUnit = Object.keys(neetHierarchy[baseClass])[0];
            }
            const unitChapters = neetHierarchy[baseClass][selectedNeetUnit] || [];
            if (!selectedNeetChapter || !unitChapters.includes(selectedNeetChapter)) {
                selectedNeetChapter = unitChapters[0] || '';
            }
            buildNeetUnitsDOM(selectedClassName);
            buildNeetChaptersDOM(selectedClassName, selectedNeetUnit);
            buildNeetTopicsDOM(selectedClassName, selectedNeetUnit, selectedNeetChapter);
            screenHistory = ['home-dashboard', 'neet-unit-screen', 'neet-chapter-screen'];
            showScreen('neet-topic-screen');
            return;
        }
        if (targetScreen === 'ix-x-chapter-screen') {
            if (!selectedClassName) selectedClassName = 'IX';
            if (selectedClassName === 'IX' || selectedClassName === 'X') {
                if (!selectedSubjectName) selectedSubjectName = 'Physics';
                buildIxXChapterDOM(selectedClassName, selectedSubjectName);
                screenHistory = ['home-dashboard', 'subject-select-screen'];
            } else {
                buildDynamicChaptersDOM(selectedClassName);
                screenHistory = ['home-dashboard'];
            }
            showScreen('ix-x-chapter-screen');
            return;
        }

        // 4. ACTIVE QUIZ OR SCORECARD DEEP-URL RESTORATION (Enforces Auth, Purchase & Availability)
        if (targetScreen === 'quiz-screen' && currentQuizId) {
            if (serverStartTime && timerSignature && quizDuration) {
                // Verify quiz access & active session with server
                const token = localStorage.getItem('pp_id_token');
                const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                    credentials: 'same-origin',
                    headers: {
                        'X-Requested-With': 'PioneersPrepApp',
                        'Authorization': `Bearer ${token}`
                    }
                });
                if (qRes.status === 401) {
                    handleExpiredSession();
                    return;
                }
                if (qRes.status === 402 || qRes.status === 403 || !qRes.ok) {
                    isRestoringSession = false;
                    prepareQuiz({ id: currentQuizId, title: activeQuizTitle || currentQuizId, duration: quizDuration });
                    return;
                }
                const metaData = await qRes.json();
                currentQuestionsCount = metaData.totalQuestions || currentQuestionsCount;
                timeRemaining = Math.max(0, quizDuration - Math.floor((Date.now() - serverStartTime) / 1000));
                showScreen('quiz-screen');
                await renderQuestion();
                startTimer();
            } else {
                isRestoringSession = false;
                prepareQuiz({ id: currentQuizId, title: activeQuizTitle || currentQuizId, duration: quizDuration });
            }
            return;
        }

        if (targetScreen === 'result-screen' && currentQuizId) {
            const token = localStorage.getItem('pp_id_token');
            const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
                credentials: 'same-origin',
                headers: {
                    'X-Requested-With': 'PioneersPrepApp',
                    'Authorization': `Bearer ${token}`
                }
            });
            if (qRes.status === 401) {
                handleExpiredSession();
                return;
            }
            showScreen('result-screen');
            return;
        }

        showScreen('home-dashboard');
    } catch (e) {
        showScreen('home-dashboard');
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
    activePremiumPdf = null;
    activePremiumType = null;
    MainNav.clearExamMode();
    sessionStorage.removeItem('pioneers_prep_state');
    document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('home-dashboard')?.classList.remove('hidden');
    updateState();
}

// ----------------------------------------------------------------------------
// UNIVERSAL CONTENT CARD RENDERER
// ----------------------------------------------------------------------------
function createContentCard(item, type, container) {
    const card = document.createElement(item.isAvailable === false ? 'div' : 'a');
    let icon = '';
    if (type === 'descriptive') icon = '📝 ';
    if (type === 'notes') icon = '📚 ';
    const title = type === 'quiz' ? (item.title || item.topic || item.id) : (icon + item.name);

    if (item.isAvailable === false) {
        card.className = type === 'quiz' ? 'card' : 'card card-yellow';
        card.style.opacity = '0.55';
        card.style.cursor = 'not-allowed';
        card.style.backgroundColor = '#f8fafc';
        card.innerHTML = `${escapeClientHtml(title)} <br><span style="font-size: 13px; color: #dc2626; font-weight: 700; margin-top: 6px; display: inline-block;">⏳ Coming Soon</span>`;
        card.addEventListener('click', (e) => {
            e.preventDefault();
            alert('This content is currently under preparation and will be available soon.');
        });
    } else {
        card.className = type === 'quiz' ? 'card' : (type === 'descriptive' ? 'card card-yellow' : 'card');
        if (item.isPremium || item.isUltra) {
            const badgeColor = item.isUltra ? '#9333ea' : '#b45309';
            const badgeLabel = item.isUltra ? 'Exclusive' : 'Premium';
            card.innerHTML = `${escapeClientHtml(title)} <br><span style="font-size: 13px; color: ${badgeColor}; font-weight: 700; margin-top: 6px; display: inline-block;">🔒 ${badgeLabel} (₹${item.price || 49})</span>`;
        } else {
            card.innerText = title;
        }

        if (type === 'quiz' || item.isJsonQuiz) {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                prepareQuiz({ 
                    id: item.id || item.fileName.replace('.json', ''), 
                    title: item.title || item.name, 
                    duration: item.duration 
                });
            });
        } else {
            if (item.isPremium || item.isUltra) {
                card.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    preparePremiumPdf(item, type);
                });
            } else {
                card.href = (type === 'notes' ? '/api/download-note/' : '/api/download-descriptive/') + encodeURIComponent(item.fileName);
            }
        }
    }
    container.appendChild(card);
}

// ----------------------------------------------------------------------------
// DESCRIPTIVE PAPERS DOM BUILDERS
// ----------------------------------------------------------------------------
function buildDescriptiveSubjectDOM(cName) {
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
}
function selectDescriptiveClass(cName) {
    selectedDescriptiveClass = cName;
    buildDescriptiveSubjectDOM(cName);
    showScreen('descriptive-subject-screen');
}
async function populateDescriptiveList(cName, subject) {
    const container = document.getElementById('descriptive-list-container');
    if (!container) return;
    const token = localStorage.getItem('pp_id_token');
    try {
        const res = await fetch('/api/descriptive-questions', {
            credentials: 'same-origin',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401) {
            handleExpiredSession();
            return;
        }
        const list = await res.json();
        const matched = list.find(n => n.class === cName && n.subject.toLowerCase() === subject.toLowerCase());
        container.innerHTML = '';
        if (matched?.papers?.length > 0) {
            matched.papers.forEach(item => createContentCard(item, 'descriptive', container));
        } else {
            container.innerHTML = `<p style="text-align:center; color:#854d0e;">No question papers available for ${escapeClientHtml(subject)} yet.</p>`;
        }
    } catch {
        container.innerHTML = '<p style="text-align:center; color:red;">Failed to load papers.</p>';
    }
}
async function selectDescriptiveSubject(subject) {
    selectedDescriptiveSubject = subject;
    const heading = document.getElementById('descriptive-screen-heading');
    if (heading) heading.innerText = `Class ${selectedDescriptiveClass} ${subject} Papers`;
    const container = document.getElementById('descriptive-list-container');
    if (container) container.innerHTML = '<p style="text-align:center;">Loading question papers...</p>';
    showScreen('descriptive-list-screen');
    await populateDescriptiveList(selectedDescriptiveClass, subject);
    updateState();
}

// ----------------------------------------------------------------------------
// STUDY NOTES DOM BUILDERS
// ----------------------------------------------------------------------------
function buildNotesSubjectDOM(cName) {
    const container = document.getElementById('notes-subject-container');
    if (!container) return;
    container.innerHTML = '';
    const subjects = (cName === 'IX' || cName === 'X') ? ['Physics', 'Chemistry', 'Biology'] : ['Biology'];
    subjects.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = sub;
        card.addEventListener('click', () => selectNotesSubject(sub));
        container.appendChild(card);
    });
}
function selectNotesClass(cName) {
    selectedNotesClass = cName;
    buildNotesSubjectDOM(cName);
    showScreen('notes-subject-screen');
}
async function populateNotesList(cName, subject) {
    const container = document.getElementById('notes-list-container');
    if (!container) return;
    const token = localStorage.getItem('pp_id_token');
    try {
        const res = await fetch('/api/notes', {
            credentials: 'same-origin',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401) {
            handleExpiredSession();
            return;
        }
        const list = await res.json();
        const matched = list.find(n => n.class === cName && n.subject.toLowerCase() === subject.toLowerCase());
        container.innerHTML = '';
        if (matched?.notes?.length > 0) {
            matched.notes.forEach(note => createContentCard(note, 'notes', container));
        } else {
            container.innerHTML = '<p style="text-align:center;">No notes available for this subject yet.</p>';
        }
    } catch {
        container.innerHTML = '<p style="text-align:center; color:red;">Failed to load notes.</p>';
    }
}
async function selectNotesSubject(subject) {
    selectedNotesSubject = subject;
    const container = document.getElementById('notes-list-container');
    if (container) container.innerHTML = '<p style="text-align:center;">Loading notes...</p>';
    showScreen('notes-list-screen');
    await populateNotesList(selectedNotesClass, subject);
    updateState();
}

// ----------------------------------------------------------------------------
// MOCK TESTS DOM BUILDERS
// ----------------------------------------------------------------------------
function selectClass(cName) {
    selectedClassName = cName;
    if (cName === 'IX' || cName === 'X') showScreen('subject-select-screen');
    else if (cName === 'XI' || cName === 'XII' || cName === 'ISC XI' || cName === 'ISC XII') {
        buildNeetUnitsDOM(cName);
        showScreen('neet-unit-screen');
    } else {
        buildDynamicChaptersDOM(cName);
        showScreen('ix-x-chapter-screen');
    }
}

function buildNeetUnitsDOM(cName) {
    const container = document.getElementById('neet-unit-container');
    if (!container) return;
    container.innerHTML = '';
    const baseClass = cName.includes('XII') ? 'XII' : 'XI';
    const units = neetHierarchy[baseClass] || {};
    Object.keys(units).forEach(uName => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerText = uName;
        card.addEventListener('click', () => selectNeetUnit(cName, uName));
        container.appendChild(card);
    });
}
function selectNeetUnit(cName, uName) {
    selectedNeetUnit = uName;
    buildNeetChaptersDOM(cName, uName);
    showScreen('neet-chapter-screen');
}

function buildNeetChaptersDOM(cName, uName) {
    const container = document.getElementById('neet-chapter-container');
    if (!container) return;
    container.innerHTML = '';
    const baseClass = cName.includes('XII') ? 'XII' : 'XI';
    const chapters = neetHierarchy[baseClass]?.[uName] || [];
    if (chapters.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No chapters found.</p>';
    } else {
        chapters.forEach(chap => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerText = chap;
            card.addEventListener('click', () => selectNeetChapter(cName, uName, chap));
            container.appendChild(card);
        });
    }
}
function selectNeetChapter(cName, uName, chap) {
    selectedNeetChapter = chap;
    buildNeetTopicsDOM(cName, uName, chap);
    showScreen('neet-topic-screen');
}

function buildNeetTopicsDOM(cName, uName, chap) {
    const container = document.getElementById('neet-topic-container');
    if (!container) return;
    container.innerHTML = '';
    const upperCName = String(cName).toUpperCase();
    const targetCategory = upperCName.startsWith('ISC') ? 'isc' : 'neet';
    const targetClass = upperCName.includes('XII') ? 'xii' : 'xi';
    const matched = dynamicQuizzes.filter(q => 
        (q.category || '').toLowerCase() === targetCategory && 
        (q.classLevel || '').toLowerCase() === targetClass && 
        isChapterMatch(q.chapter, chap)
    );
    if (matched.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No tests found for this chapter yet.</p>';
    } else {
        matched.forEach(q => createContentCard(q, 'quiz', container));
    }
}

function selectSubject(sub) {
    selectedSubjectName = sub;
    buildIxXChapterDOM(selectedClassName, sub);
    showScreen('ix-x-chapter-screen');
}
function buildIxXChapterDOM(cName, sub) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';
    const matched = dynamicQuizzes.filter(q => q.category === 'icse' && q.classLevel.toLowerCase() === cName.toLowerCase() && q.subject.toLowerCase() === sub.toLowerCase());
    if (matched.length === 0) {
        container.innerHTML = `<p style="text-align:center;">No tests found for ${escapeClientHtml(sub)} yet.</p>`;
    } else {
        matched.forEach(q => createContentCard(q, 'quiz', container));
    }
}

function buildDynamicChaptersDOM(cName) {
    const container = document.getElementById('ix-x-chapter-container');
    if (!container) return;
    container.innerHTML = '';
    let targetCategory = 'neet';
    let cleanClassLevel = cName;
    if (cName.toUpperCase().startsWith('WB ')) {
        targetCategory = 'wb';
        cleanClassLevel = cName.substring(3).trim();
    } else if (cName.toUpperCase().startsWith('ISC ')) {
        targetCategory = 'isc';
        cleanClassLevel = cName.substring(4).trim();
    }
    const matched = dynamicQuizzes.filter(q => 
        (q.category || '').toLowerCase() === targetCategory && 
        (q.classLevel || '').toLowerCase() === cleanClassLevel.toLowerCase()
    );
    if (matched.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No tests found.</p>';
    } else {
        matched.forEach(q => createContentCard(q, 'quiz', container));
    }
}

// ----------------------------------------------------------------------------
// GLOBAL SSO BYPASS & CONTENT ENTRY
// ----------------------------------------------------------------------------
function prepareQuiz(quiz) {
    const token = localStorage.getItem('pp_id_token');
    if (!token) {
        sessionStorage.setItem('force_login_open', 'true');
        alert('Please sign in on the homepage first.');
        window.location.replace('/');
        return;
    }

    activePremiumPdf = null;
    activePremiumType = null;
    currentQuizId = quiz.id;
    activeQuizTitle = quiz.title;
    timeRemaining = quiz.duration || 900;
    quizDuration = timeRemaining;

    attemptQuizStart();
}

function preparePremiumPdf(item, type) {
    const token = localStorage.getItem('pp_id_token');
    if (!token) {
        sessionStorage.setItem('force_login_open', 'true');
        alert('Please sign in on the homepage first.');
        window.location.replace('/');
        return;
    }

    currentQuizId = "";
    activePremiumPdf = item;
    activePremiumType = type;

    attemptPdfDownload();
}

// ----------------------------------------------------------------------------
// RAZORPAY CHECKOUT ENGINE
// ----------------------------------------------------------------------------
async function initiateRazorpayPayment(itemId, amount, email, firstName, lastName, onSuccessCallback) {
    try {
        const token = localStorage.getItem('pp_id_token');
        const orderRes = await fetch('/api/create-order', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ itemId })
        });
        if (orderRes.status === 401) {
            handleExpiredSession();
            return;
        }
        const orderData = await orderRes.json();

        if (!orderRes.ok) {
            alert(orderData.error || 'Failed to create payment order.');
            return;
        }

        const options = {
            key: orderData.keyId,
            amount: orderData.amount,
            currency: "INR",
            name: "Pioneers Prep",
            description: "Premium Content Access",
            order_id: orderData.orderId,
            handler: async function (response) {
                const verifyRes = await fetch('/api/verify-payment', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_signature: response.razorpay_signature,
                        itemId: itemId
                    })
                });
                const verifyData = await verifyRes.json();
                if (verifyRes.ok && verifyData.success) {
                    alert('Payment successful! Content unlocked.');
                    onSuccessCallback();
                } else {
                    alert('Payment verification failed. Please contact support.');
                }
            },
            prefill: { name: firstName + ' ' + lastName, email: email },
            theme: { color: "#ca8a04" }
        };
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response) {
            alert('Payment failed: ' + response.error.description);
        });
        rzp.open();
    } catch (err) {
        alert('Network error during payment initialization.');
    }
}

// ----------------------------------------------------------------------------
// PRIMARY ACCESS FLOW (PAYWALL -> CONTENT)
// ----------------------------------------------------------------------------
async function attemptQuizStart() {
    const token = localStorage.getItem('pp_id_token');
    const first = localStorage.getItem('pp_fname');
    const last = localStorage.getItem('pp_lname');
    const email = localStorage.getItem('pp_email');

    try {
        const startRes = await fetch('/api/start-quiz', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
        });
        const startData = await startRes.json();

        if (startRes.status === 401) {
            handleExpiredSession();
            return;
        }

        if (startRes.status === 402) {
            const qz = dynamicQuizzes.find(q => q.id === currentQuizId);
            const price = qz ? qz.price : 49;
            initiateRazorpayPayment(currentQuizId, price, email, first, last, () => attemptQuizStart());
            return;
        }
        
        if (startRes.status === 403) {
            alert(startData.error || 'Access denied. Your email is not whitelisted or this test is not yet available.');
            return;
        }

        if (!startRes.ok) {
            alert(startData.error || 'Verification Error.');
            return;
        }

        serverStartTime = startData.startTime;
        timerSignature = startData.signature;
        quizDuration = startData.duration || timeRemaining;
        timeRemaining = quizDuration;

        const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
            credentials: 'same-origin',
            headers: { 
                'X-Requested-With': 'PioneersPrepApp',
                'Authorization': `Bearer ${token}` 
            }
        });
        if (qRes.status === 401) {
            handleExpiredSession();
            return;
        }
        const metaData = await qRes.json();
        currentQuestionsCount = metaData.totalQuestions || 0;

        currentQuestionIndex = 0;
        userAnswers = {};
        skippedQuestions = new Set();
        screenHistory = [];
        questionCache = {};

        const qBox = document.getElementById('question-box');
        const oBox = document.getElementById('options-container');
        if (qBox) qBox.innerText = 'Loading Question 1...';
        if (oBox) oBox.innerHTML = '';

        showScreen('quiz-screen');
        await renderQuestion();
        startTimer();
    } catch (err) {
        alert('Network error while starting quiz. Please try again.');
    }
}

async function attemptPdfDownload() {
    const token = localStorage.getItem('pp_id_token');
    const first = localStorage.getItem('pp_fname');
    const last = localStorage.getItem('pp_lname');
    const email = localStorage.getItem('pp_email');

    const endpoint = activePremiumType === 'notes' ? '/api/download-note/' : '/api/download-descriptive/';
    const url = endpoint + encodeURIComponent(activePremiumPdf.fileName);

    const res = await fetch(url, { 
        credentials: 'same-origin',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    if (res.status === 401) {
        handleExpiredSession();
        return;
    }

    if (res.status === 402 || res.status === 403) {
        initiateRazorpayPayment(activePremiumPdf.fileName, activePremiumPdf.price || 49, email, first, last, () => {
            window.location.href = url;
        });
        return;
    }

    if (!res.ok) {
        alert('Failed to access file. Error ' + res.status);
        return;
    }

    window.location.href = url;
}

function updateQuizStats() {
    const total = currentQuestionsCount;
    const attemptedCount = Object.keys(userAnswers).length;
    let skipped = 0;
    skippedQuestions.forEach(idx => { if (userAnswers[idx] === undefined) skipped++; });

    const statsEl = document.getElementById('quiz-stats');
    if (statsEl) statsEl.innerText = `Attempted: ${attemptedCount} / ${total} | Skipped: ${skipped}`;
    const bar = document.getElementById('progress-bar');
    if (bar && total > 0) bar.style.width = `${(attemptedCount / total) * 100}%`;
    updateState();
}

async function renderQuestion() {
    document.getElementById('quiz-screen-heading').innerText = activeQuizTitle;
    const container = document.getElementById('options-container');
    const questionBox = document.getElementById('question-box');
    const token = localStorage.getItem('pp_id_token');

    if (!questionCache[currentQuestionIndex]) {
        questionBox.innerText = `Loading Question ${currentQuestionIndex + 1}...`;
        container.innerHTML = '';
        try {
            const res = await fetch(`/api/quiz/${encodeURIComponent(currentQuizId)}/question/${currentQuestionIndex}`, {
                credentials: 'same-origin',
                headers: { 
                    'X-Requested-With': 'PioneersPrepApp',
                    'Authorization': `Bearer ${token}` 
                }
            });
            if (res.status === 401) {
                handleExpiredSession();
                return;
            }
            const data = await res.json();
            if (data.payload) {
                questionCache[currentQuestionIndex] = JSON.parse(xorDecipher(data.payload, timerSignature));
            } else {
                throw new Error("Invalid payload");
            }
        } catch (e) {
            questionBox.innerText = "Connection error. Please check your internet and try again.";
            return;
        }
    }

    const q = questionCache[currentQuestionIndex];
    questionBox.innerText = `Q.${currentQuestionIndex + 1}: ${q.question}`;
    container.innerHTML = '';

    if (q.type === 'descriptive' || q.type === 'diagram') {
        const label = document.createElement('label');
        label.innerText = q.type === 'diagram' ? 'Upload image of your drawn diagram/copy:' : 'Upload image of your written answer copy:';
        label.style.cssText = 'display:block;font-weight:600;margin-bottom:8px;color:#334155;';

        const fileInput = document.createElement('input');
        fileInput.type = 'file'; 
        fileInput.accept = 'image/*';
        fileInput.setAttribute('capture', 'environment');

        if (userAnswers[currentQuestionIndex] !== undefined) {
            const preview = document.createElement('p');
            preview.style.color = '#15803d';
            preview.textContent = '✅ Image uploaded successfully for this question.';
            container.appendChild(preview);
        }

        fileInput.addEventListener('change', e => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = event => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width, height = img.height;
                    const maxDim = 800;
                    if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
                    else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
                    canvas.width = width; canvas.height = height;
                    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
                    userAnswers[currentQuestionIndex] = canvas.toDataURL('image/jpeg', 0.7);
                    skippedQuestions.delete(currentQuestionIndex);
                    updateQuizStats();
                    alert('Image attached successfully! Click Next to proceed.');
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });
        container.appendChild(label); container.appendChild(fileInput);
    } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
        const input = document.createElement('input');
        input.type = 'text'; input.placeholder = 'Type your answer here...';
        if (userAnswers[currentQuestionIndex] !== undefined) input.value = userAnswers[currentQuestionIndex];
        input.addEventListener('input', e => {
            const v = e.target.value.trim();
            if (v === '') delete userAnswers[currentQuestionIndex];
            else { userAnswers[currentQuestionIndex] = v; skippedQuestions.delete(currentQuestionIndex); }
            updateQuizStats();
        });
        container.appendChild(input);
    } else {
        q.options.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.className = `option-btn${userAnswers[currentQuestionIndex] === idx ? ' selected' : ''}`;
            btn.innerText = opt;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                userAnswers[currentQuestionIndex] = idx;
                skippedQuestions.delete(currentQuestionIndex);
                updateQuizStats();
            });
            container.appendChild(btn);
        });
    }
    updateQuizStats();
}

async function nextQuestion() {
    if (userAnswers[currentQuestionIndex] === undefined) skippedQuestions.add(currentQuestionIndex);
    if (currentQuestionIndex < currentQuestionsCount - 1) { 
        currentQuestionIndex++; 
        await renderQuestion(); 
    } else { 
        updateQuizStats(); 
    }
    updateState();
}

async function prevQuestion() {
    if (currentQuestionIndex > 0) { 
        currentQuestionIndex--; 
        await renderQuestion(); 
    }
    updateState();
}

function clearResponse() {
    delete userAnswers[currentQuestionIndex];
    document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
    const input = document.querySelector('#options-container input');
    if (input) input.value = '';
    updateQuizStats();
}

function startTimer() {
    clearInterval(timerInterval);
    const update = () => {
        let m = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
        let s = (timeRemaining % 60).toString().padStart(2, '0');
        document.getElementById('time-left').innerText = `Time Left: ${m}:${s}`;
        updateState();
    };
    update();
    timerInterval = setInterval(() => {
        if (timeRemaining <= 0) { clearInterval(timerInterval); submitQuiz(true); return; }
        timeRemaining--; update();
    }, 1000);
}

async function submitQuiz(isAuto = false) {
    const answeredCount = Object.keys(userAnswers).length;
    const total = currentQuestionsCount;
    if (!isAuto && answeredCount < total) {
        alert(`Please answer all questions before submitting. You have answered ${answeredCount} out of ${total}.`);
        return;
    }

    clearInterval(timerInterval);
    const submitBtn = document.getElementById('submit-btn');
    if (submitBtn) { submitBtn.innerText = 'Submitting...'; submitBtn.disabled = true; }

    const token = localStorage.getItem('pp_id_token');
    const first = localStorage.getItem('pp_fname') || 'STUDENT';
    const last = localStorage.getItem('pp_lname') || '';
    const email = localStorage.getItem('pp_email') || '';

    try {
        const res = await fetch('/api/submit', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({
                firstName: first, lastName: last, email,
                className: selectedClassName, chapterTitle: activeQuizTitle, quizId: currentQuizId,
                userAnswers, serverStartTime, timerSignature, quizDuration, isAutoSubmit: isAuto
            })
        });
        if (res.status === 401) {
            handleExpiredSession();
            return;
        }
        const data = await res.json();
        if (res.ok && data.success) {
            sessionStorage.removeItem('pioneers_prep_state');
            let resultScreen = document.getElementById('result-screen');
            if (!resultScreen) {
                const mainEl = document.querySelector('main.site-main') || document.body;
                resultScreen = document.createElement('div');
                resultScreen.id = 'result-screen';
                resultScreen.className = 'app-screen hidden';
                mainEl.appendChild(resultScreen);
            }
            screenHistory = [];
            showScreen('result-screen');
            try {
                const resultState = {
                    activeScreen: 'result-screen',
                    screenHistory: [],
                    currentQuizId: currentQuizId,
                    activeQuizTitle: activeQuizTitle
                };
                sessionStorage.setItem('pioneers_prep_state', JSON.stringify(resultState));
            } catch (err) {}
            triggerCelebration();
        } else {
            alert(data.error || 'Submission failed.');
            goHome();
        }
    } catch {
        alert('Network error while submitting quiz.');
    } finally {
        if (submitBtn) { submitBtn.innerText = 'Submit Quiz'; submitBtn.disabled = false; }
    }
}

// ============================================================================
// MOBILE QUIZ SCREEN OPTIMIZER
// ============================================================================
(function optimizeMobileQuiz() {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (!isMobile) return;

    const mobileQuizStyles = `
        #quiz-screen:not(.hidden) {
            padding: 15px 10px !important;
            border-radius: 0 !important;
            min-height: 100vh !important;
            box-shadow: none !important;
        }
        #question-box {
            font-size: 17px !important;
            line-height: 1.5 !important;
            margin-bottom: 20px !important;
        }
        .option-btn {
            padding: 14px 16px !important;
            font-size: 15px !important;
            margin-bottom: 10px !important;
            border-radius: 8px !important;
        }
        .quiz-nav-container {
            flex-direction: column !important;
            gap: 10px !important;
            margin-top: 20px !important;
        }
        .quiz-nav-container button {
            width: 100% !important;
            max-width: 100% !important;
            padding: 12px !important;
            font-size: 15px !important;
        }
    `;

    window.addEventListener('DOMContentLoaded', () => {
        const styleElement = document.createElement('style');
        styleElement.id = 'mobile-quiz-custom-styles';
        styleElement.innerHTML = mobileQuizStyles;
        document.head.appendChild(styleElement);
    });
})();

function triggerCelebration() {
    if (typeof confetti !== 'function') return;
    const duration = 3000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

    const interval = setInterval(function() {
        const timeLeft = animationEnd - Date.now();
        if (timeLeft <= 0) return clearInterval(interval);
        const particleCount = 50 * (timeLeft / duration);
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: Math.random() * 0.2 + 0.1, y: Math.random() - 0.2 } }));
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: Math.random() * 0.2 + 0.7, y: Math.random() - 0.2 } }));
    }, 250);
}