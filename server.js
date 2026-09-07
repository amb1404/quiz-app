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
    const quizId = req.params.id;
    if (quizzesCache[quizId]) {
        res.json(quizzesCache[quizId]);
    } else {
        res.status(404).json({ error: 'Quiz questions not found' });
    }
});

app.post('/api/submit', (req, res) => {
    const submission = req.body;
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
    res.json({ success: true, message: 'Response saved successfully!' });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});