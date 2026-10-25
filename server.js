const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key';

const pendingOtps = {};
const activeSessions = new Set();

app.use(express.json());

// --- MASTER SERVER-SIDE CSS (Guarantees .hidden works and Mobile Viewport Fits) ---
app.get('/style.css', (req, res) => {
    res.type('text/css').send(`
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');

/* CRITICAL: Hides inactive screens completely */
.hidden {
    display: none !important;
}

body {
    font-family: 'Poppins', sans-serif;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    color: #f8fafc;
    min-height: 100vh;
    margin: 0;
    padding: 40px;
    display: block;
    box-sizing: border-box;
}

#class-select-screen, 
#subject-select-screen, 
#ix-x-chapter-screen, 
#xi-xii-unit-screen, 
#xi-xii-chapter-screen, 
#xi-xii-topic-screen, 
#name-screen,
#download-screen,
#result-screen {
    background-color: rgba(255, 251, 235, 0.95);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    width: 600px;
    max-width: 90%;
    padding: 30px;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    box-sizing: border-box;
    margin: 0;
    color: #0f172a;
}

#quiz-screen {
    background-color: rgba(255, 251, 235, 0.98);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    width: 95%;
    max-width: 1200px;
    min-height: 85vh;
    padding: 40px;
    border-radius: 16px;
    box-shadow: 0 15px 40px rgba(0, 0, 0, 0.4);
    box-sizing: border-box;
    margin: 0 auto;
    color: #0f172a;
}

#first-name, #last-name {
    text-transform: uppercase;
}
#email-address {
    text-transform: lowercase;
}

#name-screen input[type="text"], 
#name-screen input[type="email"],
#otp-input-field {
    width: 100%;
    padding: 14px 18px;
    font-size: 16px;
    border-radius: 8px;
    border: 1px solid #cbd5e1;
    box-sizing: border-box;
    background-color: #ffffff;
    color: #0f172a;
    margin-bottom: 20px;
    font-family: inherit;
    outline: none;
}

.back-btn, 
#name-screen button:not(.back-btn) {
    background-color: #4f46e5;
    color: white;
    border: none;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    margin-bottom: 20px;
}

.card {
    background-color: #e8f5e9; 
    color: #0f172a;                    
    font-size: 18px;                   
    font-weight: bold;                 
    text-align: center;                
    padding: 20px;                     
    margin-bottom: 15px;               
    border-radius: 8px;                
    border: 1px solid #cbd5e1;         
    cursor: pointer;
}

.card:hover {
    background-color: #ffffff;       
    border: 1px solid #4285f4; 
    color: #4285f4;      
    transform: translateY(-4px);
}

.option-btn {
    display: block;
    width: 100%;
    background-color: #ffffff;
    color: #0f172a;
    font-size: 16px;
    font-weight: 500;
    text-align: left;
    padding: 16px 20px;
    margin-bottom: 15px;
    border-radius: 8px;
    border: 1px solid #cbd5e1;
    cursor: pointer;
}

.option-btn.selected {
    background-color: #e0f2fe;
    border-color: #4285f4;
    color: #1e40af;
    font-weight: 600;
}

/* 2-Row Centered Navigation Grid */
.quiz-nav-container {
    display: grid;
    grid-template-columns: repeat(2, 145px);
    justify-content: center;
    gap: 12px 16px;
    margin-top: 25px;
}

.quiz-nav-container button:nth-child(1) {
    grid-column: 1 / 2;
    grid-row: 1;
}

.quiz-nav-container button:nth-child(3) {
    grid-column: 2 / 3;
    grid-row: 1;
}

.quiz-nav-container button:nth-child(2) {
    grid-column: 1 / 3;
    grid-row: 2;
    width: 100%;
}

.quiz-nav-container button {
    background-color: #ffffff;
    color: #1e293b;
    border: 1px solid #cbd5e1;
    padding: 12px 20px;
    font-size: 15px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    text-decoration: none !important;
}

.quiz-nav-container button:hover {
    color: #2563eb;
    border-color: #2563eb;
    background-color: #eff6ff;
}

.quiz-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    gap: 15px;
}

#submit-btn {
    background-color: #ef4444;
    color: white;
    border: none;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 15px;
    font-weight: bold;
    cursor: pointer;
}

.progress-container {
    width: 100%;
    height: 8px;
    background-color: #e2e8f0;
    border-radius: 4px;
    margin-bottom: 25px;
    overflow: hidden;
}

.progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #4285f4, #2563eb);
    width: 0%;
    transition: width 0.4s ease;
}

/* Mobile Viewport Optimization: Fits entire card on screen without scrolling */
@media (max-width: 600px) {
    body {
        padding: 4px;
        margin: 0;
        height: 100vh;
        height: 100dvh;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    #class-select-screen, 
    #subject-select-screen, 
    #ix-x-chapter-screen, 
    #xi-xii-unit-screen, 
    #xi-xii-chapter-screen, 
    #xi-xii-topic-screen, 
    #name-screen, 
    #result-screen,
    #download-screen {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        padding: 14px 16px !important;
        border-radius: 0 !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        overflow-y: auto !important;
        margin: 0 !important;
    }

    #quiz-screen {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        padding: 10px 12px !important;
        border-radius: 0 !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        margin: 0 !important;
        overflow: hidden !important;
    }

    .quiz-header {
        flex-wrap: nowrap !important;
        margin-bottom: 4px !important;
        gap: 4px !important;
        flex-shrink: 0 !important;
    }

    #time-left {
        font-size: 13px !important;
        white-space: nowrap !important;
    }

    #quiz-stats {
        font-size: 11px !important;
        text-align: center !important;
        white-space: nowrap !important;
    }

    #submit-btn {
        padding: 5px 8px !important;
        font-size: 11px !important;
        white-space: nowrap !important;
        margin: 0 !important;
    }

    .progress-container {
        height: 4px !important;
        margin-bottom: 4px !important;
        flex-shrink: 0 !important;
    }

    #quiz-screen-heading {
        font-size: 15px !important;
        margin: 0 0 4px 0 !important;
        flex-shrink: 0 !important;
    }

    #question-box {
        font-size: 13.5px !important;
        line-height: 1.3 !important;
        margin-bottom: 6px !important;
        flex-shrink: 0 !important;
    }

    #options-container {
        margin-bottom: 4px !important;
        flex-grow: 1 !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
    }

    .option-btn {
        padding: 8px 10px !important;
        margin-bottom: 5px !important;
        font-size: 13px !important;
        line-height: 1.2 !important;
    }

    .quiz-nav-container {
        grid-template-columns: repeat(2, 120px) !important;
        gap: 6px 10px !important;
        margin-top: 2px !important;
        flex-shrink: 0 !important;
    }

    .quiz-nav-container button {
        padding: 7px 10px !important;
        font-size: 12.5px !important;
    }
}
`);
});

