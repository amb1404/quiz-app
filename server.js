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

// --- BACKEND-INJECTED CSS OVERRIDES (Mobile Fit, Centered Nav Grid, No Underlines) ---
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
        padding: 8px !important;
    }

    #quiz-screen {
        width: 100% !important;
        max-width: 100% !important;
        min-height: calc(100dvh - 16px) !important;
        padding: 12px 14px !important;
        border-radius: 12px !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        margin: 0 auto !important;
    }

    .quiz-header {
        flex-wrap: nowrap !important;
        margin-bottom: 6px !important;
        gap: 6px !important;
    }

    #time-left {
        font-size: 13.5px !important;
        white-space: nowrap !important;
    }

    #quiz-stats {
        font-size: 11.5px !important;
        text-align: center !important;
        white-space: nowrap !important;
    }

    #submit-btn {
        padding: 6px 10px !important;
        font-size: 12px !important;
        white-space: nowrap !important;
        margin: 0 !important;
    }

    .progress-container {
        height: 6px !important;
        margin-bottom: 6px !important;
    }

    #quiz-screen-heading {
        font-size: 16px !important;
        margin: 0 0 6px 0 !important;
    }

    #question-box {
        font-size: 14px !important;
        line-height: 1.35 !important;
        margin-bottom: 8px !important;
    }

    #options-container {
        margin-bottom: 6px !important;
    }

    .option-btn {
        padding: 9px 12px !important;
        margin-bottom: 7px !important;
        font-size: 13.5px !important;
        line-height: 1.25 !important;
    }

    .quiz-nav-container {
        grid-template-columns: repeat(2, 125px) !important;
        gap: 8px 12px !important;
        margin-top: 4px !important;
    }

    .quiz-nav-container button {
        padding: 8px 12px !important;
        font-size: 13px !important;
    }
}
`;

    res.type('text/css').send(cssContent + '\n' + backendCssOverrides);
});

// --- BACKEND-INJECTED JS OVERRIDES (Verify -> Start Quiz Button, Back Button Fix, Casing) ---
app.get('/script.js', (req, res) => {
    const jsPath = path.join(__dirname, 'public', 'script.js');
    let jsContent = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

    const backendJsOverrides = `
// --- Server-Enforced Frontend Behavior Overrides ---
function syncNameScreenButtons() {
    const backBtn = document.querySelector('#name-screen .back-btn');
    if (backBtn) backBtn.innerText = 'Back';

    const actionBtn = document.querySelector('#name-screen button:not(.back-btn)');
    const otpInput = document.getElementById('otp-input-field');
    if (actionBtn) {
        actionBtn.innerText = otpInput ? 'Start Quiz' : 'Verify';
        actionBtn.disabled = false;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    syncNameScreenButtons();

    const firstNameInput = document.getElementById('first-name');
    const lastNameInput = document.getElementById('last-name');
    const emailInput = document.getElementById('email-address');

    if (firstNameInput) {
        firstNameInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });
    }
    if (lastNameInput) {
        lastNameInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });
    }
    if (emailInput) {
        emailInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toLowerCase();
        });
    }
});

// Override goHome so resetting always restores "Back" and "Verify"
const originalGoHome = typeof goHome === 'function' ? goHome : null;
goHome = function() {
    if (originalGoHome) originalGoHome();
    const existingOtpWrapper = document.getElementById('otp-wrapper-container');
    if (existingOtpWrapper) existingOtpWrapper.remove();
    syncNameScreenButtons();
};

