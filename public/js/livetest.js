// 1. SYNCHRONOUSLY RESTORE SESSION INSTANTLY ON PAGE LOAD
const _savedLiveSession = sessionStorage.getItem('live_student_session');
let _initialLiveToken = "";
let _initialQuizId = "";
let _hasActiveRestoredSession = false;

if (_savedLiveSession) {
    try {
        const _parsedLive = JSON.parse(_savedLiveSession);
        _initialLiveToken = _parsedLive.token || "";
        _initialQuizId = _parsedLive.quizId || "";
        if (_initialLiveToken && _initialQuizId) {
            _hasActiveRestoredSession = true;
        }
    } catch (e) {}
}

let liveToken = _initialLiveToken;
let currentQuizId = _initialQuizId;
let currentActiveQuizFile = "";
let localIndex = -1;
let syncInterval;
let testActive = _hasActiveRestoredSession;
let lastSavedAnswer = null;

async function loadAvailableRooms() {
    const listBox = document.getElementById('live-rooms-list');
    if (!listBox) return;

    try {
        const res = await fetch('/api/live/rooms');
        const data = await res.json();

        if (data.success && Array.isArray(data.rooms) && data.rooms.length > 0) {
            listBox.innerHTML = '';
            data.rooms.forEach(room => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.style.cssText = 'width: 100%; padding: 16px 20px; background: #eff6ff; border: 2px solid #93c5fd; border-radius: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 16px; font-weight: bold; color: #1e3a8a; transition: 0.2s;';
                
                const titleSpan = document.createElement('span');
                titleSpan.textContent = `🟢 ${room.name}`;
                
                const actionSpan = document.createElement('span');
                actionSpan.style.cssText = 'background: #2563eb; color: white; padding: 6px 14px; border-radius: 6px; font-size: 13px;';
                actionSpan.textContent = 'Join Room →';

                btn.appendChild(titleSpan);
                btn.appendChild(actionSpan);
                btn.addEventListener('click', () => joinLiveRoom(room.id, btn));
                listBox.appendChild(btn);
            });
        } else {
            listBox.innerHTML = `
                <div style="padding: 20px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; text-align: center; color: #64748b; font-weight: bold;">
                    No active rooms right now. Click Refresh once Sir starts the room.
                </div>
            `;
        }
    } catch (e) {
        listBox.innerHTML = `
            <div style="padding: 20px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; text-align: center; color: #dc2626; font-weight: bold;">
                Error loading rooms. Please click Refresh.
            </div>
        `;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-rooms-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadAvailableRooms);
    }

    if (_hasActiveRestoredSession) {
        const authScreen = document.getElementById('auth-screen');
        const quizScreen = document.getElementById('quiz-screen');
        if (authScreen) authScreen.style.display = 'none';
        if (quizScreen) quizScreen.style.display = 'block';

        fetch('/api/live/student/rejoin', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${liveToken}` }
        }).catch(() => {});

        startSync();
        startHeartbeat();
    } else {
        loadAvailableRooms();
        setInterval(() => {
            if (!testActive) loadAvailableRooms();
        }, 4000);
    }
});

function handleExpiredSession() {
    localStorage.clear();
    sessionStorage.removeItem('pioneers_prep_state');
    sessionStorage.setItem('force_login_open', 'true');
    alert('Session expired. Please sign in again.');
    window.location.replace('/');
}

async function joinLiveRoom(selectedRoomId, btnEl) {
    const token = localStorage.getItem('pp_id_token');
    if (!token) {
        sessionStorage.setItem('force_login_open', 'true');
        alert('Please sign in on the homepage first.');
        window.location.replace('/');
        return;
    }

    currentQuizId = String(selectedRoomId || '').trim();
    if (!currentQuizId) return;

    if (btnEl) {
        btnEl.disabled = true;
        btnEl.style.opacity = '0.7';
    }

    try {
        const res = await fetch('/api/live/student/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ quizId: currentQuizId })
        });

        if (res.status === 401) {
            handleExpiredSession();
            return;
        }

        const data = await res.json();
        if (data.success) {
            liveToken = data.token;
            testActive = true;
            localIndex = -1;
            currentActiveQuizFile = "";

            sessionStorage.setItem('live_student_session', JSON.stringify({ token: liveToken, quizId: currentQuizId }));

            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('quiz-screen').style.display = 'block';
            startSync();
            startHeartbeat();
        } else {
            alert(data.error || 'Could not join room.');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.style.opacity = '1';
            }
            loadAvailableRooms();
        }
    } catch (e) {
        alert("Network Error joining room.");
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.style.opacity = '1';
        }
    }
}

let socket = null;
let lastRenderedKey = "";

function applyBroadcastModeUI(mode) {
    const presScreen = document.getElementById('presentation-screen');
    const quizScreen = document.getElementById('quiz-screen');
    document.body.classList.remove('rtc-presentation-active', 'rtc-both-active');

    if (mode === 'presentation') {
        document.body.classList.add('rtc-presentation-active');
        if (presScreen) presScreen.style.display = 'block';
        if (quizScreen) quizScreen.style.display = 'none';
    } else if (mode === 'both') {
        document.body.classList.add('rtc-both-active');
        if (presScreen) presScreen.style.display = 'block';
        if (quizScreen) quizScreen.style.display = 'block';
    } else {
        if (presScreen) presScreen.style.display = 'none';
        if (quizScreen && testActive) quizScreen.style.display = 'block';
    }
}
window.applyBroadcastModeUI = applyBroadcastModeUI;

if (typeof io !== 'undefined') {
    socket = io();
    socket.on("room-state", (data) => {
        if (!data) return;

        if (data.status === 'ended') {
            sessionStorage.removeItem('live_student_session');
            alert("The instructor has ended the live session.");
            window.location.replace('/');
            return;
        }

        applyBroadcastModeUI(data.broadcastMode || 'question');

        if (!data.activeQuizFile || !data.payload || !data.key) {
            currentActiveQuizFile = "";
            localIndex = -1;
            lastRenderedKey = "";
            const statusEl = document.getElementById('live-status');
            const progEl = document.getElementById('live-progress');
            const qTextEl = document.getElementById('question-text');
            const optsBox = document.getElementById('options-container');
            if (statusEl) statusEl.innerText = "🟢 Live Session Active";
            if (progEl) progEl.innerText = "Lecture Mode";
            if (qTextEl) qTextEl.innerText = "Waiting for Sir to broadcast a question...";
            if (optsBox) optsBox.innerHTML = "";
            return;
        }

        const stateKey = `${data.activeQuizFile}:${data.currentIndex}:${data.forceRefresh ? Date.now() : ''}`;
        if (stateKey !== lastRenderedKey) {
            lastRenderedKey = stateKey;
            currentActiveQuizFile = data.activeQuizFile;
            localIndex = data.currentIndex;
            renderQuestion(data);
        }
    });
}

function startSync() {
    if (socket && currentQuizId && liveToken) {
        socket.emit("join-room", { quizId: currentQuizId, token: liveToken });
    }
    if (typeof window.connectLiveKit === 'function' && currentQuizId) {
        window.connectLiveKit(currentQuizId);
    }
}

function startHeartbeat() {}

function xorDecipher(b64Str, key) {
    const raw = atob(b64Str);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const k = new TextEncoder().encode(key);
    for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
    return new TextDecoder().decode(buf);
}

function renderQuestion(data) {
    document.getElementById('live-status').innerText = "Live Broadcast";
    document.getElementById('live-progress').innerText = `Q: ${localIndex + 1}/${data.total}`;

    const q = JSON.parse(xorDecipher(data.payload, data.key));
    document.getElementById('question-text').innerText = `Q${localIndex + 1}. ${q.question}`;

    const optsBox = document.getElementById('options-container');
    optsBox.innerHTML = '';

    const hasAlreadyAnswered = data.savedAnswer !== null && data.savedAnswer !== undefined;

    q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'opt-btn';

        if (hasAlreadyAnswered && Number(data.savedAnswer) === idx) {
            btn.classList.add('selected');
        }
        if (hasAlreadyAnswered) {
            btn.disabled = true;
            btn.classList.add('locked');
        }

        btn.innerText = opt;
        btn.onclick = () => {
            document.querySelectorAll('.opt-btn').forEach(b => {
                b.disabled = true;
                b.classList.add('locked');
            });
            btn.classList.add('selected');

            fetch('/api/live/student/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${liveToken}` },
                body: JSON.stringify({ index: localIndex, answer: idx })
            });
        };
        optsBox.appendChild(btn);
    });
}

