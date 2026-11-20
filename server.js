// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://pioneersprep.in';

const APP_VERSION = Date.now();

// ============================================================================
// 1. HARDENED PROXY CONFIGURATION, CRYPTOGRAPHIC SECRETS & RAZORPAY
// ============================================================================
const TRUST_PROXY_DEPTH = process.env.TRUST_PROXY !== undefined
    ? (isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
    : 1;
app.set('trust proxy', TRUST_PROXY_DEPTH);

function loadOrGenerateMasterSecret() {
    if (process.env.TIMER_SECRET && process.env.TIMER_SECRET.trim().length >= 16) {
        return process.env.TIMER_SECRET.trim();
    }
    const persistentSeed = [
        process.env.APPS_SCRIPT_SECRET,
        process.env.LIVEKIT_API_SECRET,
        process.env.RAZORPAY_KEY_SECRET,
        process.env.UPSTASH_REDIS_REST_TOKEN,
        process.env.REDIS_URL
    ].filter(Boolean).join('|');
    if (persistentSeed.length >= 8) {
        return crypto.createHmac('sha512', 'pioneers-prep-master-secret-v1').update(persistentSeed).digest('hex');
    }
    const secretFilePath = path.join(__dirname, '.runtime_secret');
    try {
        if (fs.existsSync(secretFilePath)) {
            const existing = fs.readFileSync(secretFilePath, 'utf8').trim();
            if (existing.length >= 64) return existing;
        }
        const generated = crypto.randomBytes(64).toString('hex');
        fs.writeFileSync(secretFilePath, generated, { mode: 0o600 });
        return generated;
    } catch {
        return crypto.randomBytes(64).toString('hex');
    }
}

const SECRET = loadOrGenerateMasterSecret();
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || '';
const ADMIN_EMAIL = process.env.TARGET_EMAIL || 'anibanerjee699@gmail.com';

if (!process.env.TIMER_SECRET || !process.env.APPS_SCRIPT_SECRET) {
    console.warn('[Security Notice] Missing TIMER_SECRET or APPS_SCRIPT_SECRET in environment variables. Ensure both are set in Render dashboard.');
}

let razorpay = null;
const CLEAN_RAZORPAY_KEY_ID = (process.env.RAZORPAY_KEY_ID || '').trim();
const CLEAN_RAZORPAY_KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || '').trim();
if (CLEAN_RAZORPAY_KEY_ID && CLEAN_RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
        key_id: CLEAN_RAZORPAY_KEY_ID,
        key_secret: CLEAN_RAZORPAY_KEY_SECRET
    });
    console.log('[Finance] Razorpay SDK initialized successfully.');
} else {
    console.warn('[Finance Warning] Razorpay credentials missing in environment variables. Payments will be unavailable.');
}

// ============================================================================
// 2. REDIS DISTRIBUTED STATE ENGINE (WITH ZERO-DEPENDENCY RESP & REST CLIENTS)
// ============================================================================
const MAX_MAP_SIZE = 5000;
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // Implementation 1: Extended to 30 Days
const TOKEN_MAX_AGE_SEC = Math.ceil(TOKEN_MAX_AGE_MS / 1000);
const CACHE_TTL_MS = 60 * 1000;
const AUTH_COOKIE_NAME = 'pioneers_google_auth_v2';
const SUBMISSIONS_REDIS_KEY = 'global:submissions:history';

class NativeRedisClient {
    constructor(redisUrl) {
        this.url = new URL(redisUrl);
        this.isTls = this.url.protocol === 'rediss:';
        this.host = this.url.hostname || '127.0.0.1';
        this.port = Number(this.url.port) || 6379;
        this.username = this.url.username ? decodeURIComponent(this.url.username) : '';
        this.password = this.url.password ? decodeURIComponent(this.url.password) : '';
        this.db = this.url.pathname && this.url.pathname.length > 1 ? Number(this.url.pathname.slice(1)) : 0;
        this.socket = null;
        this.connected = false;
        this.queue = [];
        this.buffer = Buffer.alloc(0);
        this.connect();
    }

    connect() {
        const opts = { host: this.host, port: this.port, rejectUnauthorized: false };
        this.socket = this.isTls ? tls.connect(opts) : net.createConnection(opts);

        this.socket.on('connect', () => {
            this.connected = true;
            if (this.password) {
                const authArgs = this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password];
                this.sendRaw(authArgs).catch(err => console.error('[Redis Auth Error]:', err.message));
            }
            if (this.db > 0) {
                this.sendRaw(['SELECT', String(this.db)]).catch(() => {});
            }
        });

        this.socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.processBuffer();
        });

        this.socket.on('error', (err) => {
            this.connected = false;
            this.buffer = Buffer.alloc(0);
            while (this.queue.length > 0) {
                this.queue.shift().reject(err);
            }
        });

        this.socket.on('close', () => {
            this.connected = false;
            this.buffer = Buffer.alloc(0);
            const closeErr = new Error('Redis socket closed');
            while (this.queue.length > 0) {
                this.queue.shift().reject(closeErr);
            }
            setTimeout(() => this.connect(), 3000);
        });
    }

    encodeCommand(args) {
        let str = `*${args.length}\r\n`;
        for (const arg of args) {
            const val = String(arg);
            str += `$${Buffer.byteLength(val, 'utf8')}\r\n${val}\r\n`;
        }
        return str;
    }

    parseResp(buf, offset = 0) {
        if (offset >= buf.length) return null;
        const type = String.fromCharCode(buf[offset]);
        const lineEnd = buf.indexOf('\r\n', offset);
        if (lineEnd === -1) return null;
        const line = buf.slice(offset + 1, lineEnd).toString('utf8');

        if (type === '+') return { value: line, nextOffset: lineEnd + 2 };
        if (type === '-') return { error: new Error(line), nextOffset: lineEnd + 2 };
        if (type === ':') return { value: parseInt(line, 10), nextOffset: lineEnd + 2 };
        if (type === '$') {
            const len = parseInt(line, 10);
            if (len === -1) return { value: null, nextOffset: lineEnd + 2 };
            const start = lineEnd + 2;
            const end = start + len;
            if (end + 2 > buf.length) return null;
            return { value: buf.slice(start, end).toString('utf8'), nextOffset: end + 2 };
        }
        if (type === '*') {
            const count = parseInt(line, 10);
            if (count === -1) return { value: null, nextOffset: lineEnd + 2 };
            const arr = [];
            let cur = lineEnd + 2;
            for (let i = 0; i < count; i++) {
                const parsed = this.parseResp(buf, cur);
                if (!parsed) return null;
                arr.push(parsed.value);
                cur = parsed.nextOffset;
            }
            return { value: arr, nextOffset: cur };
        }
        return null;
    }

    processBuffer() {
        while (this.queue.length > 0) {
            const parsed = this.parseResp(this.buffer, 0);
            if (!parsed) break;
            this.buffer = this.buffer.slice(parsed.nextOffset);
            const req = this.queue.shift();
            if (parsed.error) req.reject(parsed.error);
            else req.resolve(parsed.value);
        }
    }

    sendRaw(args) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                return reject(new Error('Redis socket not connected'));
            }
            this.queue.push({ resolve, reject });
            this.socket.write(this.encodeCommand(args));
        });
    }
}

class StateStore {
    constructor() {
        this.upstashUrl = process.env.UPSTASH_REDIS_REST_URL ? process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '') : '';
        this.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || '';
        this.redisClient = null;
        this.fallbackMap = new Map();

        if (this.upstashUrl && this.upstashToken) {
            console.log('[StateStore] Connected to Upstash Redis REST API.');
        } else if (process.env.REDIS_URL) {
            try {
                this.redisClient = new NativeRedisClient(process.env.REDIS_URL);
                console.log('[StateStore] Initialized native Redis RESP client via REDIS_URL.');
            } catch (e) {
                console.warn('[StateStore] Failed to parse REDIS_URL, using fallback memory store:', e.message);
            }
        } else {
            console.warn('[StateStore Notice] Set REDIS_URL or UPSTASH_REDIS_REST_URL in Render Environment Variables for persistent multi-instance state.');
        }
    }

    setFallback(key, value, ttlSec) {
        if (!this.fallbackMap.has(key) && this.fallbackMap.size >= MAX_MAP_SIZE) {
            const oldestKey = this.fallbackMap.keys().next().value;
            if (oldestKey !== undefined) this.fallbackMap.delete(oldestKey);
        }
        this.fallbackMap.set(key, {
            value,
            expiresAt: Date.now() + (ttlSec * 1000)
        });
    }

    getFallback(key) {
        const entry = this.fallbackMap.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.fallbackMap.delete(key);
            return null;
        }
        return entry.value;
    }

    async execCommand(args) {
        if (this.upstashUrl && this.upstashToken) {
            const res = await fetch(this.upstashUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.upstashToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(args)
            });
            if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
            const data = await res.json();
            return data.result;
        }
        if (this.redisClient && this.redisClient.connected) {
            return await this.redisClient.sendRaw(args);
        }
        throw new Error('No external Redis active');
    }

    async get(key) {
        try {
            const val = await this.execCommand(['GET', key]);
            return val;
        } catch {
            return this.getFallback(key);
        }
    }

    async set(key, value, ttlSec) {
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        this.setFallback(key, strVal, ttlSec);
        try {
            await this.execCommand(['SET', key, strVal, 'EX', String(ttlSec)]);
        } catch {}
    }

    async sismember(key, member) {
        try {
            const res = await this.execCommand(['SISMEMBER', key, String(member)]);
            return Number(res) === 1;
        } catch {
            return false;
        }
    }

    async sadd(key, member) {
        try {
            await this.execCommand(['SADD', key, String(member)]);
        } catch {}
    }

    async setNx(key, value, ttlSec) {
        try {
            const res = await this.execCommand(['SET', key, String(value), 'EX', String(ttlSec), 'NX']);
            return res === 'OK';
        } catch {
            const existing = this.getFallback(key);
            if (existing !== null) return false;
            this.setFallback(key, String(value), ttlSec);
            return true;
        }
    }

    async del(key) {
        this.fallbackMap.delete(key);
        try {
            await this.execCommand(['DEL', key]);
        } catch {}
    }

    async checkRateLimit(bucket, ip, maxRequests, windowSec) {
        const key = `rl:${bucket}:${ip}`;
        try {
            const count = Number(await this.execCommand(['INCR', key]));
            if (count === 1) {
                await this.execCommand(['EXPIRE', key, String(windowSec)]);
            }
            return count <= maxRequests;
        } catch {
            const existing = this.getFallback(key);
            const count = existing ? Number(existing) + 1 : 1;
            const entry = this.fallbackMap.get(key);
            const remainingSec = entry ? Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : windowSec;
            this.setFallback(key, String(count), remainingSec);
            return count <= maxRequests;
        }
    }
}

const stateStore = new StateStore();
async function updateBoardSecurely(cleanId, updateFn) {
    const lockKey = `live:lock:${cleanId}`;
    let acquired = false;
    for (let i = 0; i < 50; i++) {
        acquired = await stateStore.setNx(lockKey, '1', 5);
        if (acquired) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if (!acquired) throw new Error('Data collision lock timeout');

    try {
        const rawBoard = await stateStore.get(`live:board:${cleanId}`);
        let board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
        const newBoard = updateFn(board);
        if (newBoard) await stateStore.set(`live:board:${cleanId}`, newBoard, 60 * 60 * 8);
    } finally {
        await stateStore.del(lockKey);
    }
}
// ============================================================================
// ZERO-TRUST UNIVERSAL ACCESS GATE (ENFORCES GLOBAL WHITELIST & ULTRA PAYWALL)
// ============================================================================
async function checkContentAccess(email, itemID, isPremium, isUltra = false) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return false;

    // Requirement 6 Exception: ULTRA items ALWAYS require a specific purchase
    if (isUltra) {
        const inPurchaseSet = await stateStore.sismember(`user:purchases:${cleanEmail}`, itemID);
        if (inPurchaseSet) return true;
        const inPurchaseKey = await stateStore.get(`user:purchases:${cleanEmail}:${itemID}`);
        if (inPurchaseKey) return true;
        return false; 
    }

    // If content is NOT premium, any signed-in user can access it
    if (!isPremium) return true;

    // For Premium content, enforce the Whitelist
    const isVip = await stateStore.get(`whitelist:vip:${cleanEmail}`);
    if (isVip) return true;

    const inWhitelistSet = await stateStore.sismember(`whitelist:item:${itemID}`, cleanEmail);
    if (inWhitelistSet) return true;
    const inWhitelistKey = await stateStore.get(`whitelist:item:${itemID}:${cleanEmail}`);
    if (inWhitelistKey) return true;

    // If it is Premium, also check if they bought it specifically
    const inPurchaseSet = await stateStore.sismember(`user:purchases:${cleanEmail}`, itemID);
    if (inPurchaseSet) return true;
    const inPurchaseKey = await stateStore.get(`user:purchases:${cleanEmail}:${itemID}`);
    if (inPurchaseKey) return true;

    return false; // Not whitelisted and not purchased
}

function setBoundedMap(map, key, value) {
    if (!map.has(key) && map.size >= MAX_MAP_SIZE) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(key, value);
}

function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) {
        return cfIp.trim().slice(0, 64);
    }
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
        const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
        if (ips.length > 0) {
            const trustedIndex = Math.max(0, ips.length - (Number(TRUST_PROXY_DEPTH) || 1));
            return ips[trustedIndex].slice(0, 64);
        }
    }
    const rawIp = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    return String(rawIp).trim().slice(0, 64);
}

const fsCache = {
    quizzesList: { data: null, expiresAt: 0 },
    quizPaths: { data: null, expiresAt: 0 },
    quizContentByPath: new Map(),
    notesList: { data: null, expiresAt: 0 },
    notePaths: { data: null, expiresAt: 0 },
    descList: { data: null, expiresAt: 0 },
    descPaths: { data: null, expiresAt: 0 }
};

// ============================================================================
// 3. PRE-AUTH PAYLOAD GUARD, JSON DoS PROTECTION & STRICT NONCE CSP HEADERS
// ============================================================================
function verifyJsonComplexity(req, res, buf) {
    if (!buf || buf.length === 0) return;
    let depth = 0;
    let maxDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < buf.length; i++) {
        const byte = buf[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (byte === 0x5c) {
            escaped = true;
            continue;
        }
        if (byte === 0x22) {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (byte === 0x7b || byte === 0x5b) {
                depth++;
                if (depth > maxDepth) maxDepth = depth;
                if (maxDepth > 12) {
                    throw new Error('JSON nesting depth exceeded security limit.');
                }
            } else if (byte === 0x7d || byte === 0x5d) {
                depth--;
            }
        }
    }
}

const defaultJsonParser = express.json({ limit: '50kb', verify: verifyJsonComplexity });
const submitJsonParser = express.json({ limit: '15mb', verify: verifyJsonComplexity });

app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    const cspPolicy = [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://checkout.razorpay.com https://*.razorpay.com https://accounts.google.com https://apis.google.com`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com https://*.razorpay.com",
        "font-src 'self' https://fonts.gstatic.com https://*.razorpay.com data:",
        "img-src 'self' data: blob: https://*.razorpay.com https://*.googleusercontent.com https://*.google.com https://*.gstatic.com",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "connect-src 'self' wss: https://*.livekit.cloud wss://*.livekit.cloud https://cdn.jsdelivr.net https://*.razorpay.com https://accounts.google.com https://*.google.com https://oauth2.googleapis.com https://www.googleapis.com",
        "frame-src 'self' https://*.razorpay.com https://accounts.google.com https://*.google.com",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self' https://accounts.google.com https://*.razorpay.com"
    ].join('; ');

    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Content-Security-Policy', cspPolicy);
    next();
});

app.use((req, res, next) => {
    if (req.path === '/api/submit') return next();
    return defaultJsonParser(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, error: 'Malformed or oversized JSON payload.' });
        next();
    });
});

function isSecureConnection(req) {
    return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production');
}

// Implementation 2: Prioritize Explicit Authorization Header over Stale Ambient Cookies
function extractAuthToken(req) {
    const headerToken = req.get('Authorization')?.replace('Bearer ', '').trim();
    if (headerToken && headerToken.includes('|||')) {
        return headerToken;
    }

    const cookieHeader = req.headers['cookie'];
    if (typeof cookieHeader === 'string' && cookieHeader.length > 0) {
        const pairs = cookieHeader.split(';');
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i].trim();
            if (pair.startsWith(AUTH_COOKIE_NAME + '=')) {
                const rawVal = pair.slice(AUTH_COOKIE_NAME.length + 1);
                try {
                    const decoded = decodeURIComponent(rawVal).trim();
                    if (decoded.includes('|||')) return decoded;
                } catch {
                    if (rawVal.includes('|||')) return rawVal;
                }
            }
        }
    }
    return null;
}

// Helper to keep the HttpOnly cookie synchronized with the latest valid Bearer token (for direct PDF links)
function syncAuthCookieIfNeeded(req, res, token) {
    if (token && req.get('Authorization')) {
        res.cookie(AUTH_COOKIE_NAME, token, {
            httpOnly: true,
            secure: isSecureConnection(req),
            sameSite: 'strict',
            maxAge: TOKEN_MAX_AGE_MS,
            path: '/'
        });
    }
}

// Implementation 3A: Pre-submit security guard verifies identity without burning the global SSO token
async function preSubmitSecurityGuard(req, res, next) {
    try {
        const clientIp = getClientIp(req);
        const allowed = await stateStore.checkRateLimit('submit', clientIp, 15, 15 * 60);
        if (!allowed) {
            return res.status(429).json({ success: false, error: 'Too many submission attempts. Please wait.' });
        }

        const token = extractAuthToken(req);
        if (token) {
            const preCheck = await verifyAuthToken(token, null, false);
            if (!preCheck.valid) {
                return res.status(401).json({ success: false, error: preCheck.error });
            }
            req.preVerifiedAuth = preCheck;
            return next();
        }

        const ipVerified = await stateStore.get(`ip:verified:${clientIp}`);
        if (!ipVerified) {
            return res.status(401).json({ success: false, error: 'Unauthorized submission request.' });
        }
        next();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Security verification failed.' });
    }
}

