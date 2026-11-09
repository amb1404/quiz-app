let adminKey = "";
let quizId = ""; // Holds the active Room Name
let activeQuizFile = "";
let currentIndex = 0;
let totalQuestions = 0;
let dashInterval;

async function populateAdminQuizDropdown(selectedFile = "") {
    const selectEl = document.getElementById('admin-quiz-select');
    if (!selectEl) return;
    try {
        const res = await fetch('/api/live/list');
        const data = await res.json();
        selectEl.innerHTML = '<option value="">-- None (Lecture / PPT Only) --</option>';
        if (data.success && Array.isArray(data.tests)) {
            data.tests.forEach(test => {
                const opt = document.createElement('option');
                opt.value = test.id;
                opt.textContent = `${test.title} (${test.id})`;
                if (test.id === selectedFile) opt.selected = true;
                selectEl.appendChild(opt);
            });
        }
    } catch (e) {}
}

function updateQuestionControlsUI() {
    const qCounter = document.getElementById('q-counter');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const clearBtn = document.getElementById('clear-responses-btn');

    if (!activeQuizFile || totalQuestions === 0) {
        if (qCounter) qCounter.innerText = "No Question Set Active";
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
    } else {
        if (qCounter) qCounter.innerText = `Q: ${currentIndex + 1} / ${totalQuestions}`;
        if (prevBtn) prevBtn.disabled = (currentIndex <= 0);
        if (nextBtn) nextBtn.disabled = (currentIndex + 1 >= totalQuestions);
        if (clearBtn) clearBtn.disabled = false;
    }
}

// Restore active Room session on browser refresh
window.addEventListener('DOMContentLoaded', async () => {
    await populateAdminQuizDropdown();
    updateQuestionControlsUI();

    try {
        const saved = sessionStorage.getItem('live_admin_session');
        if (saved) {
            const parsed = JSON.parse(saved);
            adminKey = parsed.adminKey;
            quizId = parsed.quizId;
            activeQuizFile = parsed.activeQuizFile || "";

            document.getElementById('admin-key').value = adminKey;
            document.getElementById('quiz-id').value = quizId;
            document.getElementById('create-room-box').style.display = 'flex';
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';

            const showBtn = document.getElementById('show-create-room-btn');
            if (showBtn) showBtn.style.display = 'none';

            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "Room Active (Restored)";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            await populateAdminQuizDropdown(activeQuizFile);
            startDashboardSync();
        }
    } catch (e) {}
});

// Step 1A: Clicking 'Create Room' validates Admin Key & reveals Room Name box
const showCreateRoomBtn = document.getElementById('show-create-room-btn');
if (showCreateRoomBtn) {
    showCreateRoomBtn.addEventListener('click', () => {
        adminKey = document.getElementById('admin-key').value.trim();
        if (!adminKey) {
            alert("Please enter your Admin Secret Key first.");
            return;
        }
        document.getElementById('create-room-box').style.display = 'flex';
        document.getElementById('quiz-id').focus();
    });
}

// Step 1B: Clicking 'Launch Room' creates the room immediately
document.getElementById('start-btn').addEventListener('click', async () => {
    adminKey = document.getElementById('admin-key').value.trim();
    quizId = document.getElementById('quiz-id').value.trim();
    if (!adminKey || !quizId) return alert("Please enter both your Admin Secret Key and a Room Name.");

    const startBtn = document.getElementById('start-btn');
    startBtn.innerText = "Creating Room...";
    try {
        const res = await fetch('/api/live/admin/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey, quizId })
        });
        const data = await res.json();
        if (data.success) {
            activeQuizFile = data.activeQuizFile || "";
            totalQuestions = data.totalQuestions || 0;
            currentIndex = 0;

            document.getElementById('otp-display').innerText = `🟢 Active Room: ${data.roomName}`;
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';

            if (showCreateRoomBtn) showCreateRoomBtn.style.display = 'none';

            sessionStorage.setItem('live_admin_session', JSON.stringify({ adminKey, quizId, activeQuizFile }));

            startBtn.innerText = "Room Active";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            await populateAdminQuizDropdown(activeQuizFile);
            updateQuestionControlsUI();
            startDashboardSync();
        } else {
            alert(data.error);
            startBtn.innerText = "🚀 Launch Room";
        }
    } catch (e) {
        alert("Network error creating room.");
        startBtn.innerText = "🚀 Launch Room";
    }
});

