let adminKey = "";
let quizId = "";
let currentIndex = 0;
let totalQuestions = 0; // Handled dynamically if refreshed
let dashInterval;

// RULE 2: Persist Admin Credentials on Refresh (Restore Session)
window.addEventListener('DOMContentLoaded', () => {
    const saved = sessionStorage.getItem('live_admin_session');
    if (saved) {
        const parsed = JSON.parse(saved);
        adminKey = parsed.adminKey;
        quizId = parsed.quizId;
        
        // Hide login, show panels immediately
        document.getElementById('admin-key').value = adminKey;
        document.getElementById('quiz-id').value = quizId;
        document.getElementById('control-panel').style.display = 'block';
        document.getElementById('board-panel').style.display = 'block';
        
        const startBtn = document.getElementById('start-btn');
        startBtn.innerText = "Live Active (Restored)";
        startBtn.disabled = true;
        startBtn.style.opacity = '0.7';
        startBtn.style.cursor = 'not-allowed';

        startDashboardSync();
    }
});

document.getElementById('start-btn').addEventListener('click', async () => {
    adminKey = document.getElementById('admin-key').value.trim();
    quizId = document.getElementById('quiz-id').value.trim();
    if (!adminKey || !quizId) return alert("Enter Key and Quiz ID");
    
    const startBtn = document.getElementById('start-btn');
    startBtn.innerText = "Starting...";
    try {
        const res = await fetch('/api/live/admin/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey, quizId })
        });
        const data = await res.json();
        if (data.success) {
            totalQuestions = data.totalQuestions;
            document.getElementById('otp-display').innerText = `OTP: ${data.otp}`;
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';
            
            // Save to sessionStorage so it survives page refreshes
            sessionStorage.setItem('live_admin_session', JSON.stringify({ adminKey, quizId }));

            // Keep visually active but fully disabled
            startBtn.innerText = "Live Active";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            startDashboardSync();
        } else { 
            alert(data.error); 
            startBtn.innerText = "Start Broadcast"; 
        }
    } catch (e) { alert("Error"); startBtn.innerText = "Start Broadcast"; }
});

// Robust Event Delegation for Admin Controls
document.addEventListener('click', async (e) => {
    const endBtn = e.target.closest('#end-test-btn');
    const clearBtn = e.target.closest('#clear-responses-btn');
    
    if (!endBtn && !clearBtn) return;
    
    // Always grab the freshest credentials from session storage
    const activeSessionStr = sessionStorage.getItem('live_admin_session');
    const creds = activeSessionStr ? JSON.parse(activeSessionStr) : { adminKey, quizId };
    
    if (!creds.adminKey || !creds.quizId) return alert("Error: Missing admin credentials. Please restart broadcast.");

    if (endBtn) {
        if (!confirm("Are you sure you want to end this test immediately for all students?")) return;
        try {
            const res = await fetch('/api/live/admin/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(creds)
            });
            const data = await res.json();
            
            if (!res.ok || !data.success) {
                return alert(data.error || "Authentication failed. Your Admin Key may be incorrect.");
            }
            
            clearInterval(dashInterval);
            sessionStorage.removeItem('live_admin_session');
            document.getElementById('control-panel').style.display = 'none';
            document.getElementById('board-panel').style.display = 'none';
            
            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "Start Broadcast & Send OTP";
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            startBtn.style.cursor = 'pointer';
            document.getElementById('otp-display').innerText = "";
            document.getElementById('admin-key').value = "";
            document.getElementById('quiz-id').value = "";
            
            alert("Test successfully terminated. Scorecards are now being displayed to students.");
        } catch (err) {
            alert("Network error. Failed to communicate with the server.");
        }
    }
    
    if (clearBtn) {
        if (!confirm("Wipe all student selections for the current question?")) return;
        try {
            const res = await fetch('/api/live/admin/clear-question', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(creds) 
            });
            const data = await res.json();
            
            if (data.success) {
                alert("Responses cleared! Students' screens have been unlocked.");
            } else {
                alert(data.error || "Failed to clear responses.");
            }
        } catch (err) {
            alert("Network error while clearing responses.");
        }
    }
});

async function setQuestionIndex(newIndex) {
    // If totalQuestions wasn't set (due to refresh), we bypass the upper limit check
    // since the server will block invalid indexes anyway.
    if (newIndex < 0 || (totalQuestions > 0 && newIndex >= totalQuestions)) return;
    document.getElementById('prev-btn').disabled = true;
    document.getElementById('next-btn').disabled = true;
    
    await fetch('/api/live/admin/set-index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey, quizId, index: newIndex })
    });
    
    currentIndex = newIndex;
    document.getElementById('q-counter').innerText = `Q: ${currentIndex + 1} ${totalQuestions > 0 ? '/ ' + totalQuestions : ''}`;
    document.getElementById('prev-btn').disabled = false;
    document.getElementById('next-btn').disabled = false;
}

document.getElementById('prev-btn').addEventListener('click', () => setQuestionIndex(currentIndex - 1));
document.getElementById('next-btn').addEventListener('click', () => setQuestionIndex(currentIndex + 1));

function startDashboardSync() {
    dashInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/live/admin/dashboard?adminKey=${adminKey}&quizId=${quizId}`);
            const data = await res.json();
            
            if (data.success) {
                // Restore state and OTP on refresh
                if (data.state) {
                    currentIndex = data.state.currentIndex;
                    document.getElementById('q-counter').innerText = `Q: ${currentIndex + 1} ${totalQuestions > 0 ? '/ ' + totalQuestions : ''}`;
                }
                
                // If the server sends the active OTP back, make sure it stays visible
                if (data.otp) {
                    document.getElementById('otp-display').innerText = `OTP: ${data.otp}`;
                }

                const tbody = document.getElementById('board-body');
                tbody.innerHTML = '';
                
                data.students.forEach(student => {
                    const ansData = student.data.answers[currentIndex];
                    const tr = document.createElement('tr');
                    
                    let timeStr = "N/A";
                    if (ansData) {
                        const date = new Date(ansData.time);
                        timeStr = `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                    }

                    tr.innerHTML = `
                        <td style="font-weight: bold;">${student.name}</td>
                        <td style="color: ${ansData ? '#38bdf8' : '#64748b'}; font-weight: bold;">
                            ${ansData ? 'Option ' + (ansData.answer + 1) : 'Waiting...'}
                        </td>
                        <td>${ansData ? `<span class="time-badge">${timeStr}</span>` : '-'}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        } catch(e) {}
    }, 700);
}