let roomToken = "";
let roomId = "";

document.getElementById('join-room-btn').addEventListener('click', async () => {
    const firstName = document.getElementById('stu-fname').value.trim();
    const lastName = document.getElementById('stu-lname').value.trim();
    roomId = document.getElementById('stu-room').value.trim();
    const otp = document.getElementById('stu-otp').value.trim();

    if (!firstName || !lastName || !roomId || !otp) return alert("Fill all fields.");

    const res = await fetch('/api/liveroom/student/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, roomId, otp })
    });
    
    const data = await res.json();
    if (data.success) {
        roomToken = data.token;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('room-viewer').style.display = 'flex';
        startRoomSync();
    } else {
        alert(data.error);
    }
});

function startRoomSync() {
    setInterval(async () => {
        if (!roomToken) return;
        try {
            const res = await fetch(`/api/liveroom/student/sync/${roomId}`, {
                headers: { 'Authorization': `Bearer ${roomToken}` }
            });
            const data = await res.json();
            if (data.success && data.canvasData) {
                document.getElementById('student-board').src = data.canvasData;
            }
        } catch(e) {}
    }, 1000);
}
