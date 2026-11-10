let liveToken = "";
let currentQuizId = "";
let currentActiveQuizFile = "";
let localIndex = -1;
let testActive = false;

document.addEventListener("DOMContentLoaded", () => {
    fetchLiveRooms();
    const refBtn = document.getElementById('refresh-rooms-btn');
    if (refBtn) refBtn.addEventListener('click', fetchLiveRooms);
});

async function fetchLiveRooms() {
    const listDiv = document.getElementById('live-rooms-list');
    if (!listDiv) return;
    try {
        listDiv.innerHTML = '<div style="padding: 18px; text-align: center; color: #64748b;">Checking for active classes...</div>';
        const res = await fetch('/api/live/rooms');
        const data = await res.json();
        
        if (!data.success || data.rooms.length === 0) {
            listDiv.innerHTML = '<div style="padding: 18px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; text-align: center; color: #64748b; font-weight: bold;">No live classes are currently active.</div>';
            return;
        }

        listDiv.innerHTML = data.rooms.map(r => `
            <div style="background: white; border: 2px solid #e2e8f0; border-radius: 8px; padding: 15px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.02); margin-bottom: 10px;">
                <div style="font-weight: bold; color: #1e293b; font-size: 15px; display: flex; align-items: center;">
                    <span style="display: inline-block; width: 10px; height: 10px; background: #10b981; border-radius: 50%; margin-right: 8px;"></span>
                    ${r.name}
                </div>
                <button onclick="joinLiveRoom('${r.id}')" style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">Join Room</button>
            </div>
        `).join('');
    } catch (err) {
        listDiv.innerHTML = '<div style="color: #ef4444; padding: 15px; font-weight: bold;">Failed to load rooms. Please refresh.</div>';
    }
}

async function joinLiveRoom(roomId) {
    try {
        const token = localStorage.getItem('pp_id_token') || sessionStorage.getItem('pp_id_token') || "";
        if (!token) {
            alert("Please sign in from the homepage first.");
            window.location.replace('/');
            return;
        }

        const res = await fetch('/api/live/student/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ quizId: roomId })
        });
        const data = await res.json();
        
        if (!data.success) {
            alert(data.error || "Failed to join room.");
            return;
        }

        liveToken = data.token;
        currentQuizId = roomId;
        testActive = true;
        
        const authScreen = document.getElementById('auth-screen');
        if (authScreen) authScreen.style.display = 'none';
        
        startSync();
    } catch (err) {
        alert("Connection error. Please try again.");
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
        if (quizScreen && typeof testActive !== 'undefined' && testActive) quizScreen.style.display = 'block';
    }
}
window.applyBroadcastModeUI = applyBroadcastModeUI;