// ============================================================================
// 4. DYNAMIC HTML INTERCEPTOR (CLEAN URLS, NONCE INJECTION & EVENT DELEGATION)
// ============================================================================
async function serveDynamicHtml(req, res, fileName, canonicalBaseRoute) {
    const isHome = canonicalBaseRoute === '/';
    const nonce = res.locals.cspNonce;

    // Check if the browser already has a valid 30-day HttpOnly auth cookie
    let serverRestoredSession = null;
    try {
        const cookieToken = extractAuthToken(req);
        if (cookieToken) {
            const authCheck = await verifyAuthToken(cookieToken, null, false);
            if (authCheck && authCheck.valid) {
                serverRestoredSession = {
                    token: cookieToken,
                    firstName: authCheck.firstName || '',
                    lastName: authCheck.lastName || '',
                    email: authCheck.email || ''
                };
            } else {
                res.clearCookie(AUTH_COOKIE_NAME);
            }
        }
    } catch (e) {}

    const filePath = path.join(__dirname, 'public', fileName);
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).send("Page not found");

        const isTests = canonicalBaseRoute === '/mock-tests';
        const isNotes = canonicalBaseRoute === '/study-notes';
        const isDesc = canonicalBaseRoute === '/descriptive-papers';

        const headerHTML = `
            <style>
                @media (max-width: 768px) {
                    .site-header { padding: 8px 10px !important; }
                    .nav-container {
                        flex-direction: column !important;
                        align-items: center !important;
                        padding: 0 !important;
                        gap: 8px !important;
                    }
                    .brand-title { font-size: 22px !important; line-height: 1 !important; }
                    .brand-subtitle { display: none !important; /* Hides subtitle on mobile to save space */ }
                    .site-nav {
                        flex-wrap: wrap !important;
                        justify-content: center !important;
                        gap: 6px !important;
                        margin-top: 0 !important;
                    }
                    .nav-link {
                        padding: 6px 10px !important;
                        font-size: 13px !important;
                        margin: 0 !important;
                    }
                    #auth-ui-container {
                        margin-left: 0 !important;
                        padding-left: 0 !important;
                        border-left: none !important;
                        margin-top: 4px !important;
                        width: 100% !important;
                        justify-content: center !important;
                    }
                    #nav-profile-badge { gap: 8px !important; }
                    #nav-avatar { width: 26px !important; height: 26px !important; font-size: 11px !important; }
                    #nav-name { font-size: 12px !important; }
                    #nav-logout-btn { font-size: 12px !important; }
                    #pwa-download-btn { padding: 6px 10px !important; font-size: 12px !important; }
                }
            </style>
            <div class="nav-container">
                <a href="/" class="brand-logo" data-action="clear-session">
                    <span class="brand-title">PIONEERS PREP</span>
                    <span class="brand-subtitle">Guided by <strong>Aniruddha Banerjee</strong>, with an experience of 8+ years in coaching.</span>
                </a>
                <nav class="site-nav" aria-label="Main Navigation">
                    <a href="/" class="nav-link ${isHome ? 'active' : ''}" data-action="clear-session">Home</a>
                    <a href="/mock-tests" class="nav-link ${isTests ? 'active' : ''}" data-action="clear-session">Mock Tests</a>
                    <a href="/study-notes" class="nav-link ${isNotes ? 'active' : ''}" data-action="clear-session">Study Notes</a>
                    <a href="/descriptive-papers" class="nav-link nav-link-yellow ${isDesc ? 'active' : ''}" data-action="clear-session">Descriptive Papers</a>
                    <button id="pwa-download-btn" type="button" style="background: linear-gradient(135deg, #059669, #10b981); color: #ffffff; border: none; padding: 8px 14px; border-radius: 6px; font-weight: 700; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);">
                        📲 Download App
                    </button>
                    
                    <!-- Global Auth UI -->
                    <div id="auth-ui-container" style="margin-left: 15px; padding-left: 15px; border-left: 2px solid #e2e8f0; display: flex; align-items: center;">
                        <button id="nav-signin-btn" style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; display: none;">Sign In</button>
                        <div id="nav-profile-badge" style="display: none; align-items: center; gap: 10px;">
                            <div id="nav-avatar" style="width: 32px; height: 32px; background: #1e3a8a; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 13px;"></div>
                            <span id="nav-name" style="font-weight: bold; color: #1e293b; font-size: 13px;"></span>
                            <button id="nav-logout-btn" style="background: none; border: none; color: #ef4444; font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0;">Logout</button>
                        </div>
                    </div>
                </nav>
            </div>
        `;

        const footerHTML = `
            <div class="footer-profile-container">
                <div class="footer-brand-info">
                    <h3>Pioneers Prep</h3>
                    <p>Founded and managed by <strong>Aniruddha Banerjee</strong>. We deliver specialized online tutoring, custom study notes, and secure mock examination portals for secondary and higher secondary science students.</p>
                </div>
                <div class="footer-contact">
                    <h4>Educator Profile & Contact</h4>
                    <a href="tel:+917407191899" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                        <span>+91 74071 91899 (Call)</span>
                    </a>
                    <a href="https://wa.me/917407191899" target="_blank" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M12.012 2c-5.506 0-9.989 4.478-9.99 9.984a9.964 9.964 0 0 0 1.333 4.976L1.92 22.07l5.244-1.376a9.972 9.972 0 0 0 4.847 1.259h.004c5.505 0 9.988-4.478 9.989-9.984 0-2.669-1.037-5.176-2.924-7.063A9.925 9.925 0 0 0 12.012 2zm0 18.283h-.003a8.272 8.272 0 0 1-4.22-1.155l-.303-.179-3.136.822.84-3.056-.197-.313a8.28 8.28 0 0 1-1.267-4.418c.001-4.57 3.72-8.288 8.293-8.288 2.215 0 4.298.863 5.864 2.428a8.236 8.236 0 0 1 2.426 5.866c-.002 4.568-3.721 8.286-8.297 8.288zm4.544-6.196c-.249-.125-1.474-.728-1.703-.811-.23-.083-.398-.124-.564.124-.167.249-.644.811-.79.77-.145-.164-.291-.207-.54-.332-1.398-.698-3.328-1.545-4.226-3.1-.096-.164-.011-.253.113-.377.111-.11.249-.29.373-.435.124-.146.166-.249.249-.415.083-.166.042-.311-.021-.436-.062-.124-.564-1.36-.773-1.865-.203-.49-.408-.424-.564-.432l-.481-.007c-.166 0-.435.062-.663.311s-.871.851-.871 2.074c0 1.223.892 2.405 1.016 2.571.124.166 1.753 2.676 4.246 3.753 1.54.665 2.112.72 2.871.603.861-.131 2.671-1.092 3.045-2.149.373-1.058.373-1.966.262-2.149-.112-.185-.415-.291-.664-.415z"/></svg>
                        <span>+91 74071 91899 (WhatsApp)</span>
                    </a>
                    <a href="mailto:anibanerjee5@gmail.com" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
                        <span>anibanerjee5@gmail.com</span>
                    </a>
                    <div class="contact-item no-hover" style="cursor: default;">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
                        <span>Berhampore, Murshidabad, West Bengal</span>
                    </div>
                </div>
            </div>
            <div class="footer-bottom">
                <div class="footer-bottom-text">
                    <strong style="font-size: 15px;">Pioneers Prep</strong> — Mentored by <strong>Aniruddha Banerjee</strong><br>
                    Online Mock Tests, Study Notes & Descriptive Worksheets for NEET, ICSE & WBCHSE.
                </div>
                <div class="footer-links" style="display: flex; gap: 14px; flex-wrap: wrap; align-items: center;">
                    <a href="/privacy-policy">Privacy Policy</a>
                    <span style="color: #64748b;">|</span>
                    <a href="/terms-of-service">Terms of Service</a>
                    <span style="color: #64748b;">|</span>
                    <a href="/sitemap.xml">Sitemap</a>
                </div>
            </div>
        `;

        const restoredSessionScript = serverRestoredSession
            ? `if (!localStorage.getItem('pp_id_token') || localStorage.getItem('pp_auth_provider') !== 'google_v2') {
                        localStorage.setItem('pp_auth_provider', 'google_v2');
                        localStorage.setItem('pp_id_token', ${JSON.stringify(serverRestoredSession.token)});
                        localStorage.setItem('pp_fname', ${JSON.stringify(serverRestoredSession.firstName)});
                        localStorage.setItem('pp_lname', ${JSON.stringify(serverRestoredSession.lastName)});
                        localStorage.setItem('pp_email', ${JSON.stringify(serverRestoredSession.email)});
                    }`
            : '';

        const headRouteGuardScript = `<base href="/">
        <link rel="preconnect" href="https://accounts.google.com">
        <script nonce="${nonce}" src="https://accounts.google.com/gsi/client" async></script>
        <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js" defer></script>
        <script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js" defer></script>
        <script nonce="${nonce}">
            (function() {
                var baseRoute = '${canonicalBaseRoute}';
                var isHome = (baseRoute === '/');
                try {
                    ${restoredSessionScript}

                    // Force all pre-Google legacy OTP browsers to log out immediately
                    if (localStorage.getItem('pp_auth_provider') !== 'google_v2') {
                        localStorage.removeItem('pp_id_token');
                        localStorage.removeItem('pp_fname');
                        localStorage.removeItem('pp_lname');
                        localStorage.removeItem('pp_email');
                    }

                    var token = localStorage.getItem('pp_id_token');
                    if (token) {
                        // Browser is already signed in: clear any pending login popup flags
                        sessionStorage.removeItem('force_login_open');
                        sessionStorage.removeItem('pp_open_google_auth');
                    } else if (sessionStorage.getItem('force_login_open') === 'true') {
                        sessionStorage.removeItem('force_login_open');
                        sessionStorage.setItem('pp_open_google_auth', 'true');
                    }

                    // GLOBAL SSO GUARD: Save target deep URL and send unauthenticated users to the Google Sign-In screen
                    var isExemptAdmin = (baseRoute === '/admin-live');
                    if (!isHome && !isExemptAdmin && !token) {
                        sessionStorage.setItem('pp_post_login_redirect', window.location.pathname + window.location.search);
                        sessionStorage.removeItem('force_login_open');
                        sessionStorage.setItem('pp_open_google_auth', 'true');
                        window.location.replace('/');
                        return;
                    }

                    if (isHome) {
                        sessionStorage.setItem('pioneers_active_route', '/');
                        if (window.location.pathname !== '/') {
                            history.replaceState({ app: 'pioneers' }, document.title, '/' + window.location.search + window.location.hash);
                        }
                    } else {
                        sessionStorage.setItem('pioneers_active_route', baseRoute);
                        // Preserve valid sub-routes (e.g. /descriptive-papers/question-papers), only rewrite raw .html paths
                        if (window.location.pathname.indexOf(baseRoute) !== 0) {
                            history.replaceState({ app: 'pioneers' }, document.title, baseRoute + window.location.search);
                        }
                    }
                } catch (e) {}
            })();
        </script>`;

        const clientIntegrationScript = `<script nonce="${nonce}">
            (function() {
                var baseRoute = '${canonicalBaseRoute}';
                if (typeof MainNav !== 'undefined') {
                    MainNav.normalizeRoute = function(route) {
                        if (!route) return '/';
                        var r = String(route).toLowerCase();
                        if (r.indexOf('/mock-tests') === 0 || r.indexOf('test-portal') !== -1) return '/test-portal.html';
                        if (r.indexOf('/study-notes') === 0 || r.indexOf('/notes') !== -1) return '/notes.html';
                        if (r.indexOf('/descriptive') === 0 || r.indexOf('descriptive') !== -1) return '/descriptive.html';
                        return '/';
                    };
                }

                function ensureRazorpaySdkLoaded() {
                    if (typeof window.Razorpay === 'function') return Promise.resolve(true);
                    return new Promise(function(resolve) {
                        var injectFresh = function() {
                            var s = document.createElement('script');
                            s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                            s.setAttribute('nonce', '${nonce}');
                            s.onload = function() { resolve(typeof window.Razorpay === 'function'); };
                            s.onerror = function() { resolve(false); };
                            document.head.appendChild(s);
                        };
                        var existing = document.querySelector('script[src*="checkout.razorpay.com/v1/checkout.js"]');
                        if (!existing) return injectFresh();
                        var waited = 0;
                        var timer = setInterval(function() {
                            waited += 100;
                            if (typeof window.Razorpay === 'function') {
                                clearInterval(timer);
                                resolve(true);
                            } else if (waited >= 3000) {
                                clearInterval(timer);
                                injectFresh();
                            }
                        }, 100);
                    });
                }

                function ensureRazorpaySdkLoaded() {
                    if (typeof window.Razorpay === 'function') return Promise.resolve(true);
                    return new Promise(function(resolve) {
                        var injectFresh = function() {
                            var s = document.createElement('script');
                            s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                            s.setAttribute('nonce', '${nonce}');
                            s.onload = function() { resolve(typeof window.Razorpay === 'function'); };
                            s.onerror = function() { resolve(false); };
                            document.head.appendChild(s);
                        };
                        var existing = document.querySelector('script[src*="checkout.razorpay.com/v1/checkout.js"]');
                        if (!existing) return injectFresh();
                        var waited = 0;
                        var timer = setInterval(function() {
                            waited += 100;
                            if (typeof window.Razorpay === 'function') {
                                clearInterval(timer);
                                resolve(true);
                            } else if (waited >= 3000) {
                                clearInterval(timer);
                                injectFresh();
                            }
                        }, 100);
                    });
                }

                function ensureRazorpaySdkLoaded() {
                    if (typeof window.Razorpay === 'function') return Promise.resolve(true);
                    return new Promise(function(resolve) {
                        var injectFresh = function() {
                            var s = document.createElement('script');
                            s.src = 'https://checkout.razorpay.com/v1/checkout.js';
                            s.setAttribute('nonce', '${nonce}');
                            s.onload = function() { resolve(typeof window.Razorpay === 'function'); };
                            s.onerror = function() { resolve(false); };
                            document.head.appendChild(s);
                        };
                        var existing = document.querySelector('script[src*="checkout.razorpay.com/v1/checkout.js"]');
                        if (!existing) return injectFresh();
                        var waited = 0;
                        var timer = setInterval(function() {
                            waited += 100;
                            if (typeof window.Razorpay === 'function') {
                                clearInterval(timer);
                                resolve(true);
                            } else if (waited >= 3000) {
                                clearInterval(timer);
                                injectFresh();
                            }
                        }, 100);
                    });
                }

                // Clean Fetch Intercept (Preserves headers & auth without forcing unwanted screen replays)
                var originalFetch = window.fetch;
                if (originalFetch) {
                    window.fetch = function(input, init) {
                        var url = '';
                        try {
                            url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
                            if (url.indexOf('/api/') !== -1) {
                                init = init || {};
                                init.credentials = 'same-origin';
                                if (init.headers) {
                                    var h = new Headers(init.headers);
                                    var authVal = h.get('Authorization');
                                    if (authVal && authVal.indexOf('|||') === -1) {
                                        h.delete('Authorization');
                                    }
                                    init.headers = h;
                                }
                            }
                        } catch (e) {}
                        var p = originalFetch.call(this, input, init);

                        if (url.indexOf('/api/create-order') !== -1) {
                            return Promise.all([p, ensureRazorpaySdkLoaded()]).then(function(results) {
                                var response = results[0];
                                var sdkReady = results[1];
                                if (!sdkReady) {
                                    return new Response(JSON.stringify({
                                        success: false,
                                        error: 'Payment gateway script was blocked or failed to load. Please disable ad-blocker / tracking prevention or try Chrome.'
                                    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
                                }
                                return response;
                            });
                        }

                        if (url.indexOf('/api/create-order') !== -1) {
                            return Promise.all([p, ensureRazorpaySdkLoaded()]).then(function(results) {
                                var response = results[0];
                                var sdkReady = results[1];
                                if (!sdkReady) {
                                    return new Response(JSON.stringify({
                                        success: false,
                                        error: 'Payment gateway script was blocked or failed to load. Please disable ad-blocker / tracking prevention or try Chrome.'
                                    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
                                }
                                return response;
                            });
                        }

                        if (url.indexOf('/api/create-order') !== -1) {
                            return Promise.all([p, ensureRazorpaySdkLoaded()]).then(function(results) {
                                var response = results[0];
                                var sdkReady = results[1];
                                if (!sdkReady) {
                                    return new Response(JSON.stringify({
                                        success: false,
                                        error: 'Payment gateway script was blocked or failed to load. Please disable ad-blocker / tracking prevention or try Chrome.'
                                    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
                                }
                                return response;
                            });
                        }

                        if (url.indexOf('/api/start-quiz') !== -1 || (url.indexOf('/api/quiz/') !== -1 && url.indexOf('/question/') === -1)) {
                            return p.then(async function(response) {
                                try {
                                    var clone = response.clone();
                                    var data = await clone.json();
                                    if (data && data.alreadyAttempted) {
                                        renderComprehensiveResultScreen(data, true);
                                        return new Promise(function() {}); 
                                    }
                                } catch (e) {}
                                return response;
                            });
                        }

                        if (url.indexOf('/api/submit') !== -1) {
                            p.then(function(response) {
                                return response.clone().json();
                            }).then(function(data) {
                                if (data && data.success && Array.isArray(data.breakdownItems)) {
                                    setTimeout(function() {
                                        renderComprehensiveResultScreen(data, false);
                                    }, 120);
                                }
                            }).catch(function() {});
                        }
                        return p;
                    };
                }

            function escHtml(str) {
                var d = document.createElement('div');
                d.textContent = String(str === null || str === undefined ? '' : str);
                return d.innerHTML;
            }

            function renderComprehensiveResultScreen(data, isSavedAttempt) {
                try {
                    document.body.classList.remove('exam-mode');
                    var pageIntro = document.querySelector('.page-intro');
                    if (pageIntro) pageIntro.style.display = 'none';
                    var resultScreen = document.getElementById('result-screen');
                    if (!resultScreen) {
                        var mainEl = document.querySelector('main.site-main') || document.body;
                        resultScreen = document.createElement('div');
                        resultScreen.id = 'result-screen';
                        resultScreen.className = 'app-screen hidden';
                        mainEl.appendChild(resultScreen);
                    }

                    document.querySelectorAll('.app-screen').forEach(function(scr) {
                        if (scr.id === 'result-screen') scr.classList.remove('hidden');
                        else scr.classList.add('hidden');
                    });

                    var total = Number(data.total) || 0;
                    var correct = Number(data.correct !== undefined ? data.correct : data.score) || 0;
                    var attempted = Number(data.attemptedCount !== undefined ? data.attemptedCount : (total - (Number(data.skipped) || 0)));
                    var incorrect = Number(data.incorrect !== undefined ? data.incorrect : Math.max(0, attempted - correct));
                    var skipped = Number(data.skipped !== undefined ? data.skipped : Math.max(0, total - attempted));

                    var scorePct = data.scorePercentage !== undefined
                        ? Number(data.scorePercentage).toFixed(1)
                        : (total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0');
                    var accuracyPct = data.accuracyPercentage !== undefined
                        ? Number(data.accuracyPercentage).toFixed(1)
                        : (attempted > 0 ? ((correct / attempted) * 100).toFixed(1) : '0.0');
                    var percentile = data.percentile !== undefined ? Number(data.percentile).toFixed(1) : '100.0';
                    var dateBanner = isSavedAttempt && data.timestamp
                        ? '<div style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:bold;margin-bottom:12px;">📌 Completed Attempt Record (' + new Date(data.timestamp).toLocaleDateString('en-IN') + ')</div>'
                        : '<div style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:bold;margin-bottom:12px;">✅ Assessment Submitted Successfully</div>';

                    var leaderboardRows = '';
                    if (Array.isArray(data.leaderboard) && data.leaderboard.length > 0) {
                        leaderboardRows = data.leaderboard.map(function(row, idx) {
                            var rankBadge = idx === 0 ? '🥇 1' : (idx === 1 ? '🥈 2' : (idx === 2 ? '🥉 3' : (idx + 1)));
                            var rTotal = Number(row.total) || total || 1;
                            var rScorePct = row.scorePercentage !== undefined ? Number(row.scorePercentage).toFixed(1) + '%' : ((Number(row.score) / rTotal) * 100).toFixed(1) + '%';
                            var rAccPct = row.accuracyPercentage !== undefined ? Number(row.accuracyPercentage).toFixed(1) + '%' : '-';
                            return '<tr style="border-bottom:1px solid #e2e8f0;">' +
                                '<td style="padding:10px 12px;font-weight:bold;color:#1e3a8a;">' + rankBadge + '</td>' +
                                '<td style="padding:10px 12px;font-weight:600;color:#0f172a;">' + escHtml(row.name) + '</td>' +
                                '<td style="padding:10px 12px;font-weight:bold;color:#2563eb;">' + row.score + ' / ' + rTotal + '</td>' +
                                '<td style="padding:10px 12px;color:#059669;font-weight:600;">' + rScorePct + '</td>' +
                                '<td style="padding:10px 12px;color:#7c3aed;font-weight:600;">' + rAccPct + '</td>' +
                            '</tr>';
                        }).join('');
                    } else {
                        leaderboardRows = '<tr><td colspan="5" style="padding:14px;text-align:center;color:#64748b;">First submission recorded for this test!</td></tr>';
                    }

                    var breakdownRows = '';
                    if (Array.isArray(data.breakdownItems)) {
                        breakdownRows = data.breakdownItems.map(function(item) {
                            var statusColor = item.status === 'Correct' ? '#10b981' : (item.status === 'Incorrect' ? '#ef4444' : '#eab308');
                            var statusBg = item.status === 'Correct' ? '#dcfce7' : (item.status === 'Incorrect' ? '#fee2e2' : '#fef9c3');
                            var selColor = item.status === 'Correct' ? '#15803d' : (item.status === 'Incorrect' ? '#991b1b' : '#64748b');
                            var expHtml = item.explanation
                                ? '<div style="margin-top:8px;font-size:13px;color:#15803d;background:#f0fdf4;padding:10px;border-radius:6px;border-left:4px solid #16a34a;"><strong>Explanation:</strong> ' + escHtml(item.explanation) + '</div>'
                                : '';

                            return '<tr style="border-bottom:1px solid #e2e8f0;">' +
                                '<td style="padding:14px;vertical-align:top;font-weight:bold;color:#475569;">' + item.qNum + '</td>' +
                                '<td style="padding:14px;vertical-align:top;"><div style="color:#1e293b;font-weight:500;font-size:15px;">' + escHtml(item.question) + '</div>' + expHtml + '</td>' +
                                '<td style="padding:14px;vertical-align:top;color:' + selColor + ';font-weight:600;">' + escHtml(item.selectedText) + '</td>' +
                                '<td style="padding:14px;vertical-align:top;color:#15803d;font-weight:600;">' + escHtml(item.correctText) + '</td>' +
                                '<td style="padding:14px;vertical-align:top;text-align:center;"><span style="background:' + statusBg + ';color:' + statusColor + ';padding:5px 10px;border-radius:6px;font-weight:bold;font-size:12px;">' + escHtml(item.status) + '</span></td>' +
                            '</tr>';
                        }).join('');
                    }

                    resultScreen.innerHTML =
                        '<div style="max-width:920px;margin:0 auto;padding:20px;font-family:sans-serif;background:#fff;border-radius:12px;text-align:left;">' +
                            '<div class="print-only-header" style="display:none;text-align:center;margin-bottom:20px;">' +
                                '<h1 style="color:#1e3a8a;margin:0;">Pioneers Prep — Official Performance Report</h1>' +
                                '<p style="color:#475569;margin-top:4px;">' + escHtml(data.chapterTitle || 'Mock Assessment') + '</p>' +
                            '</div>' +
                            '<div class="no-print" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:22px;">' +
                                '<button id="btn-return-home" type="button" style="padding:10px 18px;background:#1e293b;color:#ffffff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">&larr; Return to Homepage</button>' +
                                '<button id="btn-print-report" type="button" style="padding:10px 20px;background:#2563eb;color:#ffffff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;box-shadow:0 4px 6px rgba(37,99,235,0.2);">🖨️ Print / Save as PDF</button>' +
                            '</div>' +
                            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:26px;text-align:center;margin-bottom:28px;">' +
                                dateBanner +
                                '<h2 style="margin:0 0 6px 0;color:#1e293b;font-size:22px;">' + escHtml(data.chapterTitle || 'Final Scorecard') + '</h2>' +
                                '<div style="font-size:50px;font-weight:800;color:#2563eb;line-height:1.1;margin:8px 0;">' + scorePct + '%</div>' +
                                '<div style="font-size:17px;font-weight:bold;color:#0f172a;margin-bottom:18px;">Score: ' + correct + ' / ' + total + '</div>' +
                                '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;max-width:680px;margin:0 auto 18px auto;">' +
                                    '<div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;padding:12px;"><div style="font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;">Score Percentage</div><div style="font-size:22px;font-weight:800;color:#2563eb;margin-top:4px;">' + scorePct + '%</div></div>' +
                                    '<div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;padding:12px;"><div style="font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;">Accuracy</div><div style="font-size:22px;font-weight:800;color:#059669;margin-top:4px;">' + accuracyPct + '%</div></div>' +
                                    '<div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;padding:12px;"><div style="font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;">Percentile</div><div style="font-size:22px;font-weight:800;color:#7c3aed;margin-top:4px;">' + percentile + '%ile</div></div>' +
                                '</div>' +
                                '<div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">' +
                                    '<span style="background:#dcfce7;color:#166534;padding:7px 14px;border-radius:20px;font-weight:bold;font-size:14px;">✅ Correct: ' + correct + '</span>' +
                                    '<span style="background:#fee2e2;color:#991b1b;padding:7px 14px;border-radius:20px;font-weight:bold;font-size:14px;">❌ Incorrect: ' + incorrect + '</span>' +
                                    '<span style="background:#fef9c3;color:#854d0e;padding:7px 14px;border-radius:20px;font-weight:bold;font-size:14px;">⚠️ Skipped: ' + skipped + '</span>' +
                                '</div>' +
                            '</div>' +
                            '<h3 style="color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin-bottom:12px;">🏆 Top Performers Leaderboard</h3>' +
                            '<div style="overflow-x:auto;margin-bottom:30px;">' +
                                '<table style="width:100%;border-collapse:collapse;font-size:14px;text-align:left;">' +
                                    '<tr style="background:#1e3a8a;color:white;">' +
                                        '<th style="padding:10px 12px;border-radius:6px 0 0 0;">Rank</th>' +
                                        '<th style="padding:10px 12px;">Student Name</th>' +
                                        '<th style="padding:10px 12px;">Score</th>' +
                                        '<th style="padding:10px 12px;">Score %</th>' +
                                        '<th style="padding:10px 12px;border-radius:0 6px 0 0;">Accuracy %</th>' +
                                    '</tr>' +
                                    leaderboardRows +
                                '</table>' +
                            '</div>' +
                            '<h3 style="color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin-bottom:12px;">📋 Detailed Question-by-Question Breakdown</h3>' +
                            '<div style="overflow-x:auto;">' +
                                '<table style="width:100%;border-collapse:collapse;font-size:14px;text-align:left;">' +
                                    '<tr style="background:#1e293b;color:white;">' +
                                        '<th style="padding:12px;width:6%;">#</th>' +
                                        '<th style="padding:12px;width:44%;">Question & Explanation</th>' +
                                        '<th style="padding:12px;width:20%;">Your Answer</th>' +
                                        '<th style="padding:12px;width:20%;">Correct Answer</th>' +
                                        '<th style="padding:12px;width:10%;text-align:center;">Status</th>' +
                                    '</tr>' +
                                    breakdownRows +
                                '</table>' +
                            '</div>' +
                        '</div>' +
                        '<style>' +
                            '@media print {' +
                                '.site-header, .site-footer, .no-print { display: none !important; }' +
                                '.print-only-header { display: block !important; }' +
                                'body, main, #result-screen { background: #fff !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; }' +
                                'table { page-break-inside: auto; }' +
                                'tr { page-break-inside: avoid; page-break-after: auto; }' +
                                '* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }' +
                            '}' +
                        '</style>';

                    var homeBtn = document.getElementById('btn-return-home');
                    if (homeBtn) {
                        homeBtn.addEventListener('click', function() {
                            try {
                                sessionStorage.removeItem('pioneers_prep_state');
                            } catch (e) {}
                            window.location.href = '/';
                        });
                    }

                    var printBtn = document.getElementById('btn-print-report');
                    if (printBtn) {
                        printBtn.addEventListener('click', function() {
                            window.print();
                        });
                    }

                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } catch (e) {}
            }

            (function initTamperProofWatermark() {
                var wmEl = null;
                var posTick = 0;

                function getWatermarkLabel() {
                    var fn = (localStorage.getItem('pp_fname') || '').trim();
                    var ln = (localStorage.getItem('pp_lname') || '').trim();
                    var em = (localStorage.getItem('pp_email') || '').trim();
                    if (!em && !fn) return '';
                    return (fn + ' ' + ln).trim() + ' • ' + em + ' • Pioneers Prep';
                }

                function getTargetStage() {
                    if (baseRoute === '/live-room' || baseRoute === '/live-test') {
                        return document.getElementById('video-container') ||
                               document.getElementById('live-stage') ||
                               document.querySelector('.live-container') ||
                               document.body;
                    }
                    var quizScr = document.getElementById('quiz-screen');
                    if (quizScr && !quizScr.classList.contains('hidden')) {
                        return quizScr;
                    }
                    return null;
                }

                function enforceWatermark() {
                    try {
                        var stage = getTargetStage();
                        var label = getWatermarkLabel();
                        if (!stage || !label) {
                            if (wmEl && wmEl.parentNode) wmEl.parentNode.removeChild(wmEl);
                            return;
                        }

                        if (stage !== document.body && window.getComputedStyle(stage).position === 'static') {
                            stage.style.position = 'relative';
                        }

                        if (!wmEl || !stage.contains(wmEl)) {
                            if (wmEl && wmEl.parentNode) wmEl.parentNode.removeChild(wmEl);
                            wmEl = document.createElement('div');
                            wmEl.setAttribute('data-pp-security-wm', '1');
                            stage.appendChild(wmEl);
                        }

                        wmEl.textContent = label;
                        var positions = [
                            { top: '18%', left: '12%' },
                            { top: '68%', left: '48%' },
                            { top: '32%', left: '52%' },
                            { top: '74%', left: '15%' },
                            { top: '45%', left: '28%' }
                        ];
                        var pos = positions[posTick % positions.length];
                        posTick++;

                        wmEl.style.cssText = [
                            'position:' + (stage === document.body ? 'fixed' : 'absolute') + ' !important',
                            'top:' + pos.top + ' !important',
                            'left:' + pos.left + ' !important',
                            'pointer-events:none !important',
                            'z-index:2147483640 !important',
                            'opacity:0.20 !important',
                            'color:#64748b !important',
                            'font-family:monospace,sans-serif !important',
                            'font-size:13px !important',
                            'font-weight:700 !important',
                            'transform:rotate(-14deg) !important',
                            'user-select:none !important',
                            '-webkit-user-select:none !important',
                            'white-space:nowrap !important',
                            'display:block !important',
                            'visibility:visible !important'
                        ].join(';');
                    } catch (e) {}
                }

                setInterval(enforceWatermark, 3500);
                document.addEventListener('DOMContentLoaded', function() {
                    setTimeout(enforceWatermark, 600);
                });
            })();

                // Global Event Delegation for static data-actions (Home, Back, Select Class buttons)
                document.addEventListener('click', function(e) {
                    var target = e.target ? e.target.closest('[data-action]') : null;
                    if (!target) return;

                    var action = target.getAttribute('data-action');
                    var arg = target.getAttribute('data-arg');
                    if (action) {
                        if (action === 'clear-session') {
                            try { sessionStorage.removeItem('pioneers_prep_state'); } catch (err) {}
                        } else if (action === 'select-class' && typeof selectClass === 'function') {
                            selectClass(arg);
                        } else if (action === 'select-subject' && typeof selectSubject === 'function') {
                            selectSubject(arg);
                        } else if (action === 'select-notes-class' && typeof selectNotesClass === 'function') {
                            selectNotesClass(arg);
                        } else if (action === 'select-descriptive-class' && typeof selectDescriptiveClass === 'function') {
                            selectDescriptiveClass(arg);
                        } else if (action === 'go-back' && typeof goBack === 'function') {
                            e.preventDefault();
                            goBack();
                        } else if (action === 'go-home' && typeof goHome === 'function') {
                            e.preventDefault();
                            goHome();
                        } else if (action === 'start-quiz' && typeof startQuiz === 'function') {
                            startQuiz();
                        } else if (action === 'submit-quiz' && typeof submitQuiz === 'function') {
                            submitQuiz(false);
                        } else if (action === 'prev-question' && typeof prevQuestion === 'function') {
                            prevQuestion();
                        } else if (action === 'clear-response' && typeof clearResponse === 'function') {
                            clearResponse();
                        } else if (action === 'next-question' && typeof nextQuestion === 'function') {
                            nextQuestion();
                        }
                    }
                }, true);

                window.addEventListener('DOMContentLoaded', function() {
                    var backEventTriggered = false;
                    var screenSlugMap = {
                        'home-dashboard': '',
                        'subject-screen': '/select-subject',
                        'subject-select-screen': '/select-subject',
                        'ix-x-chapter-screen': '/select-chapter',
                        'unit-screen': '/select-unit',
                        'neet-unit-screen': '/select-unit',
                        'chapter-screen': '/select-chapter',
                        'neet-chapter-screen': '/select-chapter',
                        'topic-screen': '/select-topic',
                        'neet-topic-screen': '/select-topic',
                        'user-info-screen': '/candidate-verification',
                        'name-screen': '/candidate-verification',
                        'quiz-screen': '/live-assessment',
                        'result-screen': '/scorecard',
                        'notes-display-screen': '/study-materials',
                        'notes-subject-screen': '/select-subject',
                        'notes-list-screen': '/study-materials',
                        'descriptive-subject-screen': '/select-subject',
                        'descriptive-list-screen': '/question-papers'
                    };

                    function getCleanUrlForScreen(screenId) {
                        if (baseRoute === '/') return '/';
                        var slug = screenSlugMap[screenId];
                        if (slug === undefined) {
                            slug = screenId ? '/' + screenId.replace(/-screen$/i, '') : '';
                        }
                        return baseRoute + slug;
                    }

                    var observer = new MutationObserver(function(mutations) {
                        mutations.forEach(function(m) {
                            var el = m.target;
                            if (el.classList.contains('app-screen') && !el.classList.contains('hidden')) {
                                var introEl = document.querySelector('.page-intro');
                                if (introEl && baseRoute !== '/') {
                                    introEl.style.display = (el.id === 'result-screen' || el.id === 'quiz-screen') ? 'none' : '';
                                }
                                var targetUrl = getCleanUrlForScreen(el.id) + window.location.search;
                                if (window.location.pathname === getCleanUrlForScreen(el.id)) {
                                    history.replaceState({ app: 'pioneers', screen: el.id }, document.title, targetUrl);
                                } else if (backEventTriggered) {
                                    backEventTriggered = false;
                                    history.replaceState({ app: 'pioneers', screen: el.id }, document.title, targetUrl);
                                } else if (el.id !== 'home-dashboard' && el.id !== 'result-screen') {
                                    history.pushState({ app: 'pioneers', screen: el.id }, document.title, targetUrl);
                                } else {
                                    history.replaceState({ app: 'pioneers', screen: el.id }, document.title, targetUrl);
                                }
                            }
                        });
                    });

                    document.querySelectorAll('.app-screen').forEach(function(s) {
                        observer.observe(s, { attributes: true, attributeFilter: ['class'] });
                    });

                    window.addEventListener('popstate', function(e) {
                        var activeScreen = document.querySelector('.app-screen:not(.hidden)');
                        if (activeScreen && (activeScreen.id === 'quiz-screen' || activeScreen.id === 'result-screen')) {
                            history.pushState({ app: 'pioneers', screen: activeScreen.id }, document.title, getCleanUrlForScreen(activeScreen.id));
                            alert("Please use the 'Submit Quiz' button to exit.");
                            return;
                        }
                        if (activeScreen && activeScreen.id !== 'home-dashboard') {
                            var backBtn = activeScreen.querySelector('.back-btn');
                            if (backBtn) {
                                backEventTriggered = true;
                                backBtn.click();
                            }
                        }
                    });

                    document.addEventListener('click', function(e) {
                        if (e.target && e.target.classList && e.target.classList.contains('back-btn')) {
                            backEventTriggered = true;
                        }
                    }, true);
                });

                // ============================================================
                // INSTANT PWA DOWNLOAD BUTTON & FALLBACK INSTALL MODAL
                // ============================================================
                (function initPwaDownloadButton() {
                    var deferredPrompt = null;

                    function isRunningStandalone() {
                        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                               window.navigator.standalone === true;
                    }

                    function updateInstallButtonVisibility() {
                        var btn = document.getElementById('pwa-download-btn');
                        if (!btn) return;
                        if (isRunningStandalone()) {
                            btn.style.display = 'none';
                        }
                    }

                    if ('serviceWorker' in navigator) {
                        window.addEventListener('load', function() {
                            navigator.serviceWorker.register('/sw.js').catch(function() {});
                        });
                    }

                    window.addEventListener('beforeinstallprompt', function(e) {
                        e.preventDefault();
                        deferredPrompt = e;
                        updateInstallButtonVisibility();
                    });

                    window.addEventListener('appinstalled', function() {
                        deferredPrompt = null;
                        var btn = document.getElementById('pwa-download-btn');
                        if (btn) btn.style.display = 'none';
                        var modal = document.getElementById('pwa-install-helper-modal');
                        if (modal) modal.remove();
                    });

                    function showInstantInstallGuide() {
                        var existing = document.getElementById('pwa-install-helper-modal');
                        if (existing) existing.remove();

                        var ua = navigator.userAgent || '';
                        var isIos = /iphone|ipad|ipod/i.test(ua);
                        var stepsHtml = isIos
                            ? '<ol style="text-align:left;color:#334155;font-size:14px;line-height:1.7;margin:12px 0;padding-left:20px;">' +
                                '<li>Tap the <strong>Share</strong> button (<strong>⬆️</strong>) at the bottom of Safari.</li>' +
                                '<li>Scroll down and tap <strong>"Add to Home Screen"</strong>.</li>' +
                                '<li>Tap <strong>Add</strong> in the top-right corner.</li>' +
                              '</ol>'
                            : '<ol style="text-align:left;color:#334155;font-size:14px;line-height:1.7;margin:12px 0;padding-left:20px;">' +
                                '<li>Tap the browser menu icon (<strong>⋮</strong> or <strong>⋯</strong>) in the corner of your screen (or the install icon in the address bar).</li>' +
                                '<li>Select <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>.</li>' +
                                '<li>Tap <strong>Install</strong> to place Pioneers Prep on your home screen.</li>' +
                              '</ol>';

                        var overlay = document.createElement('div');
                        overlay.id = 'pwa-install-helper-modal';
                        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:2147483645;display:flex;align-items:center;justify-content:center;padding:16px;font-family:sans-serif;';
                        overlay.innerHTML =
                            '<div style="background:#ffffff;max-width:400px;width:100%;border-radius:12px;padding:22px;box-shadow:0 20px 35px rgba(0,0,0,0.25);text-align:center;">' +
                                '<img src="/favicon.png?v=${APP_VERSION}" alt="Pioneers Prep" style="width:56px;height:56px;border-radius:12px;margin-bottom:10px;object-fit:contain;">' +
                                '<h3 style="margin:0 0 6px 0;color:#1e293b;font-size:18px;">Install Pioneers Prep App</h3>' +
                                '<p style="margin:0 0 10px 0;color:#64748b;font-size:13px;">Install the official app for full-screen mock tests and live classes:</p>' +
                                stepsHtml +
                                '<button id="pwa-modal-close-btn" type="button" style="margin-top:10px;width:100%;padding:10px;background:#2563eb;color:#ffffff;border:none;border-radius:8px;font-weight:bold;font-size:14px;cursor:pointer;">Got It</button>' +
                            '</div>';

                        document.body.appendChild(overlay);
                        overlay.addEventListener('click', function(ev) {
                            if (ev.target === overlay || ev.target.id === 'pwa-modal-close-btn') {
                                overlay.remove();
                            }
                        });
                    }

                    document.addEventListener('click', async function(e) {
                        var btn = e.target ? e.target.closest('#pwa-download-btn') : null;
                        if (!btn) return;
                        e.preventDefault();

                        if (deferredPrompt) {
                            try {
                                deferredPrompt.prompt();
                                var choice = await deferredPrompt.userChoice;
                                if (choice && choice.outcome === 'accepted') {
                                    btn.style.display = 'none';
                                }
                            } catch (err) {}
                            deferredPrompt = null;
                        } else {
                            showInstantInstallGuide();
                        }
                    });

                    document.addEventListener('DOMContentLoaded', updateInstallButtonVisibility);
                    updateInstallButtonVisibility();
                })();

                // ============================================================
                // UNIVERSAL GOOGLE SIGN-IN (ANDROID CHROME INTENT, iOS ZERO-PASSWORD & 30-DAY SESSION)
                // ============================================================
                (function initGoogleAccountSignIn() {
                    var GOOGLE_CLIENT_ID = '${process.env.GOOGLE_CLIENT_ID || ''}';
                    var googleTokenClient = null;
                    var googleIdInitialized = false;
                    var gsiLoadPromise = null;
                    var activePollTimer = null;

                    function isIosDevice() {
                        var ua = (navigator.userAgent || '').toLowerCase();
                        return ua.indexOf('iphone') !== -1 || ua.indexOf('ipad') !== -1 || ua.indexOf('ipod') !== -1 ||
                               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                    }

                    function isAndroidDevice() {
                        var ua = navigator.userAgent || '';
                        return ua.indexOf('Android') !== -1;
                    }

                    function isAndroidNonChromeBrowser() {
                        var ua = navigator.userAgent || '';
                        if (ua.indexOf('Android') === -1) return false;
                        var altTokens = ['SamsungBrowser', 'EdgA', 'Firefox', 'FxiOS', 'OPR', 'Opera', 'MiuiBrowser', 'HeyTapBrowser', 'VivoBrowser', 'UCBrowser', 'Brave', 'wv', 'FBAN', 'FBAV', 'Instagram', 'WhatsApp'];
                        for (var i = 0; i < altTokens.length; i++) {
                            if (ua.indexOf(altTokens[i]) !== -1) return true;
                        }
                        return false;
                    }

                    function isUserSignedIn() {
                        return Boolean(localStorage.getItem('pp_id_token') && localStorage.getItem('pp_auth_provider') === 'google_v2');
                    }

                    function completePortalLogin(data) {
                        if (activePollTimer) {
                            clearInterval(activePollTimer);
                            activePollTimer = null;
                        }
                        if (!data || !data.success || !data.token) {
                            var statusEl = document.getElementById('pp-google-auth-status');
                            if (statusEl) {
                                statusEl.style.color = '#dc2626';
                                statusEl.textContent = (data && data.error) ? data.error : 'Sign-In failed. Please try again.';
                            } else {
                                alert((data && data.error) ? data.error : 'Google Sign-In failed. Please try again.');
                            }
                            return;
                        }
                        localStorage.setItem('pp_auth_provider', 'google_v2');
                        localStorage.setItem('pp_id_token', data.token);
                        localStorage.setItem('pp_fname', data.firstName || '');
                        localStorage.setItem('pp_lname', data.lastName || '');
                        localStorage.setItem('pp_email', data.email || '');
                        sessionStorage.removeItem('force_login_open');
                        sessionStorage.removeItem('pp_open_google_auth');

                        var modal = document.getElementById('pp-universal-auth-modal');
                        if (modal) modal.remove();

                        var savedTarget = sessionStorage.getItem('pp_post_login_redirect');
                        sessionStorage.removeItem('pp_post_login_redirect');
                        if (savedTarget && savedTarget.indexOf('/') === 0 && savedTarget !== window.location.pathname) {
                            window.location.replace(savedTarget);
                        } else {
                            window.location.reload();
                        }
                    }

                    function verifyGoogleWithServer(payload) {
                        var statusEl = document.getElementById('pp-google-auth-status');
                        if (statusEl) {
                            statusEl.style.color = '#2563eb';
                            statusEl.textContent = 'Verifying your Google account...';
                        }
                        fetch('/api/auth/google', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        })
                        .then(function(r) { return r.json(); })
                        .then(completePortalLogin)
                        .catch(function() {
                            if (statusEl) {
                                statusEl.style.color = '#dc2626';
                                statusEl.textContent = 'Network error while verifying account. Please try again.';
                            } else {
                                alert('Network error while verifying Google account.');
                            }
                        });
                    }

                    function buildGoogleOAuthUrl() {
                        if (!GOOGLE_CLIENT_ID) return '';
                        var csrfState = '';
                        try {
                            var randArr = new Uint32Array(4);
                            window.crypto.getRandomValues(randArr);
                            csrfState = Array.from(randArr, function(n) { return n.toString(16); }).join('');
                            sessionStorage.setItem('pp_oauth_csrf_state', csrfState);
                            if (!sessionStorage.getItem('pp_post_login_redirect')) {
                                sessionStorage.setItem('pp_post_login_redirect', window.location.pathname + window.location.search);
                            }
                        } catch (e) {}
                        var redirectUri = window.location.origin;
                        return 'https://accounts.google.com/o/oauth2/v2/auth' +
                            '?client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID) +
                            '&redirect_uri=' + encodeURIComponent(redirectUri) +
                            '&response_type=token' +
                            '&scope=' + encodeURIComponent('openid email profile') +
                            '&state=' + encodeURIComponent(csrfState) +
                            '&prompt=select_account' +
                            '&include_granted_scopes=true';
                    }

                    function redirectToGoogleOAuthPage() {
                        var oauthUrl = buildGoogleOAuthUrl();
                        if (!oauthUrl) {
                            alert('Google Sign-In is not configured yet (Missing GOOGLE_CLIENT_ID).');
                            return;
                        }
                        window.location.href = oauthUrl;
                    }

                    // 1. Handle OAuth Redirect Hash (#access_token=...) OR Android Chrome Intent Arrival (?auto_google_login=1)
                    (function handleStartupAuthTriggers() {
                        try {
                            var hash = window.location.hash || '';
                            if (hash.indexOf('access_token=') !== -1) {
                                var cleanHash = hash.charAt(0) === '#' ? hash.substring(1) : hash;
                                var params = new URLSearchParams(cleanHash);
                                var accessToken = params.get('access_token');
                                var returnedState = params.get('state');
                                var expectedState = sessionStorage.getItem('pp_oauth_csrf_state');
                                sessionStorage.removeItem('pp_oauth_csrf_state');
                                history.replaceState(null, document.title, window.location.pathname + window.location.search);

                                if (accessToken && (!expectedState || returnedState === expectedState)) {
                                    window.addEventListener('DOMContentLoaded', function() {
                                        verifyGoogleWithServer({ accessToken: accessToken });
                                    });
                                }
                                return;
                            }

                            var searchParams = new URLSearchParams(window.location.search);
                            if (searchParams.get('auto_google_login') === '1') {
                                var nextRoute = searchParams.get('next') || '';
                                if (nextRoute && nextRoute.indexOf('/') === 0) {
                                    sessionStorage.setItem('pp_post_login_redirect', nextRoute);
                                }
                                searchParams.delete('auto_google_login');
                                searchParams.delete('next');
                                var cleanSearch = searchParams.toString();
                                history.replaceState(null, document.title, window.location.pathname + (cleanSearch ? '?' + cleanSearch : ''));

                                window.addEventListener('DOMContentLoaded', function() {
                                    // If Chrome is ALREADY signed in, skip popup and go straight to destination
                                    if (isUserSignedIn()) {
                                        var target = sessionStorage.getItem('pp_post_login_redirect');
                                        sessionStorage.removeItem('pp_post_login_redirect');
                                        if (target && target.indexOf('/') === 0 && target !== window.location.pathname) {
                                            window.location.replace(target);
                                        }
                                        return;
                                    }
                                    openUniversalSignInModal(true);
                                });
                            }
                        } catch (e) {}
                    })();

                    function waitForGoogleLibrary(maxWaitMs) {
                        var limit = Math.ceil((maxWaitMs || 2500) / 100);
                        if (window.google && window.google.accounts) return Promise.resolve(true);
                        if (gsiLoadPromise) return gsiLoadPromise;

                        gsiLoadPromise = new Promise(function(resolve) {
                            var attempts = 0;
                            var timer = setInterval(function() {
                                attempts++;
                                if (window.google && window.google.accounts) {
                                    clearInterval(timer);
                                    gsiLoadPromise = null;
                                    resolve(true);
                                } else if (attempts >= limit) {
                                    clearInterval(timer);
                                    gsiLoadPromise = null;
                                    resolve(false);
                                }
                            }, 100);
                        });
                        return gsiLoadPromise;
                    }

                    function setupGoogleClients() {
                        if (!GOOGLE_CLIENT_ID || !window.google || !window.google.accounts) return false;

                        if (!googleIdInitialized && window.google.accounts.id) {
                            window.google.accounts.id.initialize({
                                client_id: GOOGLE_CLIENT_ID,
                                callback: function(response) {
                                    if (response && response.credential) {
                                        verifyGoogleWithServer({ credential: response.credential });
                                    }
                                },
                                auto_select: false,
                                cancel_on_tap_outside: false,
                                itp_support: true,
                                use_fedcm_for_prompt: true
                            });
                            googleIdInitialized = true;
                        }

                        if (!googleTokenClient && window.google.accounts.oauth2) {
                            googleTokenClient = window.google.accounts.oauth2.initTokenClient({
                                client_id: GOOGLE_CLIENT_ID,
                                scope: 'openid email profile',
                                prompt: 'select_account',
                                callback: function(tokenResponse) {
                                    if (tokenResponse && tokenResponse.access_token) {
                                        verifyGoogleWithServer({ accessToken: tokenResponse.access_token });
                                    }
                                },
                                error_callback: function() {
                                    redirectToGoogleOAuthPage();
                                }
                            });
                        }
                        return true;
                    }

                    // Restored Android Chrome / Google Play Services Account Picker Method
                    function triggerDeviceAccountSelection() {
                        var statusEl = document.getElementById('pp-google-auth-status');
                        if (isAndroidNonChromeBrowser()) {
                            var savedNext = sessionStorage.getItem('pp_post_login_redirect') || (window.location.pathname + window.location.search);
                            var sep = window.location.search ? '&' : '?';
                            var targetPath = window.location.host + window.location.pathname + window.location.search + sep + 'auto_google_login=1&next=' + encodeURIComponent(savedNext);
                            var fallback = encodeURIComponent(buildGoogleOAuthUrl() || window.location.href);
                            window.location.href = 'intent://' + targetPath + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + fallback + ';end';
                            return;
                        }
                        if (!isIosDevice() && window.google && window.google.accounts && setupGoogleClients() && googleTokenClient) {
                            if (statusEl) statusEl.textContent = '';
                            try {
                                googleTokenClient.requestAccessToken({ prompt: 'select_account' });
                                return;
                            } catch (e) {}
                        }
                        if (statusEl) {
                            statusEl.style.color = '#2563eb';
                            statusEl.textContent = 'Opening Account Chooser...';
                        }
                        redirectToGoogleOAuthPage();
                    }

                    function startMagicLinkPolling(pollId) {
                        if (activePollTimer) clearInterval(activePollTimer);
                        activePollTimer = setInterval(function() {
                            fetch('/api/auth/mail-app/poll?pollId=' + encodeURIComponent(pollId))
                                .then(function(r) { return r.json(); })
                                .then(function(d) {
                                    if (d && d.approved && d.token) {
                                        clearInterval(activePollTimer);
                                        activePollTimer = null;
                                        completePortalLogin(d);
                                    }
                                })
                                .catch(function() {});
                        }, 2000);
                    }

                    function openUniversalSignInModal(autoTriggerChooser) {
                        killLegacyOtpModal();

                        // Never show the sign-in popup if this browser is already signed in
                        if (isUserSignedIn()) {
                            sessionStorage.removeItem('pp_open_google_auth');
                            sessionStorage.removeItem('force_login_open');
                            var existingModal = document.getElementById('pp-universal-auth-modal');
                            if (existingModal) existingModal.remove();
                            return;
                        }

                        var existing = document.getElementById('pp-universal-auth-modal');
                        if (!existing) {
                            var passwordlessMailHtml =
                                '<button id="pp-toggle-mail-fallback" type="button" style="width:100%;margin-top:8px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;color:#1e293b;font-size:14px;font-weight:700;cursor:pointer;">Enter your email</button>' +
                                '<div id="pp-mail-fallback-box" style="display:block;margin-top:10px;text-align:left;background:#f8fafc;padding:14px;border-radius:12px;border:1px solid #cbd5e1;">' +
                                    '<div style="font-size:12px;font-weight:700;color:#1e3a8a;margin-bottom:8px;text-transform:uppercase;">⚡ Instant Passwordless Sign-In</div>' +
                                    '<input id="pp-mail-email-input" type="email" autocomplete="email" inputmode="email" placeholder="Enter your email address" style="width:100%;padding:11px 12px;border:1px solid #94a3b8;border-radius:8px;font-size:15px;box-sizing:border-box;margin-bottom:8px;background:#fff;">' +
                                    '<input id="pp-mail-code-input" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="6" placeholder="Or enter 6-digit code" style="display:none;width:100%;padding:10px 12px;border:2px solid #2563eb;border-radius:8px;font-size:15px;font-weight:bold;text-align:center;letter-spacing:2px;box-sizing:border-box;margin-bottom:8px;background:#fff;">' +
                                    '<button id="pp-mail-submit-btn" type="button" style="width:100%;padding:12px 14px;background:#2563eb;color:#ffffff;border:none;border-radius:9px;font-weight:700;font-size:14.5px;cursor:pointer;box-shadow:0 4px 10px rgba(37,99,235,0.25);">Sign In via OTP</button>' +
                                '</div>';

                            var bodyLayoutHtml =
                                '<div id="pp-google-rendered-btn" style="display:flex;justify-content:center;margin-bottom:6px;"></div>' +
                                passwordlessMailHtml;

                            var overlay = document.createElement('div');
                            overlay.id = 'pp-universal-auth-modal';
                            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.75);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;backdrop-filter:blur(3px);';
                            overlay.innerHTML =
                                '<div style="background:#ffffff;max-width:410px;width:100%;border-radius:16px;padding:26px 22px;box-shadow:0 25px 50px rgba(0,0,0,0.35);text-align:center;position:relative;border:1px solid #e2e8f0;">' +
                                    '<button id="pp-auth-close-btn" type="button" aria-label="Close" style="position:absolute;top:12px;right:14px;background:#f1f5f9;border:none;width:32px;height:32px;border-radius:50%;font-size:16px;font-weight:bold;color:#475569;cursor:pointer;">✕</button>' +
                                    '<img src="/favicon.png?v=${APP_VERSION}" alt="Pioneers Prep" style="width:50px;height:50px;border-radius:12px;margin-bottom:8px;object-fit:contain;">' +
                                    '<h3 style="margin:0 0 6px 0;color:#0f172a;font-size:20px;font-weight:800;">Sign in to Pioneers Prep</h3>' +
                                    '<p style="margin:0 0 14px 0;color:#475569;font-size:13.5px;line-height:1.45;">Sign in to access mock tests, study notes, and live classes:</p>' +
                                    bodyLayoutHtml +
                                    '<div id="pp-google-auth-status" style="margin-top:10px;font-size:13px;font-weight:600;color:#2563eb;min-height:18px;"></div>' +
                                '</div>';

                            document.body.appendChild(overlay);

                            overlay.addEventListener('click', function(ev) {
                                if (ev.target === overlay || ev.target.id === 'pp-auth-close-btn') {
                                    if (activePollTimer) {
                                        clearInterval(activePollTimer);
                                        activePollTimer = null;
                                    }
                                    overlay.remove();
                                }
                            });

                            var toggleMailBtn = document.getElementById('pp-toggle-mail-fallback');
                            var mailBox = document.getElementById('pp-mail-fallback-box');
                            var emailInp = document.getElementById('pp-mail-email-input');
                            if (toggleMailBtn && mailBox) {
                                toggleMailBtn.addEventListener('click', function() {
                                    mailBox.style.display = 'block';
                                    if (emailInp) emailInp.focus();
                                });
                            }

                            var mailStep = 'send';
                            var mailBtn = document.getElementById('pp-mail-submit-btn');
                            var codeInp = document.getElementById('pp-mail-code-input');
                            var statusEl = document.getElementById('pp-google-auth-status');

                            if (mailBtn) {
                                mailBtn.addEventListener('click', function() {
                                    var emailVal = (emailInp.value || '').trim().toLowerCase();
                                    if (!emailVal || emailVal.indexOf('@') === -1) {
                                        statusEl.style.color = '#dc2626';
                                        statusEl.textContent = 'Please enter your email address above.';
                                        return;
                                    }
                                    if (mailStep === 'send') {
                                        mailBtn.disabled = true;
                                        mailBtn.textContent = 'Sending OTP...';
                                        fetch('/api/auth/mail-app/send', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ email: emailVal })
                                        })
                                        .then(function(r) { return r.json(); })
                                        .then(function(d) {
                                            mailBtn.disabled = false;
                                            if (!d.success) {
                                                mailBtn.textContent = 'Sign In via OTP';
                                                statusEl.style.color = '#dc2626';
                                                statusEl.textContent = d.error || 'Could not send link.';
                                                return;
                                            }
                                            mailStep = 'verify';
                                            emailInp.readOnly = true;
                                            codeInp.style.display = 'block';
                                            mailBtn.style.background = '#059669';
                                            mailBtn.textContent = '✅ Verify Code & Sign In';
                                            statusEl.style.color = '#059669';
                                            statusEl.textContent = '6-digit code sent! Please check your Inbox (or Spam folder).';
                                            if (d.pollId) startMagicLinkPolling(d.pollId);
                                        })
                                        .catch(function() {
                                            mailBtn.disabled = false;
                                            mailBtn.textContent = 'Sign In via OTP';
                                            statusEl.style.color = '#dc2626';
                                            statusEl.textContent = 'Network error. Please try again.';
                                        });
                                    } else {
                                        var codeVal = (codeInp.value || '').trim();
                                        if (codeVal.length < 4) {
                                            statusEl.style.color = '#dc2626';
                                            statusEl.textContent = 'Tap the 1-Tap link in your Mail app or enter the 6-digit code.';
                                            return;
                                        }
                                        mailBtn.disabled = true;
                                        mailBtn.textContent = 'Verifying...';
                                        fetch('/api/auth/mail-app/verify', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ email: emailVal, code: codeVal })
                                        })
                                        .then(function(r) { return r.json(); })
                                        .then(function(d) {
                                            mailBtn.disabled = false;
                                            if (!d.success) {
                                                mailBtn.textContent = '✅ Verify Code & Sign In';
                                                statusEl.style.color = '#dc2626';
                                                statusEl.textContent = d.error || 'Invalid code.';
                                                return;
                                            }
                                            completePortalLogin(d);
                                        })
                                        .catch(function() {
                                            mailBtn.disabled = false;
                                            mailBtn.textContent = '✅ Verify Code & Sign In';
                                            statusEl.style.color = '#dc2626';
                                            statusEl.textContent = 'Network error verifying code.';
                                        });
                                    }
                                });
                            }
                        }

                        if (autoTriggerChooser && !isAndroidNonChromeBrowser() && window.google && window.google.accounts && setupGoogleClients() && googleTokenClient) {
                            try {
                                googleTokenClient.requestAccessToken({ prompt: 'select_account' });
                            } catch (e) {}
                        }

                        waitForGoogleLibrary(2500).then(function(ready) {
                            if (ready && setupGoogleClients()) {
                                var renderBox = document.getElementById('pp-google-rendered-btn');
                                if (renderBox && !renderBox.hasChildNodes() && window.google.accounts.id) {
                                    try {
                                        window.google.accounts.id.renderButton(renderBox, {
                                            type: 'standard',
                                            theme: 'outline',
                                            size: 'large',
                                            text: 'continue_with',
                                            shape: 'rectangular',
                                            logo_alignment: 'left',
                                            width: 320
                                        });
                                    } catch (e) {}
                                }
                                if (!isUserSignedIn() && window.google.accounts.id) {
                                    try { window.google.accounts.id.prompt(); } catch (e) {}
                                }
                            }
                        });
                    }

                    function killLegacyOtpModal() {
                        var knownModals = document.querySelectorAll('.modal, #auth-modal, #login-modal, #otp-modal, #sso-modal');
                        for (var i = 0; i < knownModals.length; i++) {
                            if (knownModals[i].id !== 'pp-universal-auth-modal') {
                                knownModals[i].remove();
                            }
                        }
                        var allBtns = document.querySelectorAll('button, input[type="submit"]');
                        for (var j = 0; j < allBtns.length; j++) {
                            var txt = (allBtns[j].textContent || allBtns[j].value || '').trim();
                            if (txt.indexOf('Continue & Send OTP') !== -1 || txt.indexOf('Send OTP') !== -1) {
                                var parentOverlay = allBtns[j].closest('div[style*="fixed"], div[class*="modal"], div[id*="modal"]') || allBtns[j].parentElement?.parentElement;
                                if (parentOverlay && parentOverlay.id !== 'pp-universal-auth-modal' && parentOverlay !== document.body) {
                                    parentOverlay.remove();
                                }
                            }
                        }
                    }

                    waitForGoogleLibrary(2500).then(function(ready) {
                        if (ready) setupGoogleClients();
                    });

                    document.addEventListener('click', function(e) {
                        var logoutBtn = e.target ? e.target.closest('#nav-logout-btn') : null;
                        if (logoutBtn) {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            localStorage.removeItem('pp_auth_provider');
                            localStorage.removeItem('pp_id_token');
                            localStorage.removeItem('pp_fname');
                            localStorage.removeItem('pp_lname');
                            localStorage.removeItem('pp_email');
                            sessionStorage.clear();
                            fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).finally(function() {
                                window.location.replace('/');
                            });
                            return;
                        }

                        var signInBtn = e.target ? e.target.closest('#nav-signin-btn') : null;
                        if (signInBtn) {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            openUniversalSignInModal(true);
                            return;
                        }

                        if (!isUserSignedIn() && baseRoute !== '/admin-live') {
                            var clickedInsideAuth = e.target ? e.target.closest('#pp-universal-auth-modal, #pwa-download-btn, #pwa-install-helper-modal, .footer-contact, .footer-links') : null;
                            if (clickedInsideAuth) return;

                            var portalLink = e.target ? e.target.closest('a[href*="/mock-tests"], a[href*="/study-notes"], a[href*="/descriptive"], a[href*="/live-room"], .card, [data-action^="select-"]') : null;
                            if (portalLink) {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation();
                                var href = portalLink.getAttribute('href');
                                if (href && href.indexOf('/') === 0) {
                                    sessionStorage.setItem('pp_post_login_redirect', href);
                                }
                                openUniversalSignInModal(false);
                            }
                        }
                    }, true);

                    window.addEventListener('DOMContentLoaded', function() {
                        killLegacyOtpModal();

                        if (isUserSignedIn()) {
                            sessionStorage.removeItem('pp_open_google_auth');
                            sessionStorage.removeItem('force_login_open');
                            return;
                        }

                        if (sessionStorage.getItem('pp_open_google_auth') === 'true' || sessionStorage.getItem('force_login_open') === 'true') {
                            sessionStorage.removeItem('pp_open_google_auth');
                            sessionStorage.removeItem('force_login_open');
                            openUniversalSignInModal(false);
                        }
                    });
                })();
            })();
        </script>`;
                

        const noscriptBlock = `<noscript>
            <style>
                body { background-color: #f1f5f9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; }
                .app-screen, .site-header, .site-footer, .nav-container { display: none !important; }
            </style>
            <div style="background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 500px; text-align: center;">
                <h1 style="color: #dc2626; margin-top: 0;">Security Violation</h1>
                <p style="color: #475569; line-height: 1.6;">JavaScript must be enabled in your browser to access this secure examination portal. Please enable JavaScript and refresh the page.</p>
            </div>
        </noscript>`;

        const antiCheatScript = `<script nonce="${nonce}">
            (function enforceSecurity() {
                setInterval(function() {
                    if (!document.body.classList.contains('exam-mode')) return;
                    const start = performance.now();
                    debugger; 
                    if (performance.now() - start > 100) {
                        if (typeof submitQuiz === 'function') submitQuiz(true);
                        window.location.replace('/');
                    }
                }, 1500);

                window.addEventListener('resize', function() {
                    if (document.body.classList.contains('exam-mode')) {
                        const widthDiff = window.outerWidth - window.innerWidth;
                        const heightDiff = window.outerHeight - window.innerHeight;
                        if (widthDiff > 200 || heightDiff > 200) {
                            if (typeof submitQuiz === 'function') submitQuiz(true);
                            window.location.replace('/');
                        }
                    }
                });
                console.log = console.warn = console.error = console.info = function() {};
            })();
        </script>`;

        // Implementation 4: Added cache busting for livetest.js / admin-live.js & fixed Confetti SRI integrity block
        let dynamicHtml = data
            .replace(/\sonclick="([^"]*)"/gi, ' data-csp-action="$1"')
            .replace(/Live\s+One\s+to\s+One\s+Test/gi, 'Join Room')
            .replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
            .replace(/<head>/i, `<head>\n${headRouteGuardScript}\n${antiCheatScript}`)
            .replace(/<body[^>]*>/i, match => `${match}\n${noscriptBlock}`)
            .replace(/(['"\s=])\/?test-portal\.html/gi, '$1/mock-tests')
            .replace(/(['"\s=])\/?notes\.html/gi, '$1/study-notes')
            .replace(/(['"\s=])\/?descriptive\.html/gi, '$1/descriptive-papers')
            .replace(/(['"\s=])\/?(?:live-test|livetest\.html)/gi, '$1/live-room')
            .replace(/(['"\s=])\/?index\.html/gi, '$1/')
            .replace(/Live One to One Test/gi, 'Live Room')
            .replace(/(src="\/js\/main\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(src="\/js\/quiz\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(src="\/js\/livetest\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(src="\/js\/admin-live\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(href="\/css\/style\.css)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/canvas-confetti@1\.5\.1\/dist\/confetti\.browser\.min\.js"[^>]*><\/script>/gi,
                `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/canvas-confetti@1\.5\.1/dist/confetti.browser.min.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`)
            .replace(/<meta name="viewport"[^>]*>/i, `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">\n    <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=${APP_VERSION}">
<link rel="manifest" href="/manifest.json?v=${APP_VERSION}">
<meta name="theme-color" content="#2563eb">
<script nonce="${nonce}" src="/js/pwa-register.js?v=${APP_VERSION}"></script>
<link rel="apple-touch-icon" sizes="180x180" href="/favicon.png?v=${APP_VERSION}">\n    <link rel="alternate icon" href="/favicon.ico?v=${APP_VERSION}">`)
            .replace(/<header id="site-header"[^>]*>.*?<\/header>/is, `<header id="site-header" class="site-header">${headerHTML}</header>`)
            .replace(/<footer id="site-footer"[^>]*>.*?<\/footer>/is, `<footer id="site-footer" class="site-footer">${footerHTML}</footer>`)
            .replace('</body>', `${clientIntegrationScript}\n</body>`);

        const cleanReqPath = req.path.replace(/\/+$/, '').toLowerCase();
        const isSubScreenUrl = cleanReqPath !== canonicalBaseRoute && !cleanReqPath.endsWith('.html') && cleanReqPath.startsWith(canonicalBaseRoute + '/');
        if ((req.query && req.query.class) || isSubScreenUrl) {
            dynamicHtml = dynamicHtml.replace(/id="home-dashboard"\s*class="app-screen"/g, 'id="home-dashboard" class="app-screen hidden"');
        }

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Type', 'text/html');

        res.send(dynamicHtml);
    });
}

// Primary page routes
app.get('/', (req, res) => serveDynamicHtml(req, res, 'index.html', '/'));
app.get('/index.html', (req, res) => serveDynamicHtml(req, res, 'index.html', '/'));
app.get('/live-room', (req, res) => serveDynamicHtml(req, res, 'livetest.html', '/live-room'));
app.get('/live-test', (req, res) => serveDynamicHtml(req, res, 'livetest.html', '/live-room'));
app.get('/livetest.html', (req, res) => serveDynamicHtml(req, res, 'livetest.html', '/live-room'));
app.get('/mock-tests', (req, res) => serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests'));
app.get('/test-portal.html', (req, res) => serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests'));
app.get('/study-notes', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/notes', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/notes.html', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/descriptive-papers', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));
app.get('/descriptive', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));
app.get('/descriptive.html', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));

// Add clean routing for Admin Dashboard
app.get('/admin-live', (req, res) => serveDynamicHtml(req, res, 'admin-live.html', '/admin-live'));
app.get('/admin-live.html', (req, res) => serveDynamicHtml(req, res, 'admin-live.html', '/admin-live'));

// Serve static files but force the browser to check Render for updates on refresh
app.use(express.static(path.join(__dirname, 'public'), { 
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// ============================================================================
// 5. SECURITY, SHUFFLING & CACHED FILE SYSTEM HELPERS
// ============================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function maskEmail(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return 'unknown';
    const [user, domain] = email.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
}

function safeCompareHex(sigA, sigB) {
    if (typeof sigA !== 'string' || typeof sigB !== 'string') return false;
    if (sigA.length !== sigB.length) return false;
    try {
        const bufA = Buffer.from(sigA, 'hex');
        const bufB = Buffer.from(sigB, 'hex');
        if (bufA.length !== bufB.length || bufA.length === 0) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch { return false; }
}

function safeCompareStrings(strA, strB) {
    if (typeof strA !== 'string' || typeof strB !== 'string') return false;
    const bufA = Buffer.from(strA, 'utf8');
    const bufB = Buffer.from(strB, 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

const MAX_BASE64_IMAGE_LENGTH = 2 * 1024 * 1024;

function isSafeBase64Image(str) {
    if (typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_BASE64_IMAGE_LENGTH) return false;

    const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(trimmed);
    if (!match) return false;

    const mimeSubtype = match[1].toLowerCase();
    const b64Payload = match[2];
    if (b64Payload.length < 32 || b64Payload.length % 4 !== 0) return false;

    try {
        const headerBytes = Buffer.from(b64Payload.slice(0, 32), 'base64');
        if (headerBytes.length < 12) return false;

        if (mimeSubtype === 'jpeg' || mimeSubtype === 'jpg') {
            return headerBytes[0] === 0xFF && headerBytes[1] === 0xD8 && headerBytes[2] === 0xFF;
        }
        if (mimeSubtype === 'png') {
            return (
                headerBytes[0] === 0x89 &&
                headerBytes[1] === 0x50 &&
                headerBytes[2] === 0x4E &&
                headerBytes[3] === 0x47 &&
                headerBytes[4] === 0x0D &&
                headerBytes[5] === 0x0A &&
                headerBytes[6] === 0x1A &&
                headerBytes[7] === 0x0A
            );
        }
        if (mimeSubtype === 'webp') {
            const isRiff = headerBytes[0] === 0x52 && headerBytes[1] === 0x49 && headerBytes[2] === 0x46 && headerBytes[3] === 0x46;
            const isWebp = headerBytes[8] === 0x57 && headerBytes[9] === 0x45 && headerBytes[10] === 0x42 && headerBytes[11] === 0x50;
            return isRiff && isWebp;
        }
        return false;
    } catch {
        return false;
    }
}

function getDeterministicPermutation(length, seedString) {
    const indices = Array.from({ length }, (_, i) => i);
    if (length <= 1) return indices;
    const hash = crypto.createHmac('sha256', SECRET).update(seedString).digest();
    for (let i = length - 1; i > 0; i--) {
        const byteOffset = (i * 4) % (hash.length - 4);
        const randInt = hash.readUInt32BE(byteOffset);
        const j = randInt % (i + 1);
        const temp = indices[i];
        indices[i] = indices[j];
        indices[j] = temp;
    }
    return indices;
}

function getSafeOptionPermutation(options, seedString) {
    if (!Array.isArray(options) || options.length <= 1) return [];
    const hasPositionalRef = options.some(opt =>
        /all of the|none of the|both\s*\(?[a-d1-4]|option\s*[a-d1-4]|\([a-d]\)\s*and\s*\([a-d]\)/i.test(String(opt))
    );
    if (hasPositionalRef) {
        return Array.from({ length: options.length }, (_, i) => i);
    }
    return getDeterministicPermutation(options.length, seedString);
}

// ANTI-SCRAPING: Dynamic Server-Side XOR Cipher
function xorCipher(text, key) {
    const textBuf = Buffer.from(text, 'utf8');
    const keyBuf = Buffer.from(key, 'utf8');
    const out = Buffer.alloc(textBuf.length);
    for (let i = 0; i < textBuf.length; i++) {
        out[i] = textBuf[i] ^ keyBuf[i % keyBuf.length];
    }
    return out.toString('base64');
}

const RESERVED_JSON_NAMES = new Set(['submissions', 'package', 'package-lock', 'quizzes', 'notes', 'descriptive']);

function getAllJsonFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) getAllJsonFiles(filePath, fileList);
        else if (file.toLowerCase().endsWith('.json')) fileList.push(filePath);
    }
    return fileList;
}

function getCachedQuizFiles() {
    const now = Date.now();
    if (fsCache.quizPaths.data && now < fsCache.quizPaths.expiresAt) return fsCache.quizPaths.data;
    
    const quizzesDir = path.join(__dirname, 'quizzes');
    if (!fs.existsSync(quizzesDir)) fs.mkdirSync(quizzesDir, { recursive: true });
    let files = getAllJsonFiles(quizzesDir);

    // Recursively scan the descriptive folder for JSON tests so they can be executed by the quiz engine
    const descDir = path.join(__dirname, 'descriptive');
    if (fs.existsSync(descDir)) {
        files = files.concat(getAllJsonFiles(descDir));
    }

    fsCache.quizPaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function getCachedQuizContent(filePath) {
    if (!filePath) return null;
    const now = Date.now();
    const cached = fsCache.quizContentByPath.get(filePath);
    if (cached && now < cached.expiresAt) return cached.content;

    const raw = fs.readFileSync(filePath, 'utf8');
    const content = JSON.parse(raw);
    setBoundedMap(fsCache.quizContentByPath, filePath, { content, expiresAt: now + CACHE_TTL_MS });
    return content;
}

function resolveSafeQuizPath(rawId) {
    if (!rawId || typeof rawId !== 'string') return null;
    const cleanId = path.basename(rawId.trim());
    if (!/^[a-zA-Z0-9_\-\s\(\)\.]+$/.test(cleanId)) return null;
    if (RESERVED_JSON_NAMES.has(cleanId.toLowerCase())) return null;

    const allJsonFiles = getCachedQuizFiles();
    const target1 = cleanId + '.json';
    const target2 = cleanId + '-questions.json';
    const target3 = cleanId;

    const matchedPath = allJsonFiles.find(filePath => {
        const fileName = path.basename(filePath);
        return fileName === target1 || fileName === target2 || fileName === target3;
    });
    return matchedPath || null;
}

function getOfficialQuizDuration(quizId, clientFallback) {
    const cleanId = path.basename(String(quizId || '')).trim();
    const filePath = resolveSafeQuizPath(cleanId);
    if (filePath) {
        try {
            const quizContent = getCachedQuizContent(filePath);
            if (quizContent && Number(quizContent.duration) > 0) return Number(quizContent.duration);
        } catch (err) { console.error('Error reading quiz duration:', err); }
    }
    const parsed = parseInt(clientFallback, 10);
    if (!isNaN(parsed) && parsed >= 60 && parsed <= 10800) return parsed;
    return 900;
}

// Implementation 5: Allow starting a new quiz or switching chapters cleanly in the same global session
async function getOrCreateExamSession(authSignature, cleanQuizId, clientDurationFallback, forceNew = false) {
    const sessionKey = `exam:session:${authSignature}`;
    if (!forceNew) {
        const rawExisting = await stateStore.get(sessionKey);
        if (rawExisting) {
            try {
                const existing = typeof rawExisting === 'string' ? JSON.parse(rawExisting) : rawExisting;
                if (existing.quizId === cleanQuizId) {
                    const isAlreadySubmitted = await stateStore.get(`exam:used:${existing.signature}`);
                    const elapsedSec = (Date.now() - existing.startTime) / 1000;
                    if (!isAlreadySubmitted && elapsedSec < existing.duration) {
                        return existing;
                    }
                }
            } catch {}
        }
    }

    const officialDuration = getOfficialQuizDuration(cleanQuizId, clientDurationFallback);
    const startTime = Date.now();
    const dataToSign = `${cleanQuizId}:${officialDuration}:${startTime}`;
    const signature = crypto.createHmac('sha256', SECRET).update(dataToSign).digest('hex');
    const xorKey = crypto.randomBytes(16).toString('hex');

    const session = {
        quizId: cleanQuizId,
        startTime,
        duration: officialDuration,
        signature,
        xorKey,
        expiresAt: startTime + TOKEN_MAX_AGE_MS
    };
    await stateStore.set(sessionKey, session, TOKEN_MAX_AGE_SEC);
    return session;
}

function getAllPdfFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) getAllPdfFiles(filePath, fileList);
        else if (file.toLowerCase().endsWith('.pdf')) fileList.push(filePath);
    }
    return fileList;
}

function getCachedNoteFiles() {
    const now = Date.now();
    if (fsCache.notePaths.data && now < fsCache.notePaths.expiresAt) return fsCache.notePaths.data;
    const notesDir = path.join(__dirname, 'notes');
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
    const files = getAllPdfFiles(notesDir);
    fsCache.notePaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function getCachedDescFiles() {
    const now = Date.now();
    if (fsCache.descPaths.data && now < fsCache.descPaths.expiresAt) return fsCache.descPaths.data;
    const descDir = path.join(__dirname, 'descriptive');
    if (!fs.existsSync(descDir)) fs.mkdirSync(descDir, { recursive: true });
    ['IX', 'X', 'XI', 'XII'].forEach(c => {
        const cDir = path.join(descDir, c);
        if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
    });
    let files = getAllPdfFiles(descDir);
    files = files.concat(getAllJsonFiles(descDir));
    fsCache.descPaths = { data: files, expiresAt: now + CACHE_TTL_MS };
    return files;
}

function resolveSafeNotePath(rawFileName) {
    if (!rawFileName || typeof rawFileName !== 'string') return null;
    const cleanName = path.basename(rawFileName.trim());
    const allPdfFiles = getCachedNoteFiles();
    return allPdfFiles.find(filePath => path.basename(filePath).toLowerCase() === cleanName.toLowerCase()) || null;
}

function resolveSafeDescriptivePath(rawFileName) {
    if (!rawFileName || typeof rawFileName !== 'string') return null;
    const cleanName = path.basename(rawFileName.trim());
    const allPdfFiles = getCachedDescFiles();
    return allPdfFiles.find(filePath => path.basename(filePath).toLowerCase() === cleanName.toLowerCase()) || null;
}

// Implementation 3B: Global SSO Token Verification (does not block after 1 quiz submission)
async function verifyAuthToken(authToken, expectedEmail = null, checkReplay = false) {
    if (!authToken || typeof authToken !== 'string' || !authToken.includes('|||')) {
        return { valid: false, error: 'Security Alert: Invalid submission token.' };
    }
    const parts = authToken.split('|||');
    if (parts.length !== 2) return { valid: false, error: 'Security Alert: Malformed token.' };

    const [tokenData, authSignature] = parts;

    const isBlacklisted = await stateStore.get(`blacklist:token:${authSignature}`);
    if (isBlacklisted) return { valid: false, error: 'Security Alert: Token revoked. Please sign in again.' };

    const expectedAuthSig = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');

    if (!safeCompareHex(authSignature, expectedAuthSig)) {
        return { valid: false, error: 'Security Alert: Unauthorized or tampered session.' };
    }

    const dataParts = tokenData.split('|');
if (dataParts.length < 5 || !String(dataParts[4]).startsWith('G2_')) {
    return { valid: false, error: 'Session upgraded to Google Sign-In. Please sign in with Google.' };
}

    const tokenEmail = dataParts[0];
    
    // Check if the account was deregistered by the admin
    const isEmailBlacklisted = await stateStore.get(`blacklist:email:${tokenEmail}`);
    if (isEmailBlacklisted) return { valid: false, error: 'Your account has been deregistered. Please sign in again.' };

    let issuedAt, firstName = '', lastName = '';

    if (dataParts.length >= 5) {
        firstName = decodeURIComponent(dataParts[1] || '');
        lastName = decodeURIComponent(dataParts[2] || '');
        issuedAt = parseInt(dataParts[3], 10);
    } else {
        issuedAt = parseInt(dataParts[1], 10);
    }

    if (isNaN(issuedAt) || (Date.now() - issuedAt) > TOKEN_MAX_AGE_MS) {
        return { valid: false, error: 'Session expired. Please verify your email again.' };
    }
    if (expectedEmail && tokenEmail !== expectedEmail.trim().toLowerCase()) {
        return { valid: false, error: 'Security Alert: Token email mismatch.' };
    }

    return { valid: true, email: tokenEmail, firstName, lastName, signature: authSignature };
}

// Implementation 6: Dual Redis + File Persistence for Submissions & Leaderboard History (With 30s RAM Cache)
let historicalSubmissionsRamCache = { data: null, expiresAt: 0 };

async function getHistoricalSubmissions(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && historicalSubmissionsRamCache.data && now < historicalSubmissionsRamCache.expiresAt) {
        return historicalSubmissionsRamCache.data;
    }

    let redisList = [];
    let fileList = [];

    try {
        const rawRedis = await stateStore.get(SUBMISSIONS_REDIS_KEY);
        if (rawRedis) {
            const parsed = typeof rawRedis === 'string' ? JSON.parse(rawRedis) : rawRedis;
            if (Array.isArray(parsed)) redisList = parsed;
        }
    } catch {}

    try {
        const submissionsFile = path.join(__dirname, 'submissions.json');
        if (fs.existsSync(submissionsFile)) {
            const fileData = await fs.promises.readFile(submissionsFile, 'utf8');
            const parsed = JSON.parse(fileData);
            if (Array.isArray(parsed)) fileList = parsed;
        }
    } catch {}

    let finalMerged;
    if (redisList.length === 0) {
        finalMerged = fileList;
    } else if (fileList.length === 0) {
        finalMerged = redisList;
    } else {
        const merged = [...redisList];
        const seenKeys = new Set(redisList.map(s => `${s.timestamp || ''}|${s.email || ''}|${s.quizId || s.chapterTitle || ''}|${s.score}`));
        for (const item of fileList) {
            const key = `${item.timestamp || ''}|${item.email || ''}|${item.quizId || item.chapterTitle || ''}|${item.score}`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                merged.push(item);
            }
        }
        finalMerged = merged.slice(-5000);
    }

    historicalSubmissionsRamCache = { data: finalMerged, expiresAt: now + 30000 };
    return finalMerged;
}

let submissionWritePromise = Promise.resolve();
function queueSubmissionBackup(entry) {
    submissionWritePromise = submissionWritePromise.then(async () => {
        try {
            let allSubmissions = [...(await getHistoricalSubmissions(true))];
            const { secretKey, breakdown, ...safeMetadata } = entry;
            allSubmissions.push(safeMetadata);
            if (allSubmissions.length > 5000) {
                allSubmissions = allSubmissions.slice(-5000);
            }
            historicalSubmissionsRamCache = { data: allSubmissions, expiresAt: Date.now() + 30000 };

            const tenYearsSec = 60 * 60 * 24 * 365 * 10;
            await stateStore.set(SUBMISSIONS_REDIS_KEY, allSubmissions, tenYearsSec);

            const submissionsFile = path.join(__dirname, 'submissions.json');
            await fs.promises.writeFile(submissionsFile, JSON.stringify(allSubmissions, null, 2), { mode: 0o600 });
            return allSubmissions;
        } catch (err) {
            console.error('Local backup failed:', err);
            return [];
        }
    });
    return submissionWritePromise;
}

const ATTEMPTS_FILE_PATH = path.join(__dirname, 'attempts_db.json');

async function savePermanentStudentAttempt(email, cleanQuizId, attemptRecord) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const tenYearsSec = 60 * 60 * 24 * 365 * 10;
    const key = `attempt:v1:${cleanEmail}:${cleanQuizId}`;
    await stateStore.set(key, attemptRecord, tenYearsSec);

    try {
        let db = {};
        if (fs.existsSync(ATTEMPTS_FILE_PATH)) {
            db = JSON.parse(await fs.promises.readFile(ATTEMPTS_FILE_PATH, 'utf8')) || {};
        }
        db[`${cleanEmail}__${cleanQuizId}`] = attemptRecord;
        await fs.promises.writeFile(ATTEMPTS_FILE_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
    } catch {}
}

async function getPermanentStudentAttempt(email, cleanQuizId) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const key = `attempt:v1:${cleanEmail}:${cleanQuizId}`;
    try {
        const raw = await stateStore.get(key);
        if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}

    try {
        if (fs.existsSync(ATTEMPTS_FILE_PATH)) {
            const db = JSON.parse(await fs.promises.readFile(ATTEMPTS_FILE_PATH, 'utf8')) || {};
            if (db[`${cleanEmail}__${cleanQuizId}`]) return db[`${cleanEmail}__${cleanQuizId}`];
        }
    } catch {}
    return null;
}

async function computeQuizCompetitiveStats(cleanQuizId, fullTitle, cleanChapterTitle, studentEmail, studentScore, totalCount) {
    const historical = await getHistoricalSubmissions();
    const norm = str => String(str || '').trim().toLowerCase();

    let quizSubmissions = historical.filter(s => {
        if (s.quizId && norm(s.quizId) === norm(cleanQuizId)) return true;
        if (!s.quizId && s.chapterTitle) {
            const sTitle = norm(s.chapterTitle);
            return sTitle === norm(fullTitle) || sTitle === norm(cleanChapterTitle) || sTitle.endsWith(norm(cleanChapterTitle));
        }
        return false;
    });

    const bestAttemptsMap = new Map();
    quizSubmissions.forEach(s => {
        const k = norm(s.email || `${s.firstName}_${s.lastName}`);
        const existing = bestAttemptsMap.get(k);
        if (!existing || Number(s.score) > Number(existing.score)) {
            bestAttemptsMap.set(k, s);
        }
    });

    const uniqueSubmissions = Array.from(bestAttemptsMap.values());
    uniqueSubmissions.sort((a, b) => Number(b.score) - Number(a.score));

    const totalAttempts = uniqueSubmissions.length;
    const lowerScores = uniqueSubmissions.filter(s => Number(s.score) < Number(studentScore)).length;
    const equalScores = uniqueSubmissions.filter(s => Number(s.score) === Number(studentScore)).length;

    const percentile = totalAttempts > 0
        ? Number((((lowerScores + (0.5 * equalScores)) / totalAttempts) * 100).toFixed(1))
        : 100.0;

    const avgScore = totalAttempts > 0
        ? (uniqueSubmissions.reduce((acc, s) => acc + Number(s.score || 0), 0) / totalAttempts).toFixed(1)
        : Number(studentScore).toFixed(1);

    const leaderboard = uniqueSubmissions.slice(0, 100).map((s, idx) => {
        const sTotal = Number(s.total) || Number(totalCount) || 1;
        const sCorr = Number(s.score) || 0;
        const sAtt = s.attempted !== undefined ? Number(s.attempted) : sCorr;
        return {
            rank: idx + 1,
            name: `${s.firstName || ''} ${s.lastName || ''}`.trim() || 'Student',
            score: sCorr,
            total: sTotal,
            scorePercentage: Number(((sCorr / sTotal) * 100).toFixed(1)),
            accuracyPercentage: sAtt > 0 ? Number(((sCorr / sAtt) * 100).toFixed(1)) : 0.0
        };
    });

    return { percentile, average: avgScore, totalAttempts, leaderboard };
}

function buildDetailedQuizBreakdownList(realQuestions, safeUserAnswers, seedKey, cleanQuizId) {
    const totalCount = realQuestions.length;
    const qOrder = getDeterministicPermutation(totalCount, `${seedKey}:${cleanQuizId}:q`);
    const origToClientIndex = new Array(totalCount);
    qOrder.forEach((origIdx, clientIdx) => {
        origToClientIndex[origIdx] = clientIdx;
    });

    const breakdownItems = [];
    realQuestions.forEach((q, origIndex) => {
        const clientIdx = origToClientIndex[origIndex];
        const response = safeUserAnswers[clientIdx.toString()] !== undefined ? safeUserAnswers[clientIdx.toString()] : safeUserAnswers[clientIdx];
        const attempted = response !== undefined && response !== null && response !== "";

        let status = "Skipped";
        let selectedText = "Skipped";
        let correctText = "N/A";

        if (q.type === 'descriptive' || q.type === 'diagram') {
            selectedText = attempted ? (isSafeBase64Image(response) ? "[Diagram Image Submitted]" : String(response).slice(0, 2000)) : "Skipped";
            correctText = q.model_answer || "Refer to marking scheme";
            if (attempted) status = "Needs Review";
        } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
            selectedText = attempted ? String(response).slice(0, 500) : "Skipped";
            correctText = q.answer_text || q.model_answer || "Refer to marking scheme";
            const isCorrect = attempted && String(response).trim().toLowerCase() === String(q.answer_text || q.model_answer || '').trim().toLowerCase();
            status = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
        } else {
            const clientOptIdx = parseInt(response, 10);
            const optOrder = getSafeOptionPermutation(q.options || [], `${seedKey}:${cleanQuizId}:opt:${origIndex}`);
            const actualOptIdx = (attempted && !isNaN(clientOptIdx) && optOrder[clientOptIdx] !== undefined) ? optOrder[clientOptIdx] : clientOptIdx;
            const isCorrect = attempted && actualOptIdx === q.answer;
            selectedText = attempted ? (q.options?.[actualOptIdx] || "Unknown") : "Skipped";
            correctText = q.options?.[q.answer] !== undefined ? q.options[q.answer] : "N/A";
            status = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
        }

        let rawExp = q.explanation || q.Explanation || q.exp || q.solution || q.Solution || q.rationale || q.reason || '';
        breakdownItems.push({
            qNum: origIndex + 1,
            question: q.question || "N/A",
            selectedText: String(selectedText),
            correctText: String(correctText),
            status,
            explanation: String(rawExp || '').trim()
        });
    });

    return breakdownItems;
}

async function buildSavedAttemptResponse(email, cleanId, content) {
    const savedAttempt = await getPermanentStudentAttempt(email, cleanId);
    if (!savedAttempt) return null;
    const realQuestions = content.questions || [];
    const breakdownItems = buildDetailedQuizBreakdownList(
        realQuestions,
        savedAttempt.userAnswers || {},
        savedAttempt.seedKey || '',
        cleanId
    );
    const stats = await computeQuizCompetitiveStats(
        cleanId,
        savedAttempt.chapterTitle || content.title || cleanId,
        content.title || cleanId,
        email,
        savedAttempt.score,
        realQuestions.length
    );
    return {
        alreadyAttempted: true,
        quizId: cleanId,
        chapterTitle: savedAttempt.chapterTitle || content.title || cleanId,
        score: savedAttempt.score,
        total: realQuestions.length,
        correct: savedAttempt.correct,
        incorrect: savedAttempt.incorrect,
        attemptedCount: savedAttempt.attempted,
        skipped: savedAttempt.skipped,
        scorePercentage: savedAttempt.scorePercentage,
        accuracyPercentage: savedAttempt.accuracyPercentage,
        percentile: stats.percentile,
        average: stats.average,
        totalAttempts: stats.totalAttempts,
        leaderboard: stats.leaderboard,
        breakdownItems,
        timestamp: savedAttempt.timestamp
    };
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const urls = [
        { loc: '/', priority: '1.0' },
        { loc: '/mock-tests', priority: '0.9' },
        { loc: '/study-notes', priority: '0.9' },
        { loc: '/descriptive-papers', priority: '0.8' },
        { loc: '/privacy-policy', priority: '0.5' },
        { loc: '/terms-of-service', priority: '0.5' }
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url>\n    <loc>${SITE_URL}${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
        `\n</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
});

app.get('/privacy-policy', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy — Pioneers Prep</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=${APP_VERSION}">
    <link rel="stylesheet" href="/css/style.css?v=${APP_VERSION}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 0; line-height: 1.7; }
        .legal-wrap { max-width: 820px; margin: 40px auto; background: #ffffff; padding: 36px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
        h1 { color: #1e3a8a; margin-top: 0; }
        h2 { color: #0f172a; margin-top: 24px; font-size: 18px; }
        a.back-home { display: inline-block; margin-bottom: 20px; color: #2563eb; font-weight: 700; text-decoration: none; }
    </style>
</head>
<body>
    <div class="legal-wrap">
        <a href="/" class="back-home">&larr; Back to Pioneers Prep Home</a>
        <h1>Privacy Policy</h1>
        <p><strong>Effective Date:</strong> November 15, 2026</p>
        <p>Welcome to <strong>Pioneers Prep</strong> (<a href="https://pioneersprep.in">https://pioneersprep.in</a>), founded and managed by <strong>Aniruddha Banerjee</strong> in Berhampore, Murshidabad, West Bengal. We respect your privacy and are committed to protecting the personal information of our students and users.</p>

        <h2>1. Information We Collect</h2>
        <p>When you sign in using Google Sign-In or register on Pioneers Prep, we collect only your basic profile details provided by Google: your <strong>full name</strong> and <strong>verified email address</strong>. We also record your mock test submissions, scores, and live classroom participation to generate performance scorecards and leaderboards.</p>

        <h2>2. How We Use Your Information</h2>
        <ul>
            <li>To authenticate your student account and maintain secure session access across mock tests, study notes, and live classes.</li>
            <li>To generate personalized assessment scorecards, question-by-question breakdowns, and competitive leaderboards.</li>
            <li>To verify access to purchased or whitelisted study materials via Razorpay.</li>
        </ul>

        <h2>3. Data Protection & Third-Party Sharing</h2>
        <p>We do <strong>not</strong> sell, rent, or trade your personal data or Google user data to any third parties. Payment transactions are processed securely through Razorpay, and live classroom audio/video streams are transmitted securely over encrypted WebRTC connections.</p>

        <h2>4. Data Retention & Deletion Requests</h2>
        <p>Your account profile and test records are retained to provide continuous access to your academic progress. You may request complete deletion of your account data at any time by contacting us at <a href="mailto:anibanerjee5@gmail.com">anibanerjee5@gmail.com</a>.</p>

        <h2>5. Contact Us</h2>
        <p>If you have any questions about this Privacy Policy, please contact:<br>
        <strong>Aniruddha Banerjee</strong> — Pioneers Prep<br>
        Email: <a href="mailto:anibanerjee5@gmail.com">anibanerjee5@gmail.com</a><br>
        Location: Berhampore, Murshidabad, West Bengal, India</p>
    </div>
</body>
</html>`);
});

app.get('/terms-of-service', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms of Service — Pioneers Prep</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png?v=${APP_VERSION}">
    <link rel="stylesheet" href="/css/style.css?v=${APP_VERSION}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 0; line-height: 1.7; }
        .legal-wrap { max-width: 820px; margin: 40px auto; background: #ffffff; padding: 36px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
        h1 { color: #1e3a8a; margin-top: 0; }
        h2 { color: #0f172a; margin-top: 24px; font-size: 18px; }
        a.back-home { display: inline-block; margin-bottom: 20px; color: #2563eb; font-weight: 700; text-decoration: none; }
    </style>
</head>
<body>
    <div class="legal-wrap">
        <a href="/" class="back-home">&larr; Back to Pioneers Prep Home</a>
        <h1>Terms of Service</h1>
        <p><strong>Effective Date:</strong> November 15, 2026</p>
        <p>By accessing or using <strong>Pioneers Prep</strong> (<a href="https://pioneersprep.in">https://pioneersprep.in</a>), operated by <strong>Aniruddha Banerjee</strong>, you agree to comply with and be bound by the following Terms of Service.</p>

        <h2>1. Use of Educational Portal & Intellectual Property</h2>
        <p>All mock tests, questions, explanations, study notes (PDFs), descriptive worksheets, and live classroom broadcasts on Pioneers Prep are the exclusive intellectual property of Pioneers Prep and Aniruddha Banerjee. Copying, scraping, screen-recording, redistributing, or sharing portal content is strictly prohibited and protected by forensic watermarking.</p>

        <h2>2. Student Accounts & Conduct</h2>
        <p>You agree to sign in using your own authentic Google account. Sharing account access across multiple users or attempting to tamper with exam timers, client scripts, or live classroom sessions will result in immediate account suspension.</p>

        <h2>3. Premium Content & Payments</h2>
        <p>Certain mock tests, study notes, and worksheets require whitelisting or a one-time purchase via Razorpay. Once digital study materials or tests are unlocked or downloaded, fees are non-refundable except in cases of duplicate technical charges.</p>

        <h2>4. Limitation of Liability</h2>
        <p>Pioneers Prep provides educational preparation materials for ICSE, CBSE, WBCHSE, and NEET students on an "as-is" basis. While we strive for 100% accuracy and uptime, we are not liable for external network interruptions on a user's device during online assessments.</p>

        <h2>5. Contact Information</h2>
        <p>For support or inquiries regarding these Terms:<br>
        <strong>Aniruddha Banerjee</strong> — Pioneers Prep<br>
        Email: <a href="mailto:anibanerjee5@gmail.com">anibanerjee5@gmail.com</a><br>
        Location: Berhampore, Murshidabad, West Bengal, India</p>
    </div>
</body>
</html>`);
});

app.get('/ping', (req, res) => res.status(200).send('Awake'));

// Global Favicon Handler (Serves custom public/favicon.png if present, or crisp 'PP' SVG badge)
const PP_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="ppGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e3a8a"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#ppGrad)"/>
  <rect x="3" y="3" width="58" height="58" rx="11" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-opacity="0.85"/>
  <text x="32" y="42" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="1">PP</text>
</svg>`;

app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
    const customPng = path.join(__dirname, 'public', 'favicon.png');
    const customIco = path.join(__dirname, 'public', 'favicon.ico');
    if (fs.existsSync(customPng)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(customPng);
    }
    if (fs.existsSync(customIco)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(customIco);
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(PP_FAVICON_SVG);
});

// ============================================================================
// LAYER 1 & LAYER 5: RAM-FIRST VELOCITY WALL & PAYLOAD HARDENING
// ============================================================================
const ramRateBuckets = new Map();

function checkRamVelocity(clientKey, bucketName, maxRequests, windowMs) {
    const now = Date.now();
    if (ramRateBuckets.size > 5000) {
        for (const [k, v] of ramRateBuckets.entries()) {
            if (now > v.resetAt) ramRateBuckets.delete(k);
        }
    }
    const key = `${bucketName}:${clientKey}`;
    let entry = ramRateBuckets.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + windowMs };
        ramRateBuckets.set(key, entry);
        return true;
    }
    entry.count += 1;
    return entry.count <= maxRequests;
}

function hasPrototypePollutionKeys(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return false;
    for (const key of Object.keys(obj)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
        if (typeof obj[key] === 'object' && hasPrototypePollutionKeys(obj[key], depth + 1)) return true;
    }
    return false;
}

function getCoarseDeviceSignature(req) {
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const os = ua.includes('android') ? 'android'
        : ua.includes('iphone') || ua.includes('ipad') ? 'ios'
        : ua.includes('win') ? 'windows'
        : ua.includes('mac') ? 'mac'
        : ua.includes('linux') ? 'linux' : 'other-os';
    const browser = ua.includes('edg/') ? 'edge'
        : ua.includes('chrome') && !ua.includes('edg/') ? 'chrome'
        : ua.includes('firefox') ? 'firefox'
        : ua.includes('safari') && !ua.includes('chrome') ? 'safari' : 'other-browser';
    return `${os}:${browser}`;
}

// Invisible Zero-Width Steganographic Watermarking Helpers (Layer 2)
function getStudentWatermarkBits(email) {
    const clean = String(email || '').trim().toLowerCase();
    const hex = crypto.createHash('sha256').update(`${clean}:${APPS_SECRET || 'pp_salt'}`).digest('hex').slice(0, 8);
    return parseInt(hex, 16).toString(2).padStart(32, '0');
}

function embedInvisibleWatermark(text, email) {
    if (!text || !email) return text;
    const bits = getStudentWatermarkBits(email);
    const zwTag = '\u2060' + bits.split('').map(b => (b === '1' ? '\u200B' : '\u200C')).join('') + '\u2060';
    const str = String(text);
    const firstSpace = str.indexOf(' ');
    if (firstSpace !== -1) {
        return str.slice(0, firstSpace) + zwTag + str.slice(firstSpace);
    }
    return str + zwTag;
}

function extractInvisibleWatermarkBits(leakedText) {
    const str = String(leakedText || '');
    const match = str.match(/\u2060([\u200B\u200C]{32})\u2060/);
    const rawSeq = match ? match[1] : (str.match(/[\u200B\u200C]{32}/) || [])[0];
    if (!rawSeq) return null;
    return rawSeq.split('').map(ch => (ch === '\u200B' ? '1' : '0')).join('');
}

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // 1. Block Prototype Pollution payloads across body, query, and params
    if (hasPrototypePollutionKeys(req.body) || hasPrototypePollutionKeys(req.query) || hasPrototypePollutionKeys(req.params)) {
        return res.status(400).json({ error: 'Malformed request payload rejected.' });
    }

    // 2. Enforce strict payload size cap on non-diagram endpoints (100 KB max)
    if (req.method === 'POST' && req.path !== '/api/submit') {
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (contentLength > 102400) {
            return res.status(413).json({ error: 'Payload too large.' });
        }
    }

    // 3. RAM-First Quota Protection for sensitive API routes
    const clientIp = getClientIp(req);
    if (req.path === '/api/send-otp' || req.path === '/api/request-otp') {
        if (!checkRamVelocity(clientIp, 'otp_send', 4, 10 * 60 * 1000)) {
            return res.status(429).json({ error: 'Too many OTP requests. Please wait 10 minutes.' });
        }
    } else if (req.path.startsWith('/api/')) {
        if (!checkRamVelocity(clientIp, 'api_global', 120, 60 * 1000)) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
        }
    }
    next();
});

// Admin Endpoint: Decode Invisible Steganographic Watermark from Leaked Text
app.post('/api/admin/decode-leak', async (req, res) => {
    try {
        const { adminKey, leakedText } = req.body;
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
            return res.status(403).json({ success: false, error: 'Unauthorized Admin Secret Key.' });
        }
        const bits = extractInvisibleWatermarkBits(leakedText);
        if (!bits) {
            return res.json({ success: false, message: 'No invisible watermark detected in the pasted text.' });
        }

        const candidateEmails = new Set();
        const history = await getHistoricalSubmissions();
        history.forEach(s => { if (s.email) candidateEmails.add(String(s.email).trim().toLowerCase()); });

        try {
            const attFile = path.join(__dirname, 'attempts_db.json');
            if (fs.existsSync(attFile)) {
                const db = JSON.parse(await fs.promises.readFile(attFile, 'utf8')) || {};
                Object.keys(db).forEach(k => candidateEmails.add(k.split('__')[0]));
            }
        } catch {}

        try {
            const profileKeys = await stateStore.execCommand(['KEYS', 'user:profile:*']);
            if (Array.isArray(profileKeys)) {
                profileKeys.forEach(k => candidateEmails.add(k.replace(/^user:profile:/i, '').toLowerCase()));
            }
        } catch {}

        for (const email of candidateEmails) {
            if (getStudentWatermarkBits(email) === bits) {
                return res.json({
                    success: true,
                    leakerEmail: email,
                    fingerprintHex: parseInt(bits, 2).toString(16).toUpperCase().padStart(8, '0'),
                    message: `Match found! Leaked by registered student: ${email}`
                });
            }
        }

        return res.json({
            success: false,
            message: `Watermark signature extracted (${parseInt(bits, 2).toString(16).toUpperCase()}), but no matching email was found in current records.`
        });
    } catch {
        return res.status(500).json({ success: false, error: 'Failed to decode watermark.' });
    }
});

// ============================================================================
// 6. RAZORPAY ORDER & PAYMENT VERIFICATION ENDPOINTS
// ============================================================================
app.post('/api/create-order', async (req, res) => {
    try {
        if (!razorpay) return res.status(503).json({ error: 'Payments are currently unavailable.' });
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const { itemId } = req.body;
        if (!itemId) return res.status(400).json({ error: 'Missing item ID.' });

        const cleanId = path.basename(String(itemId)).trim();
        let actualPrice = 49; // Default fallback

        // Look up the true price on the server
        if (cleanId.toUpperCase().endsWith('.PDF')) {
            actualPrice = parsePdfMetadata(cleanId).price || 49;
        } else {
            const quizPath = resolveSafeQuizPath(cleanId);
            if (!quizPath) return res.status(404).json({ error: 'Item not found.' });
            const content = getCachedQuizContent(quizPath);
            actualPrice = Number(content.price) > 0 ? Number(content.price) : 49;
        }

        const order = await razorpay.orders.create({
            amount: Math.round(actualPrice * 100), // Enforce server-side price
            currency: "INR",
            receipt: `rcpt_${Date.now().toString().slice(-8)}`,
            notes: { itemId: cleanId }
        });
        
        res.json({ success: true, orderId: order.id, amount: order.amount, keyId: CLEAN_RAZORPAY_KEY_ID });
    } catch (err) {
        console.error('Order creation error:', err);
        const rzpErr = err?.error?.description || err?.message || 'Order creation failed.';
        res.status(500).json({ error: rzpErr });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, itemId } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !itemId) {
            return res.status(400).json({ error: 'Missing payment verification details.' });
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
            .update(body.toString())
            .digest('hex');

        if (safeCompareHex(expectedSignature, razorpay_signature)) {
            const tenYearsSec = 60 * 60 * 24 * 365 * 10;
            await stateStore.set(`user:purchases:${authCheck.email}:${itemId}`, '1', tenYearsSec);
            await stateStore.sadd(`user:purchases:${authCheck.email}`, itemId);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Invalid payment signature.' });
        }
    } catch (err) {
        console.error('Payment verification error:', err);
        res.status(500).json({ error: 'Payment verification failed.' });
    }
});
// Server-Side Webhook to catch dropped connections during payment
app.post('/api/razorpay-webhook', express.json({ type: 'application/json' }), async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (webhookSecret) {
            const signature = req.get('X-Razorpay-Signature');
            const expectedSig = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(req.body)).digest('hex');
            if (!safeCompareHex(signature, expectedSig)) {
                return res.status(400).json({ error: 'Invalid webhook signature' });
            }
        }

        const event = req.body.event;
        if (event === 'payment.captured' || event === 'payment.authorized') {
            const payment = req.body.payload.payment.entity;
            const email = payment.email;
            const itemId = payment.notes?.itemId;
            
            if (email && itemId) {
                const tenYearsSec = 60 * 60 * 24 * 365 * 10;
                await stateStore.set(`user:purchases:${email.toLowerCase()}:${itemId}`, '1', tenYearsSec);
                await stateStore.sadd(`user:purchases:${email.toLowerCase()}`, itemId);
                console.log(`[Webhook] Recovered/Logged purchase for ${email} -> ${itemId}`);
            }
        }
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: 'Webhook processing failed.' });
    }
});

// ============================================================================
// 7. CONTENT & EXAM API ENDPOINTS
// ============================================================================
function parsePdfMetadata(fileName) {
    let isAvailable = true;
    let isPremium = false;
    let isUltra = false;
    let price = 0;
    let cleanFileName = fileName;

    if (cleanFileName.toUpperCase().startsWith('SOON_')) {
        isAvailable = false;
        cleanFileName = cleanFileName.replace(/^SOON_/i, '');
    } else if (cleanFileName.toUpperCase().startsWith('ULTRA_') || cleanFileName.toUpperCase().startsWith('PRO_')) {
        isPremium = true;
        if (cleanFileName.toUpperCase().startsWith('ULTRA_')) {
            isUltra = true;
        }
        const priceMatch = cleanFileName.match(/^(?:PRO|ULTRA)_(\d+)_/i);
        if (priceMatch) {
            price = parseInt(priceMatch[1], 10);
            cleanFileName = cleanFileName.replace(/^(?:PRO|ULTRA)_\d+_/i, '');
        } else {
            price = 49;
            cleanFileName = cleanFileName.replace(/^(?:PRO|ULTRA)_/i, '');
        }
    }

    const title = path.basename(cleanFileName, '.pdf')
        .replace(/[_]/g, ' ')
        .replace(/-/g, ' ')
        .replace(/class\s*(9|10|11|12|ix|x|xi|xii)/gi, '')
        .replace(/(physics|chemistry|biology)/gi, '')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());

    return {
        name: title || cleanFileName,
        fileName,
        isAvailable,
        isPremium,
        isUltra,
        price
    };
}

app.get('/api/descriptive-questions', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const now = Date.now();
        if (fsCache.descList.data && now < fsCache.descList.expiresAt) return res.json(fsCache.descList.data);

        const files = getCachedDescFiles();
        const grouped = {
            'IX': { Physics: [], Chemistry: [], Biology: [] },
            'X': { Physics: [], Chemistry: [], Biology: [] },
            'XI': { Biology: [] },
            'XII': { Biology: [] }
        };

        files.forEach(fullPath => {
            const fileName = path.basename(fullPath);
            const lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
            let cls = 'XI';
            if (lowerPath.includes('/ix/') || lowerPath.includes('class9') || lowerPath.includes('class_9') || lowerPath.includes('class-9')) cls = 'IX';
            else if (lowerPath.includes('/x/') || lowerPath.includes('class10') || lowerPath.includes('class_10') || lowerPath.includes('class-10')) cls = 'X';
            else if (lowerPath.includes('/xi/') || lowerPath.includes('class11') || lowerPath.includes('class_11') || lowerPath.includes('class-11')) cls = 'XI';
            else if (lowerPath.includes('/xii/') || lowerPath.includes('class12') || lowerPath.includes('class_12') || lowerPath.includes('class-12')) cls = 'XII';

            let subject = 'Biology';
            if (lowerPath.includes('physics')) subject = 'Physics';
            else if (lowerPath.includes('chemistry')) subject = 'Chemistry';

            let itemMeta;
            if (fileName.toLowerCase().endsWith('.json')) {
                const c = getCachedQuizContent(fullPath);
                const fileBase = fileName.replace(/\.json$/i, '');
                const isUltra = c.isUltra === true || fileBase.toUpperCase().startsWith('ULTRA_');
                const isPremium = isUltra || c.isPremium === true || fileBase.toUpperCase().startsWith('PRO_');
                const isAvailable = c.isAvailable !== false && !fileBase.toUpperCase().startsWith('SOON_');
                itemMeta = {
                    id: fileBase,
                    title: c.title || fileBase,
                    name: c.title || fileBase,
                    fileName: fileName,
                    isJsonQuiz: true,
                    duration: c.duration || 900,
                    isAvailable,
                    isPremium,
                    isUltra,
                    price: Number(c.price) > 0 ? Number(c.price) : 49
                };
            } else {
                itemMeta = parsePdfMetadata(fileName);
            }

            if (grouped[cls] && grouped[cls][subject]) {
                grouped[cls][subject].push(itemMeta);
            }
        });

        const formatted = [];
        for (const [cls, subjects] of Object.entries(grouped)) {
            for (const [sub, list] of Object.entries(subjects)) {
                if (list.length > 0) formatted.push({ class: cls, subject: sub, papers: list });
            }
        }

        fsCache.descList = { data: formatted, expiresAt: now + CACHE_TTL_MS };
        res.json(formatted);
    } catch (err) {
        console.error('Error reading descriptive questions:', err);
        res.status(500).json([]);
    }
});

// Protected Download Route for Descriptive Papers
app.get('/api/download-descriptive/:fileName', async (req, res) => {
    const rawFileName = String(req.params.fileName || '');
    const upperName = rawFileName.toUpperCase();

    if (upperName.startsWith('SOON_')) {
        return res.status(403).send("This paper is not yet available.");
    }

    // Require Auth for ALL downloads
    const token = extractAuthToken(req);
    const authCheck = await verifyAuthToken(token);
    if (!authCheck.valid) {
        return res.status(401).send("Authentication required. Please sign in on the homepage.");
    }
    syncAuthCookieIfNeeded(req, res, token);

    const isUltra = upperName.startsWith('ULTRA_');
    const isPremium = isUltra || upperName.startsWith('PRO_');
    
    // Check if they are allowed (handles free vs premium vs ultra via our updated function)
    const hasAccess = await checkContentAccess(authCheck.email, rawFileName, isPremium, isUltra);
    if (!hasAccess) {
        return res.status(403).send(isUltra ? "Purchase required to access this Ultra content." : "Your email is not whitelisted for this premium material.");
    }

    const clientIp = getClientIp(req);
    const allowed = await stateStore.checkRateLimit('dl', clientIp, 10, 15 * 60);
    if (!allowed) return res.status(429).send("Rate limit exceeded. Try again in 15 minutes.");


    const filePath = resolveSafeDescriptivePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Descriptive paper not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download file.");
    });
});

app.get('/api/notes', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const now = Date.now();
        if (fsCache.notesList.data && now < fsCache.notesList.expiresAt) return res.json(fsCache.notesList.data);

        const files = getCachedNoteFiles();
        const grouped = {
            'IX': { Physics: [], Chemistry: [], Biology: [] },
            'X': { Physics: [], Chemistry: [], Biology: [] },
            'XI': { Biology: [] },
            'XII': { Biology: [] }
        };

        files.forEach(fullPath => {
            const fileName = path.basename(fullPath);
            const lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
            let cls = 'XI';
            if (lowerPath.includes('/ix/') || lowerPath.includes('class9') || lowerPath.includes('class_9') || lowerPath.includes('class-9')) cls = 'IX';
            else if (lowerPath.includes('/x/') || lowerPath.includes('class10') || lowerPath.includes('class_10') || lowerPath.includes('class-10')) cls = 'X';
            else if (lowerPath.includes('/xi/') || lowerPath.includes('class11') || lowerPath.includes('class_11') || lowerPath.includes('class-11')) cls = 'XI';
            else if (lowerPath.includes('/xii/') || lowerPath.includes('class12') || lowerPath.includes('class_12') || lowerPath.includes('class-12')) cls = 'XII';

            let subject = 'Biology';
            if (lowerPath.includes('physics')) subject = 'Physics';
            else if (lowerPath.includes('chemistry')) subject = 'Chemistry';

            const itemMeta = parsePdfMetadata(fileName);
            if (grouped[cls] && grouped[cls][subject]) {
                grouped[cls][subject].push(itemMeta);
            }
        });

        const formatted = [];
        for (const [cls, subjects] of Object.entries(grouped)) {
            for (const [sub, list] of Object.entries(subjects)) {
                if (list.length > 0) formatted.push({ class: cls, subject: sub, notes: list });
            }
        }

        fsCache.notesList = { data: formatted, expiresAt: now + CACHE_TTL_MS };
        res.json(formatted);
    } catch (err) {
        console.error('Error reading notes directory:', err);
        res.status(500).json([]);
    }
});

