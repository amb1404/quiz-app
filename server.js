const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Route: Fetch quizzes list
app.get('/api/quizzes', (req, res) => {
    fs.readFile(path.join(__dirname, 'quizzes.json'), 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to load quizzes list' });
        res.json(JSON.parse(data));
    });
});

// API Route: Fetch questions for a chapter
app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const fileName = `${quizId}-questions.json`;
    fs.readFile(path.join(__dirname, fileName), 'utf8', (err, data) => {
        if (err) return res.status(404).json({ error: 'Question file not found' });
        res.json(JSON.parse(data));
    });
});

// API Route: Send submission data to Google Apps Script Web App
app.post('/api/submit', async (req, res) => {
    const { studentName, quizId, score, total, answers } = req.body;
    const targetEmail = process.env.TARGET_EMAIL || process.env.EMAIL_USER;
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;

    if (!appsScriptUrl) {
        console.error('APPS_SCRIPT_URL environment variable is missing.');
        return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    try {
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentName: studentName || 'Anonymous',
                quizId,
                score,
                total,
                answers,
                targetEmail
            })
        });

        const result = await response.json();

        if (result.success) {
            res.status(200).json({ success: true, message: 'Email sent successfully via Gmail!' });
        } else {
            console.error('Google Apps Script error:', result.error);
            res.status(500).json({ success: false, message: 'Failed to send email' });
        }
    } catch (err) {
        console.error('Error connecting to Apps Script:', err);
        res.status(500).json({ success: false, message: 'Failed to send email' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