// --- BACKEND-INJECTED JS OVERRIDES ---
app.get('/script.js', (req, res) => {
    const jsPath = path.join(__dirname, 'public', 'script.js');
    let jsContent = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

    const backendJsOverrides = `
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

const originalGoHome = typeof goHome === 'function' ? goHome : null;
goHome = function() {
    if (originalGoHome) originalGoHome();
    const existingOtpWrapper = document.getElementById('otp-wrapper-container');
    if (existingOtpWrapper) existingOtpWrapper.remove();
    syncNameScreenButtons();
};

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
    }
});

app.get('/api/papers/:className', (req, res) => {
    const { className } = req.params;
    let papers = [];

    try {
        if (fs.existsSync(path.join(__dirname, 'wb.json'))) {
            const wbData = JSON.parse(fs.readFileSync(path.join(__dirname, 'wb.json'), 'utf8'));
            const wbClass = wbData.find(c => c.className === className || c.className === `WB ${className}`);
            if (wbClass && wbClass.papers) papers = papers.concat(wbClass.papers);
        }

        if (papers.length === 0 && fs.existsSync(path.join(__dirname, 'neet.json'))) {
            const neetData = JSON.parse(fs.readFileSync(path.join(__dirname, 'neet.json'), 'utf8'));
            const neetClass = neetData.find(c => c.name === className || c.name === `Class ${className}`);
            if (neetClass && neetClass.papers) papers = papers.concat(neetClass.papers);
        }

        res.json({ success: true, papers });
    } catch (error) {
        console.error("Error fetching papers:", error);
        res.json({ success: false, papers: [] });
    }
});

app.get('/api/download/:fileName', (req, res) => {
    const safeFileName = path.basename(req.params.fileName);
    const filePath = path.join(__dirname, 'secure_papers', safeFileName); 
    
    res.download(filePath, (err) => {
        if (err) {
            console.error("File download error:", err);
            if (!res.headersSent) res.status(404).send("File not found.");
        }
    });
});

app.get('/api/quiz/:id', (req, res) => {
    const requestSource = req.get('X-Requested-With');
    if (requestSource !== 'PioneersPrepApp') {
        return res.status(403).json({ error: "Security Alert: Direct API access is forbidden." });
    }

    try {
        const id = req.params.id;
        let filePath = path.join(__dirname, `${id}.json`);

        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, `${id}-questions.json`);
        }

        const rawData = fs.readFileSync(filePath, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        const safeQuestions = realQuestions.map(q => {
            return {
                type: q.type || 'mcq',
                question: q.question,
                options: q.options || []
            };
        });

        res.json(safeQuestions);
    } catch (error) {
        console.error("Error fetching quiz:", error);
        res.status(500).json({ error: "Failed to load quiz" });
    }
});

app.post('/api/start-quiz', (req, res) => {
    const { quizId, duration } = req.body;
    const startTime = Date.now();
    const dataToSign = `${quizId}:${duration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');
    res.json({ startTime, signature });
});

app.post('/api/send-otp', async (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase() : '';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase() : '';
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';

    if (!firstName || !lastName || !email) {
        return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    pendingOtps[email] = {
        otp,
        firstName,
        lastName,
        expiresAt: Date.now() + 5 * 60 * 1000
    };

    const scriptURL = process.env.APP_SCRIPT_URL;
    if (scriptURL) {
        try {
            const emailPayload = {
                targetEmail: email,
                subject: 'Pioneers Prep - Verification Code',
                breakdown: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">` +
                           `<h2>Hello ${firstName} ${lastName},</h2>` +
                           `<p>Your verification code to start the mock test on <b>Pioneers Prep</b> is:</p>` +
                           `<h1 style="color: #4285f4; letter-spacing: 6px; font-size: 36px; margin: 20px 0;">${otp}</h1>` +
                           `<p>This code is valid for 5 minutes. Do not share this code with anyone.</p>` +
                           `</div>`,
                score: 0, total: 0, attempted: 0, skipped: 0, correct: 0, incorrect: 0
            };

            await fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emailPayload)
            });

            res.json({ success: true, message: 'OTP sent successfully to your email.', firstName, lastName, email });
        } catch (err) {
            console.error('Failed to dispatch OTP email:', err);
            res.status(500).json({ success: false, error: 'Failed to send OTP email via server.' });
        }
    } else {
        res.status(500).json({ success: false, error: 'Email service URL not configured on server.' });
    }
});

