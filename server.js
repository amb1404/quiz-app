const express = require('express');
const crypto = require('crypto');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Enforce mandatory environment variables
const TIMER_SECRET = process.env.TIMER_SECRET;
const APPS_SECRET = process.env.APPS_SECRET;

if (!TIMER_SECRET || !APPS_SECRET) {
  console.error("FATAL ERROR: Required environment variables (TIMER_SECRET, APPS_SECRET) are missing.");
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight health check endpoint for self-pings and monitors
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

/**
 * 1. Generate Stateless Quiz Session Token
 * Returns: base64(payload).signature
 */
app.post('/api/start-quiz', (req, res) => {
  try {
    const { email, testId } = req.body;
    if (!email || !testId) {
      return res.status(400).json({ success: false, error: 'Email and testId required' });
    }

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
    return res.status(200).json({ success: true, sessionToken });
  } catch (err) {
    console.error("Error generating session:", err);
    return res.status(500).json({ success: false, error: 'Could not initialize session' });
  }
});

/**
 * 2. Validate Session & Score Submission
 * Validates HMAC signature independently of server restarts
 */
app.post('/api/submit-quiz', (req, res) => {
  try {
    const { sessionToken, answers, userEmail } = req.body;

    if (!sessionToken || !sessionToken.includes('.')) {
      return res.status(401).json({ success: false, error: 'Unauthorized/tampered session: Missing token.' });
    }

    const [encodedPayload, clientSignature] = sessionToken.split('.');

    // Compute expected HMAC signature
    const expectedSignature = crypto
      .createHmac('sha256', TIMER_SECRET)
      .update(encodedPayload)
      .digest('hex');

    // Timing-safe comparison against tampering
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(clientSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );

    if (!isSignatureValid) {
      return res.status(401).json({ success: false, error: 'Unauthorized/tampered session: Invalid signature.' });
    }

    // Decode verified payload
    const decodedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf-8'));
    const { email, startTime, testId } = decodedPayload;

    // Optional email consistency check
    if (userEmail && userEmail.trim().toLowerCase() !== email) {
      return res.status(401).json({ success: false, error: 'Unauthorized/tampered session: User identity mismatch.' });
    }

    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Prevent impossible instantaneous bot submissions (< 5 seconds)
    if (elapsedSeconds < 5) {
      return res.status(400).json({ success: false, error: 'Submission rejected: Minimum duration not met.' });
    }

    // Place your score computation logic and Google Apps Script forwarder here
    console.log(`Verified submission from ${email} for ${testId}. Time elapsed: ${elapsedSeconds}s`);

    return res.status(200).json({
      success: true,
      message: 'Quiz submitted successfully',
      elapsedSeconds
    });

  } catch (err) {
    console.error("Submission verification error:", err);
    return res.status(401).json({ success: false, error: 'Unauthorized/tampered session' });
  }
});

// Start Express Server
const server = app.listen(PORT, () => {
  console.log(`Pioneers Prep server running on port ${PORT}`);
  startSelfPing();
});

/**
 * 3. Keep-Alive Ping Routine (Prevents Render Free-Tier 15-Minute Sleep)
 */
function startSelfPing() {
  const PING_INTERVAL = 12 * 60 * 1000; // Ping every 12 minutes
  const pingUrl = process.env.PING_URL || 'https://pioneersprep.in/health';

  setInterval(() => {
    https.get(pingUrl, (res) => {
      console.log(`[Keep-Alive Ping] Status: ${res.statusCode} at ${new Date().toISOString()}`);
    }).on('error', (err) => {
      console.warn(`[Keep-Alive Ping Failed]: ${err.message}`);
    });
  }, PING_INTERVAL);
}
