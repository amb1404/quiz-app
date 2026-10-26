const express = require('express');
const crypto = require('crypto');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Use environment variables, but provide a temporary fallback to prevent deployment crashes
const TIMER_SECRET = process.env.TIMER_SECRET || 'temp_timer_secret_pioneers_2026';
const APPS_SECRET = process.env.APPS_SECRET || 'temp_apps_secret_pioneers_2026';

if (!process.env.TIMER_SECRET || !process.env.APPS_SECRET) {
  console.warn("⚠️ WARNING: TIMER_SECRET or APPS_SECRET is missing in Render Environment Variables.");
  console.warn("⚠️ Server is running using temporary fallbacks. Please add them in Render settings.");
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight health check endpoint for self-pings and monitors
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

// Route for serving the quiz page (Stateless HTML generation)
app.get('/quiz', (req, res) => {
  const email = req.query.email || 'student@example.com'; 
  const testId = req.query.testId || 'IX_Physics_01';

  const payload = JSON.stringify({
    email: email.trim().toLowerCase(),
    testId,
    startTime: Date.now()
  });
  
  const encodedPayload = Buffer.from(payload).toString('base64');
  const signature = crypto
    .createHmac('sha256', TIMER_SECRET)
    .update(encodedPayload)
    .digest('hex');
    
  const sessionToken = `${encodedPayload}.${signature}`;

  const quizHtml = `
    <!DOCTYPE html>
    <html>
    <body>
      <h2>Mock Test: ${testId}</h2>
      <form action="/submit-quiz" method="POST">
        <div>
          <p>1. What is the SI unit of force?</p>
          <input type="radio" name="q1" value="Newton"> Newton
          <input type="radio" name="q1" value="Joule"> Joule
        </div>
        <input type="hidden" name="sessionToken" value="${sessionToken}">
        <input type="hidden" name="userEmail" value="${email}">
        <br><br>
        <button type="submit">Submit Test</button>
      </form>
    </body>
    </html>
  `;

  res.send(quizHtml);
});

// Route for validating the submitted quiz
app.post('/submit-quiz', (req, res) => {
  try {
    const { sessionToken, userEmail, q1 } = req.body;

    if (!sessionToken || !sessionToken.includes('.')) {
      return res.status(401).send("<h1>Error: Unauthorized or tampered session.</h1>");
    }

    const [encodedPayload, clientSignature] = sessionToken.split('.');

    const expectedSignature = crypto
      .createHmac('sha256', TIMER_SECRET)
      .update(encodedPayload)
      .digest('hex');

    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(clientSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );

    if (!isSignatureValid) {
      return res.status(401).send("<h1>Error: Tampered session token.</h1>");
    }

    const decodedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf-8'));
    const elapsedSeconds = Math.floor((Date.now() - decodedPayload.startTime) / 1000);

    let score = (q1 === 'Newton') ? 1 : 0;

    res.send(`<h1>Quiz Complete!</h1><p>Time taken: ${elapsedSeconds} seconds.</p><p>Score: ${score}</p>`);

  } catch (err) {
    console.error("Submission error:", err);
    res.status(500).send("<h1>Server Error during submission.</h1>");
  }
});

// Start Express Server
const server = app.listen(PORT, () => {
  console.log(`Pioneers Prep server running on port ${PORT}`);
  startSelfPing();
});

// Keep-Alive Ping Routine
function startSelfPing() {
  const PING_INTERVAL = 12 * 60 * 1000; 
  const pingUrl = process.env.PING_URL || 'https://pioneersprep.in/health';

  setInterval(() => {
    https.get(pingUrl, (res) => {
      console.log(`[Keep-Alive Ping] Status: ${res.statusCode} at ${new Date().toISOString()}`);
    }).on('error', (err) => {
      console.warn(`[Keep-Alive Ping Failed]: ${err.message}`);
    });
  }, PING_INTERVAL);
}
