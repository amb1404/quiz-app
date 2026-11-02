const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const textInput = document.getElementById('rich-text-input');
const wrapper = document.getElementById('canvas-wrapper');

let currentTool = 'pen';
let isDrawing = false;
let lastX = 0, lastY = 0;
let textPos = { x: 0, y: 0 };
let lastSyncTime = 0;
let isSyncing = false;

// Custom Cursors
const penCursor = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path></svg>') 0 24, auto`;
const eraserCursor = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="4" ry="4"></rect></svg>') 12 12, auto`;

// Goal 1: Auto-Login via URL parameters
window.onload = () => {
    const params = new URLSearchParams(window.location.search);
    const k = params.get('k');
    const r = params.get('r');
    if (k && r) {
        document.getElementById('sync-key').value = k;
        document.getElementById('sync-room').value = r;
        document.getElementById('auth-panel').style.display = 'none'; // Hide if auto-filled
    }
    setPage('portrait');
};

document.getElementById('btn-portrait').addEventListener('click', () => setPage('portrait'));
document.getElementById('btn-landscape').addEventListener('click', () => setPage('landscape'));
document.getElementById('btn-clear').addEventListener('click', clearCanvas);

// Goal 4: Add Page (Seamless Vertical Extension)
document.getElementById('btn-add-page').addEventListener('click', () => {
    const oldData = canvas.toDataURL(); // Save current work
    canvas.height += 1131; // Add one portrait page of height
    
    const img = new Image();
    img.onload = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height); // Fill new space white
        ctx.drawImage(img, 0, 0); // Restore old work
        syncToBackend();
        wrapper.scrollTo({ top: wrapper.scrollHeight, behavior: 'smooth' });
    };
    img.src = oldData;
});

document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => setTool(e.currentTarget.getAttribute('data-tool')));
});

function setPage(layout) {
    canvas.width = layout === 'portrait' ? 800 : 1131;
    canvas.height = layout === 'portrait' ? 1131 : 800;
    clearCanvas();
    setTool('pen');
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
    
    if (tool === 'pen') canvas.style.cursor = penCursor;
    else if (tool === 'eraser') canvas.style.cursor = eraserCursor;
    else canvas.style.cursor = 'text';

    if (tool !== 'text') finalizeText();
}

// Block the default right-click menu so the XP Pen eraser button works cleanly
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
    if (currentTool === 'text') {
        finalizeText();
        const rect = canvas.getBoundingClientRect();
        textPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        
        textInput.style.left = `${textPos.x}px`;
        textInput.style.top = `${textPos.y}px`;
        textInput.style.fontSize = `${document.getElementById('size-picker').value * 4}px`;
        textInput.style.display = 'block';
        textInput.innerHTML = '';
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

    // Goal 7: Catch XP Pen Stylus button (usually maps to buttons=2 or 32)
    const isStylusEraser = (e.pointerType === 'pen' && (e.buttons === 2 || e.buttons === 32));
    const activeTool = isStylusEraser ? 'eraser' : currentTool;

    // Apply PowerPoint-style smoothing using Quadratic Bezier Curves
    const midX = (lastX + x) / 2;
    const midY = (lastY + y) / 2;

    ctx.lineWidth = activeTool === 'eraser' ? 30 : document.getElementById('size-picker').value * (e.pressure ? e.pressure * 1.5 : 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (activeTool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
    } else {
        ctx.strokeStyle = document.getElementById('text-color').value;
    }

    ctx.quadraticCurveTo(lastX, lastY, midX, midY);
    ctx.stroke();
    
    lastX = x; lastY = y;

    if (Date.now() - lastSyncTime > 350) {
        syncToBackend();
        lastSyncTime = Date.now();
    }
});

canvas.addEventListener('pointerup', () => {
    if (isDrawing) {
        isDrawing = false;
        ctx.stroke();
        ctx.closePath();
        syncToBackend(); 
    }
});

// Goal 5 & 6: Bake MS Word rich text into the Canvas image
textInput.addEventListener('blur', finalizeText);

function finalizeText() {
    if (textInput.style.display === 'none' || textInput.innerText.trim() === '') {
        textInput.style.display = 'none';
        return;
    }

    const htmlContent = textInput.innerHTML;
    
    // Wrap the rich text in an SVG foreignObject to preserve all colors, bold, and highlights
    const svgData = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">
        <foreignObject width="100%" height="100%" x="${textPos.x}" y="${textPos.y}">
            <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Arial; font-size: ${document.getElementById('size-picker').value * 4}px;">
                ${htmlContent}
            </div>
        </foreignObject>
    </svg>`;

    const DOMURL = window.URL || window.webkitURL || window;
    const img = new Image();
    const svg = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = DOMURL.createObjectURL(svg);

    img.onload = () => {
        ctx.drawImage(img, 0, 0);
        DOMURL.revokeObjectURL(url);
        syncToBackend();
    };
    img.src = url;

    textInput.style.display = 'none';
    textInput.innerHTML = '';
}

async function syncToBackend() {
    if (isSyncing) return;
    
    const adminKey = document.getElementById('sync-key').value.trim();
    const roomId = document.getElementById('sync-room').value.trim();
    if (!adminKey || !roomId) return;

    isSyncing = true;
    const canvasData = canvas.toDataURL('image/jpeg', 0.3); 
    
    try {
        await fetch('/api/liveroom/admin/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey, roomId, canvasData })
        });
    } catch(err) {}
    
    isSyncing = false;
}