// Protected Download Route for Study Notes
app.get('/api/download-note/:fileName', async (req, res) => {
    const rawFileName = String(req.params.fileName || '');
    const upperName = rawFileName.toUpperCase();

    if (upperName.startsWith('SOON_')) {
        return res.status(403).send("This note is not yet available.");
    }

    // Require Auth for ALL downloads
    const token = extractAuthToken(req);
    const authCheck = await verifyAuthToken(token);
    if (!authCheck.valid) {
        return res.status(401).send("Authentication required. Please sign in on the homepage.");
    }
    syncAuthCookieIfNeeded(req, res, token);

    const isUltra = upperName.startsWith('ULTRA_');
    const isPremium = isUltra || upperName.startsWith('PRO_');
    
    // Check if they are allowed (handles free vs premium vs ultra via our updated function)
    const hasAccess = await checkContentAccess(authCheck.email, rawFileName, isPremium, isUltra);
    if (!hasAccess) {
        return res.status(403).send(isUltra ? "Purchase required to access this Ultra content." : "Your email is not whitelisted for this premium material.");
    }

    const clientIp = getClientIp(req);
    const allowed = await stateStore.checkRateLimit('dl', clientIp, 10, 15 * 60);
    if (!allowed) return res.status(429).send("Rate limit exceeded. Try again in 15 minutes.");


    const filePath = resolveSafeNotePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Note file not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download note.");
    });
});

