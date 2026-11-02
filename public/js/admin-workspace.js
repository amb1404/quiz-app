const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const textInput = document.getElementById('text-input');

let currentTool = 'pen';
let isDrawing = false;
let lastX = 0, lastY = 0;
let textPos = { x: 0, y: 0 };

document.getElementById('btn-portrait').addEventListener('click', () => setPage('portrait'));
document.getElementById('btn-landscape').addEventListener('click', () => setPage('landscape'));
document.getElementById('btn-clear').addEventListener('click', clearCanvas);

document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => setTool(e.currentTarget.getAttribute('data-tool')));
});

function setPage(layout) {
    canvas.width = layout === 'portrait' ? 800 : 1131;
    canvas.height = layout === 'portrait' ? 1131 : 800;
    clearCanvas();
}

function clearCanvas() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    syncToBackend();
}

function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${tool}`).classList.add('active');
    if (tool !== 'text') finalizeText();
}

canvas.addEventListener('pointerdown', (e) => {
    if (currentTool === 'text') {
        finalizeText();
        const rect = canvas.getBoundingClientRect();
        textPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        
        const size = document.getElementById('size-picker').value;
        textInput.style.left = `${e.clientX}px`;
        textInput.style.top = `${e.clientY}px`;
        textInput.style.fontSize = `${size * 3}px`;
        textInput.style.color = document.getElementById('color-picker').value;
        textInput.style.display = 'block';
        textInput.value = '';
        setTimeout(() => textInput.focus(), 10);
        return;
    }

    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = (e.clientX - rect.left) * (canvas.width / rect.width);
    lastY = (e.clientY - rect.top) * (canvas.height / rect.height);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || currentTool === 'text') return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    ctx.lineWidth = document.getElementById('size-picker').value;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (currentTool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
        ctx.globalCompositeOperation = 'source-over';
    } else {
        ctx.strokeStyle = document.getElementById('color-picker').value;
        ctx.globalCompositeOperation = 'source-over';
    }

    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x; lastY = y;
});

canvas.addEventListener('pointerup', () => {
    if (isDrawing) {
        isDrawing = false;
        ctx.closePath();
        syncToBackend(); 
    }
});

textInput.addEventListener('blur', finalizeText);

function finalizeText() {
    if (textInput.style.display === 'none' || textInput.value.trim() === '') {
        textInput.style.display = 'none';
        return;
    }

    const size = document.getElementById('size-picker').value * 3;
    const isBold = document.getElementById('text-bold').checked;
    const isItalic = document.getElementById('text-italic').checked;
    const isHighlight = document.getElementById('text-highlight').checked;
    
    ctx.font = `${isItalic ? 'italic ' : ''}${isBold ? 'bold ' : ''}${size}px Arial`;
    ctx.textBaseline = 'top';
    
    const textWidth = ctx.measureText(textInput.value).width;
    
    if (isHighlight) {
        ctx.fillStyle = document.getElementById('highlight-picker').value;
        ctx.fillRect(textPos.x - 2, textPos.y - 2, textWidth + 4, size + 4);
    }
    
    ctx.fillStyle = document.getElementById('color-picker').value;
    ctx.fillText(textInput.value, textPos.x, textPos.y);
    
    textInput.style.display = 'none';
    textInput.value = '';
    syncToBackend();
}

function syncToBackend() {
    const adminKey = document.getElementById('sync-key').value.trim();
    const roomId = document.getElementById('sync-room').value.trim();
    if (!adminKey || !roomId) return;

    const canvasData = canvas.toDataURL('image/jpeg', 0.6); 
    
    fetch('/api/liveroom/admin/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey, roomId, canvasData })
    }).catch(err => console.error("Sync failed:", err));
}

setPage('portrait');