if (typeof io !== 'undefined') {
    socket = io();
    
    socket.on("room-state", (data) => {
        if (!data) return;

        if (data.status === 'ended') {
            sessionStorage.removeItem('live_student_session');
            
            // 1. Disconnect LiveKit and hide PIP box immediately
            if (typeof room !== 'undefined' && room) {
                room.disconnect();
            }
            const pipBox = document.getElementById('student-pip-box');
            if (pipBox) pipBox.style.display = 'none';

            // 2. Fetch scorecard data and render UI directly
            fetch(`/api/live/student/scorecard?quizId=${encodeURIComponent(currentQuizId)}`, {
                headers: { 'Authorization': `Bearer ${liveToken}` }
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    // Hide active testing screens
                    const quizScreen = document.getElementById('quiz-screen');
                    const presScreen = document.getElementById('presentation-screen');
                    if (quizScreen) quizScreen.style.display = 'none';
                    if (presScreen) presScreen.style.display = 'none';
                    document.body.classList.remove('rtc-presentation-active', 'rtc-both-active', 'rtc-stream-active');

                    // Build detailed table
                    const sc = result.scorecard;
                    const pct = sc.total > 0 ? ((sc.correct / sc.total) * 100).toFixed(1) : "0.0";
                    
                    let breakdownHtml = `<div style="overflow-x: auto; margin-top: 20px;"><table style="width: 100%; border-collapse: collapse; text-align: left;">
                        <thead>
                            <tr style="background: #1e293b; color: white;">
                                <th style="padding: 12px; border-top-left-radius: 8px;">#</th>
                                <th style="padding: 12px;">Question</th>
                                <th style="padding: 12px;">Your Answer</th>
                                <th style="padding: 12px; border-top-right-radius: 8px;">Correct Answer</th>
                            </tr>
                        </thead>
                        <tbody>`;

                    result.breakdown.forEach(item => {
                        let bg = item.status === 'Correct' ? '#f0fdf4' : (item.status === 'Incorrect' ? '#fef2f2' : '#fefce8');
                        let text = item.status === 'Correct' ? '#166534' : (item.status === 'Incorrect' ? '#991b1b' : '#854d0e');
                        breakdownHtml += `
                            <tr style="border-bottom: 1px solid #e2e8f0; background: ${bg}; color: ${text};">
                                <td style="padding: 12px; font-weight: bold;">${item.qNum}</td>
                                <td style="padding: 12px;">${item.question} <br> <span style="font-size: 13px; color: #475569; display: block; margin-top: 4px;">${item.explanation}</span></td>
                                <td style="padding: 12px; font-weight: bold;">${item.selectedText}</td>
                                <td style="padding: 12px; font-weight: bold;">${item.correctText}</td>
                            </tr>`;
                    });
                    breakdownHtml += `</tbody></table></div>`;

                    // Inject the scorecard into the DOM
                    let resultContainer = document.getElementById('live-result-screen');
                    if (!resultContainer) {
                        resultContainer = document.createElement('div');
                        resultContainer.id = 'live-result-screen';
                        resultContainer.className = 'live-container';
                        resultContainer.style.maxWidth = '800px';
                        resultContainer.style.margin = '20px auto';
                        resultContainer.style.width = '100%';
                        document.body.appendChild(resultContainer);
                    }

                    resultContainer.innerHTML = `
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h2 style="color: #1e293b; font-size: 26px; margin-bottom: 5px;">Final Scorecard</h2>
                            <div style="font-size: 60px; font-weight: bold; color: #2563eb; margin: 15px 0;">${pct}%</div>
                            <div style="font-size: 18px; color: #475569; font-weight: bold; margin-bottom: 25px;">${sc.correct} / ${sc.total} Correct</div>
                            
                            <div style="display: flex; justify-content: center; gap: 12px; flex-wrap: wrap;">
                                <span style="background: #dcfce7; color: #166534; padding: 8px 16px; border-radius: 20px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">✅ Correct: ${sc.correct}</span>
                                <span style="background: #fee2e2; color: #991b1b; padding: 8px 16px; border-radius: 20px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">❌ Incorrect: ${sc.incorrect}</span>
                                <span style="background: #fef9c3; color: #854d0e; padding: 8px 16px; border-radius: 20px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">⚠️ Skipped: ${sc.skipped}</span>
                            </div>
                        </div>
                        <h3 style="color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-top: 30px; text-align: left;">Detailed Question Breakdown</h3>
                        ${breakdownHtml}
                        <button onclick="window.location.replace('/')" style="margin-top: 30px; background: #2563eb; color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; box-shadow: 0 4px 6px rgba(37, 99, 235, 0.2);">Return to Dashboard</button>
                    `;
                    
                    resultContainer.style.display = 'block';
                    
                    if (typeof confetti === 'function') {
                        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
                    }
                } else {
                    alert("The instructor has ended the live session.");
                    window.location.replace('/');
                }
            })
            .catch(() => {
                alert("The instructor has ended the live session.");
                window.location.replace('/');
            });
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

    // Moderation event listener (Mute/Kick)
    socket.on("moderation-event", async (data) => {
        if (!data || !data.targetName) return;
        
        const tokenObj = localStorage.getItem('pp_id_token') || "";
        let myName = "";
        if (tokenObj) {
            const parts = tokenObj.split('|||')[0].split('|');
            if (parts.length > 2) myName = decodeURIComponent(parts[1] + ' ' + parts[2]);
        }
        
        if (data.targetName.toLowerCase() === myName.trim().toLowerCase()) {
            if (data.action === 'mute') {
                if (typeof studentMicTrack !== 'undefined' && studentMicTrack) {
                    try {
                        if (typeof room !== 'undefined' && room && room.state === 'connected') {
                            await room.localParticipant.unpublishTrack(studentMicTrack);
                        }
                        studentMicTrack.stop();
                    } catch(e) {}
                    studentMicTrack = null;
                    const speakBtn = document.getElementById('btn-student-call');
                    if (speakBtn) {
                        speakBtn.textContent = '📞 Speak';
                        speakBtn.classList.remove('on-call');
                    }
                }
            } else if (data.action === 'kick') {
                if (typeof room !== 'undefined' && room) room.disconnect();
                sessionStorage.removeItem('live_student_session');
                alert("You have been removed from the session by the instructor.");
                window.location.replace('/');
            }
        }
    });
}

function startSync() {
    if (socket && typeof currentQuizId !== 'undefined' && typeof liveToken !== 'undefined') {
        socket.emit("join-room", { quizId: currentQuizId, token: liveToken });
    }
    if (typeof window.connectLiveKit === 'function' && typeof currentQuizId !== 'undefined') {
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