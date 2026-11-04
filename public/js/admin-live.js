let adminKey = "";
let quizId = "";
let currentIndex = 0;
let totalQuestions = 0; 
let dashInterval;

// Persist Admin Credentials on Refresh (Restore Session)
window.addEventListener('DOMContentLoaded', () => {
    try {
        const saved = sessionStorage.getItem('live_admin_session');
        if (saved) {
            const parsed = JSON.parse(saved);
            adminKey = parsed.adminKey;
            quizId = parsed.quizId;
            
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
    } catch (e) {
        console.error("Failed to restore session", e);
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
            
            sessionStorage.setItem('live_admin_session', JSON.stringify({ adminKey, quizId }));

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

// Robust Event Delegation with IN-UI CONFIRMATION (Bypasses Browser Blocks)
document.addEventListener('click', async (e) => {
    const endBtn = e.target.closest('#end-test-btn');
    const clearBtn = e.target.closest('#clear-responses-btn');
    
    if (!endBtn && !clearBtn) return;
    
    e.preventDefault();
    
    let creds = { adminKey, quizId };
    try {
        const activeSessionStr = sessionStorage.getItem('live_admin_session');
        if (activeSessionStr) creds = JSON.parse(activeSessionStr);
    } catch (err) {}
    
    if (!creds.adminKey || !creds.quizId) return console.error("Missing admin credentials.");

    if (endBtn) {
        // Double-Click UI Confirmation
        if (endBtn.dataset.confirm !== "true") {
            const originalText = endBtn.innerText;
            endBtn.innerText = "Click Again to END TEST";
            endBtn.style.background = "#991b1b"; // Dark red
            endBtn.dataset.confirm = "true";
            setTimeout(() => {
                endBtn.innerText = originalText;
                endBtn.style.background = "#dc2626"; // Original red
                endBtn.dataset.confirm = "false";
            }, 3000);
            return;
        }
        
        endBtn.innerText = "Ending...";
        try {
            const res = await fetch('/api/live/admin/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(creds)
            });
            const data = await res.json();
            
            if (!res.ok || !data.success) {
                endBtn.innerText = "Auth Failed";
                return;
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
            
            // Revert button visually for future sessions
            endBtn.innerText = "End Test Now";
            endBtn.style.background = "#dc2626";
            endBtn.dataset.confirm = "false";
        } catch (err) {
            endBtn.innerText = "Network Error";
        }
    }
    
    if (clearBtn) {
        // Double-Click UI Confirmation
        if (clearBtn.dataset.confirm !== "true") {
            const originalText = clearBtn.innerText;
            clearBtn.innerText = "Click Again to WIPE RESPONSES";
            clearBtn.style.background = "#ca8a04"; // Dark yellow
            clearBtn.dataset.confirm = "true";
            setTimeout(() => {
                clearBtn.innerText = originalText;
                clearBtn.style.background = "#eab308"; // Original yellow
                clearBtn.dataset.confirm = "false";
            }, 3000);
            return;
        }
        
        clearBtn.innerText = "Clearing...";
        try {
            const res = await fetch('/api/live/admin/clear-question', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(creds) 
            });
            const data = await res.json();
            
            if (data.success) {
                clearBtn.innerText = "Responses Cleared!";
                clearBtn.style.background = "#16a34a"; // Green
            } else {
                clearBtn.innerText = "Failed to Clear";
                clearBtn.style.background = "#dc2626"; // Red
            }
            
            setTimeout(() => {
                clearBtn.innerText = "Clear Current Question Responses";
                clearBtn.style.background = "#eab308";
                clearBtn.dataset.confirm = "false";
            }, 2000);
            
        } catch (err) {
            clearBtn.innerText = "Network Error";
            setTimeout(() => {
                clearBtn.innerText = "Clear Current Question Responses";
                clearBtn.style.background = "#eab308";
                clearBtn.dataset.confirm = "false";
            }, 2000);
        }
    }
});

async function setQuestionIndex(newIndex) {
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
                if (data.state) {
                    currentIndex = data.state.currentIndex;
                    document.getElementById('q-counter').innerText = `Q: ${currentIndex + 1} ${totalQuestions > 0 ? '/ ' + totalQuestions : ''}`;
                }
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
    }, 2000); // Relaxed to 2000ms to protect Redis rate limits
}