app.get('/api/quizzes', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const now = Date.now();
        if (fsCache.quizzesList.data && now < fsCache.quizzesList.expiresAt) return res.json({ success: true, quizzes: fsCache.quizzesList.data });

        const allFiles = getCachedQuizFiles();
        const list = allFiles.map(fp => {
            try {
                const c = getCachedQuizContent(fp);
                const fileBase = path.basename(fp, '.json');
                const isUltra = c.isUltra === true || fileBase.toUpperCase().startsWith('ULTRA_');
                const isPremium = isUltra || c.isPremium === true || fileBase.toUpperCase().startsWith('PRO_');
                const isAvailable = c.isAvailable !== false && !fileBase.toUpperCase().startsWith('SOON_');

                return {
                    id: fileBase,
                    title: c.title || fileBase,
                    category: c.category || 'general',
                    classLevel: c.classLevel || 'xi',
                    subject: c.subject || 'general',
                    unit: c.unit || '',
                    chapter: c.chapter || '',
                    topic: c.topic || '',
                    duration: c.duration || 900,
                    totalQuestions: c.questions ? c.questions.length : 0,
                    isAvailable,
                    isPremium,
                    isUltra,
                    price: Number(c.price) > 0 ? Number(c.price) : 49
                };
            } catch { return null; }
        }).filter(Boolean);

        fsCache.quizzesList = { data: list, expiresAt: now + CACHE_TTL_MS };
        res.json({ success: true, quizzes: list });
    } catch {
        res.status(500).json({ success: false, quizzes: [] });
    }
});

