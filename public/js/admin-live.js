let adminKey = "";
let quizId = ""; // Holds the active Room Name
let activeQuizFile = "";
let currentIndex = 0;
let totalQuestions = 0;
let activeQuizFile2 = "";
let currentIndex2 = 0;
let totalQuestions2 = 0;
let dashInterval;

async function populateAdminQuizDropdown(selectedFile = "", selectedFile2 = "") {
    const selectEl = document.getElementById('admin-quiz-select');
    const selectEl2 = document.getElementById('admin-quiz-select-2');
    if (!selectEl && !selectEl2) return;
    try {
        const res = await fetch('/api/live/list');
        const data = await res.json();
        const tests = (data.success && Array.isArray(data.tests)) ? data.tests : [];

        if (selectEl) {
            selectEl.innerHTML = '<option value="">-- None (Lecture / PPT Only) --</option>';
            tests.forEach(test => {
                const opt = document.createElement('option');
                opt.value = test.id;
                opt.textContent = `${test.title} (${test.id})`;
                if (test.id === selectedFile) opt.selected = true;
                selectEl.appendChild(opt);
            });
        }
        if (selectEl2) {
            selectEl2.innerHTML = '<option value="">-- None (Off — Hidden from Students) --</option>';
            tests.forEach(test => {
                const opt = document.createElement('option');
                opt.value = test.id;
                opt.textContent = `${test.title} (${test.id})`;
                if (test.id === selectedFile2) opt.selected = true;
                selectEl2.appendChild(opt);
            });
        }
    } catch (e) {}
}

function updateQuestionControlsUI() {
    const qCounter = document.getElementById('q-counter');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const clearBtn = document.getElementById('clear-responses-btn');

    const isPdfActive = Boolean(activeQuizFile && String(activeQuizFile).toLowerCase().endsWith('.pdf'));
    if (!activeQuizFile || totalQuestions === 0) {
        if (qCounter) qCounter.innerText = isPdfActive ? "📄 PDF Active" : "No Question Set Active";
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
    } else {
        if (qCounter) qCounter.innerText = `Q: ${currentIndex + 1} / ${totalQuestions}`;
        if (prevBtn) prevBtn.disabled = (currentIndex <= 0);
        if (nextBtn) nextBtn.disabled = (currentIndex + 1 >= totalQuestions);
        if (clearBtn) clearBtn.disabled = false;
    }

    const qCounter2 = document.getElementById('q-counter-2');
    const prevBtn2 = document.getElementById('prev-btn-2');
    const nextBtn2 = document.getElementById('next-btn-2');
    const clearBtn2 = document.getElementById('clear-responses-btn-2');

    const isPdfActive2 = Boolean(activeQuizFile2 && String(activeQuizFile2).toLowerCase().endsWith('.pdf'));
    if (!activeQuizFile2 || totalQuestions2 === 0) {
        if (qCounter2) qCounter2.innerText = isPdfActive2 ? "📄 PDF Active" : "Screen 2 Inactive";
        if (prevBtn2) prevBtn2.disabled = true;
        if (nextBtn2) nextBtn2.disabled = true;
        if (clearBtn2) clearBtn2.disabled = true;
    } else {
        if (qCounter2) qCounter2.innerText = `Q: ${currentIndex2 + 1} / ${totalQuestions2}`;
        if (prevBtn2) prevBtn2.disabled = (currentIndex2 <= 0);
        if (nextBtn2) nextBtn2.disabled = (currentIndex2 + 1 >= totalQuestions2);
        if (clearBtn2) clearBtn2.disabled = false;
    }
}

function removeAllRejoinButtons() {
    document.querySelectorAll('.rejoin-room-btn, #rejoin-room-btn').forEach(el => el.remove());
}