// Override startQuiz to keep Back button intact and transition Verify -> Start Quiz
startQuiz = async function() {
    const firstNameEl = document.getElementById('first-name');
    const lastNameEl = document.getElementById('last-name');
    const emailEl = document.getElementById('email-address');

    if (firstNameEl) firstNameEl.value = firstNameEl.value.trim().toUpperCase();
    if (lastNameEl) lastNameEl.value = lastNameEl.value.trim().toUpperCase();
    if (emailEl) emailEl.value = emailEl.value.trim().toLowerCase();

    const firstName = firstNameEl?.value || '';
    const lastName = lastNameEl?.value || '';
    const email = emailEl?.value || '';

    if (!firstName || !lastName || !email) {
        alert('Please fill in all fields (First Name, Last Name, and Email Address) to start.');
        return;
    }

    const emailPattern = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
    if (!emailPattern.test(email)) {
        alert('Please enter a valid email address.');
        return;
    }

    const backBtn = document.querySelector('#name-screen .back-btn');
    if (backBtn) backBtn.innerText = 'Back';

    const submitBtn = document.querySelector('#name-screen button:not(.back-btn)');
    let otpInput = document.getElementById('otp-input-field');

    if (!otpInput) {
        if (submitBtn) {
            submitBtn.innerText = 'Sending Code...';
            submitBtn.disabled = true;
        }

        try {
            const response = await fetch('/api/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firstName, lastName, email })
            });
            const data = await response.json();

            if (!response.ok) {
                alert(data.error || 'Failed to send verification code.');
                if (submitBtn) {
                    submitBtn.innerText = 'Verify';
                    submitBtn.disabled = false;
                }
                return;
            }

            alert('A 6-digit verification code has been sent to your email address. Please check your inbox.');

            const nameScreenContainer = document.getElementById('name-screen');
            if (nameScreenContainer) {
                const otpWrapper = document.createElement('div');
                otpWrapper.id = 'otp-wrapper-container';
                otpWrapper.style.cssText = 'margin-top: 15px;';
                otpWrapper.innerHTML = \`
                    <label style="display: block; font-weight: bold; margin-bottom: 5px; color: #333; text-align: left;">Enter 6-Digit Verification Code:</label>
                    <input type="text" id="otp-input-field" maxlength="6" placeholder="123456" style="width: 100%; padding: 12px; font-size: 18px; text-align: center; letter-spacing: 4px; border-radius: 8px; border: 1px solid #cbd5e1; box-sizing: border-box; margin-bottom: 12px;" />
                \`;

                if (submitBtn && submitBtn.parentNode === nameScreenContainer) {
                    nameScreenContainer.insertBefore(otpWrapper, submitBtn);
                } else {
                    nameScreenContainer.appendChild(otpWrapper);
                }

                if (submitBtn) {
                    submitBtn.innerText = 'Start Quiz';
                    submitBtn.disabled = false;
                }
            }
        } catch (error) {
            console.error('OTP request error:', error);
            alert('Network error connecting to authentication server.');
            if (submitBtn) {
                submitBtn.innerText = 'Verify';
                submitBtn.disabled = false;
            }
        }
        return;
    }

    const enteredOtp = otpInput.value.trim();
    if (enteredOtp.length !== 6) {
        alert('Please enter the complete 6-digit verification code.');
        return;
    }

    try {
        const verifyResponse = await fetch('/api/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp: enteredOtp })
        });
        const verifyData = await verifyResponse.json();

        if (!verifyResponse.ok) {
            alert(verifyData.error || 'Invalid verification code.');
            return;
        }

        studentAuthToken = verifyData.authToken;

        const tokenResponse = await fetch('/api/start-quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quizId: currentQuizId, duration: timeRemaining })
        });
        const tokenData = await tokenResponse.json();
        
        serverStartTime = tokenData.startTime;
        timerSignature = tokenData.signature;
        quizDuration = timeRemaining;
        clientStartTime = Date.now(); 
        
        if (currentQuestionIndex === 0 && Object.keys(userAnswers).length === 0) {
            skippedQuestions = new Set();
        }

        showScreen('quiz-screen');
        startTimer();
        renderQuestion();
        saveState();

    } catch (error) {
        console.error('Verification error:', error);
        alert('Authentication failed. Please try again.');
    }
};
`;

    res.type('application/javascript').send(jsContent + '\n' + backendJsOverrides);
});

app.use(express.static(path.join(__dirname, 'public')));

// Keep-awake route for cron-job.org
app.get('/ping', (req, res) => {
    res.status(200).send('Awake');
});

app.get('/api/quizzes', (req, res) => {
    const quizListPath = path.join(__dirname, 'quizzes.json');
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'quizzes.json configuration file not found' });
    }
});

app.get('/api/neet', (req, res) => {
    const neetListPath = path.join(__dirname, 'neet.json');
    if (fs.existsSync(neetListPath)) {
        res.json(JSON.parse(fs.readFileSync(neetListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'neet.json configuration file not found' });
    }
});

app.get('/api/wb', (req, res) => {
    const wbListPath = path.join(__dirname, 'wb.json');
    if (fs.existsSync(wbListPath)) {
        res.json(JSON.parse(fs.readFileSync(wbListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'wb.json configuration file not found' });
    }
});

app.get('/api/papers/:className/:subjectName', (req, res) => {
    const { className, subjectName } = req.params;
    let papers = [];

    try {
        if (fs.existsSync(path.join(__dirname, 'quizzes.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'quizzes.json'), 'utf8'));
            const classObj = data.find(c => c.name === className || c.name === `Class ${className}`);
            const subjectObj = classObj?.subjects?.find(s => s.name.toLowerCase() === subjectName.toLowerCase());
            if (subjectObj && subjectObj.papers) papers = papers.concat(subjectObj.papers);
        }

        if (papers.length === 0 && fs.existsSync(path.join(__dirname, 'neet.json'))) {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'neet.json'), 'utf8'));
            const classObj = data.find(c => c.name === className || c.name === `Class ${className}`);
            const unitObj = classObj?.units?.find(u => u.name.toLowerCase() === subjectName.toLowerCase());
            if (unitObj && unitObj.papers) papers = papers.concat(unitObj.papers);
        }

        res.json({ success: true, papers });
    } catch (error) {
        console.error("Error fetching papers:", error);
        res.json({ success: false, papers: [] });