// Returns XOR Encrypted Questions
// 1. Initial Quiz Verification (Returns saved scorecard if already attempted, else total count)
app.get('/api/quiz/:id', async (req, res) => {
    try {
        if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token, null, false);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const cleanId = path.basename(String(req.params.id || '')).trim();
        const filePath = resolveSafeQuizPath(cleanId);
        if (!filePath) return res.status(404).json({ error: "Not found" });

        const content = getCachedQuizContent(filePath);
        const isAvailable = content.isAvailable !== false && !cleanId.toUpperCase().startsWith('SOON_');
        if (!isAvailable) return res.status(403).json({ error: "This test is not yet available." });

        const isUltra = content.isUltra === true || cleanId.toUpperCase().startsWith('ULTRA_');
        const isPremium = isUltra || content.isPremium === true || cleanId.toUpperCase().startsWith('PRO_');
        if (isPremium) {
            const hasAccess = await checkContentAccess(authCheck.email, cleanId, isPremium, isUltra);
            if (!hasAccess) return res.status(402).json({ error: "Payment required to access this content." });
        }

        const existingAttemptPayload = await buildSavedAttemptResponse(authCheck.email, cleanId, content);
        if (existingAttemptPayload) {
            return res.json(existingAttemptPayload);
        }

        const session = await getOrCreateExamSession(authCheck.signature, cleanId, null, false);
        if (session.error) return res.status(403).json({ error: session.error });

        res.json({ totalQuestions: (content.questions || []).length });
    } catch {
        res.status(500).json({ error: "Failed to read quiz file." });
    }
});

// 2. JIT Single Question Delivery (Protected by Velocity Wall, Device Lock & Invisible Steganography)
app.get('/api/quiz/:id/question/:index', async (req, res) => {
    try {
        if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token, null, false);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        // Layer 2: Per-Student Anti-Scraping Velocity Wall (allows normal clicking, blocks automated bulk dumpers)
        if (!checkRamVelocity(authCheck.email, 'q_fetch_burst', 5, 3000)) {
            return res.status(429).json({ error: "Fetching questions too rapidly. Please wait a moment." });
        }

        const cleanId = path.basename(String(req.params.id || '')).trim();
        const index = parseInt(req.params.index, 10);
        const filePath = resolveSafeQuizPath(cleanId);

        const sessionKey = `exam:session:${authCheck.signature}`;
        const rawSession = await stateStore.get(sessionKey);
        if (!rawSession) return res.status(403).json({ error: "No active session." });

        const session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;

        // Layer 3: Device-Class Session Lock Verification
        const savedDevice = await stateStore.get(`exam:device:${authCheck.signature}`);
        const currentDevice = getCoarseDeviceSignature(req);
        if (savedDevice && savedDevice !== currentDevice) {
            return res.status(403).json({ error: "Security Violation: Concurrent access from a different device detected." });
        }

        const seedKey = session.signature || authCheck.signature;

        const content = getCachedQuizContent(filePath);
        const rawQuestions = content.questions || [];
        if (index < 0 || index >= rawQuestions.length) return res.status(400).json({ error: "Invalid index." });

        const qOrder = getDeterministicPermutation(rawQuestions.length, `${seedKey}:${cleanId}:q`);
        const origIdx = qOrder[index];
        const q = rawQuestions[origIdx];
        const qType = q.type || 'mcq';
        let clientOptions = q.options || [];

        if (qType === 'mcq' && Array.isArray(q.options) && q.options.length > 1) {
            const optOrder = getSafeOptionPermutation(q.options, `${seedKey}:${cleanId}:opt:${origIdx}`);
            clientOptions = optOrder.map(oIdx => q.options[oIdx]);
        }

        // Layer 2: Embed invisible zero-width student fingerprint into question text
        const watermarkedQuestion = embedInvisibleWatermark(q.question, authCheck.email);
        const sanitized = { type: qType, question: watermarkedQuestion, options: clientOptions };
        const payload = xorCipher(JSON.stringify(sanitized), seedKey);

        res.json({ payload });
    } catch {
        res.status(500).json({ error: "Failed to fetch question." });
    }
});