async function rejoinActiveRoom(targetRoomId, targetRoomName, btnEl) {
    adminKey = document.getElementById('admin-key').value.trim();
    if (!adminKey) {
        alert("Please enter your Admin Secret Key first.");
        document.getElementById('admin-key')?.focus();
        return;
    }

    if (btnEl) {
        btnEl.disabled = true;
        btnEl.innerText = "Rejoining Room...";
    }

    try {
        const res = await fetch('/api/live/admin/resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey, quizId: targetRoomId })
        });
        const data = await res.json();
        if (data.success) {
            quizId = data.quizId;
            activeQuizFile = data.activeQuizFile || "";
            totalQuestions = data.totalQuestions || 0;
            currentIndex = data.currentIndex || 0;

            document.title = `Admin - ${data.roomName}`;
            document.getElementById('quiz-id').value = quizId;
            document.getElementById('otp-display').innerText = `🟢 Active Room: ${data.roomName}`;
            document.getElementById('create-room-box').style.display = 'flex';
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';

            const showBtn = document.getElementById('show-create-room-btn');
            if (showBtn) showBtn.style.display = 'none';
            removeAllRejoinButtons();

            sessionStorage.setItem('live_admin_session', JSON.stringify({ quizId, activeQuizFile }));
            if (typeof window.saveAdminPanelState === 'function') {
                window.saveAdminPanelState({ adminKey });
            }

            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "Room Active";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            await populateAdminQuizDropdown(activeQuizFile);
            updateQuestionControlsUI();
            startDashboardSync();
            if (typeof window.ensureAdminLiveKitConnected === 'function') {
                window.ensureAdminLiveKitConnected(quizId, true).catch(() => {});
            }
        } else {
            alert(data.error || "Could not rejoin room.");
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerText = `🔄 Rejoin Room: ${targetRoomName}`;
            }
        }
    } catch (e) {
        alert("Network error rejoining room.");
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.innerText = `🔄 Rejoin Room: ${targetRoomName}`;
        }
    }
}

async function checkAndShowRejoinRoomButton() {
    try {
        const res = await fetch('/api/live/rooms');
        const data = await res.json();
        if (!data.success || !Array.isArray(data.rooms) || data.rooms.length === 0) return;

        const sorted = [...data.rooms].sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
        const showBtn = document.getElementById('show-create-room-btn');
        if (!showBtn) return;

        removeAllRejoinButtons();
        let insertAnchor = showBtn;
        sorted.forEach((activeRoom) => {
            if (!activeRoom || !activeRoom.id) return;
            const rejoinBtn = document.createElement('button');
            rejoinBtn.className = 'rejoin-room-btn';
            rejoinBtn.type = 'button';
            rejoinBtn.style.background = '#059669';
            rejoinBtn.innerText = `🔄 Rejoin Room: ${activeRoom.name}`;
            rejoinBtn.addEventListener('click', () => rejoinActiveRoom(activeRoom.id, activeRoom.name, rejoinBtn));
            insertAnchor.insertAdjacentElement('afterend', rejoinBtn);
            insertAnchor = rejoinBtn;
        });
    } catch (e) {}
}

// Restore active Room session on browser refresh, or offer 1-click Rejoin for every active room
window.addEventListener('DOMContentLoaded', async () => {
    await populateAdminQuizDropdown();
    updateQuestionControlsUI();

    try {
        const saved = sessionStorage.getItem('live_admin_session');
        if (saved) {
            const parsed = JSON.parse(saved);
            quizId = parsed.quizId;
            activeQuizFile = parsed.activeQuizFile || "";

            document.title = `Admin - ${quizId}`;
            document.getElementById('quiz-id').value = quizId;
            document.getElementById('otp-display').innerText = `🟢 Active Room: ${quizId}`;
            document.getElementById('create-room-box').style.display = 'flex';
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';

            const showBtn = document.getElementById('show-create-room-btn');
            if (showBtn) showBtn.style.display = 'none';

            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "Room Active";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            await populateAdminQuizDropdown(activeQuizFile);
            startDashboardSync();
        } else {
            await checkAndShowRejoinRoomButton();
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
            currentIndex = data.currentIndex || 0;

            document.title = `Admin - ${data.roomName}`;
            document.getElementById('otp-display').innerText = `🟢 Active Room: ${data.roomName}`;
            document.getElementById('control-panel').style.display = 'block';
            document.getElementById('board-panel').style.display = 'block';

            if (showCreateRoomBtn) showCreateRoomBtn.style.display = 'none';
            removeAllRejoinButtons();

            sessionStorage.setItem('live_admin_session', JSON.stringify({ quizId, activeQuizFile }));
            if (typeof window.saveAdminPanelState === 'function') {
                window.saveAdminPanelState({ adminKey });
            }

            startBtn.innerText = "Room Active";
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';

            await populateAdminQuizDropdown(activeQuizFile);
            updateQuestionControlsUI();
            startDashboardSync();
            if (typeof window.ensureAdminLiveKitConnected === 'function') {
                window.ensureAdminLiveKitConnected(quizId, true).catch(() => {});
            }
        } else {
            alert(data.error);
            startBtn.innerText = "Launch Room";
        }
    } catch (e) {
        alert("Network error creating room.");
        startBtn.innerText = "Launch Room";
    }
});

