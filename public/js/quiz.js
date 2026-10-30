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
let quizCipherKey = "";
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

function updateState() {
    if (isRestoringSession) return;
    MainNav.saveSessionState(
        CURRENT_ROUTE, currentQuizId, activeQuizTitle, currentQuestionIndex,
        timeRemaining, quizDuration, serverStartTime, timerSignature,
        userAnswers, skippedQuestions, screenHistory,
        { selectedClassName, selectedSubjectName, selectedNotesClass, selectedNotesSubject, selectedDescriptiveClass, selectedDescriptiveSubject, selectedNeetUnit, selectedNeetChapter, quizCipherKey }
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
            console.error("Failed to load quizzes", e);
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
        quizCipherKey = state.quizCipherKey || '';
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
                const encryptedData = await qRes.json();
                if (encryptedData.payload && quizCipherKey) {
                    currentQuestions = JSON.parse(xorDecipher(encryptedData.payload, quizCipherKey));
                } else {
                    currentQuestions = encryptedData;
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
    activePremiumPdf = null;
    activePremiumType = null;
    MainNav.clearExamMode();
    sessionStorage.removeItem('pioneers_prep_state');
    const optW = document.getElementById('otp-wrapper');
    if (optW) optW.remove();
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Verify & Start'; vBtn.disabled = false; }
    document.querySelectorAll('.app-screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('home-dashboard')?.classList.remove('hidden');
}

// ----------------------------------------------------------------------------
// UNIVERSAL CONTENT CARD RENDERER (SUPPORTS COMING SOON, PRO & ULTRA TIERS)
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

        if (type === 'quiz') {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                prepareQuiz(item);
            });
        } else {
            if (item.isPremium || item.isUltra) {
                card.addEventListener('click', (e) => {
                    e.preventDefault();
                    preparePremiumPdf(item, type);
                });
            } else {
                card.href = (type === 'notes' ? '/api/download-note/' : '/api/download-descriptive/') + encodeURIComponent(item.fileName);
            }
        }
    }
    container.appendChild(card);
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
            matched.papers.forEach(item => createContentCard(item, 'descriptive', container));
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
            matched.notes.forEach(note => createContentCard(note, 'notes', container));
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
        matched.forEach(q => createContentCard(q, 'quiz', container));
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
        matched.forEach(q => createContentCard(q, 'quiz', container));
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
        matched.forEach(q => createContentCard(q, 'quiz', container));
    }
    showScreen('neet-topic-screen');
}

function prepareQuiz(quiz) {
    activePremiumPdf = null;
    activePremiumType = null;
    currentQuizId = quiz.id;
    activeQuizTitle = quiz.title;
    timeRemaining = quiz.duration || 900;
    quizDuration = timeRemaining;

    const h2 = document.getElementById('name-screen')?.querySelector('h2');
    if (h2) h2.innerText = "Candidate Verification";

    const optW = document.getElementById('otp-wrapper');
    if (optW) optW.remove();
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Verify & Start'; vBtn.disabled = false; }
    showScreen('name-screen');
}

function preparePremiumPdf(item, type) {
    currentQuizId = "";
    activePremiumPdf = item;
    activePremiumType = type;

    const h2 = document.getElementById('name-screen')?.querySelector('h2');
    if (h2) h2.innerText = "Premium Access Verification";

    const optW = document.getElementById('otp-wrapper');
    if (optW) optW.remove();
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Verify Email'; vBtn.disabled = false; }
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
        vBtn.innerText = activePremiumPdf ? 'Proceed' : 'Start Quiz';
        vBtn.disabled = false;
    }
}

