const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configured with family: 4 to force IPv4 and bypass Render IPv6 limits
const transporter = nodemailer.createTransport({
    service: 'gmail',
    family: 4, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.get('/api/quizzes', (req, res) => {
    fs.readFile(path.join(__dirname, 'quizzes.json'), 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to load quizzes list' });
        res.json(JSON.parse(data));
    });
});

app.get('/api/quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const fileName = `${quizId}-questions.json`;
    fs.readFile(path.join(__dirname, fileName), 'utf8', (err, data) => {
        if (err) return res.status(404).json({ error: 'Question file not found' });
        res.json(JSON.parse(data));
    });
});

app.post('/api/submit', async (req, res) => {
    const { studentName, quizId, score, total, answers } = req.body;

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.TARGET_EMAIL || process.env.EMAIL_USER,
        subject: `New Quiz Submission: ${quizId} - ${studentName || 'Anonymous'}`,
        text: `A student has completed a quiz on your portal.

Student Name: ${studentName || 'Anonymous'}
Chapter/Quiz ID: ${quizId}
Score Achieved: ${score} / ${total}
Submission Time: ${new Date().toLocaleString()}

Raw Option Answers Index Array: ${JSON.stringify(answers)}`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: 'Result emailed successfully!' });
    } catch (err) {
        console.error('Error sending email:', err);
        res.status(500).json({ success: false, message: 'Failed to send result email' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