app.post('/api/start-quiz', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token, null, false);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });
        syncAuthCookieIfNeeded(req, res, token);

        const { quizId, duration } = req.body;
        const cleanId = path.basename(String(quizId || '')).trim();
        const filePath = resolveSafeQuizPath(cleanId);
        if (!filePath) return res.status(400).json({ error: "Invalid quiz ID." });

        const content = getCachedQuizContent(filePath);
        const isAvailable = content.isAvailable !== false && !cleanId.toUpperCase().startsWith('SOON_');
        if (!isAvailable) {
            return res.status(403).json({ error: "This test is not yet available." });
        }

        const isUltra = content.isUltra === true || cleanId.toUpperCase().startsWith('ULTRA_');
        const isPremium = isUltra || content.isPremium === true || cleanId.toUpperCase().startsWith('PRO_');
        if (isPremium) {
            const hasAccess = await checkContentAccess(authCheck.email, cleanId, isPremium, isUltra);
            if (!hasAccess) {
                return res.status(402).json({ error: "Payment required to access this content." });
            }
        }

        const existingAttemptPayload = await buildSavedAttemptResponse(authCheck.email, cleanId, content);
        if (existingAttemptPayload) {
            return res.json(existingAttemptPayload);
        }

        const session = await getOrCreateExamSession(authCheck.signature, cleanId, duration, true);
        if (session.error) return res.status(403).json({ error: session.error });

        // Layer 3: Lock this exam session to the student's current device class
        const currentDevice = getCoarseDeviceSignature(req);
        await stateStore.set(`exam:device:${authCheck.signature}`, currentDevice, 60 * 60 * 6);

        res.json({
            startTime: session.startTime,
            duration: session.duration,
            signature: session.signature,
            cipherKey: session.xorKey
        });
    } catch {
        res.status(500).json({ error: "Failed to start quiz session." });
    }
});

const USERS_FILE_PATH = path.join(__dirname, 'users.json');

async function getRegisteredStudentProfile(rawEmail) {
    const cleanEmail = String(rawEmail || '').trim().toLowerCase();
    if (!cleanEmail) return null;

    // 1. Check Redis Permanent Profile Store
    try {
        const rawProfile = await stateStore.get(`user:profile:${cleanEmail}`);
        if (rawProfile) {
            const parsed = typeof rawProfile === 'string' ? JSON.parse(rawProfile) : rawProfile;
            if (parsed && parsed.firstName && parsed.lastName) return parsed;
        }
    } catch {}

    // 2. Check Local users.json Backup File
    try {
        if (fs.existsSync(USERS_FILE_PATH)) {
            const usersMap = JSON.parse(await fs.promises.readFile(USERS_FILE_PATH, 'utf8'));
            if (usersMap && usersMap[cleanEmail] && usersMap[cleanEmail].firstName) {
                const profile = usersMap[cleanEmail];
                const tenYearsSec = 60 * 60 * 24 * 365 * 10;
                await stateStore.set(`user:profile:${cleanEmail}`, profile, tenYearsSec);
                return profile;
            }
        }
    } catch {}

    // 3. Fallback: Check Historical Quiz Submissions so past students are automatically recognized
    try {
        const history = await getHistoricalSubmissions();
        for (let i = history.length - 1; i >= 0; i--) {
            const item = history[i];
            if (item && String(item.email || '').trim().toLowerCase() === cleanEmail && item.firstName && item.lastName) {
                const profile = {
                    firstName: String(item.firstName).trim().toUpperCase(),
                    lastName: String(item.lastName).trim().toUpperCase(),
                    email: cleanEmail
                };
                await saveRegisteredStudentProfile(cleanEmail, profile.firstName, profile.lastName);
                return profile;
            }
        }
    } catch {}

    return null;
}

// Wipe local legacy OTP users.json once on startup
try {
    if (fs.existsSync(USERS_FILE_PATH)) fs.unlinkSync(USERS_FILE_PATH);
} catch {}

async function saveRegisteredStudentProfile(rawEmail, firstName, lastName) {
    const cleanEmail = String(rawEmail || '').trim().toLowerCase();
    const profile = {
        firstName: String(firstName || '').trim().toUpperCase().slice(0, 60),
        lastName: String(lastName || '').trim().toUpperCase().slice(0, 60),
        email: cleanEmail,
        updatedAt: new Date().toISOString()
    };
    const tenYearsSec = 60 * 60 * 24 * 365 * 10;
    await stateStore.set(`user:profile:${cleanEmail}`, profile, tenYearsSec);

    try {
        let usersMap = {};
        if (fs.existsSync(USERS_FILE_PATH)) {
            usersMap = JSON.parse(await fs.promises.readFile(USERS_FILE_PATH, 'utf8')) || {};
        }
        usersMap[cleanEmail] = profile;
        await fs.promises.writeFile(USERS_FILE_PATH, JSON.stringify(usersMap, null, 2), { mode: 0o600 });
    } catch {}
    return profile;
}

app.post('/api/auth/google', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const allowed = await stateStore.checkRateLimit('verify', clientIp, 20, 15 * 60);
        if (!allowed) {
            return res.status(429).json({ success: false, error: 'Too many sign-in attempts. Please wait 15 minutes.' });
        }

        const expectedClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
        if (!expectedClientId) {
            return res.status(500).json({ success: false, error: 'Server missing GOOGLE_CLIENT_ID configuration.' });
        }

        const { accessToken, credential } = req.body || {};
        let email = '';
        let googleFirstName = '';
        let googleLastName = '';

        if (accessToken && typeof accessToken === 'string') {
            // 1. Verify the access token belongs to our GOOGLE_CLIENT_ID
            const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
            if (!tokenInfoRes.ok) {
                return res.status(401).json({ success: false, error: 'Invalid Google access token.' });
            }
            const tokenInfo = await tokenInfoRes.json();
            if (tokenInfo.aud !== expectedClientId && tokenInfo.azp !== expectedClientId) {
                return res.status(403).json({ success: false, error: 'Security Alert: Client ID mismatch.' });
            }

            // 2. Fetch the user's verified Google profile details
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!profileRes.ok) {
                return res.status(401).json({ success: false, error: 'Could not retrieve Google profile.' });
            }
            const profile = await profileRes.json();
            if (!profile.email || !profile.email_verified) {
                return res.status(400).json({ success: false, error: 'Google account email is not verified.' });
            }

            email = String(profile.email).trim().toLowerCase();
            googleFirstName = String(profile.given_name || (profile.name ? profile.name.split(' ')[0] : 'STUDENT')).trim().toUpperCase().slice(0, 60);
            googleLastName = String(profile.family_name || (profile.name && profile.name.split(' ').length > 1 ? profile.name.split(' ').slice(1).join(' ') : '.')).trim().toUpperCase().slice(0, 60);
        } else if (credential && typeof credential === 'string') {
            // Verify Google One Tap ID token
            const idRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
            if (!idRes.ok) {
                return res.status(401).json({ success: false, error: 'Invalid Google ID token.' });
            }
            const idInfo = await idRes.json();
            if (idInfo.aud !== expectedClientId) {
                return res.status(403).json({ success: false, error: 'Security Alert: Client ID mismatch.' });
            }
            if (!idInfo.email || String(idInfo.email_verified) !== 'true') {
                return res.status(400).json({ success: false, error: 'Google account email is not verified.' });
            }

            email = String(idInfo.email).trim().toLowerCase();
            googleFirstName = String(idInfo.given_name || (idInfo.name ? idInfo.name.split(' ')[0] : 'STUDENT')).trim().toUpperCase().slice(0, 60);
            googleLastName = String(idInfo.family_name || (idInfo.name && idInfo.name.split(' ').length > 1 ? idInfo.name.split(' ').slice(1).join(' ') : '.')).trim().toUpperCase().slice(0, 60);
        } else {
            return res.status(400).json({ success: false, error: 'Missing Google authentication token.' });
        }

        // Single-use replay lock: burn this Google token in Redis for 1 hour so it can never be reused
        const rawGoogleToken = String(accessToken || credential || '');
        const googleTokenHash = crypto.createHash('sha256').update(rawGoogleToken).digest('hex');
        const isFreshGoogleToken = await stateStore.setNx(`used:gtoken:${googleTokenHash}`, '1', 3600);
        if (!isFreshGoogleToken) {
            return res.status(401).json({ success: false, error: 'Security Alert: This Google sign-in token has already been used.' });
        }

        // Always use and sync the student's verified Google Account name
        const finalFirstName = googleFirstName || 'STUDENT';
        const finalLastName = googleLastName || '.';
        await stateStore.del(`blacklist:email:${email}`); // Clear deregistration block so they can re-register
        await saveRegisteredStudentProfile(email, finalFirstName, finalLastName);

        const tokenData = `${email}|${encodeURIComponent(finalFirstName)}|${encodeURIComponent(finalLastName)}|${Date.now()}|G2_${crypto.randomBytes(8).toString('hex')}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
        const authToken = `${tokenData}|||${signature}`;

        await stateStore.set(`ip:verified:${clientIp}`, '1', TOKEN_MAX_AGE_SEC);

        res.cookie(AUTH_COOKIE_NAME, authToken, {
            httpOnly: true,
            secure: isSecureConnection(req),
            sameSite: 'strict',
            maxAge: TOKEN_MAX_AGE_MS,
            path: '/'
        });

        res.json({
            success: true,
            token: authToken,
            firstName: finalFirstName,
            lastName: finalLastName,
            email
        });
    } catch (err) {
        console.error('Google Auth Error:', err);
        res.status(500).json({ success: false, error: 'Google authentication failed.' });
    }
});
// Spam-Proof 6-Digit Verification Code Sender (No External Links or Emojis to Trigger Phishing Filters)
app.post('/api/auth/mail-app/send', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const allowed = await stateStore.checkRateLimit('mail_send', clientIp, 6, 10 * 60);
        if (!allowed) return res.status(429).json({ success: false, error: 'Too many requests. Please wait a few minutes.' });

        const rawEmail = String(req.body.email || '').trim().toLowerCase();
        if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
        }

        const existingProfile = await getRegisteredStudentProfile(rawEmail);
        const code = String(crypto.randomInt(100000, 999999));
        await stateStore.set(`mailauth:otp:${rawEmail}`, code, 600); // Valid 10 mins

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (!scriptURL || !APPS_SECRET) {
            return res.status(500).json({ success: false, error: 'Mail service not configured on server.' });
        }

        await fetch(scriptURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send_otp',
                type: 'otp',
                email: rawEmail,
                targetEmail: rawEmail,
                otp: code,
                code: code,
                subject: `Pioneers Prep Verification Code: ${code}`,
                plainBody: `Your Pioneers Prep verification code is ${code}. This code is valid for 10 minutes. Do not share this code with anyone.`,
                breakdown: `<div style="font-family:Arial,sans-serif;padding:20px;border:1px solid #e2e8f0;border-radius:8px;max-width:440px;color:#0f172a;">
                    <h3 style="margin:0 0 12px 0;color:#1e3a8a;">Pioneers Prep Account Verification</h3>
                    <p style="font-size:14px;color:#334155;margin:0 0 14px 0;">Use the 6-digit verification code below to complete your sign-in:</p>
                    <div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#0f172a;background:#f8fafc;border:1px solid #cbd5e1;padding:12px;text-align:center;border-radius:6px;margin:14px 0;">${code}</div>
                    <p style="font-size:12px;color:#64748b;margin:14px 0 0 0;">This code is valid for 10 minutes. If you did not request this code, you can safely ignore this email.</p>
                </div>`,
                secretKey: APPS_SECRET
            })
        });

        res.json({
            success: true,
            hasExistingProfile: Boolean(existingProfile && existingProfile.firstName && existingProfile.firstName !== 'STUDENT'),
            firstName: existingProfile ? existingProfile.firstName : '',
            lastName: existingProfile ? existingProfile.lastName : ''
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not send verification email.' });
    }
});

// 1-Tap Magic Link Handler (Approves original iOS Safari/PWA tab AND signs in current tab)
app.get('/api/auth/mail-app/magic', async (req, res) => {
    try {
        const rawT = String(req.query.t || '');
        if (!rawT) return res.status(400).send('Invalid sign-in link.');

        const decoded = Buffer.from(rawT, 'base64url').toString('utf8');
        if (!decoded.includes('|||')) return res.status(400).send('Malformed sign-in link.');

        const [magicPayload, sig] = decoded.split('|||');
        const expectedSig = crypto.createHmac('sha256', SECRET).update(`MAGIC:${magicPayload}`).digest('hex');
        if (!safeCompareHex(sig, expectedSig)) return res.status(403).send('Invalid or expired sign-in link.');

        const [cleanEmail, pollId, issuedAtStr] = magicPayload.split('|');
        const issuedAt = parseInt(issuedAtStr, 10);
        if (!cleanEmail || isNaN(issuedAt) || (Date.now() - issuedAt) > 10 * 60 * 1000) {
            return res.status(403).send('This sign-in link has expired. Please request a new one.');
        }

        const existingProfile = await getRegisteredStudentProfile(cleanEmail);
        const finalFirstName = (existingProfile && existingProfile.firstName) ? existingProfile.firstName : cleanEmail.split('@')[0].toUpperCase().slice(0, 60);
        const finalLastName = (existingProfile && existingProfile.lastName) ? existingProfile.lastName : '.';

        await stateStore.del(`blacklist:email:${cleanEmail}`);
        await saveRegisteredStudentProfile(cleanEmail, finalFirstName, finalLastName);

        const tokenData = `${cleanEmail}|${encodeURIComponent(finalFirstName)}|${encodeURIComponent(finalLastName)}|${Date.now()}|G2_${crypto.randomBytes(8).toString('hex')}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
        const authToken = `${tokenData}|||${signature}`;

        const clientIp = getClientIp(req);
        await stateStore.set(`ip:verified:${clientIp}`, '1', TOKEN_MAX_AGE_SEC);

        if (pollId) {
            await stateStore.set(`mailauth:poll:${pollId}`, JSON.stringify({
                status: 'approved',
                token: authToken,
                firstName: finalFirstName,
                lastName: finalLastName,
                email: cleanEmail
            }), 300);
        }

        res.cookie(AUTH_COOKIE_NAME, authToken, {
            httpOnly: true,
            secure: isSecureConnection(req),
            sameSite: 'strict',
            maxAge: TOKEN_MAX_AGE_MS,
            path: '/'
        });

        const nonce = res.locals.cspNonce;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Signed In — Pioneers Prep</title></head>
        <body style="font-family:-apple-system,sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;text-align:center;">
            <div style="background:#fff;padding:28px;border-radius:16px;max-width:380px;width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.08);border:1px solid #e2e8f0;">
                <div style="font-size:44px;margin-bottom:10px;">✅</div>
                <h2 style="color:#0f172a;margin:0 0 8px 0;">Signed In Successfully!</h2>
                <p style="color:#475569;font-size:14px;margin:0 0 18px 0;">Welcome, <strong>${escapeHtml(finalFirstName)}</strong>. Your session is now active.</p>
                <a href="/" style="display:block;background:#2563eb;color:#fff;text-decoration:none;padding:12px;border-radius:10px;font-weight:bold;font-size:15px;">Continue to Pioneers Prep &rarr;</a>
            </div>
            <script nonce="${nonce}">
                try {
                    localStorage.setItem('pp_auth_provider', 'google_v2');
                    localStorage.setItem('pp_id_token', ${JSON.stringify(authToken)});
                    localStorage.setItem('pp_fname', ${JSON.stringify(finalFirstName)});
                    localStorage.setItem('pp_lname', ${JSON.stringify(finalLastName)});
                    localStorage.setItem('pp_email', ${JSON.stringify(cleanEmail)});
                    var target = sessionStorage.getItem('pp_post_login_redirect') || '/';
                    sessionStorage.removeItem('pp_post_login_redirect');
                    setTimeout(function() { window.location.replace(target); }, 600);
                } catch (e) {}
            </script>
        </body></html>`);
    } catch (err) {
        res.status(500).send('Sign-in failed. Please try again.');
    }
});

// Cross-App Polling Endpoint (Auto-completes login in Safari/PWA as soon as user taps Magic Link in Apple Mail/Gmail)
app.get('/api/auth/mail-app/poll', async (req, res) => {
    try {
        const pollId = String(req.query.pollId || '').trim();
        if (!pollId) return res.json({ approved: false });

        const raw = await stateStore.get(`mailauth:poll:${pollId}`);
        if (!raw) return res.json({ approved: false });

        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data && data.status === 'approved' && data.token) {
            await stateStore.del(`mailauth:poll:${pollId}`);
            res.cookie(AUTH_COOKIE_NAME, data.token, {
                httpOnly: true,
                secure: isSecureConnection(req),
                sameSite: 'strict',
                maxAge: TOKEN_MAX_AGE_MS,
                path: '/'
            });
            return res.json({
                approved: true,
                success: true,
                token: data.token,
                firstName: data.firstName,
                lastName: data.lastName,
                email: data.email
            });
        }
        res.json({ approved: false });
    } catch (err) {
        res.json({ approved: false });
    }
});

app.post('/api/auth/mail-app/verify', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const allowed = await stateStore.checkRateLimit('mail_verify', clientIp, 15, 15 * 60);
        if (!allowed) return res.status(429).json({ success: false, error: 'Too many attempts. Please wait.' });

        const cleanEmail = String(req.body.email || '').trim().toLowerCase();
        const code = String(req.body.code || '').trim();
        const inputFirst = String(req.body.firstName || '').trim().toUpperCase().slice(0, 60);
        const inputLast = String(req.body.lastName || '').trim().toUpperCase().slice(0, 60);

        if (!cleanEmail || !code) {
            return res.status(400).json({ success: false, error: 'Email and verification code are required.' });
        }

        const savedCode = await stateStore.get(`mailauth:otp:${cleanEmail}`);
        if (!savedCode || !safeCompareStrings(String(savedCode), code)) {
            return res.status(401).json({ success: false, error: 'Invalid or expired code. Please check your Gmail / Mail app.' });
        }
        await stateStore.del(`mailauth:otp:${cleanEmail}`);

        const existingProfile = await getRegisteredStudentProfile(cleanEmail);
        const finalFirstName = inputFirst || (existingProfile ? existingProfile.firstName : cleanEmail.split('@')[0].toUpperCase());
        const finalLastName = inputLast || (existingProfile ? existingProfile.lastName : '.');

        await stateStore.del(`blacklist:email:${cleanEmail}`);
        await saveRegisteredStudentProfile(cleanEmail, finalFirstName, finalLastName);

        const tokenData = `${cleanEmail}|${encodeURIComponent(finalFirstName)}|${encodeURIComponent(finalLastName)}|${Date.now()}|G2_${crypto.randomBytes(8).toString('hex')}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
        const authToken = `${tokenData}|||${signature}`;

        await stateStore.set(`ip:verified:${clientIp}`, '1', TOKEN_MAX_AGE_SEC);

        res.cookie(AUTH_COOKIE_NAME, authToken, {
            httpOnly: true,
            secure: isSecureConnection(req),
            sameSite: 'strict',
            maxAge: TOKEN_MAX_AGE_MS,
            path: '/'
        });

        res.json({
            success: true,
            token: authToken,
            firstName: finalFirstName,
            lastName: finalLastName,
            email: cleanEmail
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Verification failed.' });
    }
});

// Secure Logout Endpoint (Token Revocation)
app.post('/api/logout', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        if (token) {
            const parts = token.split('|||');
            if (parts.length === 2) {
                const signature = parts[1];
                await stateStore.set(`blacklist:token:${signature}`, '1', TOKEN_MAX_AGE_SEC);
            }
        }
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
// Implementation 7: Per-Exam Replay Lock, Persistent Cookie & Redis Leaderboard
app.post('/api/submit', preSubmitSecurityGuard, (req, res, next) => {
    submitJsonParser(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, error: 'Invalid or oversized submission payload.' });
        }
        next();
    });
}, async (req, res) => {
    const rawEmail = req.body.email ? String(req.body.email).trim().toLowerCase().slice(0, 120) : null;
    const { className, chapterTitle, quizId, userAnswers, serverStartTime, timerSignature, quizDuration } = req.body;

    const tokenToVerify = extractAuthToken(req);
    const authCheck = await verifyAuthToken(tokenToVerify, rawEmail, false);
    if (!authCheck.valid) {
        return res.status(401).json({ success: false, error: authCheck.error });
    }
    syncAuthCookieIfNeeded(req, res, tokenToVerify);

    const firstName = authCheck.firstName || (req.body.firstName ? String(req.body.firstName).trim().toUpperCase().slice(0, 60) : 'UNKNOWN');
    const lastName = authCheck.lastName || (req.body.lastName ? String(req.body.lastName).trim().toUpperCase().slice(0, 60) : 'NAME');
    const email = authCheck.email;

    const cleanQuizId = path.basename(String(quizId || '')).trim();
    const filePath = resolveSafeQuizPath(cleanQuizId);
    if (!filePath) {
        return res.status(400).json({ success: false, error: 'Invalid quiz ID.' });
    }

    const sessionKey = `exam:session:${authCheck.signature}`;
    const rawLockedSession = await stateStore.get(sessionKey);
    const lockedSession = rawLockedSession ? (typeof rawLockedSession === 'string' ? JSON.parse(rawLockedSession) : rawLockedSession) : null;

    const effectiveStartTime = (lockedSession && lockedSession.quizId === cleanQuizId) ? lockedSession.startTime : Number(serverStartTime);
    const effectiveDuration = (lockedSession && lockedSession.quizId === cleanQuizId) ? lockedSession.duration : Number(quizDuration);

    if (!effectiveStartTime || !timerSignature || !effectiveDuration) {
        return res.status(400).json({ success: false, error: 'Missing quiz timer credentials.' });
    }

    const expectedTimerSig = crypto.createHmac('sha256', SECRET).update(`${cleanQuizId}:${effectiveDuration}:${effectiveStartTime}`).digest('hex');
    if (!safeCompareHex(timerSignature, expectedTimerSig)) {
        return res.status(400).json({ success: false, error: 'Tampered timer token detected.' });
    }

    const elapsedSeconds = (Date.now() - effectiveStartTime) / 1000;
    if (elapsedSeconds < 0 || elapsedSeconds > effectiveDuration + 120) {
        return res.status(400).json({ success: false, error: 'Quiz time limit exceeded.' });
    }

    // Per-exam submission lock & replay guard (prevents double-submitting the same attempt without burning the global login token)
    const lockKey = `sub:lock:${expectedTimerSig}`;
    const acquired = await stateStore.setNx(lockKey, '1', 60);
    if (!acquired) {
        return res.status(429).json({ success: false, error: 'Submission is already being processed.' });
    }

    const markedUnused = await stateStore.setNx(`exam:used:${expectedTimerSig}`, '1', TOKEN_MAX_AGE_SEC);
    if (!markedUnused) {
        await stateStore.del(lockKey);
        return res.status(403).json({ success: false, error: 'This quiz attempt has already been submitted.' });
    }
    await stateStore.del(sessionKey);

    try {
        const safeUserAnswers = (userAnswers && typeof userAnswers === 'object') ? userAnswers : {};
        const content = getCachedQuizContent(filePath);
        const realQuestions = content.questions || [];

        let correctCount = 0, incorrectCount = 0, attemptedCount = 0;
        const totalCount = realQuestions.length;

        // Backward compatible seed check: supports both new per-exam signature seed and active pre-deploy authSignature seed
        const seedCandidates = [expectedTimerSig];
        if (authCheck.signature && authCheck.signature !== expectedTimerSig) {
            seedCandidates.push(authCheck.signature);
        }

        let bestEval = null;
        for (const seedKey of seedCandidates) {
            let cCount = 0, iCount = 0, aCount = 0;
            const qOrder = getDeterministicPermutation(totalCount, `${seedKey}:${cleanQuizId}:q`);
            const origToClientIndex = new Array(totalCount);
            qOrder.forEach((origIdx, clientIdx) => {
                origToClientIndex[origIdx] = clientIdx;
            });

            let html = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;"><tr style="background-color:#f1f5f9;text-align:left;"><th>#</th><th>Question</th><th>Student's Selection</th><th>Correct Option</th><th>Status</th></tr>`;

            realQuestions.forEach((q, origIndex) => {
                const clientIdx = origToClientIndex[origIndex];
                const response = safeUserAnswers[clientIdx.toString()] !== undefined ? safeUserAnswers[clientIdx.toString()] : safeUserAnswers[clientIdx];
                const attempted = response !== undefined && response !== null && response !== "";
                if (attempted) aCount++;

                let isCorrect = false, selText = "Skipped", corrText = "N/A", rawStatus = "Skipped", statusColor = "yellow";

                if (q.type === 'descriptive' || q.type === 'diagram') {
                    if (attempted && isSafeBase64Image(response)) selText = `<img src="${response.trim()}" style="max-width:200px;border-radius:4px;" />`;
                    else selText = attempted ? escapeHtml(String(response).slice(0, 2000)) : "Skipped";
                    corrText = escapeHtml(q.model_answer || "Refer to marking scheme");
                    if (attempted) { rawStatus = "Needs Review"; statusColor = "orange"; }
                } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
                    selText = attempted ? escapeHtml(String(response).slice(0, 500)) : "Skipped";
                    corrText = escapeHtml(q.answer_text || q.model_answer || "Refer to marking scheme");
                    isCorrect = attempted && String(response).trim().toLowerCase() === String(q.answer_text || q.model_answer || '').trim().toLowerCase();
                    if (isCorrect) cCount++; else if (attempted) iCount++;
                    rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                    statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
                } else {
                    const clientOptIdx = parseInt(response, 10);
                    const optOrder = getSafeOptionPermutation(q.options || [], `${seedKey}:${cleanQuizId}:opt:${origIndex}`);
                    const actualOptIdx = (attempted && !isNaN(clientOptIdx) && optOrder[clientOptIdx] !== undefined) ? optOrder[clientOptIdx] : clientOptIdx;

                    isCorrect = attempted && actualOptIdx === q.answer;
                    if (isCorrect) cCount++; else if (attempted) iCount++;
                    selText = attempted ? escapeHtml(q.options?.[actualOptIdx] || "Unknown") : "Skipped";
                    corrText = q.options?.[q.answer] !== undefined ? escapeHtml(q.options[q.answer]) : "N/A";
                    rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                    statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
                }

                let questionText = escapeHtml(q.question || "N/A");
                if (q.explanation) {
                    questionText += `<br><br><span style="color: green;"><b>Explanation:</b> ${escapeHtml(q.explanation)}</span>`;
                }

                html += `<tr><td>${origIndex + 1}</td><td>${questionText}</td><td>${selText}</td><td>${corrText}</td><td style="text-align:center;"><span style="background-color:${statusColor};color:black;font-weight:bold;padding:4px 8px;border-radius:4px;">${rawStatus}</span></td></tr>`;
            });
            html += `</table>`;

            if (!bestEval || cCount > bestEval.cCount) {
                bestEval = { cCount, iCount, aCount, html, seedKey };
            }
            if (lockedSession && lockedSession.signature === expectedTimerSig) break;
        }

        correctCount = bestEval.cCount;
        incorrectCount = bestEval.iCount;
        attemptedCount = bestEval.aCount;
        const winningSeedKey = bestEval.seedKey || expectedTimerSig;
        const breakdownHtml = bestEval.html;

        const skippedCount = Math.max(0, totalCount - attemptedCount);
        const scorePercentage = totalCount > 0 ? Number(((correctCount / totalCount) * 100).toFixed(1)) : 0.0;
        const accuracyPercentage = attemptedCount > 0 ? Number(((correctCount / attemptedCount) * 100).toFixed(1)) : 0.0;

        const cleanClassName = String(className || '').trim().slice(0, 40);
        const cleanChapterTitle = String(chapterTitle || content.title || 'Quiz').trim().slice(0, 120);
        const fullTitle = (cleanClassName && !cleanChapterTitle.startsWith(cleanClassName)) ? `${cleanClassName} - ${cleanChapterTitle}` : cleanChapterTitle;
        const timestampIso = new Date().toISOString();

        const sanitizedAnswersToSave = {};
        Object.entries(safeUserAnswers).forEach(([k, v]) => {
            sanitizedAnswersToSave[k] = (typeof v === 'string' && v.startsWith('data:image/'))
                ? '[Diagram Image Submitted]'
                : v;
        });

        await savePermanentStudentAttempt(email, cleanQuizId, {
            quizId: cleanQuizId,
            chapterTitle: fullTitle,
            seedKey: winningSeedKey,
            userAnswers: sanitizedAnswersToSave,
            score: correctCount,
            total: totalCount,
            correct: correctCount,
            incorrect: incorrectCount,
            attempted: attemptedCount,
            skipped: skippedCount,
            scorePercentage,
            accuracyPercentage,
            timestamp: timestampIso
        });

        const payload = {
            quizId: cleanQuizId,
            firstName: escapeHtml(firstName), lastName: escapeHtml(lastName), email: escapeHtml(email),
            className: escapeHtml(cleanClassName), chapterTitle: escapeHtml(fullTitle),
            subject: `New Quiz Submission - ${fullTitle} - ${firstName} ${lastName}`.trim(),
            score: correctCount, total: totalCount, attempted: attemptedCount, skipped: skippedCount,
            correct: correctCount, incorrect: incorrectCount,
            scorePercentage, accuracyPercentage,
            breakdown: breakdownHtml, targetEmail: ADMIN_EMAIL, secretKey: APPS_SECRET
        };

        const lightweightBreakdown = breakdownHtml.replace(/<img src="data:image\/[^;]+;base64,[^"]+"[^>]*>/g, '[Image submitted - Refer to email]');
        const lightweightPayload = { ...payload, breakdown: lightweightBreakdown };

        await queueSubmissionBackup({ timestamp: timestampIso, ...lightweightPayload });

        const stats = await computeQuizCompetitiveStats(cleanQuizId, fullTitle, cleanChapterTitle, email, correctCount, totalCount);
        const breakdownItems = buildDetailedQuizBreakdownList(realQuestions, sanitizedAnswersToSave, winningSeedKey, cleanQuizId);

        // Send all competitive data + detailed breakdown to the frontend
        res.json({ 
            success: true, 
            quizId: cleanQuizId,
            chapterTitle: fullTitle,
            score: correctCount, 
            total: totalCount,
            correct: correctCount,
            incorrect: incorrectCount,
            attemptedCount,
            skipped: skippedCount,
            scorePercentage,
            accuracyPercentage,
            percentile: stats.percentile,
            average: stats.average,
            totalAttempts: stats.totalAttempts,
            leaderboard: stats.leaderboard,
            breakdownItems,
            timestamp: timestampIso
        });

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (scriptURL && APPS_SECRET) {
            fetch(scriptURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(err => console.error('Email error:', err));
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Grading failed.' });
    } finally {
        await stateStore.del(lockKey);
    }
});