// ----------------------------------------------------------------------------
// RAZORPAY CHECKOUT ENGINE
// ----------------------------------------------------------------------------
async function initiateRazorpayPayment(itemId, amount, email, firstName, lastName, onSuccessCallback) {
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) { vBtn.innerText = 'Initializing Payment...'; vBtn.disabled = true; }

    try {
        const orderRes = await fetch('/api/create-order', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId, amount })
        });
        const orderData = await orderRes.json();

        if (!orderRes.ok) {
            alert(orderData.error || 'Failed to create payment order.');
            if (vBtn) { vBtn.innerText = 'Retry'; vBtn.disabled = false; }
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
                if (vBtn) { vBtn.innerText = 'Verifying Payment...'; }
                const verifyRes = await fetch('/api/verify-payment', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
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
                    if (vBtn) { vBtn.innerText = 'Retry'; vBtn.disabled = false; }
                }
            },
            prefill: { name: firstName + ' ' + lastName, email: email },
            theme: { color: "#ca8a04" }
        };
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', function (response) {
            alert('Payment failed: ' + response.error.description);
            if (vBtn) { vBtn.innerText = 'Retry'; vBtn.disabled = false; }
        });
        rzp.open();
    } catch (err) {
        alert('Network error during payment initialization.');
        if (vBtn) { vBtn.innerText = 'Retry'; vBtn.disabled = false; }
    }
}

// ----------------------------------------------------------------------------
// PRIMARY ACCESS FLOW (OTP -> PAYWALL -> CONTENT)
// ----------------------------------------------------------------------------
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
            vBtn.innerText = activePremiumPdf ? 'Verify Email' : 'Verify & Start';
            vBtn.disabled = false;
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
        vBtn.innerText = activePremiumPdf ? 'Proceed' : 'Start Quiz';
        vBtn.disabled = false;
        return;
    }

    if (activePremiumPdf) {
        await attemptPdfDownload(first, last, email);
    } else if (currentQuizId) {
        await attemptQuizStart(first, last, email);
    }
}

async function attemptQuizStart(first, last, email) {
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) vBtn.innerText = 'Starting...';

    const startRes = await fetch('/api/start-quiz', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
    });
    const startData = await startRes.json();

    if (startRes.status === 402) {
        const qz = dynamicQuizzes.find(q => q.id === currentQuizId);
        const price = qz ? qz.price : 49;
        initiateRazorpayPayment(currentQuizId, price, email, first, last, () => attemptQuizStart(first, last, email));
        return;
    }

    if (!startRes.ok) {
        alert(startData.error || 'Verification Error.');
        if (vBtn) { vBtn.innerText = 'Start Quiz'; vBtn.disabled = false; }
        return;
    }

    serverStartTime = startData.startTime;
    timerSignature = startData.signature;
    quizDuration = startData.duration || timeRemaining;
    timeRemaining = quizDuration;
    quizCipherKey = startData.cipherKey || '';

    const qRes = await fetch('/api/quiz/' + encodeURIComponent(currentQuizId), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'PioneersPrepApp' }
    });
    const encryptedData = await qRes.json();

    if (encryptedData.payload && quizCipherKey) {
        currentQuestions = JSON.parse(xorDecipher(encryptedData.payload, quizCipherKey));
    } else {
        currentQuestions = encryptedData;
    }

    currentQuestionIndex = 0; userAnswers = {}; skippedQuestions = new Set(); screenHistory = [];

    showScreen('quiz-screen');
    renderQuestion();
    startTimer();
}