// Step 2: Selecting a Question File from /livemock Dropdown (Screen 1 or Screen 2)
async function handleScreenQuizSelect(selectedFile, screenNum) {
    const creds = getActiveAdminCreds();
    if (!creds.adminKey || !creds.quizId) {
        alert("Please enter your Admin Secret Key first.");
        return;
    }
    adminKey = creds.adminKey;
    quizId = creds.quizId;

    try {
        const res = await fetch('/api/live/admin/select-quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                adminKey: creds.adminKey,
                quizId: creds.quizId,
                questionFile: selectedFile,
                screen: screenNum
            })
        });
        const data = await res.json();
        if (data.success) {
            const saved = JSON.parse(sessionStorage.getItem('live_admin_session') || '{}');
            if (screenNum === 2) {
                activeQuizFile2 = data.activeQuizFile || "";
                totalQuestions2 = data.totalQuestions || 0;
                currentIndex2 = data.currentIndex || 0;
                saved.activeQuizFile2 = activeQuizFile2;
            } else {
                activeQuizFile = data.activeQuizFile || "";
                totalQuestions = data.totalQuestions || 0;
                currentIndex = data.currentIndex || 0;
                saved.activeQuizFile = activeQuizFile;
            }
            sessionStorage.setItem('live_admin_session', JSON.stringify(saved));
            updateQuestionControlsUI();
        } else {
            alert(data.error || "Failed to load question set.");
        }
    } catch (err) {
        alert("Error switching question set.");
    }
}

const adminQuizSelect = document.getElementById('admin-quiz-select');
if (adminQuizSelect) {
    adminQuizSelect.addEventListener('change', (e) => handleScreenQuizSelect(e.target.value, 1));
}
const adminQuizSelect2 = document.getElementById('admin-quiz-select-2');
if (adminQuizSelect2) {
    adminQuizSelect2.addEventListener('change', (e) => handleScreenQuizSelect(e.target.value, 2));
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
            if (!creds.quizId && parsed.quizId) creds.quizId = parsed.quizId;
        }
    } catch (err) {}
    return creds;
}

// End Room, Clear Responses & Student Moderation Delegation
document.addEventListener('click', async (e) => {
    const endBtn = e.target.closest('#end-test-btn');
    const clearBtn = e.target.closest('#clear-responses-btn, #clear-responses-btn-2');
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

        if (typeof window.stopAdminBroadcastStream === 'function') {
            await window.stopAdminBroadcastStream(false);
        }

        clearInterval(dashInterval);
            sessionStorage.removeItem('live_admin_session');
            document.getElementById('control-panel').style.display = 'none';
            document.getElementById('board-panel').style.display = 'none';
            document.title = 'Admin - Live Dashboard';
            document.getElementById('create-room-box').style.display = 'none';
            removeAllRejoinButtons();
            if (showCreateRoomBtn) showCreateRoomBtn.style.display = 'inline-block';

            const startBtn = document.getElementById('start-btn');
            startBtn.innerText = "Launch Room";
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

    // 3. Clear Current Question Responses (Screen 1 or Screen 2)
    if (clearBtn) {
        const screenNum = clearBtn.id === 'clear-responses-btn-2' ? 2 : 1;
        const defaultLabel = screenNum === 2 ? 'Clear S2' : 'Clear S1';
        if (clearBtn.dataset.confirm !== "true") {
            clearBtn.innerText = `Click Again (S${screenNum})`;
            clearBtn.style.background = "#ca8a04";
            clearBtn.style.color = "#0f172a";
            clearBtn.dataset.confirm = "true";
            setTimeout(() => {
                clearBtn.innerText = defaultLabel;
                clearBtn.style.background = "#334155";
                clearBtn.style.color = "#f8fafc";
                clearBtn.dataset.confirm = "false";
            }, 3000);
            return;
        }

        clearBtn.innerText = "Clearing...";
        try {
            const res = await fetch('/api/live/admin/clear-question', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...creds, screen: screenNum })
            });
            const data = await res.json();
            clearBtn.innerText = data.success ? "Cleared!" : "Failed";
            clearBtn.style.background = data.success ? "#16a34a" : "#dc2626";
            clearBtn.style.color = "#ffffff";
            fetchAndRenderDashboard();
            setTimeout(() => {
                clearBtn.innerText = defaultLabel;
                clearBtn.style.background = "#334155";
                clearBtn.style.color = "#f8fafc";
                clearBtn.dataset.confirm = "false";
            }, 2000);
        } catch (err) {
            clearBtn.innerText = "Network Error";
        }
    }
});

