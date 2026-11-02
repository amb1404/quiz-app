let liveToken = "";
let currentQuizId = "";
let localIndex = -1;
let syncInterval;
let testActive = true;

document.getElementById('join-btn').addEventListener('click', async () => {
    const first = document.getElementById('live-first').value.trim().toUpperCase();
    const last = document.getElementById('live-last').value.trim().toUpperCase();
    const otp = document.getElementById('live-otp').value.trim();
    currentQuizId = document.getElementById('live-quiz-id').value.trim();

    if (!first || !last || !otp || !currentQuizId) return alert("Fill all fields.");
    
    document.getElementById('join-btn').innerText = "Verifying...";
    try {
        const res = await fetch('/api/live/student/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName: first, lastName: last, quizId: currentQuizId, otp })
        });
        const data = await res.json();
        if (data.success) {
            liveToken = data.token;
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('quiz-screen').style.display = 'block';
            startSync();
            startHeartbeat(); 
        } else { alert(data.error); document.getElementById('join-btn').innerText = "Join Test"; }
    } catch (e) { alert("Network Error"); document.getElementById('join-btn').innerText = "Join Test"; }
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
            const data = await res.json();
            
            if (data.status === 'ended' && data.scorecard) {
                testActive = false;
                clearInterval(syncInterval);
                
                // Requirement 3 & 4: Explicit Popup followed by Scorecard
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
                return;
            }

            if (data.status === 'active' && data.currentIndex !== localIndex) {
                localIndex = data.currentIndex;
                renderQuestion(data);
            }
        } catch (e) {}
    }, 2000);
}

function renderQuestion(data) {
    document.getElementById('live-status').innerText = "Live Broadcast";
    document.getElementById('live-progress').innerText = `Q: ${localIndex + 1}/${data.total}`;
    
    const q = JSON.parse(xorDecipher(data.payload, data.key));
    document.getElementById('question-text').innerText = `Q${localIndex + 1}. ${q.question}`;
    
    const optsBox = document.getElementById('options-container');
    optsBox.innerHTML = '';
    
    q.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'opt-btn';
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
