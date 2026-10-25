const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // ADDED: For cryptographic signatures
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key'; // ADDED: Secret key for timer

// --- NEW: OTP & Session Stores ---
const pendingOtps = {};
const activeSessions = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    // --- Anti-Scraping Security Check ---
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

// Generates a cryptographically signed start time
app.post('/api/start-quiz', (req, res) => {
    const { quizId, duration } = req.body;
    const startTime = Date.now();
    const dataToSign = `${quizId}:${duration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');
    res.json({ startTime, signature });
});

// --- NEW: Backend OTP Routes with Text Normalization ---
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
        expiresAt: Date.now() + 5 * 60 * 1000 // Valid for 5 minutes
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

            res.json({ success: true, message: 'OTP sent successfully to your email.' });
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
    
    // Issue secure session token and register it on the backend
    const authToken = crypto.createHmac('sha256', SECRET).update(`${email}:${Date.now()}`).digest('hex');
    activeSessions.add(authToken);

    res.json({ 
        success: true, 
        authToken, 
        firstName: record.firstName, 
        lastName: record.lastName 
    });
});
// -----------------------------

app.post('/api/submit', async (req, res) => {
    // --- Backend Normalization for Submission Data ---
    const firstName = req.body.firstName ? req.body.firstName.trim().toUpperCase() : 'UNKNOWN';
    const lastName = req.body.lastName ? req.body.lastName.trim().toUpperCase() : 'NAME';
    const email = req.body.email ? req.body.email.trim().toLowerCase() : 'no-email';
    
    const { className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration, authToken } = req.body;

    // --- BACKEND AUTHENTICATION CHECK ---
    if (!authToken || !activeSessions.has(authToken)) {
        return res.status(403).json({ success: false, error: 'Security Alert: Unauthorized submission. Please verify your email first.' });
    }
    activeSessions.delete(authToken); // Invalidate token immediately (One-Time Use)
    // ----------------------------------------

    // --- SECURE SERVER-SIDE TIMER CHECK ---
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
