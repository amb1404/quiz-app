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
    try {
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
    } catch (e) {
        console.error("Error loading quizzes.json cache:", e);
    }
}

app.get('/api/quizzes', (req, res) => {
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'Quizzes configuration not found' });
    }
});

// Helper function to safely extract questions whether stored as a direct array or wrapped in an object
function getQuestionsArray(fileData) {
    if (Array.isArray(fileData)) return fileData;
    if (fileData && Array.isArray(fileData.questions)) return fileData.questions;
    return null;
}

app.get('/api/quiz/:id', (req, res) => {
    try {
        let id = req.params.id;

        // Map any frontend request aliases for Class XI/XII directly to 'neet' (neet.json)
        const xiXiiAliases = ['class11', 'class12', 'xi', 'xii', 'class-xi', 'class-xii', 'class11-12'];
        if (xiXiiAliases.includes(id.toLowerCase())) {
            id = 'neet';
        }

        let fileData;

        // 1. Look in the Class IX/X memory cache first
        if (quizzesCache[id]) {
            fileData = quizzesCache[id];
        } 
        // 2. Look for exact filename (e.g., neet.json for Class XI/XII structures)
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

        // Check if this file contains a question bank
        const rawQuestions = getQuestionsArray(fileData);
        const isQuestionBank = rawQuestions !== null && rawQuestions.length > 0 && rawQuestions[0].answer !== undefined;

        if (isQuestionBank) {
            // SECURITY: Strip answers and explanations before sending to the client browser
            const safeQuestions = rawQuestions.map(q => ({
                question: q.question,
                options: q.options
            }));

            if (!Array.isArray(fileData)) {
                return res.json({ ...fileData, questions: safeQuestions });
            }
            return res.json(safeQuestions);
        }

        // If it is a structural file (Units, Chapters, Topics for XI-XII from neet.json), send it through untouched
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
        let id = quizId;

        // Map aliases for grading lookups as well
        const xiXiiAliases = ['class11', 'class12', 'xi', 'xii', 'class-xi', 'class-xii', 'class11-12'];
        if (xiXiiAliases.includes((id || '').toLowerCase())) {
            id = 'neet';
        }

        let fileData;

        // Securely locate the master file on the server
        if (quizzesCache[id]) {
            fileData = quizzesCache[id];
        } else if (fs.existsSync(path.join(__dirname, `${id}.json`))) {
            fileData = JSON.parse(fs.readFileSync(path.join(__dirname, `${id}.json`), 'utf-8'));
        } else if (fs.existsSync(path.join(__dirname, `${id}-questions.json`))) {
            fileData = JSON.parse(fs.readFileSync(path.join(__dirname, `${id}-questions.json`), 'utf-8'));
        } else {
            return res.status(404).json({ success: false, error: "Quiz not found for grading" });
        }

        const realQuestions = getQuestionsArray(fileData);
        if (!realQuestions || realQuestions.length === 0) {
            return res.status(400).json({ success: false, error: "Invalid quiz format for grading" });
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
            
            const rawStatus = isCorrect ? "Correct" : (isAttempted ? "Incorrect" : "Skipped");
            const statusText = `<span style="background-color: yellow; color: black; font-weight: bold; padding: 4px 8px; border-radius: 4px;">${rawStatus}</span>`;
            
            const explanationHtml = q.explanation ? `<br><br><span style="font-size: 14px; color: #15803d; line-height: 1.4; display: block;"><b>Explanation:</b> ${q.explanation}</span>` : "";

            breakdownHtml += `<tr><td>${index + 1}</td><td>${q.question || "N/A"}${explanationHtml}</td><td>${studentSelectionText}</td><td>${correctOptionText}</td><td style="text-align: center;">${statusText}</td></tr>`;
        });
        breakdownHtml += `</table>`;

        const securePayload = {
            firstName, lastName, email, chapterTitle,
            score: correctCount, total: totalCount,
            attempted: attemptedCount, skipped: skippedCount,
            correct: correctCount, incorrect: incorrectCount,
            breakdown: breakdownHtml,
            targetEmail: process.env.TARGET_EMAIL 
        };

        if (process.env.APP_SCRIPT_URL) {
            await fetch(process.env.APP_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(securePayload)
            });
        }

        res.json({ success: true, score: correctCount, total: totalCount });

    } catch (error) {
        console.error("Submission error:", error);
        res.status(500).json({ success: false, error: "Grading failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
