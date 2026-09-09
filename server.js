const express = require('express');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend'); // Uses HTTP API to bypass Render's SMTP block
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Resend with your Render Environment Variable
const resend = new Resend(process.env.RESEND_API_KEY);

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

app.post('/api/submit', (req, res) => {
    const submission = req.body;
    
    // 1. Save local backup instantly
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

    // 2. Respond immediately to the frontend so the UI never freezes
    res.json({ success: true, message: 'Response logged and email dispatch triggered.' });

    // 3. Process the email securely in the background via HTTP API
    const { firstName, lastName, email, chapterTitle, score, total, attempted, skipped, correct, incorrect, breakdown } = submission;
    const targetEmail = process.env.TARGET_EMAIL || "anibanerjee5@gmail.com";
    
    const htmlMessage = `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1e293b;">
            <div style="font-size: 24px;">
                A student has completed a quiz on your portal.<br><br>
                <b>Student Name:</b> ${firstName} ${lastName}<br>
                <b>Email ID:</b> ${email}<br>
                <b>Chapter/Topic:</b> ${chapterTitle}<br>
                <b>Score Achieved:</b> ${score} / ${total}<br>
                <b>Attempted:</b> ${attempted} | <b>Skipped:</b> ${skipped} | <b>Correct:</b> ${correct} | <b>Incorrect:</b> ${incorrect}<br>
                <b>Submission Time:</b> ${new Date().toLocaleString()}<br><br>
            </div>
            <div style="font-size: 22px;">
                <h3>=== QUESTION BREAKDOWN ===</h3><br>
                ${breakdown}
            </div>
        </div>
    `;

    resend.emails.send({
        from: 'Quiz Portal <onboarding@resend.dev>',
        to: [targetEmail],
        subject: `New Quiz Submission: ${chapterTitle} - ${firstName} ${lastName}`,
        html: htmlMessage
    })
    .then(response => console.log("Email successfully sent via Resend API:", response))
    .catch(error => console.error("Error sending email via Resend API:", error));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