async function setQuestionIndex(newIndex, screenNum = 1) {
    const isS2 = screenNum === 2;
    const file = isS2 ? activeQuizFile2 : activeQuizFile;
    const total = isS2 ? totalQuestions2 : totalQuestions;
    if (!file || newIndex < 0 || (total > 0 && newIndex >= total)) return;

    const pBtn = document.getElementById(isS2 ? 'prev-btn-2' : 'prev-btn');
    const nBtn = document.getElementById(isS2 ? 'next-btn-2' : 'next-btn');
    if (pBtn) pBtn.disabled = true;
    if (nBtn) nBtn.disabled = true;

    const creds = getActiveAdminCreds();
    await fetch('/api/live/admin/set-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: creds.adminKey, quizId: creds.quizId, index: newIndex, screen: screenNum })
    });

    if (isS2) currentIndex2 = newIndex;
    else currentIndex = newIndex;
    updateQuestionControlsUI();
    fetchAndRenderDashboard();
}

document.getElementById('prev-btn')?.addEventListener('click', () => setQuestionIndex(currentIndex - 1, 1));
document.getElementById('next-btn')?.addEventListener('click', () => setQuestionIndex(currentIndex + 1, 1));
document.getElementById('prev-btn-2')?.addEventListener('click', () => setQuestionIndex(currentIndex2 - 1, 2));
document.getElementById('next-btn-2')?.addEventListener('click', () => setQuestionIndex(currentIndex2 + 1, 2));

