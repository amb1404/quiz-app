const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pre-load chapter question files into memory based on the nested structure (For IX and X)
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
        const id = req.params.id;
        let fileData;

        // 1. Look in the Class IX/X memory cache first
        if (quizzesCache[id]) {
            fileData = quizzesCache[id];
        } 
        // 2. Look for exact filename (Class XI/XII structures and questions)
        else if (fs.existsSync(path.join(__dirname, `${id}.json`))) {
            fileData = JSON.parse(fs.readFileSync(path.join(__dirname, `${id}.json`), 'utf-8'));
        } 
        // 3. Fallback for files with -questions suffix
        else if (fs.existsSync(path.join(__dirname, `${id}-questions.json`))) {
            fileData = JSON.parse(fs.readFileSync(path.join(__dirname, `${id}-questions.json`), 'utf-8'));
        } 
        else {
            return res.status(404).json({ error: "File not found" });
        }

        // SMART CHECK: Strip answers if it's a question bank
        if (Array.isArray(fileData) && fileData.length > 0 && fileData[0].question !== undefined) {
            const safeQuestions = fileData.map(q => {
                return {
                    question: q.question,
                    options: q.options
                };
            });
            return res.json(safeQuestions);
        }

        // Send structural files (like neet.json for Class XI-XII) exactly as they are
        res.json(fileData);

    } catch (error) {
        console.error("Error fetching file:", error);
        res.status(500).json({ error: "Failed to load file" });
    }
});

app.post('/api/submit', async (req, res) => {
    const { firstName, lastName, email, chapterTitle, quizId, userAnswers } = req.body;

    try {
        const safeUserAnswers = userAnswers || {};
        let realQuestions;

        // Securely find the correct master answer key
        if (quizzesCache[quizId]) {
            realQuestions = quizzesCache[quizId];
        } else if (fs.existsSync(path.join(__dirname, `${quizId}.json`))) {
            realQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `${quizId}.json`), 'utf-8'));
        } else if (fs.existsSync(path.join(__dirname, `${quizId}-questions.json`))) {
            realQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `${quizId}-questions.json`), 'utf-8'));
        } else {
            return res.status(404).json({ success: false, error: "Quiz not found for grading" });
        }

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
