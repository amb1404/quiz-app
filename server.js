const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pre-load chapter question files into memory based on the nested structure
const quizzesCache = {};
const quizListPath = path.join(__dirname, 'quizzes.json');

if (fs.existsSync(quizListPath)) {
    const subjects = JSON.parse(fs.readFileSync(quizListPath, 'utf8'));
    subjects.forEach(subj => {
        if (subj.chapters) {
            subj.chapters.forEach(ch => {
                const filePath = path.join(__dirname, `${ch.id}-questions.json`);
                if (fs.existsSync(filePath)) {
                    quizzesCache[ch.id] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                }
            });
        }
    });
}

app.get('/api/quizzes', (req, res) => {
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'Quizzes configuration not found' });
    }
});

app.get('/api/quiz/:id', (req, res) => {
    try {
        const rawData = fs.readFileSync(`./${req.params.id}.json`, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        // CREATE A "SAFE" VERSION FOR THE STUDENT
        const safeQuestions = realQuestions.map(q => {
            return {
                question: q.question,
                options: q.options
            };
        });

        res.json(safeQuestions);
    } catch (error) {
        console.error("Error fetching quiz:", error);
        res.status(500).json({ error: "Failed to load quiz" });
    }
});

// Basic Rate Limiter to prevent spamming
const submissionTimestamps = new Map();

const rateLimiter = (req, res, next) => {
    // Identify the user by their IP address
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    const lastSubmission = submissionTimestamps.get(ip);

    // Limit to 1 submission per 60 seconds (60000 milliseconds)
    if (lastSubmission && (now - lastSubmission < 60000)) {
        return res.status(429).json({ 
            success: false, 
            error: "Too many submissions. Please wait a minute." 
        });
    }
    
    submissionTimestamps.set(ip, now);
    next();
};

app.post('/api/submit', rateLimiter, async (req, res) => {
    const { firstName, lastName, email, chapterTitle, quizId, userAnswers } = req.body;

    try {
        const safeUserAnswers = userAnswers || {};
        const rawData = fs.readFileSync(`./${quizId}.json`, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        let correctCount = 0;
        let incorrectCount = 0;
        const totalCount = realQuestions.length;
        const attemptedCount = Object.keys(safeUserAnswers).length;
        const skippedCount = totalCount - attemptedCount;

        let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 16px;">` +
            `<tr style="background-color: #f1f5f9; text-align: left;">` +
            `<th style="width: 5%;">#</th><th style="width: 40%;">Question</th><th style="width: 25%;">Student's Selection</th><th style="width: 20%;">Correct Option</th><th style="width: 10%; text-align: center;">Status</th></tr>`;

        realQuestions.forEach((q, index) => {
            const studentSelectionIndex = safeUserAnswers[index.toString()]; 
            const isAttempted = studentSelectionIndex !== undefined;
            const isCorrect = isAttempted && parseInt(studentSelectionIndex) === q.answer;

            if (isCorrect) correctCount++;
            else if (isAttempted) incorrectCount++;

            const studentSelectionText = isAttempted ? (q.options[studentSelectionIndex] || "Unknown") : "Skipped";
            const correctOptionText = q.options[q.answer] !== undefined ? q.options[q.answer] : "N/A";
            const statusText = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
            
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${q.explanation}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${q.question || "N/A"}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const securePayload = {
            firstName, lastName, email, chapterTitle,
            score: correctCount, total: totalCount,
            attempted: attemptedCount, skipped: skippedCount,
            correct: correctCount, incorrect: incorrectCount,
            breakdown: breakdownHtml
        };

        await fetch(process.env.APP_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(securePayload)
        });

        res.json({ success: true, score: correctCount, total: totalCount });

    } catch (error) {
        console.error("Submission error:", error);
        res.status(500).json({ success: false, error: "Grading failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
