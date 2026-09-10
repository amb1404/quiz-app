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

app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const filePath = path.join(__dirname, `${quizId}-questions.json`);
    
    if (fs.existsSync(filePath)) {
        res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } else {
        res.status(404).json({ error: `File ${quizId}-questions.json not found` });
    }
});

app.post('/api/submit', async (req, res) => {
    const submission = req.body;
    
    // Keep your local backup working
    try {
        const submissionsFile = path.join(__dirname, 'submissions.json');
        let allSubmissions = [];
        if (fs.existsSync(submissionsFile)) {
            allSubmissions = JSON.parse(fs.readFileSync(submissionsFile, 'utf8'));
        }
        allSubmissions.push({
            timestamp: new Date().toISOString(),
            ...submission
        });
        fs.writeFileSync(submissionsFile, JSON.stringify(allSubmissions, null, 2));
    } catch (err) {
        console.error("Local backup failed:", err);
    }

    // Immediately tell the frontend the submission was successful so the student sees the result screen
    res.json({ success: true, message: 'Response logged and forwarded to Apps Script.' });

    // Now, silently forward the payload (including the target email) to Google Apps Script
    const scriptURL = process.env.APP_SCRIPT_URL;
    
    if (scriptURL) {
        // We inject the TARGET_EMAIL from Render's environment into the payload going to Google
        const payloadToForward = {
            ...submission,
            targetEmail: process.env.TARGET_EMAIL
        };

        try {
            const response = await fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadToForward)
            });
            const result = await response.text();
            console.log("Successfully forwarded to Google Apps Script:", result);
        } catch (error) {
            console.error("Failed to forward to Google Apps Script:", error);
        }
    } else {
        console.error("CRITICAL: APP_SCRIPT_URL environment variable is missing in Render.");
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
