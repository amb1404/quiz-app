let liveToken = "";
let currentQuizId = "";
let localIndex = -1;
let syncInterval;
let testActive = true;
let lastSavedAnswer = null; // Tracks the current answer state

// 1. AUTO-RESTORE SESSION IF THE BROWSER IS REFRESHED
window.addEventListener('DOMContentLoaded', () => {
    const savedSession = sessionStorage.getItem('live_student_session');
    
    if (savedSession) {
        const parsed = JSON.parse(savedSession);
        liveToken = parsed.token;
        currentQuizId = parsed.quizId;
        
        // Hide the auth form and show the test interface
        const authScreen = document.getElementById('auth-screen');
        const quizScreen = document.getElementById('quiz-screen');
        if (authScreen) authScreen.style.display = 'none';
        if (quizScreen) quizScreen.style.display = 'block';
        
        // Jump straight back into the server synchronization loop
        if (typeof startSync === 'function') {
            fetch('/api/live/student/rejoin', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${liveToken}` }
            }).catch(() => {});

            startSync();
            startHeartbeat(); 
        }
    }
});

function handleExpiredSession() {
    localStorage.clear();
    sessionStorage.removeItem('pioneers_prep_state');
    sessionStorage.setItem('force_login_open', 'true');
    alert('Session expired. Please sign in again.');
    window.location.replace('/');
}

document.getElementById('join-btn').addEventListener('click', async () => {
    const token = localStorage.getItem('pp_id_token');
    if (!token) {
        sessionStorage.setItem('force_login_open', 'true');
        alert('Please sign in on the homepage first.');
        window.location.replace('/');
        return;
    }

    currentQuizId = document.getElementById('live-quiz-id').value.trim();
    const otp = document.getElementById('live-otp').value.trim();

    if (!currentQuizId || !otp) return alert("Test ID and OTP are required.");
    
    document.getElementById('join-btn').innerText = "Verifying...";
    try {
        const res = await fetch('/api/live/student/verify', {
            method: 'POST', 
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ quizId: currentQuizId, otp })
        });

        if (res.status === 401) {
            handleExpiredSession();
            return;
        }

        const data = await res.json();
        if (data.success) {
            liveToken = data.token;
            testActive = true;     // Reset for multiple live tests
            localIndex = -1;       // Reset question index tracker
            
            // 2. SAVE THE ACTIVE SESSION TO SURVIVE BROWSER REFRESHES
            sessionStorage.setItem('live_student_session', JSON.stringify({ token: liveToken, quizId: currentQuizId }));

            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('quiz-screen').style.display = 'block';
            startSync();
            startHeartbeat(); 
        } else { 
            alert(data.error); 
            document.getElementById('join-btn').innerText = "Join Test"; 
        }
    } catch (e) { 
        alert("Network Error"); 
        document.getElementById('join-btn').innerText = "Join Test"; 
    }
});

function startHeartbeat() {
    setInterval(() => {
        if (liveToken && testActive) {
            fetch('/api/live/student/heartbeat', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${liveToken}` }
            }).catch(() => {});
        }
    }, 3000);
}

// Remove student from admin dashboard ONLY when tab is explicitly closed
window.addEventListener('beforeunload', () => {
    if (liveToken && testActive) {
        fetch('/api/live/student/leave', {
            method: 'POST',
            keepalive: true,
            headers: { 'Authorization': `Bearer ${liveToken}` }
        }).catch(() => {});
    }
});

function xorDecipher(b64Str, key) {
    const raw = atob(b64Str);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const k = new TextEncoder().encode(key);
    for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
    return new TextDecoder().decode(buf);
}

function startSync() {
    syncInterval = setInterval(async () => {
        if (!testActive) return;
        try {
            const res = await fetch(`/api/live/student/sync/${currentQuizId}`, {
                headers: { 'Authorization': `Bearer ${liveToken}` }
            });

            if (res.status === 401) {
                testActive = false;
                clearInterval(syncInterval);
                handleExpiredSession();
                return;
            }

            const data = await res.json();
            
            if (data.status === 'ended' && data.scorecard) {
                testActive = false;
                clearInterval(syncInterval);
                
                // 3. WIPE THE MEMORY BECAUSE THE TEST IS OFFICIALLY OVER
                sessionStorage.removeItem('live_student_session');
                
                alert("Test was ended by admin.");
                
                // Inject the advanced scorecard + breakdown UI
                renderLiveMockResults(data.scorecard, data.breakdown || []);
                triggerCelebration();
                return;
            }

            if (data.status === 'active') {
                const indexChanged = data.currentIndex !== localIndex;
                const answerWasClearedByAdmin = (lastSavedAnswer !== null && data.savedAnswer === null);

                if (indexChanged || answerWasClearedByAdmin) {
                    localIndex = data.currentIndex;
                    lastSavedAnswer = data.savedAnswer;
                    renderQuestion(data);
                } else {
                    // Just keep our local tracker updated
                    lastSavedAnswer = data.savedAnswer;
                }
            }
        } catch (e) {}
    }, 2000);
}

function renderQuestion(data) {
    document.getElementById('live-status').innerText = "Live Broadcast";
    document.getElementById('live-progress').innerText = `Q: ${localIndex + 1}/${data.total}`;
    
    // Decrypting the payload uses data.key - ensuring it works correctly based on your previous fixes
    const q = JSON.parse(xorDecipher(data.payload, data.key));
    document.getElementById('question-text').innerText = `Q${localIndex + 1}. ${q.question}`;
    
    const optsBox = document.getElementById('options-container');
    optsBox.innerHTML = '';
    
    const hasAlreadyAnswered = data.savedAnswer !== null && data.savedAnswer !== undefined;

    q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'opt-btn';
        
        // Restore previous selection if student refreshed or reconnected
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
                <button onclick="window.location.href='/'" style="padding: 10px 18px; background: #e2e8f0; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; color: #475569;">&larr; Exit Dashboard</button>
                <button onclick="window.print()" style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
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