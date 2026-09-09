const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer'); // Now using your installed nodemailer package
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serves front-end files located inside the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Nodemailer to use your Render Environment Variables
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// API route: Fetch Class IX & X navigation configuration
app.get('/api/quizzes', (req, res) => {
    const quizListPath = path.join(__dirname, 'quizzes.json');
    if (fs.existsSync(quizListPath)) {
        res.json(JSON.parse(fs.readFileSync(quizListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'quizzes.json configuration file not found' });
    }
});

// API route: Fetch Class XI & XII NEET navigation configuration
app.get('/api/neet', (req, res) => {
    const neetListPath = path.join(__dirname, 'neet.json');
    if (fs.existsSync(neetListPath)) {
        res.json(JSON.parse(fs.readFileSync(neetListPath, 'utf8')));
    } else {
        res.status(404).json({ error: 'neet.json configuration file not found' });
    }
});

// Dynamic API route: Loads [id]-questions.json on demand
app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const filePath = path.join(__dirname, `${quizId}-questions.json`);
    
    if (fs.existsSync(filePath)) {
        const quizData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(quizData);
    } else {
        res.status(404).json({ error: `File ${quizId}-questions.json not found` });
    }
});

// Main submission route handling both local backup and email processing
app.post('/api/submit', async (req, res) => {
    const submission = req.body;
    
    // 1. Save local backup to submissions.json
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

    // 2. Handle Mailing Process directly from the backend
    const { firstName, lastName, email, chapterTitle, score, total, attempted, skipped, correct, incorrect, breakdown } = submission;
    
    const targetEmail = process.env.TARGET_EMAIL || process.env.EMAIL_USER;
    
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

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: targetEmail,
        subject: `New Quiz Submission: ${chapterTitle} - ${firstName} ${lastName}`,
        html: htmlMessage
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email successfully sent to ${targetEmail}`);
    } catch (error) {
        console.error("Error sending email via Nodemailer:", error);
    }

    res.json({ success: true, message: 'Response logged and email dispatched.' });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
