let liveToken = "";
let currentQuizId = "";
let localIndex = -1;
let syncInterval;
let testActive = true;
let lastSavedAnswer = null; // NEW: Tracks the current answer state

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
                
                document.getElementById('quiz-screen').innerHTML = `
                    <div style="max-width: 600px; margin: 40px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center;">
                        <h2 style="color: #1e3a8a; margin-top: 0;">Exam Completed — Scorecard</h2>
                        <p style="color: #64748b;">Here is your performance summary for this live assessment.</p>
                        <div style="display: flex; justify-content: space-around; margin: 25px 0;">
                            <div style="background: #f1f5f9; padding: 15px 25px; border-radius: 8px;">
                                <div style="font-size: 24px; font-weight: bold; color: #16a34a;">${data.scorecard.correct}</div>
                                <div style="font-size: 13px; color: #475569;">Correct</div>
                            </div>
                            <div style="background: #f1f5f9; padding: 15px 25px; border-radius: 8px;">
                                <div style="font-size: 24px; font-weight: bold; color: #dc2626;">${data.scorecard.incorrect}</div>
                                <div style="font-size: 13px; color: #475569;">Incorrect</div>
                            </div>
                            <div style="background: #f1f5f9; padding: 15px 25px; border-radius: 8px;">
                                <div style="font-size: 24px; font-weight: bold; color: #ca8a04;">${data.scorecard.skipped}</div>
                                <div style="font-size: 13px; color: #475569;">Skipped</div>
                            </div>
                        </div>
                        <div style="font-size: 18px; font-weight: bold; color: #0f172a; margin-top: 15px;">
                            Final Score: ${data.scorecard.correct} / ${data.scorecard.total}
                        </div>
                        <a href="/" style="display: inline-block; margin-top: 25px; background: #2563eb; color: white; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Return to Homepage</a>
                    </div>
                `;
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