const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Master Questions (Answers never leave the server)
const masterQuestions = {
  'reproductive': [
    { id: "Q1", question: "The site of fertilization in the human female reproductive system is the:", options: ["Uterus", "Vagina", "Fallopian tube", "Ovary"], answer: 2 },
    // Add your 35 WBCHSE/ICSE questions here
  ]
};

// In-memory store for active student sessions
const activeSessions = {};
const QUIZ_DURATION_MS = 35 * 60 * 1000; // 35 minutes

app.post('/api/quiz/start', (req, res) => {
  const { email, chapter } = req.body;
  if (!masterQuestions[chapter]) return res.status(404).send("Chapter not found");

  // Create or resume session
  if (!activeSessions[email]) {
    activeSessions[email] = {
      chapter: chapter,
      startTime: Date.now(),
      answers: {}
    };
  }

  const session = activeSessions[email];
  const elapsed = Date.now() - session.startTime;
  const timeLeft = QUIZ_DURATION_MS - elapsed;

  if (timeLeft <= 0) {
    return res.status(403).json({ error: "Time expired for this session." });
  }

  // Strip answers before sending to frontend
  const safeQuestions = masterQuestions[chapter].map(q => ({
    id: q.id,
    question: q.question,
    options: q.options
  }));

  res.json({ questions: safeQuestions, timeLeft, savedAnswers: session.answers });
});

app.post('/api/quiz/save', (req, res) => {
  const { email, questionIndex, selectedOption } = req.body;
  if (activeSessions[email]) {
    activeSessions[email].answers[questionIndex] = selectedOption;
  }
  res.sendStatus(200);
});

app.post('/api/quiz/submit', (req, res) => {
  const { email } = req.body;
  const session = activeSessions[email];
  if (!session) return res.status(400).json({ error: "No active session" });

  // Validate time (allowing 1 minute grace for network latency)
  const elapsed = Date.now() - session.startTime;
  if (elapsed > QUIZ_DURATION_MS + 60000) {
    delete activeSessions[email];
    return res.status(403).json({ error: "Submission rejected: Time limit exceeded." });
  }

  // Grade the quiz securely
  let score = 0;
  const questions = masterQuestions[session.chapter];
  
  for (const [index, ans] of Object.entries(session.answers)) {
    if (questions[index].answer === parseInt(ans)) score++;
  }

  delete activeSessions[email]; // Clear session on completion
  res.json({ success: true, score, total: questions.length });
});

app.listen(3000, () => console.log('Secure server running on port 3000'));
