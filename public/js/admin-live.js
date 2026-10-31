let adminKey = "";
let quizId = "";
let currentIndex = 0;
let totalQuestions = 0;
let dashInterval;

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

// End test on all student browsers immediately ONLY when admin explicitly exits tab
window.addEventListener('beforeunload', () => {
    if (adminKey && quizId) {
        fetch('/api/live/admin/end', {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey, quizId })
        }).catch(() => {});
    }
});

async function setQuestionIndex(newIndex) {
    if (newIndex < 0 || newIndex >= totalQuestions) return;
    document.getElementById('prev-btn').disabled = true;
    document.getElementById('next-btn').disabled = true;
    
    await fetch('/api/live/admin/set-index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey, quizId, index: newIndex })
    });
    
    currentIndex = newIndex;
    document.getElementById('q-counter').innerText = `Q: ${currentIndex + 1} / ${totalQuestions}`;
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
    }, 1500);
}