const activeLiveRooms = new Map(); // Tracks active rooms for 1-click student joining

function getLiveMockContent(rawId) {
    if (!rawId) return null;
    const cleanId = path.basename(String(rawId)).trim().replace('.json', '');
    const liveDir = path.join(__dirname, 'livemock');
    if (!fs.existsSync(liveDir)) fs.mkdirSync(liveDir, { recursive: true });

    const allLiveFiles = getAllJsonFiles(liveDir);
    const targetFileName = cleanId + '.json';
    const matchedPath = allLiveFiles.find(filePath => path.basename(filePath) === targetFileName);

    if (!matchedPath) return null;
    return JSON.parse(fs.readFileSync(matchedPath, 'utf8'));
}

// Automatically list all available Live Mock Question Sets for the Admin Dropdown
app.get('/api/live/list', (req, res) => {
    try {
        const liveDir = path.join(__dirname, 'livemock');
        if (!fs.existsSync(liveDir)) return res.json({ success: true, tests: [] });

        const allLiveFiles = getAllJsonFiles(liveDir);
        const tests = allLiveFiles.map(filePath => {
            const fileName = path.basename(filePath, '.json');
            try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return { id: fileName, title: content.title || fileName };
            } catch (err) {
                return { id: fileName, title: fileName };
            }
        });

        res.json({ success: true, tests });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list live tests.' });
    }
});
const LIVE_ROOMS_REDIS_KEY = 'live:active_rooms:registry';

async function syncActiveRoomsToRedis() {
    try {
        const obj = Object.fromEntries(activeLiveRooms.entries());
        await stateStore.set(LIVE_ROOMS_REDIS_KEY, obj, 60 * 60 * 8);
    } catch {}
}

async function loadActiveRoomsFromRedis() {
    try {
        const raw = await stateStore.get(LIVE_ROOMS_REDIS_KEY);
        if (!raw) return;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === 'object') {
            for (const [id, info] of Object.entries(parsed)) {
                if (!activeLiveRooms.has(id)) activeLiveRooms.set(id, info);
            }
        }
    } catch {}
}

// Step 4: Return Active Rooms for the Student 1-Click "Join Room" Lobby
app.get('/api/live/rooms', async (req, res) => {
    try {
        await loadActiveRoomsFromRedis();
        const now = Date.now();
        const rooms = [];
        let changed = false;
        for (const [id, info] of activeLiveRooms.entries()) {
            if (now - info.lastSeen <= 8 * 60 * 60 * 1000) {
                rooms.push({ id: info.id, name: info.name, lastSeen: info.lastSeen || info.createdAt || 0 });
            } else {
                activeLiveRooms.delete(id);
                changed = true;
            }
        }
        if (changed) await syncActiveRoomsToRedis();
        res.json({ success: true, rooms });
    } catch (err) {
        res.status(500).json({ success: false, rooms: [] });
    }
});

// Step 5: Admin Mute / Unmute / Remove (Kick) Student Control
app.post('/api/live/admin/moderate-student', async (req, res) => {
    try {
        const { adminKey, quizId, studentName, action } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized Admin' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const targetName = String(studentName || '').trim();
        if (!cleanId || !targetName) return res.status(400).json({ error: 'Missing room or student name.' });

        await updateBoardSecurely(cleanId, (board) => {
            if (!board[targetName]) {
                board[targetName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false };
            }
            if (action === 'mute') {
                board[targetName].muted = true;
            } else if (action === 'unmute') {
                board[targetName].muted = false;
            } else if (action === 'kick') {
                board[targetName].kicked = true;
                board[targetName].disconnected = true;
            }
            return board;
        });

        await emitAdminBoard(cleanId);
        io.to(cleanId).emit('student-moderated', { studentName: targetName, action });

        res.json({ success: true, studentName: targetName, action });
    } catch (err) {
        res.status(500).json({ error: 'Failed to moderate student.' });
    }
});

function formatLiveStudentIdentity(firstName, lastName, email) {
    const baseName = `${String(firstName || '').trim().toUpperCase()} ${String(lastName || '').trim().toUpperCase()}`.trim() || 'STUDENT';
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return baseName;
    const localPart = cleanEmail.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 12);
    const domainHash = crypto.createHash('md5').update(cleanEmail).digest('hex').slice(0, 3);
    return `${baseName} (${localPart}·${domainHash})`;
}

function verifyLiveRoomToken(liveToken) {
    if (!liveToken || typeof liveToken !== 'string' || !liveToken.includes('|||')) return null;
    const [tokenData, sig] = liveToken.split('|||');
    const expectedSig = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
    if (!safeCompareHex(sig, expectedSig)) return null;

    const parts = tokenData.split('|');
    if (parts[0] === 'LIVE' && parts.length >= 7) {
        const issuedAt = parseInt(parts[6], 10);
        if (isNaN(issuedAt) || (Date.now() - issuedAt) > 12 * 60 * 60 * 1000) {
            return null;
        }
        const quizId = parts[1];
        const firstName = decodeURIComponent(parts[2] || '');
        const lastName = decodeURIComponent(parts[3] || '');
        const email = decodeURIComponent(parts[4] || '').trim().toLowerCase();
        const sessionId = parts[5] || '';
        return {
            valid: true,
            quizId,
            email,
            sessionId,
            studentName: formatLiveStudentIdentity(firstName, lastName, email)
        };
    }
    return null;
}

async function buildLiveStatePayload(cleanId, studentName = null) {
    const stateStr = await stateStore.get(`live:state:${cleanId}`);
    if (!stateStr) return null;
    const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;

    const out = {
        roomName: state.roomName || cleanId,
        status: state.status || 'active',
        activeQuizFile: state.activeQuizFile || '',
        currentIndex: Number(state.currentIndex) || 0,
        total: Number(state.totalQuestions) || 0,
        totalQuestions: Number(state.totalQuestions) || 0,
        broadcastMode: state.broadcastMode || 'question',
        title: state.title || state.roomName || cleanId,
        payload: null,
        key: null,
        savedAnswer: null,
        muted: false,
        kicked: false
    };

    if (out.activeQuizFile) {
        const content = getLiveMockContent(out.activeQuizFile);
        if (content && Array.isArray(content.questions) && content.questions[out.currentIndex]) {
            const q = content.questions[out.currentIndex];
            const key = crypto.createHmac('sha256', SECRET)
                .update(`${cleanId}:${out.activeQuizFile}:${out.currentIndex}`)
                .digest('hex')
                .slice(0, 16);
            const sanitized = {
                type: q.type || 'mcq',
                question: q.question,
                options: q.options || []
            };
            out.payload = xorCipher(JSON.stringify(sanitized), key);
            out.key = key;
            out.total = content.questions.length;
            out.totalQuestions = content.questions.length;
        }
    }

    if (studentName) {
        const rawBoard = await stateStore.get(`live:board:${cleanId}`);
        const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
        const studentRecord = board[studentName];
        if (studentRecord) {
            out.muted = Boolean(studentRecord.muted);
            out.kicked = Boolean(studentRecord.kicked);
            if (studentRecord.answers && studentRecord.answers[out.currentIndex] !== undefined) {
                out.savedAnswer = studentRecord.answers[out.currentIndex].answer;
            }
        }
    }

    return out;
}

async function emitRoomStateToAll(cleanId, forceRefresh = false) {
    const basePayload = await buildLiveStatePayload(cleanId);
    if (!basePayload) return;
    if (forceRefresh) basePayload.forceRefresh = true;

    io.to(`admin-${cleanId}`).emit('room-state', basePayload);

    const rawBoard = await stateStore.get(`live:board:${cleanId}`);
    const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
    const roomSockets = io.sockets.adapter.rooms.get(cleanId);

    if (roomSockets) {
        for (const socketId of roomSockets) {
            const sObj = io.sockets.sockets.get(socketId);
            const sName = sObj ? sObj.studentName : null;
            const rec = (sName && board[sName]) ? board[sName] : null;
            io.to(socketId).emit('room-state', {
                ...basePayload,
                muted: rec ? Boolean(rec.muted) : false,
                kicked: rec ? Boolean(rec.kicked) : false,
                savedAnswer: (rec && rec.answers && rec.answers[basePayload.currentIndex] !== undefined)
                    ? rec.answers[basePayload.currentIndex].answer
                    : null
            });
        }
    }
}

async function emitAdminBoard(cleanId) {
    const rawBoard = await stateStore.get(`live:board:${cleanId}`);
    const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
    const payload = await buildLiveStatePayload(cleanId);
    io.to(`admin-${cleanId}`).emit('admin-board', {
        board,
        currentIndex: payload ? payload.currentIndex : 0,
        activeQuizFile: payload ? payload.activeQuizFile : '',
        totalQuestions: payload ? payload.totalQuestions : 0
    });
}

// Step 1: Admin Creates a Named Room (resumes intact if an active room with the same name already exists)
app.post('/api/live/admin/start', async (req, res) => {
    try {
        const { adminKey, quizId, questionFile } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized Admin' });

        const rawRoomName = String(quizId || '').trim();
        const cleanId = path.basename(rawRoomName).trim();
        if (!cleanId) return res.status(400).json({ error: 'Room name is required.' });

        // If this room is already active, resume it without wiping live students or answers
        const existingRaw = await stateStore.get(`live:state:${cleanId}`);
        const existingState = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : null;
        if (existingState && existingState.status === 'active') {
            await stateStore.set(`live:state:${cleanId}`, existingState, 60 * 60 * 8);
            await stateStore.set(`live:admin_seen:${cleanId}`, Date.now(), 60 * 60 * 8);
            await loadActiveRoomsFromRedis();
            activeLiveRooms.set(cleanId, {
                id: cleanId,
                name: existingState.roomName || rawRoomName,
                createdAt: activeLiveRooms.get(cleanId)?.createdAt || Date.now(),
                lastSeen: Date.now()
            });
            await syncActiveRoomsToRedis();
            await emitAdminBoard(cleanId);
            return res.json({
                success: true,
                resumed: true,
                quizId: cleanId,
                roomName: existingState.roomName || rawRoomName,
                activeQuizFile: existingState.activeQuizFile || '',
                totalQuestions: Number(existingState.totalQuestions) || 0,
                currentIndex: Number(existingState.currentIndex) || 0
            });
        }

        let activeQuizFile = '';
        let totalQuestions = 0;
        let displayTitle = rawRoomName;

        if (questionFile) {
            const content = getLiveMockContent(questionFile);
            if (content && Array.isArray(content.questions)) {
                activeQuizFile = path.basename(String(questionFile)).trim().replace('.json', '');
                totalQuestions = content.questions.length;
                displayTitle = `${rawRoomName} — ${content.title || activeQuizFile}`;
            }
        }

        const roomState = {
            roomName: rawRoomName,
            currentIndex: 0,
            status: 'active',
            activeQuizFile,
            broadcastMode: 'question',
            title: displayTitle,
            totalQuestions,
            questionStartTime: Date.now()
        };

        await stateStore.set(`live:state:${cleanId}`, roomState, 60 * 60 * 8);
        await stateStore.set(`live:admin_seen:${cleanId}`, Date.now(), 60 * 60 * 8);
        await stateStore.del(`live:board:${cleanId}`);

        await loadActiveRoomsFromRedis();
        activeLiveRooms.set(cleanId, {
            id: cleanId,
            name: rawRoomName,
            createdAt: Date.now(),
            lastSeen: Date.now()
        });
        await syncActiveRoomsToRedis();

        await emitRoomStateToAll(cleanId);
        await emitAdminBoard(cleanId);

        res.json({
            success: true,
            quizId: cleanId,
            roomName: rawRoomName,
            activeQuizFile,
            totalQuestions,
            currentIndex: 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create room.' });
    }
});

// Admin Rejoin Last Active Room (after disconnect or accidental browser close)
app.post('/api/live/admin/resume', async (req, res) => {
    try {
        const { adminKey, quizId } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized Admin' });

        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return res.status(400).json({ error: 'Room ID is required.' });

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        const state = stateStr ? (typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr) : null;
        if (!state || state.status !== 'active') {
            return res.status(404).json({ error: 'This room is no longer active.' });
        }

        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);
        await stateStore.set(`live:admin_seen:${cleanId}`, Date.now(), 60 * 60 * 8);
        await loadActiveRoomsFromRedis();
        activeLiveRooms.set(cleanId, {
            id: cleanId,
            name: state.roomName || cleanId,
            createdAt: activeLiveRooms.get(cleanId)?.createdAt || Date.now(),
            lastSeen: Date.now()
        });
        await syncActiveRoomsToRedis();
        await emitAdminBoard(cleanId);

        res.json({
            success: true,
            quizId: cleanId,
            roomName: state.roomName || cleanId,
            activeQuizFile: state.activeQuizFile || '',
            totalQuestions: Number(state.totalQuestions) || 0,
            currentIndex: Number(state.currentIndex) || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to rejoin room.' });
    }
});

// Step 2: Admin Selects or Switches Question Set from /livemock Dropdown
app.post('/api/live/admin/select-quiz', async (req, res) => {
    try {
        const { adminKey, quizId, questionFile } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized Admin' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room is not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;

        if (!questionFile || String(questionFile).trim() === '') {
            state.activeQuizFile = '';
            state.currentIndex = 0;
            state.totalQuestions = 0;
            state.title = state.roomName || cleanId;
            await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);
            await emitRoomStateToAll(cleanId);
            await emitAdminBoard(cleanId);
            return res.json({ success: true, activeQuizFile: '', totalQuestions: 0, currentIndex: 0 });
        }

        const cleanQuizFile = path.basename(String(questionFile)).trim().replace('.json', '');
        const content = getLiveMockContent(cleanQuizFile);
        if (!content || !Array.isArray(content.questions) || content.questions.length === 0) {
            return res.status(404).json({ error: 'Selected question file has no questions or was not found.' });
        }

        state.activeQuizFile = cleanQuizFile;
        state.currentIndex = 0;
        state.totalQuestions = content.questions.length;
        state.title = `${state.roomName || cleanId} — ${content.title || cleanQuizFile}`;
        state.questionStartTime = Date.now();

        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);
        await emitRoomStateToAll(cleanId);
        await emitAdminBoard(cleanId);

        res.json({
            success: true,
            activeQuizFile: cleanQuizFile,
            title: state.title,
            totalQuestions: state.totalQuestions,
            currentIndex: 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load question set.' });
    }
});

// Admin: Switch Student Main Screen Mode ('question', 'presentation', 'both')
app.post('/api/live/rtc/admin/mode', async (req, res) => {
    try {
        const { adminKey, quizId, broadcastMode } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        state.broadcastMode = ['question', 'presentation', 'both'].includes(broadcastMode) ? broadcastMode : 'question';
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);

        await emitRoomStateToAll(cleanId);
        res.json({ success: true, broadcastMode: state.broadcastMode });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update broadcast mode.' });
    }
});

// Admin: Clear Current Question Responses
app.post('/api/live/admin/clear-question', async (req, res) => {
    try {
        const { adminKey, quizId } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });
        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        const idx = Number(state.currentIndex) || 0;

        state.questionStartTime = Date.now();
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);

        await updateBoardSecurely(cleanId, (board) => {
            Object.keys(board).forEach(student => {
                if (board[student] && board[student].answers) {
                    delete board[student].answers[idx];
                }
            });
            return board;
        });

        await emitRoomStateToAll(cleanId, true);
        await emitAdminBoard(cleanId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear responses.' });
    }
});

// Admin: End Room
app.post('/api/live/admin/end', async (req, res) => {
    try {
        const { adminKey, quizId } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized' });
        const cleanId = path.basename(String(quizId)).trim();

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (stateStr) {
            const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
            state.status = 'ended';
            await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);
        }

        await loadActiveRoomsFromRedis();
        activeLiveRooms.delete(cleanId);
        await syncActiveRoomsToRedis();
        await stateStore.del(`live:otp:${cleanId}`);

        const roomPrefix = `${cleanId}:::`;
        for (const key of liveDisconnectTimers.keys()) {
            if (key.startsWith(roomPrefix)) {
                clearTimeout(liveDisconnectTimers.get(key));
                liveDisconnectTimers.delete(key);
            }
        }
        for (const key of liveHiddenTimers.keys()) {
            if (key.startsWith(roomPrefix)) {
                clearTimeout(liveHiddenTimers.get(key));
                liveHiddenTimers.delete(key);
            }
        }
        for (const key of liveStudentSockets.keys()) {
            if (key.startsWith(roomPrefix)) liveStudentSockets.delete(key);
        }
        for (const key of Array.from(liveBackgroundedStudents.values())) {
            if (key.startsWith(roomPrefix)) liveBackgroundedStudents.delete(key);
        }
        for (const key of Array.from(liveStudentLastSeen.keys())) {
            if (key.startsWith(roomPrefix)) liveStudentLastSeen.delete(key);
        }

        await emitRoomStateToAll(cleanId);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to end room.' }); }
});
// Admin: Change Question Index
app.post('/api/live/admin/set-index', async (req, res) => {
    try {
        const { adminKey, quizId, index } = req.body;
        if (!safeCompareStrings(adminKey, APPS_SECRET)) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId)).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        state.currentIndex = parseInt(index, 10);
        state.questionStartTime = Date.now();
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 8);

        await emitRoomStateToAll(cleanId);
        await emitAdminBoard(cleanId);

        res.json({ success: true, currentIndex: state.currentIndex });
    } catch (err) { res.status(500).json({ error: 'Failed to update index.' }); }
});

