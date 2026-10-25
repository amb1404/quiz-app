const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key';

// OTP & Session Stores
const pendingOtps = {};
const activeSessions = new Set();

app.use(express.json());

// --- BACKEND-INJECTED CSS OVERRIDES (Mobile Layout Fix, Centered Nav Grid, No Underlines) ---
app.get('/style.css', (req, res) => {
    const cssPath = path.join(__dirname, 'public', 'style.css');
    let cssContent = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';

    const backendCssOverrides = `
/* --- Server-Enforced Navigation Grid & Mobile Viewport Fit --- */
#first-name, #last-name {
    text-transform: uppercase;
}
#email-address {
    text-transform: lowercase;
}

.quiz-nav-container {
    display: grid !important;
    grid-template-columns: repeat(2, 145px) !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 12px 16px !important;
    margin-top: 24px !important;
}

.quiz-nav-container button {
    margin: 0 !important;
    width: 100% !important;
    max-width: none !important;
    text-decoration: none !important;
}

.quiz-nav-container button:hover {
    text-decoration: none !important;
}

.quiz-nav-container button:nth-child(1) {
    grid-column: 1 / 2 !important;
    grid-row: 1 !important;
}

.quiz-nav-container button:nth-child(3) {
    grid-column: 2 / 3 !important;
    grid-row: 1 !important;
}

.quiz-nav-container button:nth-child(2) {
    grid-column: 1 / 3 !important;
    grid-row: 2 !important;
}

@media (max-width: 600px) {
    body {
        padding: 6px !important;
    }

    #quiz-screen {
        width: 100% !important;
        max-width: 100% !important;
        min-height: calc(100dvh - 12px) !important;
        padding: 10px 12px !important;
        border-radius: 12px !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        margin: 0 auto !important;
        box-sizing: border-box !important;
    }

    /* Stack header cleanly on mobile so Submit Quiz doesn't overflow */
    .quiz-header {
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 6px !important;
        margin-bottom: 6px !important;
    }

    .quiz-header-top {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
    }

    #time-left {
        font-size: 14px !important;
    }

    #quiz-stats {
        font-size: 12px !important;
        text-align: right !important;
    }

    #submit-btn {
        width: 100% !important;
        padding: 8px !important;
        font-size: 13px !important;
        margin: 0 !important;
        text-align: center !important;
    }

    .progress-container {
        height: 5px !important;
        margin-bottom: 6px !important;
    }

    #quiz-screen-heading {
        font-size: 15px !important;
        margin: 0 0 4px 0 !important;
    }

    #question-box {
        font-size: 13.5px !important;
        line-height: 1.3 !important;
        margin-bottom: 6px !important;
    }

    #options-container {
        margin-bottom: 4px !important;
    }

    .option-btn {
        padding: 8px
