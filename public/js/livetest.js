let liveToken = "";
let currentQuizId = "";
let localIndex = -1;
let syncInterval;

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
        } else { alert(data.error); document.getElementById('join-btn').innerText = "Join Test"; }
    } catch (e) { alert("Network Error"); document.getElementById('join-btn').innerText = "Join Test"; }
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
        try {
            const res = await fetch(`/api/live/student/sync/${currentQuizId}`, {
                headers: { 'Authorization': `Bearer ${liveToken}` }
            });
            const data = await res.json();
            
            if (data.status === 'active' && data.currentIndex !== localIndex) {
                localIndex = data.currentIndex;
                renderQuestion(data);
            }
        } catch (e) {}
    }, 2000); // Check for new question every 2 seconds
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
            // HARD LOCK: Disable all buttons immediately to prevent switching
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