app.post('/api/verify-otp', (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const otp = req.body.otp ? req.body.otp.trim() : '';
    const record = pendingOtps[email];

    if (!record) {
        return res.status(400).json({ success: false, error: 'No pending verification found. Please request a new code.' });
    }
    if (Date.now() > record.expiresAt) {
        delete pendingOtps[email];
        return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
    }
    if (record.otp !== otp) {
        return res.status(400).json({ success: false, error: 'Invalid verification code entered.' });
    }

    delete pendingOtps[email];
    
    const authToken = crypto.createHmac('sha256', SECRET).update(`${email}:${Date.now()}`).digest('hex');
    activeSessions.add(authToken);

    res.json({ 
        success: true, 
        authToken, 
        firstName: record.firstName, 
        lastName: record.lastName,
        email
    });
});

app.post('/api/submit', async (req, res) => {
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase() : 'UNKNOWN';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase() : 'NAME';
    const email = req.body.email ? req.body.email.trim().toLowerCase() : 'no-email';
    
    const { className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration, authToken } = req.body;

    if (!authToken || !activeSessions.has(authToken)) {
        return res.status(403).json({ success: false, error: 'Security Alert: Unauthorized submission. Please verify your email first.' });
    }
    activeSessions.delete(authToken);

    if (!serverStartTime || !timerSignature || !quizDuration) {
        return res.status(400).json({ success: false, error: 'Security Alert: Missing timer tokens. Submission rejected.' });
    }

    const expectedSignature = crypto.createHmac('sha256', SECRET).update(`${quizId}:${quizDuration}:${serverStartTime}`).digest('hex');
    if (expectedSignature !== timerSignature) {
        return res.status(400).json({ success: false, error: 'Security Alert: Tampered timer token detected.' });
    }

    const elapsedSeconds = (Date.now() - serverStartTime) / 1000;
    const gracePeriod = 45; 
    if (elapsedSeconds > quizDuration + gracePeriod) {
        return res.status(400).json({ success: false, error: 'Time limit exceeded. Submission blocked by server.' });
    }

    try {
        const safeUserAnswers = userAnswers || {};
        let filePath = path.join(__dirname, `${quizId}.json`);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, `${quizId}-questions.json`);
        }
        const rawData = fs.readFileSync(filePath, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        let correctCount = 0;
        let incorrectCount = 0;
        const totalCount = realQuestions.length;
        const attemptedCount = Object.keys(safeUserAnswers).length;
        const skippedCount = totalCount - attemptedCount;
        
        if (!isAutoSubmit && attemptedCount < totalCount) {
            return res.status(400).json({ 
                success: false, 
                error: `Submission rejected. Only ${attemptedCount} out of ${totalCount} questions were answered.` 
            });
        }

        let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 16px;">` +
            `<tr style="background-color: #f1f5f9; text-align: left;">` +
            `<th style="width: 5%;">#</th><th style="width: 40%;">Question</th><th style="width: 25%;">Student's Selection</th><th style="width: 20%;">Correct Option</th><th style="width: 10%; text-align: center;">Status</th></tr>`;

        realQuestions.forEach((q, index) => {
            const studentResponse = safeUserAnswers[index.toString()]; 
            const isAttempted = studentResponse !== undefined && studentResponse !== "";

            let isCorrect = false;
            let studentSelectionText = "Skipped";
            let correctOptionText = "N/A";
            let rawStatus = "Skipped";
            let statusColor = "yellow";

            if (q.type === 'descriptive') {
                studentSelectionText = isAttempted ? studentResponse : "Skipped";
                correctOptionText = q.model_answer || "Refer to marking scheme";
                if (isAttempted) {
                    rawStatus = "Needs Review";
                    statusColor = "orange";
                }
            } else {
                isCorrect = isAttempted && parseInt(studentResponse) === q.answer;
                if (isCorrect) correctCount++;
                else if (isAttempted) incorrectCount++;

                studentSelectionText = isAttempted ? (q.options[studentResponse] || "Unknown") : "Skipped";
                correctOptionText = q.options[q.answer] !== undefined ? q.options[q.answer] : "N/A";
                rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (isAttempted ? "lightcoral" : "yellow");
            }
            
            const statusText = `<span style="background-color: ${statusColor}; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${q.explanation}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${q.question || "N/A"}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const fullTitle = (className && !chapterTitle.startsWith(className))
            ? `${className} - ${chapterTitle}`
            : chapterTitle;

        const studentName = `${firstName} ${lastName}`.trim();

        const securePayload = {
            firstName, lastName, email,
            className: className || "",
            chapterTitle: fullTitle,
            subject: `New Quiz Submission - ${fullTitle} - ${studentName}`,
            score: correctCount, total: totalCount,
            attempted: attemptedCount, skipped: skippedCount,
            correct: correctCount, incorrect: incorrectCount,
            breakdown: breakdownHtml,
            targetEmail: process.env.TARGET_EMAIL
        };

        try {
            const submissionsFile = path.join(__dirname, 'submissions.json');
            let allSubmissions = [];
            
            if (fs.existsSync(submissionsFile)) {
                const fileData = await fs.promises.readFile(submissionsFile, 'utf8');
                allSubmissions = JSON.parse(fileData);
            }
            
            allSubmissions.push({
                timestamp: new Date().toISOString(),
                ...securePayload
            });
            
            await fs.promises.writeFile(submissionsFile, JSON.stringify(allSubmissions, null, 2));
        } catch (err) {
            console.error("Local backup failed:", err);
        }

        res.json({ success: true, score: correctCount, total: totalCount });

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (scriptURL) {
            await fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(securePayload)
            });
        }

    } catch (error) {
        console.error("Submission error:", error);
        res.status(500).json({ success: false, error: "Grading failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
