const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- START OF NEW NEET CODE ---
const neetListPath = path.join(__dirname, 'neet.json');

if (fs.existsSync(neetListPath)) {
    const classes = JSON.parse(fs.readFileSync(neetListPath, 'utf8'));
    classes.forEach(cls => {
        if (cls.chapters) {
            cls.chapters.forEach(ch => {
                if (ch.topics) {
                    ch.topics.forEach(topic => {
                        // Iterating into the new deeper 'subtopics' layer
                        if (topic.subtopics) {
                            topic.subtopics.forEach(sub => {
                                const filePath = path.join(__dirname, `${sub.id}-questions.json`);
                                if (fs.existsSync(filePath)) {
                                    quizzesCache[sub.id] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                                }
                            });
                        }
                    });
                }
            });
        }
    });
}

app.get('/api/neet', (req, res) => {
    if (fs.existsSync(neetListPath)) {
        res.json(JSON.parse(fs.readFileSync(neetListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'NEET configuration not found' });
    }
});
// --- END OF NEW NEET CODE ---

app.get('/api/quizzes', (req, res) => {
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'Quizzes configuration not found' });
    }
});

app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    if (quizzesCache[quizId]) {
        res.json(quizzesCache[quizId]);
    } else {
        res.status(404).json({ error: 'Quiz questions not found' });
    }
});

app.post('/api/submit', async (req, res) => {
    const submission = req.body;
    const submissionsFile = path.join(__dirname, 'submissions.json');
    
    let allSubmissions = [];
    if (fs.existsSync(submissionsFile)) {
        allSubmissions = JSON.parse(fs.readFileSync(submissionsFile, 'utf8'));
    }

    const questions = quizzesCache[submission.quizId] || [];
    
    let score = 0;
    let attempted = 0;
    let detailedBreakdown = "";
    
    questions.forEach((q, idx) => {
        const userAnsIdx = submission.answers[idx];
        const correctIdx = q.answer !== undefined ? q.answer : q.correctAnswer;
        const isSkipped = (userAnsIdx === null || userAnsIdx === undefined);
        const isCorrect = (!isSkipped && userAnsIdx === correctIdx);
        
        if (!isSkipped) {
            attempted++;
            if (isCorrect) {
                score++;
            }
        }
        
        const status = isSkipped ? "Skipped" : (isCorrect ? "Correct" : "Incorrect");
        const userChoice = isSkipped ? "None" : q.options[userAnsIdx];
        const correctChoice = q.options[correctIdx];

        detailedBreakdown += `Q${idx + 1}: ${q.question}\n`;
        detailedBreakdown += `Status: ${status}\n`;
        detailedBreakdown += `Student's Answer: ${userChoice}\n`;
        detailedBreakdown += `Correct Answer: ${correctChoice}\n`;
        if (q.explanation) {
            detailedBreakdown += `Explanation: ${q.explanation}\n`;
        }
        detailedBreakdown += `----------------------------------------\n`;
    });

    let incorrect = attempted - score;
    let skipped = questions.length - attempted;
    
    allSubmissions.push({
        timestamp: new Date().toISOString(),
        score,
        attempted,
        skipped,
        incorrect,
        ...submission
    });
    
    fs.writeFileSync(submissionsFile, JSON.stringify(allSubmissions, null, 2));

    if (process.env.APPS_SCRIPT_URL) {
        try {
            await fetch(process.env.APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetEmail: process.env.TARGET_EMAIL,
                    firstName: submission.firstName,
                    lastName: submission.lastName,
                    email: submission.email,
                    chapterTitle: submission.chapterTitle,
                    score: score,
                    total: questions.length,
                    attempted: attempted,
                    skipped: skipped,
                    correct: score,
                    incorrect: incorrect,
                    breakdown: detailedBreakdown
                })
            });
        } catch (error) {
            console.error('Failed to trigger Apps Script email:', error);
        }
    }
    
    res.json({ success: true, message: 'Response saved and email triggered successfully!' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