// Student Join Room Verification
app.post('/api/live/student/verify', async (req, res) => {
    try {
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token, null, false);
        if (!authCheck.valid) return res.status(401).json({ error: 'Unauthorized. Please sign in globally first.' });
        syncAuthCookieIfNeeded(req, res, token);

        const { quizId } = req.body;
        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return res.status(400).json({ error: 'Please select a Room to join.' });

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        const state = stateStr ? (typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr) : null;
        if (!state || state.status !== 'active') {
            return res.status(400).json({ error: 'This room is no longer active.' });
        }

        const fName = String(authCheck.firstName).trim().toUpperCase();
        const lName = String(authCheck.lastName).trim().toUpperCase();
        const cleanEmail = String(authCheck.email || '').trim().toLowerCase();
        const studentName = formatLiveStudentIdentity(fName, lName, cleanEmail);
        const newSessionId = crypto.randomBytes(6).toString('hex');

        await updateBoardSecurely(cleanId, (board) => {
            if (!board[studentName]) {
                board[studentName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false, email: cleanEmail };
            }
            board[studentName].email = cleanEmail;
            board[studentName].activeSessionId = newSessionId;
            board[studentName].disconnected = false;
            board[studentName].hiddenAway = false;
            board[studentName].kicked = false; 
            board[studentName].lastSeenAt = Date.now();
            return board;
        });

        // Kick any previous device/browser session for this same email in real time
        const presenceKey = `${cleanId}:::${studentName}`;
        liveBackgroundedStudents.delete(presenceKey);
        if (liveDisconnectTimers.has(presenceKey)) {
            clearTimeout(liveDisconnectTimers.get(presenceKey));
            liveDisconnectTimers.delete(presenceKey);
        }
        const existingSockets = liveStudentSockets.get(presenceKey);
        if (existingSockets && existingSockets.size > 0) {
            for (const oldSocketId of existingSockets) {
                io.to(oldSocketId).emit('session-replaced', {
                    reason: 'You joined this room from another device or browser tab. Your previous session has been disconnected.'
                });
                const sObj = io.sockets.sockets.get(oldSocketId);
                if (sObj) {
                    sObj.quizId = null;
                    sObj.studentName = null;
                    sObj.sessionId = null;
                    sObj.leave(cleanId);
                }
            }
            existingSockets.clear();
        }

        await emitAdminBoard(cleanId);

        const tokenData = `LIVE|${cleanId}|${encodeURIComponent(fName)}|${encodeURIComponent(lName)}|${encodeURIComponent(cleanEmail)}|${newSessionId}|${Date.now()}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');

        res.json({ success: true, token: `${tokenData}|||${signature}`, studentName });
    } catch (err) {
        res.status(500).json({ error: 'Failed to join room.' });
    }
});

app.post('/api/live/student/rejoin', async (req, res) => {
    const liveCheck = verifyLiveRoomToken(extractAuthToken(req));
    if (!liveCheck) return res.status(401).json({ error: 'Invalid session' });

    const cleanId = liveCheck.quizId;
    const studentName = liveCheck.studentName;
    const presenceKey = `${cleanId}:::${studentName}`;

    if (typeof clearHiddenRosterTimer === 'function') clearHiddenRosterTimer(presenceKey);
    if (typeof liveDisconnectTimers !== 'undefined' && liveDisconnectTimers.has(presenceKey)) {
        clearTimeout(liveDisconnectTimers.get(presenceKey));
        liveDisconnectTimers.delete(presenceKey);
    }

    // Fast-path check without spin-lock if student is already marked connected
    const rawBoard = await stateStore.get(`live:board:${cleanId}`);
    const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
    const rec = board[studentName];

    if (rec && rec.activeSessionId && liveCheck.sessionId && rec.activeSessionId !== liveCheck.sessionId) {
        return res.status(409).json({ error: 'Session replaced by a newer login.', sessionReplaced: true });
    }

    liveStudentLastSeen.set(presenceKey, Date.now());
    if (rec && !rec.kicked && !rec.disconnected && !rec.hiddenAway) {
        return res.json({ success: true, studentName });
    }

    let replaced = false;
    let reconnectedNow = false;
    await updateBoardSecurely(cleanId, (lockedBoard) => {
        let lockedRec = lockedBoard[studentName];
        if (!lockedRec) {
            lockedRec = {
                joinedAt: Date.now(),
                answers: {},
                muted: false,
                kicked: false,
                email: liveCheck.email || '',
                activeSessionId: liveCheck.sessionId || '',
                disconnected: false,
                lastSeenAt: Date.now()
            };
            lockedBoard[studentName] = lockedRec;
            reconnectedNow = true;
            return lockedBoard;
        }
        if (lockedRec.activeSessionId && liveCheck.sessionId && lockedRec.activeSessionId !== liveCheck.sessionId) {
            replaced = true;
            return lockedBoard;
        }
        if (!lockedRec.kicked) {
            if (lockedRec.disconnected || lockedRec.hiddenAway) reconnectedNow = true;
            lockedRec.disconnected = false;
            lockedRec.hiddenAway = false;
            lockedRec.lastSeenAt = Date.now();
        }
        return lockedBoard;
    });

    if (replaced) {
        return res.status(409).json({ error: 'Session replaced by a newer login.', sessionReplaced: true });
    }

    if (reconnectedNow) {
        await emitAdminBoard(cleanId);
    }
    res.json({ success: true, studentName });
});

// Instant removal beacon when student closes tab, presses Back button, or switches tab for 3s
app.post('/api/live/student/leave', async (req, res) => {
    try {
        const rawToken = extractAuthToken(req) || (req.body && req.body.token) || '';
        const liveCheck = verifyLiveRoomToken(rawToken);
        if (!liveCheck) return res.status(200).json({ ok: false });

        const cleanId = liveCheck.quizId;
        const studentName = liveCheck.studentName;
        const presenceKey = `${cleanId}:::${studentName}`;
        const rawBoardNow = await stateStore.get(`live:board:${cleanId}`);
        const boardNow = rawBoardNow ? (typeof rawBoardNow === 'string' ? JSON.parse(rawBoardNow) : rawBoardNow) : {};
        if (boardNow[studentName]?.activeSessionId && liveCheck.sessionId && boardNow[studentName].activeSessionId !== liveCheck.sessionId) {
            return res.json({ success: true, ignoredStaleSession: true });
        }

        if (req.body && req.body.cancelHidden) {
            if (typeof clearHiddenRosterTimer === 'function') clearHiddenRosterTimer(presenceKey);
            let restoredFromHidden = false;
            await updateBoardSecurely(cleanId, (board) => {
                if (board[studentName] && !board[studentName].kicked && (board[studentName].hiddenAway || board[studentName].disconnected)) {
                    board[studentName].hiddenAway = false;
                    board[studentName].disconnected = false;
                    board[studentName].lastSeenAt = Date.now();
                    restoredFromHidden = true;
                }
                return board;
            });
            if (restoredFromHidden) await emitAdminBoard(cleanId);
            return res.json({ success: true, cancelled: true });
        }

        const isImmediate = Boolean(req.body && req.body.immediate);
        const hiddenGraceMs = Number(req.body && req.body.hiddenGraceMs) || 0;

        // Tab switch / minimize (Android & iOS): remove from admin roster after 3s, keep student live in room
        if (!isImmediate && hiddenGraceMs > 0) {
            if (typeof scheduleHiddenRosterRemoval === 'function') {
                scheduleHiddenRosterRemoval(cleanId, studentName, hiddenGraceMs);
            }
            return res.json({ success: true, hiddenScheduled: true });
        }

        if (isImmediate && typeof clearHiddenRosterTimer === 'function') {
            clearHiddenRosterTimer(presenceKey);
        }
        if (typeof liveBackgroundedStudents !== 'undefined') {
            liveBackgroundedStudents.delete(presenceKey);
        }

        if (typeof liveDisconnectTimers !== 'undefined') {
            if (liveDisconnectTimers.has(presenceKey)) {
                clearTimeout(liveDisconnectTimers.get(presenceKey));
                liveDisconnectTimers.delete(presenceKey);
            }

            const forceRemoveStudent = async () => {
                liveDisconnectTimers.delete(presenceKey);
                if (typeof liveStudentSockets !== 'undefined') {
                    liveStudentSockets.delete(presenceKey);
                }
                await updateBoardSecurely(cleanId, (board) => {
                    if (board[studentName]) {
                        board[studentName].disconnected = true;
                    }
                    return board;
                });
                await emitAdminBoard(cleanId);
            };

            if (isImmediate) {
                await forceRemoveStudent();
            } else {
                // 800ms micro-buffer so F5 refresh stays connected, while tab/browser close removes in real time
                const timer = setTimeout(async () => {
                    liveDisconnectTimers.delete(presenceKey);
                    if (typeof liveStudentSockets !== 'undefined' && liveStudentSockets.has(presenceKey)) return;
                    await forceRemoveStudent();
                }, 800);
                liveDisconnectTimers.set(presenceKey, timer);
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(200).json({ ok: false });
    }
});

// Student Submit Answer in Live Room
app.post('/api/live/student/submit', async (req, res) => {
    try {
        const liveCheck = verifyLiveRoomToken(extractAuthToken(req));
        if (!liveCheck) return res.status(401).json({ error: 'Unauthorized live session.' });

        const { index, answer } = req.body;
        const cleanId = liveCheck.quizId;
        const studentName = liveCheck.studentName;

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        const state = stateStr ? (typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr) : null;
        if (!state || state.status !== 'active' || Number(index) !== Number(state.currentIndex)) {
            return res.status(400).json({ error: 'Question is no longer active for submission.' });
        }
        const qStart = state.questionStartTime ? state.questionStartTime : Date.now() - 2000;
        const timeSec = Math.max(0.1, ((Date.now() - qStart) / 1000)).toFixed(1);

        let isCorrect = null;
        let optionLabel = `Option ${Number(answer) + 1}`;
        if (state && state.activeQuizFile) {
            const content = getLiveMockContent(state.activeQuizFile);
            const q = content?.questions?.[index];
            if (q) {
                isCorrect = (Number(answer) === Number(q.answer));
                if (q.options && q.options[answer] !== undefined) {
                    optionLabel = q.options[answer];
                }
            }
        }

        let sessionReplaced = false;
        await updateBoardSecurely(cleanId, (board) => {
            if (board[studentName]?.activeSessionId && liveCheck.sessionId && board[studentName].activeSessionId !== liveCheck.sessionId) {
                sessionReplaced = true;
                return board;
            }
            if (!board[studentName]) {
                board[studentName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false };
            }
            if (board[studentName].kicked) return board;
            board[studentName].answers = board[studentName].answers || {};
            if (board[studentName].answers[index] === undefined) {
                board[studentName].answers[index] = {
                    answer: Number(answer),
                    optionLabel,
                    isCorrect,
                    timeSec,
                    submittedAt: Date.now()
                };
            }
            return board;
        });

        if (sessionReplaced) {
            return res.status(409).json({ error: 'Session replaced by a newer login.' });
        }

        await emitAdminBoard(cleanId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to submit answer.' });
    }
});
// Student Live Room Scorecard & Breakdown Generator
app.get('/api/live/student/scorecard', async (req, res) => {
    try {
        const liveCheck = verifyLiveRoomToken(extractAuthToken(req));
        if (!liveCheck) return res.status(401).json({ error: 'Unauthorized live session.' });

        const cleanId = path.basename(String(req.query.quizId || liveCheck.quizId)).trim();
        const studentName = liveCheck.studentName;

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        const state = stateStr ? (typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr) : null;
        if (!state || !state.activeQuizFile) {
            return res.status(400).json({ error: 'No question set was active in this room.' });
        }

        const content = getLiveMockContent(state.activeQuizFile);
        const realQuestions = content?.questions || [];

        const rawBoard = await stateStore.get(`live:board:${cleanId}`);
        const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
        const studentRecord = board[studentName] || { answers: {} };
        const studentAnswers = studentRecord.answers || {};

        let correct = 0;
        let incorrect = 0;
        let skipped = 0;
        const breakdown = [];

        realQuestions.forEach((q, idx) => {
            const ansObj = studentAnswers[idx];
            const attempted = ansObj !== undefined && ansObj !== null;
            const studentOptIdx = attempted ? Number(ansObj.answer) : null;

            let status = 'Skipped';
            let selectedText = 'Skipped';
            const correctText = q.options?.[q.answer] !== undefined ? q.options[q.answer] : 'N/A';

            if (attempted) {
                if (studentOptIdx === q.answer) {
                    correct++;
                    status = 'Correct';
                } else {
                    incorrect++;
                    status = 'Incorrect';
                }
                selectedText = q.options?.[studentOptIdx] !== undefined ? q.options[studentOptIdx] : 'Unknown';
            } else {
                skipped++;
            }

            let rawExp = q.explanation || q.Explanation || q.exp || q.solution || q.Solution || q.rationale || q.reason || q.details || q.desc || q.note || '';
        if (!rawExp && q && typeof q === 'object') {
            const expKey = Object.keys(q).find(k => /^(exp|sol|rat|reas|desc|note)/i.test(k.trim()));
            if (expKey) rawExp = q[expKey];
        }

        breakdown.push({
            qNum: idx + 1,
            question: q.question || 'N/A',
            selectedText,
            correctText,
            status,
            explanation: String(rawExp || '').trim()
        });
        });

        res.json({
            success: true,
            scorecard: {
                correct,
                incorrect,
                skipped,
                total: realQuestions.length
            },
            breakdown
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate scorecard.' });
    }
});
// ============================================================================
// 9. LIVEKIT SFU TOKEN GENERATION
// ============================================================================
const { AccessToken } = require('livekit-server-sdk');

app.get('/api/livekit/token', async (req, res) => {
    try {
        const { quizId, studentName, adminKey } = req.query;
        if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
            return res.status(500).json({ error: "Missing SFU keys." });
        }

        const cleanId = path.basename(String(quizId || 'default')).trim();
        const rawName = String(studentName || 'user').trim();
        const isAdmin = rawName.toLowerCase() === 'admin';

        if (isAdmin) {
            if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
                return res.status(403).json({ error: "Unauthorized Admin LiveKit token request." });
            }
        }

        let canStudentPublish = true;
        let resolvedStudentName = rawName.replace(/^admin/i, 'student').trim() || 'Student';

        if (!isAdmin) {
            const liveCheck = verifyLiveRoomToken(extractAuthToken(req));
            if (!liveCheck || liveCheck.quizId !== cleanId) {
                return res.status(401).json({ error: "Unauthorized live room session." });
            }
            resolvedStudentName = liveCheck.studentName;
            const rawBoard = await stateStore.get(`live:board:${cleanId}`);
            const board = rawBoard ? (typeof rawBoard === 'string' ? JSON.parse(rawBoard) : rawBoard) : {};
            const studentRec = board[resolvedStudentName];
            if (studentRec) {
                if (studentRec.kicked) return res.status(403).json({ error: "Removed from room." });
                if (studentRec.activeSessionId && liveCheck.sessionId && studentRec.activeSessionId !== liveCheck.sessionId) {
                    return res.status(409).json({ error: "Session replaced by a newer login." });
                }
            }
        }

        const randSuffix = crypto.randomBytes(2).toString('hex');
        const identity = isAdmin ? 'admin' : `${resolvedStudentName}_${randSuffix}`;

        const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity,
            ttl: '8h',
            metadata: JSON.stringify({ role: isAdmin ? 'admin' : 'student' })
        });
        at.addGrant({
            roomJoin: true,
            room: cleanId,
            canPublish: isAdmin ? true : canStudentPublish,
            canSubscribe: true
        });
        res.json({ token: await at.toJwt() });
    } catch (err) {
        res.status(500).json({ error: "Token generation failed." });
    }
});
// ============================================================================
// ADMIN CONTROL SYSTEM: USER MANAGEMENT & CROSS-FOLDER QUIZ ANALYTICS
// ============================================================================

// 1. Get all registered accounts, test histories, and purchase records (Deduplicated)
app.post('/api/admin/users/list', async (req, res) => {
    try {
        const { adminKey } = req.body;
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
            return res.status(403).json({ error: 'Unauthorized Admin Key' });
        }

        const usersMap = new Map();

        const registerUser = (email, fName = 'STUDENT', lName = '.') => {
            const cleanEmail = String(email || '').trim().toLowerCase();
            if (!cleanEmail || !cleanEmail.includes('@')) return null;
            if (!usersMap.has(cleanEmail)) {
                usersMap.set(cleanEmail, {
                    email: cleanEmail,
                    firstName: String(fName || 'STUDENT').trim().toUpperCase(),
                    lastName: String(lName || '.').trim().toUpperCase(),
                    attemptsMap: new Map(), // Deduplicates attempts across submissions.json & attempts_db.json
                    purchasesSet: new Set()
                });
            } else {
                const existing = usersMap.get(cleanEmail);
                if (existing.firstName === 'STUDENT' && fName && fName !== 'STUDENT') {
                    existing.firstName = String(fName).trim().toUpperCase();
                    existing.lastName = String(lName || '.').trim().toUpperCase();
                }
            }
            return usersMap.get(cleanEmail);
        };

        // Helper to collect keys from both external Redis and in-memory fallbackMap
        const getMatchingKeys = async (prefix) => {
            const matched = new Set();
            if (stateStore.fallbackMap) {
                for (const k of stateStore.fallbackMap.keys()) {
                    if (k.startsWith(prefix)) matched.add(k);
                }
            }
            try {
                const redisKeys = await stateStore.execCommand(['KEYS', `${prefix}*`]);
                if (Array.isArray(redisKeys)) redisKeys.forEach(k => matched.add(k));
            } catch (e) {}
            return Array.from(matched);
        };

        // A. Scan Redis user profiles & purchases
        try {
            const profileKeys = await getMatchingKeys('user:profile:');
            for (const k of profileKeys) {
                const raw = await stateStore.get(k);
                if (raw) {
                    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (p && p.email) registerUser(p.email, p.firstName, p.lastName);
                }
            }

            const purchaseKeys = await getMatchingKeys('user:purchases:');
            for (const k of purchaseKeys) {
                const parts = k.replace(/^user:purchases:/i, '').split(':');
                const email = parts[0];
                if (email && email.includes('@')) {
                    const u = registerUser(email);
                    if (u && parts.length > 1 && parts[1]) {
                        u.purchasesSet.add(parts[1]);
                    }
                }
            }
        } catch (e) {}

        // B. Scan attempts_db.json first (authoritative per-quiz attempt store)
        try {
            const attFile = path.join(__dirname, 'attempts_db.json');
            if (fs.existsSync(attFile)) {
                const db = JSON.parse(fs.readFileSync(attFile, 'utf8')) || {};
                Object.entries(db).forEach(([compoundKey, att]) => {
                    const email = compoundKey.split('__')[0];
                    const qIdFromKey = compoundKey.split('__')[1] || '';
                    if (email) {
                        const u = registerUser(email);
                        const rawQuizId = att.quizId || qIdFromKey || 'Unknown Test';
                        const dedupeKey = path.basename(String(rawQuizId)).trim().toLowerCase();
                        if (u && !u.attemptsMap.has(dedupeKey)) {
                            u.attemptsMap.set(dedupeKey, {
                                quizId: rawQuizId,
                                score: att.score,
                                total: att.total,
                                timestamp: att.timestamp
                            });
                        }
                    }
                });
            }
        } catch (e) {}

        // C. Scan historical submissions (merges without duplicating existing quizId attempts)
        const history = await getHistoricalSubmissions();
        history.forEach(s => {
            if (s.email) {
                const u = registerUser(s.email, s.firstName, s.lastName);
                const rawQuizId = s.quizId || s.chapterTitle || 'Unknown Test';
                const dedupeKey = path.basename(String(rawQuizId)).trim().toLowerCase();
                if (u && !u.attemptsMap.has(dedupeKey)) {
                    u.attemptsMap.set(dedupeKey, {
                        quizId: rawQuizId,
                        score: s.score,
                        total: s.total,
                        timestamp: s.timestamp
                    });
                }
            }
        });

        const usersList = Array.from(usersMap.values()).map(u => ({
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            attempts: Array.from(u.attemptsMap.values()),
            purchases: Array.from(u.purchasesSet)
        }));

        res.json({ success: true, users: usersList });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user list.' });
    }
});

// 2. Targetedly delete a user's test history, purchase history, or deregister account
app.post('/api/admin/users/delete-data', async (req, res) => {
    try {
        const { adminKey, email, dataType } = req.body;
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
            return res.status(403).json({ error: 'Unauthorized Admin Key' });
        }

        const cleanEmail = String(email || '').trim().toLowerCase();
        if (!cleanEmail) return res.status(400).json({ error: 'Missing email.' });

        const deleteKeysByPrefix = async (prefix) => {
            if (stateStore.fallbackMap) {
                for (const k of Array.from(stateStore.fallbackMap.keys())) {
                    if (k.startsWith(prefix)) stateStore.fallbackMap.delete(k);
                }
            }
            try {
                const keys = await stateStore.execCommand(['KEYS', `${prefix}*`]);
                if (Array.isArray(keys)) {
                    for (const k of keys) await stateStore.del(k);
                }
            } catch (e) {}
        };

        if (dataType === 'history') {
            // 1. Clear attempts from attempts_db.json
            try {
                const attFile = path.join(__dirname, 'attempts_db.json');
                if (fs.existsSync(attFile)) {
                    const db = JSON.parse(fs.readFileSync(attFile, 'utf8')) || {};
                    Object.keys(db).forEach(k => {
                        if (k.toLowerCase().startsWith(`${cleanEmail}__`)) delete db[k];
                    });
                    fs.writeFileSync(attFile, JSON.stringify(db, null, 2), { mode: 0o600 });
                }
            } catch (e) {}

            // 2. Clear from submissions.json
            try {
                const subFile = path.join(__dirname, 'submissions.json');
                if (fs.existsSync(subFile)) {
                    let subs = JSON.parse(fs.readFileSync(subFile, 'utf8')) || [];
                    subs = subs.filter(s => String(s.email || '').trim().toLowerCase() !== cleanEmail);
                    fs.writeFileSync(subFile, JSON.stringify(subs, null, 2), { mode: 0o600 });
                }
            } catch (e) {}

            // 3. Clear from Redis global history cache
            try {
                const rawRedis = await stateStore.get(SUBMISSIONS_REDIS_KEY);
                if (rawRedis) {
                    let parsed = typeof rawRedis === 'string' ? JSON.parse(rawRedis) : rawRedis;
                    if (Array.isArray(parsed)) {
                        parsed = parsed.filter(s => String(s.email || '').trim().toLowerCase() !== cleanEmail);
                        await stateStore.set(SUBMISSIONS_REDIS_KEY, parsed, 60 * 60 * 24 * 365 * 10);
                    }
                }
            } catch (e) {}

            // 4. Clear Redis & fallbackMap attempt keys + reset submissions RAM cache
            historicalSubmissionsRamCache = { data: null, expiresAt: 0 };
            await deleteKeysByPrefix(`attempt:v1:${cleanEmail}:`);
        } else if (dataType === 'purchases') {
            await stateStore.del(`user:purchases:${cleanEmail}`);
            await deleteKeysByPrefix(`user:purchases:${cleanEmail}:`);
        } else if (dataType === 'account') {
            await stateStore.set(`blacklist:email:${cleanEmail}`, '1', TOKEN_MAX_AGE_SEC);
            await stateStore.del(`user:profile:${cleanEmail}`);
            await stateStore.del(`whitelist:vip:${cleanEmail}`);
            try {
                const usersFile = path.join(__dirname, 'users.json');
                if (fs.existsSync(usersFile)) {
                    let map = JSON.parse(fs.readFileSync(usersFile, 'utf8')) || {};
                    delete map[cleanEmail];
                    fs.writeFileSync(usersFile, JSON.stringify(map, null, 2), { mode: 0o600 });
                }
            } catch (e) {}
        }

        res.json({ success: true, message: `Successfully cleared ${dataType} for ${cleanEmail}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user data.' });
    }
});

// 3. List all JSON files across all folders for the dropdown
app.post('/api/admin/json-files/list', async (req, res) => {
    try {
        const { adminKey } = req.body;
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
            return res.status(403).json({ error: 'Unauthorized Admin Key' });
        }

        const allFolders = [
            path.join(__dirname, 'quizzes'),
            path.join(__dirname, 'descriptive'),
            path.join(__dirname, 'livemock'),
            path.join(__dirname, 'notes')
        ];

        const jsonFiles = [];
        allFolders.forEach(folder => {
            if (fs.existsSync(folder)) {
                const files = getAllJsonFiles(folder);
                files.forEach(filePath => {
                    const fileName = path.basename(filePath, '.json');
                    const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
                    try {
                        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        jsonFiles.push({
                            id: fileName,
                            path: relativePath,
                            title: content.title || fileName,
                            category: content.category || 'general'
                        });
                    } catch (e) {
                        jsonFiles.push({ id: fileName, path: relativePath, title: fileName, category: 'general' });
                    }
                });
            }
        });

        res.json({ success: true, files: jsonFiles });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list JSON files.' });
    }
});

// 4. Get attempts and scores for a specific test file ID
app.post('/api/admin/quiz-attempts', async (req, res) => {
    try {
        const { adminKey, quizId } = req.body;
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) {
            return res.status(403).json({ error: 'Unauthorized Admin Key' });
        }

        const cleanQuizId = path.basename(String(quizId || '')).trim().toLowerCase();
        const attempts = [];
        const seenEmails = new Set();

        const addAttemptRecord = (email, name, score, total, timestamp) => {
            const cleanEm = String(email || 'unknown').trim().toLowerCase();
            const uniqueKey = `${cleanEm}_${timestamp}`;
            if (!seenEmails.has(uniqueKey)) {
                seenEmails.add(uniqueKey);
                attempts.push({
                    email: cleanEm,
                    name: name || 'Student',
                    score: Number(score) || 0,
                    total: Number(total) || 1,
                    timestamp: timestamp || new Date().toISOString()
                });
            }
        };

        // A. Check historical submissions
        const history = await getHistoricalSubmissions();
        history.forEach(s => {
            const sId = path.basename(String(s.quizId || s.chapterTitle || '')).trim().toLowerCase();
            if (sId === cleanQuizId || sId.includes(cleanQuizId)) {
                addAttemptRecord(s.email, `${s.firstName || ''} ${s.lastName || ''}`.trim(), s.score, s.total, s.timestamp);
            }
        });

        // B. Check attempts_db.json
        try {
            const attFile = path.join(__dirname, 'attempts_db.json');
            if (fs.existsSync(attFile)) {
                const db = JSON.parse(fs.readFileSync(attFile, 'utf8')) || {};
                Object.entries(db).forEach(([compoundKey, att]) => {
                    const [email, qId] = compoundKey.split('__');
                    if (qId && (qId.toLowerCase() === cleanQuizId || att.quizId?.toLowerCase() === cleanQuizId)) {
                        addAttemptRecord(email, att.name || email, att.score, att.total, att.timestamp);
                    }
                });
            }
        } catch (e) {}

        attempts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json({ success: true, attempts });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch test attempts.' });
    }
});
app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });

    const p = req.path.toLowerCase();
    if (p.includes('live-room') || p.includes('liveroom') || p.includes('live-test') || p.includes('livetest')) {
        return serveDynamicHtml(req, res, 'livetest.html', '/live-room');
    }
    if (p.includes('mock-tests') || p.includes('test-portal')) {
        return serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests');
    }
    if (p.includes('study-notes') || p.includes('notes')) {
        return serveDynamicHtml(req, res, 'notes.html', '/study-notes');
    }
    if (p.includes('descriptive')) {
        return serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers');
    }
    if (p.includes('admin-live') || p.includes('adminlive')) {
        return serveDynamicHtml(req, res, 'admin-live.html', '/admin-live');
    }

    res.redirect(302, '/');
});

const PING_INTERVAL = 14 * 60 * 1000;
const PING_URL = process.env.PING_URL || 'https://pioneersprep.in/ping';
setInterval(() => {
    const handler = PING_URL.startsWith('https') ? https : http;
    handler.get(PING_URL, (res) => console.log(`[Keep-Awake] Ping Status: ${res.statusCode} at ${new Date().toISOString()}`)).on('error', (err) => console.warn(`[Keep-Awake] Ping failed: ${err.message}`));
}, PING_INTERVAL);

const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: { origin: "*" },
    pingInterval: 4000,
    pingTimeout: 4000
});

// Tracks active socket IDs, disconnect timers, hidden roster timers, and last-seen timestamps per student
const liveStudentSockets = new Map();
const liveDisconnectTimers = new Map();
const liveHiddenTimers = new Map();
const liveBackgroundedStudents = new Set();
const liveStudentLastSeen = new Map();

function clearHiddenRosterTimer(presenceKey) {
    if (liveHiddenTimers.has(presenceKey)) {
        clearTimeout(liveHiddenTimers.get(presenceKey));
        liveHiddenTimers.delete(presenceKey);
    }
}

function scheduleHiddenRosterRemoval(cleanId, studentName, delayMs = 3000) {
    const presenceKey = `${cleanId}:::${studentName}`;
    if (liveHiddenTimers.has(presenceKey)) return; // Already counting down
    const timer = setTimeout(async () => {
        liveHiddenTimers.delete(presenceKey);
        try {
            await updateBoardSecurely(cleanId, (board) => {
                if (board[studentName]) {
                    board[studentName].hiddenAway = true;
                }
                return board;
            });
            await emitAdminBoard(cleanId);
        } catch (e) {}
    }, delayMs);
    liveHiddenTimers.set(presenceKey, timer);
}

async function handleStudentDeparture(cleanId, studentName, socketId, isExplicitExit = false) {
    if (!cleanId || !studentName) return;
    const presenceKey = `${cleanId}:::${studentName}`;

    const activeSet = liveStudentSockets.get(presenceKey);
    if (activeSet) {
        activeSet.delete(socketId);
        if (activeSet.size === 0) liveStudentSockets.delete(presenceKey);
    }

    // If the student still has another active socket open in the room, keep them online
    if (liveStudentSockets.has(presenceKey)) return;

    const markOffline = async () => {
        liveDisconnectTimers.delete(presenceKey);
        liveBackgroundedStudents.delete(presenceKey);
        if (liveStudentSockets.has(presenceKey)) return;
        try {
            await updateBoardSecurely(cleanId, (board) => {
                if (board[studentName]) {
                    board[studentName].disconnected = true;
                }
                return board;
            });
            await emitAdminBoard(cleanId);
        } catch (err) {}
    };

    if (liveDisconnectTimers.has(presenceKey)) {
        clearTimeout(liveDisconnectTimers.get(presenceKey));
    }

    // 900ms micro-buffer so pressing F5 (Refresh) doesn't blink; closing tab or forced exit removes in <1s
    const delayMs = isExplicitExit ? 600 : 900;
    const timer = setTimeout(markOffline, delayMs);
    liveDisconnectTimers.set(presenceKey, timer);
}

io.on("connection", (socket) => {
    socket.on("join-room", async ({ quizId, token, hidden }) => {
        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return;

        const liveAuth = verifyLiveRoomToken(token);
        const ssoAuth = !liveAuth ? await verifyAuthToken(token, null, false) : null;
        if (!liveAuth && (!ssoAuth || !ssoAuth.valid)) return;

        const studentName = liveAuth
            ? liveAuth.studentName
            : formatLiveStudentIdentity(ssoAuth.firstName, ssoAuth.lastName, ssoAuth.email);

        // Reject stale socket reconnects from a previous device/browser session
        const rawBoardCheck = await stateStore.get(`live:board:${cleanId}`);
        const boardCheck = rawBoardCheck ? (typeof rawBoardCheck === 'string' ? JSON.parse(rawBoardCheck) : rawBoardCheck) : {};
        if (liveAuth && boardCheck[studentName]?.activeSessionId && boardCheck[studentName].activeSessionId !== liveAuth.sessionId) {
            socket.emit('session-replaced', {
                reason: 'You joined this room from another device or browser tab. Your previous session has been disconnected.'
            });
            return;
        }

        const presenceKey = `${cleanId}:::${studentName}`;
        liveStudentLastSeen.set(presenceKey, Date.now());
        liveBackgroundedStudents.delete(presenceKey);

        if (!hidden) {
            clearHiddenRosterTimer(presenceKey);
            if (liveDisconnectTimers.has(presenceKey)) {
                clearTimeout(liveDisconnectTimers.get(presenceKey));
                liveDisconnectTimers.delete(presenceKey);
            }
        }

        if (!liveStudentSockets.has(presenceKey)) {
            liveStudentSockets.set(presenceKey, new Set());
        }
        liveStudentSockets.get(presenceKey).add(socket.id);

        socket.join(cleanId);
        socket.studentName = studentName;
        socket.quizId = cleanId;
        socket.sessionId = liveAuth ? liveAuth.sessionId : '';

        let neededReconnectFix = false;
        if (!hidden) {
            await updateBoardSecurely(cleanId, (board) => {
                if (!board[studentName]) {
                    board[studentName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false };
                    neededReconnectFix = true;
                }
                if (!board[studentName].kicked) {
                    if (board[studentName].disconnected || board[studentName].hiddenAway) neededReconnectFix = true;
                    board[studentName].disconnected = false;
                    board[studentName].hiddenAway = false;
                    board[studentName].lastSeenAt = Date.now();
                }
                return board;
            });
        }

        const payload = await buildLiveStatePayload(cleanId, studentName);
        if (payload) socket.emit("room-state", payload);
        if (neededReconnectFix) await emitAdminBoard(cleanId);
    });

    // Removes student from admin roster after 3s on tab switch/minimize, while keeping them live in the room
    socket.on("student-visibility", async ({ hidden } = {}) => {
        if (!socket.quizId || !socket.studentName) return;
        const cleanId = socket.quizId;
        const studentName = socket.studentName;
        const presenceKey = `${cleanId}:::${studentName}`;

        if (hidden) {
            scheduleHiddenRosterRemoval(cleanId, studentName, 3000);
        } else {
            clearHiddenRosterTimer(presenceKey);
            liveStudentLastSeen.set(presenceKey, Date.now());
            liveBackgroundedStudents.delete(presenceKey);
            let restored = false;
            try {
                await updateBoardSecurely(cleanId, (board) => {
                    if (board[studentName] && !board[studentName].kicked && (board[studentName].hiddenAway || board[studentName].disconnected)) {
                        board[studentName].hiddenAway = false;
                        board[studentName].disconnected = false;
                        board[studentName].lastSeenAt = Date.now();
                        restored = true;
                    }
                    return board;
                });
                if (restored) await emitAdminBoard(cleanId);
            } catch (e) {}
        }
    });

    socket.on("leave-room", async ({ immediate } = {}) => {
        if (socket.quizId && socket.studentName) {
            const rawBoardNow = await stateStore.get(`live:board:${socket.quizId}`);
            const boardNow = rawBoardNow ? (typeof rawBoardNow === 'string' ? JSON.parse(rawBoardNow) : rawBoardNow) : {};
            if (socket.sessionId && boardNow[socket.studentName]?.activeSessionId && boardNow[socket.studentName].activeSessionId !== socket.sessionId) {
                return;
            }
            const presenceKey = `${socket.quizId}:::${socket.studentName}`;
            liveBackgroundedStudents.delete(presenceKey);
            if (immediate) {
                liveStudentSockets.delete(presenceKey);
                if (liveDisconnectTimers.has(presenceKey)) {
                    clearTimeout(liveDisconnectTimers.get(presenceKey));
                    liveDisconnectTimers.delete(presenceKey);
                }
                await updateBoardSecurely(socket.quizId, (board) => {
                    if (board[socket.studentName]) board[socket.studentName].disconnected = true;
                    return board;
                });
                await emitAdminBoard(socket.quizId);
            } else {
                await handleStudentDeparture(socket.quizId, socket.studentName, socket.id, true);
            }
        }
    });

    socket.on("disconnect", async () => {
        if (socket.quizId && socket.studentName) {
            const rawBoardNow = await stateStore.get(`live:board:${socket.quizId}`);
            const boardNow = rawBoardNow ? (typeof rawBoardNow === 'string' ? JSON.parse(rawBoardNow) : rawBoardNow) : {};
            if (socket.sessionId && boardNow[socket.studentName]?.activeSessionId && boardNow[socket.studentName].activeSessionId !== socket.sessionId) {
                return;
            }
            await handleStudentDeparture(socket.quizId, socket.studentName, socket.id, false);
        }
    });

    socket.on("join-admin-room", async ({ quizId, adminKey }) => {
        if (!APPS_SECRET || !safeCompareStrings(adminKey, APPS_SECRET)) return;
        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return;
        socket.join(`admin-${cleanId}`);
        const payload = await buildLiveStatePayload(cleanId);
        if (payload) socket.emit("room-state", payload);
        await emitAdminBoard(cleanId);
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));