// Step 2: Selecting a Question File from /livemock Dropdown starts broadcasting questions immediately
const adminQuizSelect = document.getElementById('admin-quiz-select');
if (adminQuizSelect) {
    adminQuizSelect.addEventListener('change', async (e) => {
        const selectedFile = e.target.value;
        if (!adminKey || !quizId) return;

        try {
            const res = await fetch('/api/live/admin/select-quiz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminKey, quizId, questionFile: selectedFile })
            });
            const data = await res.json();
            if (data.success) {
                activeQuizFile = data.activeQuizFile || "";
                totalQuestions = data.totalQuestions || 0;
                currentIndex = data.currentIndex || 0;

                const saved = JSON.parse(sessionStorage.getItem('live_admin_session') || '{}');
                saved.activeQuizFile = activeQuizFile;
                sessionStorage.setItem('live_admin_session', JSON.stringify(saved));

                updateQuestionControlsUI();
            } else {
                alert(data.error || "Failed to load question set.");
            }
        } catch (err) {
            alert("Error switching question set.");
        }
    });
}

// Persistent state tracker so the 2-second table redraw never wipes button confirmations
const studentModUIState = new Map();

function getActiveAdminCreds() {
    let creds = {
        adminKey: adminKey || (document.getElementById('admin-key')?.value || '').trim(),
        quizId: quizId || (document.getElementById('quiz-id')?.value || '').trim()
    };
    try {
        const activeSessionStr = sessionStorage.getItem('live_admin_session');
        if (activeSessionStr) {
            const parsed = JSON.parse(activeSessionStr);
            if (!creds.adminKey && parsed.adminKey) creds.adminKey = parsed.adminKey;
            if (!creds.quizId && parsed.quizId) creds.quizId = parsed.quizId;
        }
    } catch (err) {}
    return creds;
}

// End Room, Clear Responses & Student Moderation Delegation
document.addEventListener('click', async (e) => {
    const endBtn = e.target.closest('#end-test-btn');
    const clearBtn = e.target.closest('#clear-responses-btn');
    const modBtn = e.target.closest('.btn-student-moderate');

    if (!endBtn && !clearBtn && !modBtn) return;
    e.preventDefault();

    const creds = getActiveAdminCreds();
    if (!creds.adminKey || !creds.quizId) return;

    // 1. Student Mute / Unmute / Remove (Built identically to Clear & Close Room buttons)
    if (modBtn) {
        const studentName = modBtn.getAttribute('data-student');
        const action = modBtn.getAttribute('data-action');
        if (!studentName || !action) return;

        const stateKey = `${studentName}_${action}`;
        const existingState = studentModUIState.get(stateKey);

        // 2-Click Confirmation for Remove (Kick), persisted across table refreshes
        if (action === 'kick' && (!existingState || existingState.phase !== 'confirm')) {
            const timerId = setTimeout(() => {
                studentModUIState.delete(stateKey);
                fetchAndRenderDashboard();
            }, 3000);

            studentModUIState.set(stateKey, { phase: 'confirm', timerId });
            modBtn.innerText = 'Click Again to REMOVE';
            modBtn.style.background = '#991b1b';
            return;
        }

        if (existingState && existingState.timerId) {
            clearTimeout(existingState.timerId);
        }

        studentModUIState.set(stateKey, { phase: 'loading' });
        modBtn.disabled = true;
        modBtn.innerText = action === 'kick' ? 'Removing...' : (action === 'mute' ? 'Muting...' : 'Unmuting...');
        modBtn.style.background = '#475569';
        if ((action === 'kick' || action === 'mute') && typeof window.cutStudentAudioImmediately === 'function') {
            window.cutStudentAudioImmediately(studentName);
        }

        try {
            const res = await fetch('/api/live/admin/moderate-student', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adminKey: creds.adminKey,
                    quizId: creds.quizId,
                    studentName,
                    action
                })
            });
            const data = await res.json();

            if (res.ok && data.success) {
                modBtn.innerText = action === 'kick' ? 'Removed!' : (action === 'mute' ? 'Muted!' : 'Unmuted!');
                modBtn.style.background = '#16a34a';
                modBtn.style.color = '#ffffff';
                setTimeout(() => {
                    studentModUIState.delete(stateKey);
                    fetchAndRenderDashboard();
                }, 600);
            } else {
                studentModUIState.delete(stateKey);
                modBtn.innerText = 'Failed';
                modBtn.style.background = '#dc2626';
                setTimeout(fetchAndRenderDashboard, 1500);
            }
        } catch (err) {
            studentModUIState.delete(stateKey);
            modBtn.innerText = 'Network Error';
            setTimeout(fetchAndRenderDashboard, 1500);
        }
        return;
    }

    // 2. Close Room Now
    if (endBtn) {
        if (endBtn.dataset.confirm !== "true") {
            const originalText = endBtn.innerText;
            endBtn.innerText = "Click Again to CLOSE ROOM";
            endBtn.style.background = "#991b1b";
            endBtn.dataset.confirm = "true";
            setTimeout(() => {
                endBtn.innerText = originalText;
                endBtn.style.background = "#dc2626";
                endBtn.dataset.confirm = "false";
            }, 3000);
            return;
        }

        endBtn.innerText = "Closing Room...";
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
            document.getElementById('create-room-box').style.display = 'none';
            if (showCreateRoomBtn) showCreateRoomBtn.style.display = 'inline-block';

            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "🚀 Launch Room";
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            startBtn.style.cursor = 'pointer';
            document.getElementById('otp-display').innerText = "";
            document.getElementById('quiz-id').value = "";

            endBtn.innerText = "🛑 Close Room Now";
            endBtn.style.background = "#dc2626";
            endBtn.dataset.confirm = "false";
        } catch (err) {
            endBtn.innerText = "Network Error";
        }
    }

    // 3. Clear Current Question Responses
    if (clearBtn) {
        if (clearBtn.dataset.confirm !== "true") {
            const originalText = clearBtn.innerText;
            clearBtn.innerText = "Click Again to WIPE RESPONSES";
            clearBtn.style.background = "#ca8a04";
            clearBtn.dataset.confirm = "true";
            setTimeout(() => {
                clearBtn.innerText = originalText;
                clearBtn.style.background = "#eab308";
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
            clearBtn.innerText = data.success ? "Responses Cleared!" : "Failed to Clear";
            clearBtn.style.background = data.success ? "#16a34a" : "#dc2626";
            fetchAndRenderDashboard();
            setTimeout(() => {
                clearBtn.innerText = "Clear Current Question Responses";
                clearBtn.style.background = "#eab308";
                clearBtn.dataset.confirm = "false";
            }, 2000);
        } catch (err) {
            clearBtn.innerText = "Network Error";
        }
    }
});