async function attemptPdfDownload(first, last, email) {
    const vBtn = document.getElementById('verify-start-btn');
    if (vBtn) vBtn.innerText = 'Accessing...';

    const endpoint = activePremiumType === 'notes' ? '/api/download-note/' : '/api/download-descriptive/';
    const url = endpoint + encodeURIComponent(activePremiumPdf.fileName);

    const res = await fetch(url, { credentials: 'same-origin' });

    if (res.status === 402) {
        initiateRazorpayPayment(activePremiumPdf.fileName, activePremiumPdf.price || 49, email, first, last, () => {
            window.location.href = url;
            goHome();
        });
        return;
    }

    if (!res.ok) {
        alert('Failed to access file. Error ' + res.status);
        if (vBtn) { vBtn.innerText = 'Proceed'; vBtn.disabled = false; }
        return;
    }

    window.location.href = url;
    goHome();
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

function nextQuestion() {
    if (userAnswers[currentQuestionIndex] === undefined) skippedQuestions.add(currentQuestionIndex);
    if (currentQuestionIndex < currentQuestions.length - 1) { currentQuestionIndex++; renderQuestion(); }
    else { updateQuizStats(); }
    updateState();
}

function prevQuestion() {
    if (currentQuestionIndex > 0) { currentQuestionIndex--; renderQuestion(); }
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
    const total = currentQuestions.length;
    if (!isAuto && answeredCount < total) {
        alert(`Please answer all questions before submitting. You have answered ${answeredCount} out of ${total}.`);
        return;
    }

    clearInterval(timerInterval);
    const submitBtn = document.getElementById('submit-btn');
    if (submitBtn) { submitBtn.innerText = 'Submitting...'; submitBtn.disabled = true; }

    const first = document.getElementById('first-name').value.trim().toUpperCase();
    const last = document.getElementById('last-name').value.trim().toUpperCase();
    const email = document.getElementById('email-address').value.trim().toLowerCase();

    try {
        const res = await fetch('/api/submit', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstName: first, lastName: last, email,
                className: selectedClassName, chapterTitle: activeQuizTitle, quizId: currentQuizId,
                userAnswers, serverStartTime, timerSignature, quizDuration, isAutoSubmit: isAuto
            })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            sessionStorage.removeItem('pioneers_prep_state');
            const safeCandidate = escapeClientHtml(`${first} ${last}`);
            const safeScore = escapeClientHtml(data.score);
            const safeTotal = escapeClientHtml(data.total);
            document.getElementById('result-screen').innerHTML =
                `<button class="back-btn" data-action="go-home">Back to Portal</button>` +
                `<h2 style="text-align:center;color:#4285f4;margin-top:0;">Quiz Results</h2>` +
                `<div style="text-align:center;margin-top:20px;">` +
                `<p style="font-size:18px;color:#333;">Candidate: <strong>${safeCandidate}</strong></p>` +
                `<h1 style="color:#4285f4;font-size:48px;margin:10px 0;">${safeScore} / ${safeTotal}</h1>` +
                `<p style="font-size:16px;color:#64748b;">Response recorded and mailed to the administrator successfully. A copy of your response has also been mailed to your provided email id.</p>` +
                `</div>`;
            screenHistory = [];
            showScreen('result-screen');
            if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
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
            padding: 20px 15px !important;
            border-radius: 0 !important;
            min-height: 100vh !important;
            box-shadow: none !important;
        }
        #question-box {
            font-size: 18px !important;
            line-height: 1.6 !important;
            margin-bottom: 24px !important;
        }
        .option-btn {
            padding: 16px 18px !important;
            font-size: 16px !important;
            margin-bottom: 12px !important;
            border-radius: 8px !important;
        }
        .quiz-nav-container {
            flex-direction: column !important;
            gap: 12px !important;
            margin-top: 30px !important;
        }
        .quiz-nav-container button {
            width: 100% !important;
            max-width: 100% !important;
            padding: 14px !important;
            font-size: 16px !important;
        }
        .quiz-header {
            flex-direction: column !important;
            align-items: center !important;
            text-align: center !important;
            gap: 12px !important;
            margin-bottom: 20px !important;
        }
        #submit-btn {
            width: 100% !important;
            padding: 12px !important;
        }
    `;

    let styleElement = null;
    let originalViewport = null;

    const observer = new MutationObserver(() => {
        const quizScreen = document.getElementById('quiz-screen');
        if (!quizScreen) return;

        const isQuizActive = !quizScreen.classList.contains('hidden');
        const metaViewport = document.querySelector('meta[name="viewport"]');

        if (isQuizActive) {
            if (metaViewport && metaViewport.getAttribute('content') === 'width=1280') {
                originalViewport = 'width=1280';
                metaViewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
            }
            if (!styleElement) {
                styleElement = document.createElement('style');
                styleElement.id = 'mobile-quiz-custom-styles';
                styleElement.innerHTML = mobileQuizStyles;
                document.head.appendChild(styleElement);
            }
        } else {
            if (metaViewport && originalViewport) {
                metaViewport.setAttribute('content', originalViewport);
            }
            if (styleElement) {
                styleElement.remove();
                styleElement = null;
            }
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    });
})();
