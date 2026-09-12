const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/api/quiz/:id', (req, res) => {
    try {
        const id = req.params.id;
        let filePath = path.join(__dirname, `${id}.json`);

        // If the exact file doesn't exist, fall back to the -questions.json suffix
        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, `${id}-questions.json`);
        }

        const rawData = fs.readFileSync(filePath, 'utf-8');
        const realQuestions = JSON.parse(rawData);

        // CREATE A "SAFE" VERSION FOR THE STUDENT (Stripping answers)
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

app.post('/api/submit', async (req, res) => {
   const { firstName, lastName, email, className, chapterTitle, quizId, userAnswers } = req.body;

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
            
            const rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
            const statusText = `<span style="background-color: yellow; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${q.explanation}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${q.question || "N/A"}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        // Avoid duplicate prefix if chapterTitle already contains className
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

        // Keep your local backup working
        try {
            const submissionsFile = path.join(__dirname, 'submissions.json');
            let allSubmissions = [];
            if (fs.existsSync(submissionsFile)) {
                allSubmissions = JSON.parse(fs.readFileSync(submissionsFile, 'utf8'));
            }
            allSubmissions.push({
                timestamp: new Date().toISOString(),
                ...securePayload
            });
            fs.writeFileSync(submissionsFile, JSON.stringify(allSubmissions, null, 2));
        } catch (err) {
            console.error("Local backup failed:", err);
        }

        // Send score back to the frontend browser
        res.json({ success: true, score: correctCount, total: totalCount });

        // Forward securely to Google Apps Script
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
