const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());

// Serves your front-end files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// API to load quizzes.json (For Class IX & X)
app.get('/api/quizzes', (req, res) => {
    const quizListPath = path.join(__dirname, 'quizzes.json');
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'Quizzes configuration not found' });
    }
});

// API to load neet.json (For Class XI & XII)
app.get('/api/neet', (req, res) => {
    const neetListPath = path.join(__dirname, 'neet.json');
    if (fs.existsSync(neetListPath)) {
        res.json(JSON.parse(fs.readFileSync(neetListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'NEET configuration not found' });
    }
});

// DYNAMIC ROUTE: Loads ANY [id]-questions.json file on demand
app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const filePath = path.join(__dirname, `${quizId}-questions.json`);
    
    // If the requested file exists, send it. Otherwise, return a 404.
    if (fs.existsSync(filePath)) {
        const quizData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(quizData);
    } else {
        res.status(404).json({ error: `Quiz questions not found for ID: ${quizId}` });
    }
});

// Handle quiz submissions
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