async function setQuestionIndex(newIndex) {
    if (!activeQuizFile || newIndex < 0 || (totalQuestions > 0 && newIndex >= totalQuestions)) return;
    document.getElementById('prev-btn').disabled = true;
    document.getElementById('next-btn').disabled = true;

    const creds = getActiveAdminCreds();
    await fetch('/api/live/admin/set-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: creds.adminKey, quizId: creds.quizId, index: newIndex })
    });

    currentIndex = newIndex;
    updateQuestionControlsUI();
    fetchAndRenderDashboard();
}

document.getElementById('prev-btn').addEventListener('click', () => setQuestionIndex(currentIndex - 1));
document.getElementById('next-btn').addEventListener('click', () => setQuestionIndex(currentIndex + 1));

async function fetchAndRenderDashboard() {
    try {
        const creds = getActiveAdminCreds();
        if (!creds.adminKey || !creds.quizId) return;

        const res = await fetch(`/api/live/admin/dashboard?adminKey=${encodeURIComponent(creds.adminKey)}&quizId=${encodeURIComponent(creds.quizId)}`);
        const data = await res.json();

        if (data.success) {
            if (data.state) {
                currentIndex = data.state.currentIndex || 0;
                activeQuizFile = data.state.activeQuizFile || "";
                totalQuestions = data.state.totalQuestions || 0;
                const selectEl = document.getElementById('admin-quiz-select');
                if (selectEl && selectEl.value !== activeQuizFile) {
                    selectEl.value = activeQuizFile;
                }
                updateQuestionControlsUI();
            }
            if (data.roomName) {
                document.getElementById('otp-display').innerText = `🟢 Active Room: ${data.roomName}`;
            }
            const callerBadge = document.getElementById('admin-caller-badge');
            if (callerBadge) {
                if (data.broadcastActive && Array.isArray(data.activeCallers) && data.activeCallers.length > 0) {
                    callerBadge.textContent = `🟢 Student Speaking: ${data.activeCallers.join(', ')}`;
                    callerBadge.classList.add('calling');
                } else {
                    callerBadge.textContent = '🎧 No active student calls';
                    callerBadge.classList.remove('calling');
                }
            }

            const tbody = document.getElementById('board-body');
            tbody.innerHTML = '';

            data.students.forEach(student => {
                const ansData = student.data.answers ? student.data.answers[currentIndex] : null;
                const isMuted = Boolean(student.data.muted);
                const isCalling = Boolean(student.data.isCalling);
                const tr = document.createElement('tr');

                let timeStr = "-";
                if (ansData) {
                    const date = new Date(ansData.time);
                    timeStr = `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                }

                const tdName = document.createElement('td');
                tdName.style.fontWeight = 'bold';
                tdName.textContent = student.name + (isCalling ? ' 🎙️ (Speaking)' : '') + (isMuted ? ' 🔇 (Muted)' : '');
                if (isCalling) tdName.style.color = '#34d399';

                const tdOption = document.createElement('td');
                tdOption.style.fontWeight = 'bold';
                tdOption.style.color = ansData ? '#38bdf8' : '#94a3b8';
                tdOption.textContent = !activeQuizFile
                    ? 'Joined (Lecture / PPT Mode)'
                    : (ansData ? `Option ${ansData.answer + 1}` : 'Waiting...');

                const tdTime = document.createElement('td');
                if (ansData) {
                    const badge = document.createElement('span');
                    badge.className = 'time-badge';
                    badge.textContent = timeStr;
                    tdTime.appendChild(badge);
                } else {
                    tdTime.textContent = '-';
                }

                const tdControls = document.createElement('td');
                tdControls.style.display = 'flex';
                tdControls.style.gap = '8px';

                // Mute / Unmute Button (Preserves state across 2s table redraws)
                const muteAction = isMuted ? 'unmute' : 'mute';
                const muteState = studentModUIState.get(`${student.name}_${muteAction}`);
                const muteBtn = document.createElement('button');
                muteBtn.type = 'button';
                muteBtn.className = 'btn-student-moderate';
                muteBtn.setAttribute('data-student', student.name);
                muteBtn.setAttribute('data-action', muteAction);
                muteBtn.style.padding = '8px 14px';
                muteBtn.style.fontSize = '12px';
                muteBtn.style.borderRadius = '6px';
                muteBtn.style.fontWeight = 'bold';
                muteBtn.style.cursor = 'pointer';

                if (muteState && muteState.phase === 'loading') {
                    muteBtn.disabled = true;
                    muteBtn.style.background = '#475569';
                    muteBtn.style.color = '#ffffff';
                    muteBtn.textContent = muteAction === 'mute' ? 'Muting...' : 'Unmuting...';
                } else {
                    muteBtn.style.background = isMuted ? '#059669' : '#eab308';
                    muteBtn.style.color = isMuted ? '#ffffff' : '#0f172a';
                    muteBtn.textContent = isMuted ? '🔊 Unmute' : '🔇 Mute';
                }

                // Remove Button (Preserves 2-click confirmation state across 2s table redraws)
                const kickState = studentModUIState.get(`${student.name}_kick`);
                const kickBtn = document.createElement('button');
                kickBtn.type = 'button';
                kickBtn.className = 'btn-student-moderate';
                kickBtn.setAttribute('data-student', student.name);
                kickBtn.setAttribute('data-action', 'kick');
                kickBtn.style.padding = '8px 14px';
                kickBtn.style.fontSize = '12px';
                kickBtn.style.borderRadius = '6px';
                kickBtn.style.fontWeight = 'bold';
                kickBtn.style.cursor = 'pointer';
                kickBtn.style.color = '#ffffff';

                if (kickState && kickState.phase === 'confirm') {
                    kickBtn.style.background = '#991b1b';
                    kickBtn.textContent = 'Click Again to REMOVE';
                } else if (kickState && kickState.phase === 'loading') {
                    kickBtn.disabled = true;
                    kickBtn.style.background = '#475569';
                    kickBtn.textContent = 'Removing...';
                } else {
                    kickBtn.style.background = '#dc2626';
                    kickBtn.textContent = '🚫 Remove';
                }

                tdControls.appendChild(muteBtn);
                tdControls.appendChild(kickBtn);

                tr.appendChild(tdName);
                tr.appendChild(tdOption);
                tr.appendChild(tdTime);
                tr.appendChild(tdControls);
                tbody.appendChild(tr);
            });
        }
    } catch (e) {}
}

function startDashboardSync() {
    if (dashInterval) clearInterval(dashInterval);
    fetchAndRenderDashboard();
    dashInterval = setInterval(fetchAndRenderDashboard, 2000);
}