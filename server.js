const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // ADDED: For cryptographic signatures
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.TIMER_SECRET || 'pioneers-prep-secure-key'; // ADDED: Secret key for timer

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
    // path.basename() completely strips out any directory paths (like ../) 
    // and strictly returns just the final file name.
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
    // --- NEW: Anti-Scraping Security Check ---
    const requestSource = req.get('X-Requested-With');
    if (requestSource !== 'PioneersPrepApp') {
        return res.status(403).json({ error: "Security Alert: Direct API access is forbidden." });
    }
    // -----------------------------------------

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
                type: q.type || 'mcq', // Identifies descriptive questions
                question: q.question,
                options: q.options || [] // Prevents crashes if options array is missing
            };
        });

        res.json(safeQuestions);
    } catch (error) {
        console.error("Error fetching quiz:", error);
        res.status(500).json({ error: "Failed to load quiz" });
    }
});

// ADDED: Generates a cryptographically signed start time
app.post('/api/start-quiz', (req, res) => {
    const { quizId, duration } = req.body;
    const startTime = Date.now();
    // Create a tamper-proof signature binding the quiz, duration, and start time
    const dataToSign = `${quizId}:${duration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');
    res.json({ startTime, signature });
});

app.post('/api/submit', async (req, res) => {
    // ADDED: serverStartTime, timerSignature, and quizDuration
    const { firstName, lastName, email, className, chapterTitle, quizId, userAnswers, isAutoSubmit, serverStartTime, timerSignature, quizDuration } = req.body;

    // --- ADDED: SECURE SERVER-SIDE TIMER CHECK ---
    if (!serverStartTime || !timerSignature || !quizDuration) {
        return res.status(400).json({ success: false, error: 'Security Alert: Missing timer tokens. Submission rejected.' });
    }

    // 1. Verify the signature wasn't tampered with by a student
    const expectedSignature = crypto.createHmac('sha256', SECRET).update(`${quizId}:${quizDuration}:${serverStartTime}`).digest('hex');
    if (expectedSignature !== timerSignature) {
        return res.status(400).json({ success: false, error: 'Security Alert: Tampered timer token detected.' });
    }

    // 2. Verify they didn't take too long (Allowing a 45-second grace period for network lag)
    const elapsedSeconds = (Date.now() - serverStartTime) / 1000;
    const gracePeriod = 45; 
    if (elapsedSeconds > quizDuration + gracePeriod) {
        return res.status(400).json({ success: false, error: 'Time limit exceeded. Submission blocked by server.' });
    }
    // -------------------------------------------

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
            // Treat as attempted if an option index exists OR if text was typed
            const isAttempted = studentResponse !== undefined && studentResponse !== "";

            let isCorrect = false;
            let studentSelectionText = "Skipped";
            let correctOptionText = "N/A";
            let rawStatus = "Skipped";
            let statusColor = "yellow";

            if (q.type === 'descriptive') {
                studentSelectionText = isAttempted ? studentResponse : "Skipped";
                // Show the model answer from your JSON in the grading email
                correctOptionText = q.model_answer || "Refer to marking scheme";
                if (isAttempted) {
                    rawStatus = "Needs Review";
                    statusColor = "orange";
                }
            } else {
                // Standard MCQ grading
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

        const studentName = `${firstName} ${lastName}`.trim().toUpperCase();

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