function renderLiveMockResults(scorecard, breakdown) {
    const percentage = ((scorecard.correct / scorecard.total) * 100).toFixed(1);
    
    // Fallback escaper
    const esc = str => {
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    };

    let html = `
        <div style="max-width: 900px; margin: 0 auto; padding: 20px; font-family: sans-serif; background: #fff;">
            
            <!-- Print Header (Hidden on screen, visible on PDF) -->
            <div class="print-only-header" style="display: none; text-align: center; margin-bottom: 25px;">
                <h1 style="color: #1e3a8a; margin: 0;">Pioneers Prep - Live Mock Report</h1>
                <p style="color: #64748b; margin-top: 5px;">Candidate Performance Breakdown</p>
            </div>

            <!-- Action Bar (Hidden on print) -->
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;" class="no-print">
                <button id="btn-exit-dashboard" style="padding: 10px 18px; background: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; color: #475569;">&larr; Exit Dashboard</button>
                <button id="btn-print-pdf" style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"></path></svg>
                    Print / Save as PDF
                </button>
            </div>

            <!-- Scorecard -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 30px; text-align: center; margin-bottom: 35px; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
                <h2 style="margin: 0 0 10px 0; color: #334155;">Final Scorecard</h2>
                <h1 style="font-size: 54px; margin: 0; color: #2563eb; line-height: 1;">${percentage}%</h1>
                <p style="font-size: 18px; font-weight: 600; color: #0f172a; margin-top: 8px;">${scorecard.correct} / ${scorecard.total} Correct</p>
                
                <div style="display: flex; justify-content: center; gap: 15px; margin-top: 20px; flex-wrap: wrap;">
                    <span style="background: #dcfce7; color: #166534; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 15px;">✅ Correct: ${scorecard.correct}</span>
                    <span style="background: #fee2e2; color: #991b1b; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 15px;">❌ Incorrect: ${scorecard.incorrect}</span>
                    <span style="background: #fef9c3; color: #854d0e; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 15px;">⚠️ Skipped: ${scorecard.skipped}</span>
                </div>
            </div>

            <h3 style="color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 0;">Detailed Question Breakdown</h3>
            
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: left;">
                    <tr style="background: #1e293b; color: white;">
                        <th style="padding: 14px; border-radius: 6px 0 0 0; width: 5%;">#</th>
                        <th style="padding: 14px; width: 45%;">Question</th>
                        <th style="padding: 14px; width: 20%;">Your Answer</th>
                        <th style="padding: 14px; width: 20%;">Correct Answer</th>
                        <th style="padding: 14px; border-radius: 0 6px 0 0; width: 10%; text-align: center;">Status</th>
                    </tr>
    `;

    breakdown.forEach(item => {
        let statusColor = item.status === 'Correct' ? '#10b981' : (item.status === 'Incorrect' ? '#ef4444' : '#eab308');
        let statusBg = item.status === 'Correct' ? '#dcfce7' : (item.status === 'Incorrect' ? '#fee2e2' : '#fef9c3');
        let selColor = item.status === 'Correct' ? '#15803d' : (item.status === 'Incorrect' ? '#991b1b' : '#64748b');
        
        html += `
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 16px; vertical-align: top; font-weight: bold; color: #475569;">${item.qNum}</td>
                        <td style="padding: 16px; vertical-align: top;">
                            <div style="color: #1e293b; font-weight: 500; font-size: 15px;">${esc(item.question)}</div>
                            ${item.explanation ? `<div style="margin-top: 10px; font-size: 13px; color: #15803d; background: #f0fdf4; padding: 10px; border-radius: 6px; border-left: 4px solid #16a34a;"><strong>Explanation:</strong> ${esc(item.explanation)}</div>` : ''}
                        </td>
                        <td style="padding: 16px; vertical-align: top; color: ${selColor}; font-weight: ${item.status === 'Skipped' ? 'normal' : '600'};">${esc(item.selectedText)}</td>
                        <td style="padding: 16px; vertical-align: top; color: #15803d; font-weight: 600;">${esc(item.correctText)}</td>
                        <td style="padding: 16px; vertical-align: top; text-align: center;">
                            <span style="background: ${statusBg}; color: ${statusColor}; padding: 6px 10px; border-radius: 6px; font-weight: bold; font-size: 12px; border: 1px solid ${statusColor}40;">${item.status}</span>
                        </td>
                    </tr>
        `;
    });

    html += `
                </table>
            </div>
        </div>
        <style>
            @media print {
                body * { visibility: hidden; }
                #quiz-screen { display: none !important; }
                #result-screen, #result-screen * { visibility: visible; }
                #result-screen { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; margin: 0 !important; }
                .no-print { display: none !important; }
                .print-only-header { display: block !important; }
                .app-screen, main { display: block !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; }
                table { page-break-inside: auto; }
                tr { page-break-inside: avoid; page-break-after: auto; }
                td, th { border: 1px solid #cbd5e1 !important; }
                * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            }
        </style>
    `;
    
    // Inject and display
    const quizScreen = document.getElementById('quiz-screen');
    const resultScreen = document.createElement('div');
    resultScreen.id = 'result-screen';
    resultScreen.innerHTML = html;
    
    // Replace the quiz screen with the result screen seamlessly
    quizScreen.replaceWith(resultScreen);

    // Add Event Listeners for the Action Buttons
    document.getElementById('btn-exit-dashboard').addEventListener('click', () => {
        window.location.href = '/';
    });
    
    document.getElementById('btn-print-pdf').addEventListener('click', () => {
        window.print();
    });
}

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