// --- BULLETPROOF SOCKET INITIALIZATION & LIVE ROSTER RENDERER ---
let socket;
if (typeof io !== 'undefined') {
    socket = io();

    // Automatically rejoin admin room on initial connect AND after any new commit / server restart
    socket.on("connect", () => {
        const creds = getActiveAdminCreds();
        if (creds.quizId && creds.adminKey) {
            socket.emit("join-admin-room", { quizId: creds.quizId, adminKey: creds.adminKey });
        }
    });

    socket.on("room-state", (data) => {
        if (!data) return;
        activeQuizFile = data.activeQuizFile || "";
        currentIndex = Number(data.currentIndex) || 0;
        totalQuestions = Number(data.totalQuestions) || 0;
        const selectEl = document.getElementById('admin-quiz-select');
        if (selectEl && selectEl.value !== activeQuizFile) {
            selectEl.value = activeQuizFile;
        }

        const s2 = data.screen2 || {};
        activeQuizFile2 = s2.activeQuizFile || "";
        currentIndex2 = Number(s2.currentIndex) || 0;
        totalQuestions2 = Number(s2.totalQuestions) || 0;
        const selectEl2 = document.getElementById('admin-quiz-select-2');
        if (selectEl2 && selectEl2.value !== activeQuizFile2) {
            selectEl2.value = activeQuizFile2;
        }

        if (data.broadcastMode && typeof window.syncAdminBroadcastModeFromServer === 'function') {
            window.syncAdminBroadcastModeFromServer(data.broadcastMode);
        }
        updateQuestionControlsUI();
    });

    socket.on("admin-board", (data) => {
        if (!data || !data.board) return;
        window.latestAdminBoard = data.board;
        const tbody = document.getElementById('board-body');
        if (!tbody) return;

        const qIdx = Number(data.currentIndex) || 0;
        const qIdx2 = Number(data.screen2CurrentIndex) || 0;
        const s1HasJson = Boolean(data.activeQuizFile && data.activeQuizType !== 'pdf' && Number(data.totalQuestions) > 0);
        const s2HasJson = Boolean(data.screen2ActiveQuizFile && data.screen2ActiveQuizType !== 'pdf' && Number(data.screen2TotalQuestions) > 0);

        Object.entries(data.board).forEach(([sName, info]) => {
            if ((info.kicked || info.disconnected || info.muted) && typeof window.cutStudentAudioImmediately === 'function') {
                window.cutStudentAudioImmediately(sName);
            }
        });
        const entries = Object.entries(data.board).filter(([_, info]) => !info.kicked && !info.disconnected && !info.hiddenAway);

        if (entries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="color: #94a3b8; text-align: center;">No students in room yet.</td></tr>';
            return;
        }

        const escHtml = (str) => String(str === null || str === undefined ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const formatAnsBadge = (ansObj, prefix = '') => {
            if (!ansObj) {
                return {
                    status: `${prefix}<span style="color: #94a3b8;">⏳ Thinking / Listening...</span>`,
                    speed: prefix ? `${prefix}-` : '-'
                };
            }
            const badgeColor = ansObj.isCorrect === true ? '#10b981' : (ansObj.isCorrect === false ? '#ef4444' : '#3b82f6');
            const icon = ansObj.isCorrect === true ? '✅' : (ansObj.isCorrect === false ? '❌' : '☑️');
            const safeOptionText = escHtml(ansObj.optionLabel || ('Option ' + (ansObj.answer + 1)));
            return {
                status: `${prefix}<span style="color: ${badgeColor}; font-weight: bold;">${icon} ${safeOptionText}</span>`,
                speed: `${prefix}<span class="time-badge">${escHtml(ansObj.timeSec)}s</span>`
            };
        };

        tbody.innerHTML = entries.map(([studentName, info]) => {
            const ans1 = info.answers ? info.answers[qIdx] : null;
            const ans2 = info.answers2 ? info.answers2[qIdx2] : null;

            let statusHtml;
            let speedHtml;

            if (s1HasJson && s2HasJson) {
                const r1 = formatAnsBadge(ans1, '<span style="color:#93c5fd;font-weight:700;font-size:11px;margin-right:4px;">S1:</span>');
                const r2 = formatAnsBadge(ans2, '<span style="color:#c4b5fd;font-weight:700;font-size:11px;margin-right:4px;">S2:</span>');
                statusHtml = `<div style="display:flex;flex-direction:column;gap:3px;"><div>${r1.status}</div><div>${r2.status}</div></div>`;
                speedHtml = `<div style="display:flex;flex-direction:column;gap:3px;"><div>${r1.speed}</div><div>${r2.speed}</div></div>`;
            } else if (!s1HasJson && s2HasJson) {
                const r2 = formatAnsBadge(ans2);
                statusHtml = r2.status;
                speedHtml = r2.speed;
            } else {
                const r1 = formatAnsBadge(ans1);
                statusHtml = r1.status;
                speedHtml = r1.speed;
            }

            const isMuted = info.muted === true;
            const muteAction = isMuted ? 'unmute' : 'mute';
            const muteLabel = isMuted ? 'Unmute' : ' Mute';
            const muteBg = isMuted ? '#64748b' : '#f59e0b';
            const safeStudent = escHtml(studentName);

            return `
                <tr>
                    <td style="font-weight: bold;">${safeStudent}</td>
                    <td>${statusHtml}</td>
                    <td>${speedHtml}</td>
                    <td style="display: flex; gap: 8px; align-items: center;">
                        <button class="btn-student-moderate" data-student="${safeStudent}" data-action="${muteAction}" style="background: ${muteBg}; padding: 6px 12px; font-size: 12px;">${muteLabel}</button>
                        <button class="btn-student-moderate" data-student="${safeStudent}" data-action="kick" style="background: #dc2626; padding: 6px 12px; font-size: 12px;">Remove</button>
                    </td>
                </tr>
            `;
        }).join('');
    });
}

window.startDashboardSync = function() {
    const creds = getActiveAdminCreds();
    if (creds.quizId && creds.adminKey && socket) {
        socket.emit("join-admin-room", { quizId: creds.quizId, adminKey: creds.adminKey });
    }
};

window.fetchAndRenderDashboard = function() {
    window.startDashboardSync();
};