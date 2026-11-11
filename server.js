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
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
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
const AUTH_COOKIE_NAME = 'pioneers_auth_token';
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
            while (this.queue.length > 0) {
                this.queue.shift().reject(err);
            }
        });

        this.socket.on('close', () => {
            this.connected = false;
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
        if (newBoard) await stateStore.set(`live:board:${cleanId}`, newBoard, 60 * 60 * 4);
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
        `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://checkout.razorpay.com`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https://*.razorpay.com",
        "media-src 'self' blob:",
       "worker-src 'self' blob:",
    "connect-src 'self' wss: https://*.livekit.cloud wss://*.livekit.cloud https://cdn.jsdelivr.net https://api.razorpay.com https://lumberjack-cx.razorpay.com",
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'"
    ].join('; ');

    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
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
function serveDynamicHtml(req, res, fileName, canonicalBaseRoute) {
    const isHome = canonicalBaseRoute === '/';
    const nonce = res.locals.cspNonce;

    // Exempt Home, Admin Dashboard, and Live Room from strict direct-navigation blocks
    if (!isHome && canonicalBaseRoute !== '/admin-live' && canonicalBaseRoute !== '/live-room') {
        const secFetchSite = (req.get('Sec-Fetch-Site') || '').toLowerCase();
        const referer = req.get('Referer') || '';
        const host = req.get('Host') || '';
        const hasSameOriginReferer = Boolean(referer && host && referer.includes(host));

        if (secFetchSite === 'none' || secFetchSite === 'cross-site' || !hasSameOriginReferer) {
            return res.redirect(302, '/');
        }
    }

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
                    <a href="tel:+91XXXXXXXXXX" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                        <span>+91 XXXXX XXXXX (Call)</span>
                    </a>
                    <a href="https://wa.me/91XXXXXXXXXX" target="_blank" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M12.012 2c-5.506 0-9.989 4.478-9.99 9.984a9.964 9.964 0 0 0 1.333 4.976L1.92 22.07l5.244-1.376a9.972 9.972 0 0 0 4.847 1.259h.004c5.505 0 9.988-4.478 9.989-9.984 0-2.669-1.037-5.176-2.924-7.063A9.925 9.925 0 0 0 12.012 2zm0 18.283h-.003a8.272 8.272 0 0 1-4.22-1.155l-.303-.179-3.136.822.84-3.056-.197-.313a8.28 8.28 0 0 1-1.267-4.418c.001-4.57 3.72-8.288 8.293-8.288 2.215 0 4.298.863 5.864 2.428a8.236 8.236 0 0 1 2.426 5.866c-.002 4.568-3.721 8.286-8.297 8.288zm4.544-6.196c-.249-.125-1.474-.728-1.703-.811-.23-.083-.398-.124-.564.124-.167.249-.644.811-.79.77-.145-.164-.291-.207-.54-.332-1.398-.698-3.328-1.545-4.226-3.1-.096-.164-.011-.253.113-.377.111-.11.249-.29.373-.435.124-.146.166-.249.249-.415.083-.166.042-.311-.021-.436-.062-.124-.564-1.36-.773-1.865-.203-.49-.408-.424-.564-.432l-.481-.007c-.166 0-.435.062-.663.311s-.871.851-.871 2.074c0 1.223.892 2.405 1.016 2.571.124.166 1.753 2.676 4.246 3.753 1.54.665 2.112.72 2.871.603.861-.131 2.671-1.092 3.045-2.149.373-1.058.373-1.966.262-2.149-.112-.185-.415-.291-.664-.415z"/></svg>
                        <span>+91 XXXXX XXXXX (WhatsApp)</span>
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
                <div class="footer-links"><a href="/sitemap.xml">Sitemap</a></div>
            </div>
        `;

        const headRouteGuardScript = `<base href="/">
        <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
        <script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>
        <script nonce="${nonce}">
            (function() {
                var baseRoute = '${canonicalBaseRoute}';
                var isHome = (baseRoute === '/');
                try {
                    var navEntries = window.performance && window.performance.getEntriesByType ? window.performance.getEntriesByType('navigation') : [];
                    var navType = (navEntries && navEntries[0]) ? navEntries[0].type : 'navigate';
                    var clickStamp = parseInt(sessionStorage.getItem('pioneers_nav_ok') || '0', 10);
                    var isRecentClick = (Date.now() - clickStamp) < 15000;
                    var isReload = (navType === 'reload') && (sessionStorage.getItem('pioneers_active_route') === baseRoute);

                    // GLOBAL SSO GUARD: Warn and kick unauthenticated users to home
                    var token = localStorage.getItem('pp_id_token');
                    var isExemptAdmin = (baseRoute === '/admin-live');
                    if (!isHome && !isExemptAdmin && !token) {
                        alert('Please sign in to access premium study contents.');
                        sessionStorage.setItem('force_login_open', 'true');
                        window.location.replace('/');
                        return;
                    }

                    if (isHome) {
                        sessionStorage.setItem('pioneers_active_route', '/');
                        sessionStorage.removeItem('pioneers_nav_ok');
                        if (window.location.pathname !== '/') {
                            history.replaceState({ app: 'pioneers' }, document.title, '/' + window.location.search);
                        }
                    } else {
                        // Exempt Admin Dashboard and Live Room from frontend direct-navigation blocks
                        var isExempt = (baseRoute === '/admin-live' || baseRoute === '/live-room');
                        if (!isExempt && !isRecentClick && !isReload && window.location.search === '') {
                            sessionStorage.removeItem('pioneers_prep_state');
                            window.location.replace('/');
                            return;
                        }
                        
                        sessionStorage.removeItem('pioneers_nav_ok');
                        sessionStorage.setItem('pioneers_active_route', baseRoute);
                        if (window.location.pathname !== baseRoute) {
                            history.replaceState({ app: 'pioneers' }, document.title, baseRoute + window.location.search);
                        }
                    }
                } catch (e) {}

                function authorizeInternalNav() {
                    try { sessionStorage.setItem('pioneers_nav_ok', Date.now().toString()); } catch (e) {}
                }
                window.addEventListener('mousedown', authorizeInternalNav, true);
                window.addEventListener('touchstart', authorizeInternalNav, true);
                window.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') authorizeInternalNav();
                }, true);
            })();
        </script>`;

        const clientIntegrationScript = `<script nonce="${nonce}">
            (function() {
                if (typeof MainNav !== 'undefined') {
                    MainNav.normalizeRoute = function(route) {
                        if (!route) return '/';
                        var r = String(route).toLowerCase();
                        if (r.indexOf('/mock-tests') === 0 || r.indexOf('test-portal') !== -1) return '/test-portal.html';
                        if (r.indexOf('/study-notes') === 0 || r.indexOf('/notes') === 0) return '/notes.html';
                        if (r.indexOf('/descriptive') === 0) return '/descriptive.html';
                        return '/';
                    };
                }

                // 1. Track every navigation function call & its arguments in sessionStorage
                var NAV_HISTORY_KEY = 'pioneers_nav_chain';
                function recordStep(fnName, arg) {
                    try {
                        var chain = JSON.parse(sessionStorage.getItem(NAV_HISTORY_KEY) || '{}');
                        chain[fnName] = arg;
                        sessionStorage.setItem(NAV_HISTORY_KEY, JSON.stringify(chain));
                    } catch (e) {}
                }

                // Wrap global navigation functions once they load so every step is recorded
                function wrapNavFunctions() {
                    var fns = ['selectClass', 'selectSubject', 'selectUnit', 'selectChapter', 'selectNotesClass', 'selectDescriptiveClass', 'selectDescriptiveSubject'];
                    fns.forEach(function(fn) {
                        if (typeof window[fn] === 'function' && !window[fn].__wrapped) {
                            var orig = window[fn];
                            window[fn] = function(arg) {
                                recordStep(fn, arg);
                                const res = orig.apply(this, arguments);
                                setTimeout(snapshotAllPopulatedScreens, 120);
                                return res;
                            };
                            window[fn].__wrapped = true;
                        }
                    });
                }

                // 2. Snapshot innerHTML of any screen that actually has rendered items
                var DOM_CACHE_KEY = 'pioneers_dom_cache_v2';
                function isScreenPopulated(screenEl) {
                    if (!screenEl) return false;
                    // Look for any dynamic container with children, or more than 1 button/card
                    var cards = screenEl.querySelectorAll('.card, .quiz-card, .chapter-card, .unit-card, .subject-card, .note-card, .paper-card, a[href], button:not(.back-btn)');
                    return cards.length > 0;
                }

                function snapshotAllPopulatedScreens() {
                    try {
                        var cache = JSON.parse(sessionStorage.getItem(DOM_CACHE_KEY) || '{}');
                        document.querySelectorAll('.app-screen').forEach(function(scr) {
                            if (scr.id && scr.id !== 'quiz-screen' && scr.id !== 'result-screen' && isScreenPopulated(scr)) {
                                // Tag dynamic cards with their visible text so click delegation works after restore
                                scr.querySelectorAll('.card, button:not(.back-btn)').forEach(function(el) {
                                    if (!el.getAttribute('data-restored-label')) {
                                        el.setAttribute('data-restored-label', (el.innerText || '').trim());
                                    }
                                });
                                cache[scr.id] = scr.innerHTML;
                            }
                        });
                        sessionStorage.setItem(DOM_CACHE_KEY, JSON.stringify(cache));
                    } catch (e) {}
                }

                function restoreBlankScreensFromCache() {
                    try {
                        var cache = JSON.parse(sessionStorage.getItem(DOM_CACHE_KEY) || '{}');
                        document.querySelectorAll('.app-screen').forEach(function(scr) {
                            if (scr.id && scr.id !== 'quiz-screen' && scr.id !== 'result-screen' && cache[scr.id] && !isScreenPopulated(scr)) {
                                scr.innerHTML = cache[scr.id];
                            }
                        });
                    } catch (e) {}
                }

                // 3. Rebuild parent screens natively after a page refresh without switching away from the active screen
                function replayParentHierarchySilently() {
                    try {
                        wrapNavFunctions();
                        var activeBefore = document.querySelector('.app-screen:not(.hidden)');
                        var activeId = activeBefore ? activeBefore.id : null;
                        if (!activeId || activeId === 'home-dashboard' || activeId === 'quiz-screen' || activeId === 'result-screen') return;

                        var state = JSON.parse(sessionStorage.getItem('pioneers_prep_state') || '{}');
                        var chain = JSON.parse(sessionStorage.getItem(NAV_HISTORY_KEY) || '{}');

                        var cls = chain.selectClass || state.selectedClass || state.currentClass || state.classLevel;
                        var sub = chain.selectSubject || state.selectedSubject || state.currentSubject || state.subject;
                        var unit = chain.selectUnit || state.selectedUnit || state.currentUnit || state.unit;
                        var nCls = chain.selectNotesClass || cls;
                        var dCls = chain.selectDescriptiveClass || cls;
                        var dSub = chain.selectDescriptiveSubject || sub;

                        // Replay parent builders in order so their DOM containers are populated with live listeners
                        if (cls && typeof window.selectClass === 'function') window.selectClass(cls);
                        if (nCls && typeof window.selectNotesClass === 'function') window.selectNotesClass(nCls);
                        if (dCls && typeof window.selectDescriptiveClass === 'function') window.selectDescriptiveClass(dCls);
                        if (sub && typeof window.selectSubject === 'function') window.selectSubject(sub);
                        if (dSub && typeof window.selectDescriptiveSubject === 'function') window.selectDescriptiveSubject(dSub);
                        if (unit && typeof window.selectUnit === 'function') window.selectUnit(unit);

                        // Restore the exact screen the student was on when they hit refresh
                        document.querySelectorAll('.app-screen').forEach(function(s) {
                            if (s.id === activeId) s.classList.remove('hidden');
                            else s.classList.add('hidden');
                        });
                        state.activeScreen = activeId;
                        sessionStorage.setItem('pioneers_prep_state', JSON.stringify(state));
                        snapshotAllPopulatedScreens();
                    } catch (e) {}
                }

                try {
                    var origSetItem = sessionStorage.setItem;
                    sessionStorage.setItem = function(key, val) {
                        if (key === 'pioneers_prep_state' && typeof val === 'string') {
                            try {
                                var parsed = JSON.parse(val);
                                if (parsed && 'studentAuthToken' in parsed) {
                                    delete parsed.studentAuthToken;
                                    val = JSON.stringify(parsed);
                                }
                            } catch (e) {}
                        }
                        return origSetItem.call(this, key, val);
                    };
                } catch (e) {}

                // Intercept fetch so as soon as /api/quizzes, /api/notes, or /api/descriptive-questions finishes loading on refresh, we rebuild parent screens
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

                    if (url.indexOf('/api/start-quiz') !== -1 || (url.indexOf('/api/quiz/') !== -1 && url.indexOf('/question/') === -1)) {
                        return p.then(async function(response) {
                            try {
                                var clone = response.clone();
                                var data = await clone.json();
                                if (data && data.alreadyAttempted) {
                                    renderComprehensiveResultScreen(data, true);
                                    return new Promise(function() {}); // Halt quiz initialization cleanly
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

                    if (url.indexOf('/api/quizzes') !== -1 || url.indexOf('/api/notes') !== -1 || url.indexOf('/api/descriptive-questions') !== -1) {
                        p.then(function() {
                            setTimeout(function() {
                                replayParentHierarchySilently();
                                restoreBlankScreensFromCache();
                            }, 150);
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
                    if (!resultScreen) return;

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
                                sessionStorage.removeItem(DOM_CACHE_KEY);
                                sessionStorage.removeItem(NAV_HISTORY_KEY);
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

                window.addEventListener('mousedown', snapshotAllPopulatedScreens, true);
                window.addEventListener('touchstart', snapshotAllPopulatedScreens, true);
                window.addEventListener('beforeunload', snapshotAllPopulatedScreens);

                document.addEventListener('click', function(e) {
                    wrapNavFunctions();
                    var target = e.target ? e.target.closest('[data-action], [data-csp-action], .card, button, a') : null;
                    if (!target) return;

                    var action = target.getAttribute('data-action');
                    var arg = target.getAttribute('data-arg');
                    if (action) {
                        if (action === 'clear-session') {
                            try {
                                sessionStorage.removeItem('pioneers_prep_state');
                                sessionStorage.removeItem(DOM_CACHE_KEY);
                                sessionStorage.removeItem(NAV_HISTORY_KEY);
                            } catch (err) {}
                        } else if (action === 'select-class' && typeof selectClass === 'function') {
                            selectClass(arg);
                        } else if (action === 'select-subject' && typeof selectSubject === 'function') {
                            selectSubject(arg);
                        } else if (action === 'select-notes-class' && typeof selectNotesClass === 'function') {
                            selectNotesClass(arg);
                        } else if (action === 'select-descriptive-class' && typeof selectDescriptiveClass === 'function') {
                            selectDescriptiveClass(arg);
                        } else if (action === 'select-descriptive-subject' && typeof selectDescriptiveSubject === 'function') {
                            selectDescriptiveSubject(arg);
                        } else if (action === 'go-back' && typeof goBack === 'function') {
                            goBack();
                            setTimeout(restoreBlankScreensFromCache, 20);
                        } else if (action === 'go-home' && typeof goHome === 'function') {
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
                        return;
                    }

                    var txt = (target.innerText || '').trim();
                    if (txt.includes('Class IX (Physics')) { selectClass('IX'); return; }
                    if (txt.includes('Class X (Physics')) { selectClass('X'); return; }
                    if (txt.includes('NEET Class XI')) { selectClass('XI'); return; }
                    if (txt.includes('NEET Class XII')) { selectClass('XII'); return; }
                    if (txt.includes('Next') && typeof nextQuestion === 'function') { nextQuestion(); return; }
                    if (txt.includes('Previous') && typeof prevQuestion === 'function') { prevQuestion(); return; }
                    if (txt.includes('Clear') && typeof clearResponse === 'function') { clearResponse(); return; }
                    if ((txt.includes('Submit') || txt.includes('Finish')) && typeof submitQuiz === 'function') { submitQuiz(false); return; }

                    var legacyExpr = target.getAttribute('data-csp-action');
                    if (legacyExpr) {
                        if (legacyExpr.indexOf("sessionStorage.removeItem('pioneers_prep_state')") !== -1) {
                            try {
                                sessionStorage.removeItem('pioneers_prep_state');
                                sessionStorage.removeItem(DOM_CACHE_KEY);
                                sessionStorage.removeItem(NAV_HISTORY_KEY);
                            } catch (err) {}
                            return;
                        }
                        var fnMatch = /^([a-zA-Z0-9_]+)\((.*)\)$/.exec(legacyExpr.trim());
                        if (fnMatch) {
                            var fnName = fnMatch[1];
                            var rawArg = fnMatch[2].trim().replace(/^['"]|['"]$/g, '');
                            if (typeof window[fnName] === 'function') {
                                if (fnName === 'submitQuiz') window[fnName](rawArg === 'true');
                                else window[fnName](rawArg);
                                setTimeout(restoreBlankScreensFromCache, 20);
                            }
                            return;
                        }
                    }

                    // If a restored card on Unit/Subject screen was clicked after DOM cache restore
                    var parentScreen = target.closest('.app-screen');
                    if (parentScreen && target.classList.contains('card') && !target.hasAttribute('data-csp-action')) {
                        var cardTitleEl = target.querySelector('h3, h4, .card-title, strong');
                        var cardLabel = cardTitleEl ? cardTitleEl.innerText.trim() : txt.split('\\n')[0].trim();
                        if (parentScreen.id.indexOf('unit') !== -1 && typeof window.selectUnit === 'function') {
                            window.selectUnit(cardLabel);
                        } else if (parentScreen.id.indexOf('chapter') !== -1 && typeof window.selectChapter === 'function') {
                            window.selectChapter(cardLabel);
                        } else if (parentScreen.id.indexOf('subject') !== -1 && typeof window.selectSubject === 'function') {
                            window.selectSubject(cardLabel);
                        }
                    }
                });

                try {
                    var s = sessionStorage.getItem('pioneers_prep_state');
                    if (s) {
                        var st = JSON.parse(s);
                        var a = st.activeScreen;
                        if (a && a !== 'home-dashboard') {
                            var screens = document.querySelectorAll('.app-screen');
                            var found = false;
                            for (var i = 0; i < screens.length; i++) {
                                if (screens[i].id === a) {
                                    screens[i].classList.remove('hidden');
                                    found = true;
                                } else {
                                    screens[i].classList.add('hidden');
                                }
                            }
                            if (a === 'quiz-screen') document.body.classList.add('exam-mode');
                            if (!found) {
                                var home = document.getElementById('home-dashboard');
                                if (home) home.classList.remove('hidden');
                            }
                        }
                    }
                } catch(e) {}

                window.addEventListener('DOMContentLoaded', function() {
                    var baseRoute = '${canonicalBaseRoute}';
                    var backEventTriggered = false;

                    wrapNavFunctions();
                    restoreBlankScreensFromCache();
                    setTimeout(function() {
                        replayParentHierarchySilently();
                        restoreBlankScreensFromCache();
                    }, 300);

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

                    setTimeout(function() {
                        if (window.location.search && window.location.search.indexOf('class=') !== -1) {
                            return;
                        }
                        var activeEl = document.querySelector('.app-screen:not(.hidden)');
                        if (!activeEl) return;
                        var initialUrl = getCleanUrlForScreen(activeEl.id);
                        history.replaceState({ app: 'pioneers', screen: activeEl.id }, document.title, initialUrl);
                    }, 0);

                    var observer = new MutationObserver(function(mutations) {
                    mutations.forEach(function(m) {
                        var el = m.target;
                        if (el.classList.contains('app-screen') && !el.classList.contains('hidden')) {
                            var introEl = document.querySelector('.page-intro');
                            if (introEl && baseRoute !== '/') {
                                introEl.style.display = (el.id === 'result-screen' || el.id === 'quiz-screen') ? 'none' : '';
                            }
                                if (!isScreenPopulated(el)) {
                                    restoreBlankScreensFromCache();
                                }
                                var targetUrl = getCleanUrlForScreen(el.id);
                                if (backEventTriggered) {
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
                            setTimeout(restoreBlankScreensFromCache, 20);
                        }
                        // The fatal mobile redirect to window.location.href = '/' has been removed from here
                    }
                });

                    document.addEventListener('click', function(e) {
                        if (e.target && e.target.classList && e.target.classList.contains('back-btn')) {
                            backEventTriggered = true;
                            setTimeout(restoreBlankScreensFromCache, 20);
                        }
                    }, true);
                });
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
                    const start = performance.now();
                    debugger; 
                    if (performance.now() - start > 100 && document.body.classList.contains('exam-mode')) {
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
            .replace(/<meta name="viewport"[^>]*>/i, '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">')
            .replace(/<header id="site-header"[^>]*>.*?<\/header>/is, `<header id="site-header" class="site-header">${headerHTML}</header>`)
            .replace(/<footer id="site-footer"[^>]*>.*?<\/footer>/is, `<footer id="site-footer" class="site-footer">${footerHTML}</footer>`)
            .replace('</body>', `${clientIntegrationScript}\n</body>`);

        if (req.query && req.query.class) {
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
    const files = getAllJsonFiles(quizzesDir);
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
    const files = getAllPdfFiles(descDir);
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
    if (dataParts.length < 2) return { valid: false, error: 'Security Alert: Outdated session token.' };

    const tokenEmail = dataParts[0];
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

// Implementation 6: Dual Redis + File Persistence for Submissions & Leaderboard History
async function getHistoricalSubmissions() {
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

    if (redisList.length === 0) return fileList;
    if (fileList.length === 0) return redisList;

    const merged = [...redisList];
    const seenKeys = new Set(redisList.map(s => `${s.timestamp || ''}|${s.email || ''}|${s.quizId || s.chapterTitle || ''}|${s.score}`));
    for (const item of fileList) {
        const key = `${item.timestamp || ''}|${item.email || ''}|${item.quizId || item.chapterTitle || ''}|${item.score}`;
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            merged.push(item);
        }
    }
    return merged.slice(-5000);
}

let submissionWritePromise = Promise.resolve();
function queueSubmissionBackup(entry) {
    submissionWritePromise = submissionWritePromise.then(async () => {
        try {
            let allSubmissions = await getHistoricalSubmissions();
            const { secretKey, breakdown, ...safeMetadata } = entry;
            allSubmissions.push(safeMetadata);
            if (allSubmissions.length > 5000) {
                allSubmissions = allSubmissions.slice(-5000);
            }
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
        { loc: '/descriptive-papers', priority: '0.8' }
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url>\n    <loc>${SITE_URL}${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
        `\n</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
});

app.get('/ping', (req, res) => res.status(200).send('Awake'));

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
        if (!APPS_SECRET || adminKey !== APPS_SECRET) {
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
        
        res.json({ success: true, orderId: order.id, amount: order.amount, keyId: process.env.RAZORPAY_KEY_ID });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: 'Order creation failed.' });
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

app.get('/api/descriptive-questions', (req, res) => {
    try {
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

            const itemMeta = parsePdfMetadata(fileName);
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

    const referer = req.get('Referer') || '';
    if (!referer.includes('pioneersprep.in') && !referer.includes(req.get('Host'))) {
        return res.status(403).send("Direct script downloads are blocked.");
    }

    const filePath = resolveSafeDescriptivePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Descriptive paper not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download file.");
    });
});

app.get('/api/notes', (req, res) => {
    try {
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

    const referer = req.get('Referer') || '';
    if (!referer.includes('pioneersprep.in') && !referer.includes(req.get('Host'))) {
        return res.status(403).send("Direct script downloads are blocked.");
    }

    const filePath = resolveSafeNotePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Note file not found.");
    res.download(filePath, path.basename(filePath), (err) => {
        if (err && !res.headersSent) res.status(500).send("Failed to download note.");
    });
});

app.get('/api/quizzes', (req, res) => {
    try {
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

// 2. JIT Single Question Delivery (Fetches one question dynamically)
app.get('/api/quiz/:id/question/:index', async (req, res) => {
    try {
        if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
        const token = extractAuthToken(req);
        const authCheck = await verifyAuthToken(token, null, false);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        const cleanId = path.basename(String(req.params.id || '')).trim();
        const index = parseInt(req.params.index, 10);
        const filePath = resolveSafeQuizPath(cleanId);

        const sessionKey = `exam:session:${authCheck.signature}`;
        const rawSession = await stateStore.get(sessionKey);
        if (!rawSession) return res.status(403).json({ error: "No active session." });

        const session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;
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

        const sanitized = { type: qType, question: q.question, options: clientOptions };
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
        if (!usersMap[cleanEmail]) {
            usersMap[cleanEmail] = profile;
            await fs.promises.writeFile(USERS_FILE_PATH, JSON.stringify(usersMap, null, 2), { mode: 0o600 });
        }
    } catch {}
    return profile;
}

app.post('/api/send-otp', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const now = Date.now();

        const allowed = await stateStore.checkRateLimit('otp', clientIp, 10, 15 * 60);
        if (!allowed) {
            return res.status(429).json({ success: false, error: 'Too many requests. Wait 15 minutes.' });
        }

        const email = req.body.email ? String(req.body.email).trim().toLowerCase().slice(0, 120) : '';
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid Email Address.' });
        }

        // Check if this email already has a permanently registered name
        const existingProfile = await getRegisteredStudentProfile(email);
        let firstName = '';
        let lastName = '';

        if (existingProfile) {
            // Returning student: lock in their registered name and ignore any modifications
            firstName = existingProfile.firstName;
            lastName = existingProfile.lastName;
        } else {
            // First-time student: require First Name and Last Name once
            firstName = req.body.firstName ? String(req.body.firstName).trim().toUpperCase().slice(0, 60) : '';
            lastName = req.body.lastName ? String(req.body.lastName).trim().toUpperCase().slice(0, 60) : '';
            if (!firstName || !lastName) {
                return res.json({
                    success: false,
                    requireName: true,
                    message: 'First-time sign in: Please enter your First Name and Last Name.'
                });
            }
        }

        const otpKey = `otp:pending:${email}`;
        const rawExistingOtp = await stateStore.get(otpKey);
        if (rawExistingOtp) {
            try {
                const existingOtp = typeof rawExistingOtp === 'string' ? JSON.parse(rawExistingOtp) : rawExistingOtp;
                if (existingOtp && (now - existingOtp.lastSentAt) < 60 * 1000) {
                    return res.status(429).json({ success: false, error: 'Please wait 60 seconds before requesting another OTP.' });
                }
            } catch {}
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        await stateStore.set(otpKey, {
            otp, firstName, lastName, expiresAt: now + 5 * 60 * 1000, attempts: 0, lastSentAt: now
        }, 5 * 60);

        console.log(`[OTP Dispatched] Recipient: ${maskEmail(email)} at ${new Date().toISOString()}`);

        const scriptURL = process.env.APP_SCRIPT_URL;
        if (scriptURL && APPS_SECRET) {
            const fullName = `${escapeHtml(firstName)} ${escapeHtml(lastName)}`.trim();
            const plainTextBody = [
                `Hello ${firstName} ${lastName},`,
                ``,
                `Thank you for signing in to Pioneers Prep (https://pioneersprep.in).`,
                `Your one-time login verification code is: ${otp}`,
                ``,
                `This code is valid for 5 minutes. For your account security, please do not share this code with anyone.`,
                ``,
                `If you did not request this sign-in code, you can safely ignore this message.`,
                ``,
                `Warm regards,`,
                `Aniruddha Banerjee`,
                `Pioneers Prep — Online Mock Tests & Study Portal`,
                `Berhampore, Murshidabad, West Bengal`
            ].join('\n');

            const inboxSafeHtml = `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1e293b; line-height: 1.6; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;">
                    <p style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #1e3a8a;">Pioneers Prep — Student Portal</p>
                    <p style="margin: 0 0 16px 0; font-size: 15px;">Hello <strong>${fullName}</strong>,</p>
                    <p style="margin: 0 0 16px 0; font-size: 15px;">You requested a one-time verification code to sign in to your Pioneers Prep student account. Please enter the following 6-digit code on the portal:</p>
                    <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 14px 20px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 24px; font-weight: 700; color: #1e3a8a; letter-spacing: 4px; font-family: monospace;">${otp}</span>
                    </div>
                    <p style="margin: 0 0 16px 0; font-size: 14px; color: #475569;">This verification code will expire in 5 minutes. Please do not share this code with anyone.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
                    <p style="margin: 0; font-size: 12px; color: #64748b;">
                        Warm regards,<br />
                        <strong>Aniruddha Banerjee</strong><br />
                        Pioneers Prep (<a href="https://pioneersprep.in" style="color: #2563eb; text-decoration: none;">pioneersprep.in</a>)<br />
                        Berhampore, Murshidabad, West Bengal
                    </p>
                </div>
            `;

            fetch(scriptURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'otp',
                    targetEmail: email,
                    senderName: 'Pioneers Prep',
                    subject: `Pioneers Prep login code for ${firstName} (${otp})`,
                    plainText: plainTextBody,
                    secretKey: APPS_SECRET,
                    breakdown: inboxSafeHtml
                })
            }).catch(err => console.error('OTP email error:', err));
        }
        res.json({
            success: true,
            isReturningUser: Boolean(existingProfile),
            firstName,
            lastName
        });
    } catch {
        res.status(500).json({ success: false, error: 'Failed to process OTP request.' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const allowed = await stateStore.checkRateLimit('verify', clientIp, 15, 15 * 60);
        if (!allowed) {
            return res.status(429).json({ success: false, error: 'Too many verification attempts. Please wait 15 minutes.' });
        }

        const email = req.body.email ? String(req.body.email).trim().toLowerCase() : '';
        const otp = req.body.otp ? String(req.body.otp).trim() : '';
        const otpKey = `otp:pending:${email}`;
        const rawRecord = await stateStore.get(otpKey);

        if (!rawRecord) {
            return res.status(400).json({ success: false, error: 'Verification code expired. Please request a new OTP.' });
        }

        const record = typeof rawRecord === 'string' ? JSON.parse(rawRecord) : rawRecord;
        if (!record || Date.now() > record.expiresAt) {
            await stateStore.del(otpKey);
            return res.status(400).json({ success: false, error: 'Verification code expired. Please request a new OTP.' });
        }

        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5) {
            await stateStore.del(otpKey);
            return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Request a new OTP.' });
        }

        if (!safeCompareStrings(record.otp, otp)) {
            const remainingSec = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
            await stateStore.set(otpKey, record, remainingSec);
            return res.status(400).json({ success: false, error: 'Invalid verification code.' });
        }

        await stateStore.del(otpKey);

        // Permanently lock the student's name to this email upon first successful OTP verification
        const existingProfile = await getRegisteredStudentProfile(email);
        const finalFirstName = existingProfile ? existingProfile.firstName : record.firstName;
        const finalLastName = existingProfile ? existingProfile.lastName : record.lastName;
        if (!existingProfile) {
            await saveRegisteredStudentProfile(email, finalFirstName, finalLastName);
        }

        const tokenData = `${email}|${encodeURIComponent(finalFirstName)}|${encodeURIComponent(finalLastName)}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
        const authToken = `${tokenData}|||${signature}`;

        await stateStore.set(`ip:verified:${clientIp}`, '1', TOKEN_MAX_AGE_SEC);

        res.cookie(AUTH_COOKIE_NAME, authToken, {
            httpOnly: true, secure: isSecureConnection(req), sameSite: 'strict', maxAge: TOKEN_MAX_AGE_MS, path: '/'
        });

        // Send the token and locked user data to the frontend for Global SSO
        res.json({ 
            success: true, 
            token: authToken, 
            firstName: finalFirstName, 
            lastName: finalLastName, 
            email: email 
        });
    } catch {
        res.status(500).json({ success: false, error: 'OTP verification failed.' });
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
        await stateStore.set(LIVE_ROOMS_REDIS_KEY, obj, 60 * 60 * 4);
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
            if (now - info.lastSeen <= 4 * 60 * 60 * 1000) {
                rooms.push({ id: info.id, name: info.name });
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
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized Admin' });

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

function verifyLiveRoomToken(liveToken) {
    if (!liveToken || typeof liveToken !== 'string' || !liveToken.includes('|||')) return null;
    const [tokenData, sig] = liveToken.split('|||');
    const expectedSig = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
    if (!safeCompareHex(sig, expectedSig)) return null;

    const parts = tokenData.split('|');
    if (parts[0] === 'LIVE' && parts.length >= 5) {
        const quizId = parts[1];
        const firstName = decodeURIComponent(parts[2] || '');
        const lastName = decodeURIComponent(parts[3] || '');
        return {
            valid: true,
            quizId,
            studentName: `${firstName} ${lastName}`.trim() || 'Student'
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

async function emitRoomStateToAll(cleanId) {
    const payload = await buildLiveStatePayload(cleanId);
    if (payload) {
        io.to(cleanId).emit('room-state', payload);
        io.to(`admin-${cleanId}`).emit('room-state', payload);
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

// Step 1: Admin Creates a Named Room
app.post('/api/live/admin/start', async (req, res) => {
    try {
        const { adminKey, quizId, questionFile } = req.body;
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized Admin' });

        const rawRoomName = String(quizId || '').trim();
        const cleanId = path.basename(rawRoomName).trim();
        if (!cleanId) return res.status(400).json({ error: 'Room name is required.' });

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

        await stateStore.set(`live:state:${cleanId}`, roomState, 60 * 60 * 4);
        await stateStore.set(`live:admin_seen:${cleanId}`, Date.now(), 60 * 60 * 4);
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
            roomName: rawRoomName,
            activeQuizFile,
            totalQuestions
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create room.' });
    }
});

// Step 2: Admin Selects or Switches Question Set from /livemock Dropdown
app.post('/api/live/admin/select-quiz', async (req, res) => {
    try {
        const { adminKey, quizId, questionFile } = req.body;
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized Admin' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room is not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;

        if (!questionFile || String(questionFile).trim() === '') {
            state.activeQuizFile = '';
            state.currentIndex = 0;
            state.totalQuestions = 0;
            state.title = state.roomName || cleanId;
            await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);
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

        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);
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
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        state.broadcastMode = ['question', 'presentation', 'both'].includes(broadcastMode) ? broadcastMode : 'question';
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);

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
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId || '')).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });
        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        const idx = Number(state.currentIndex) || 0;

        state.questionStartTime = Date.now();
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);

        await updateBoardSecurely(cleanId, (board) => {
            Object.keys(board).forEach(student => {
                if (board[student] && board[student].answers) {
                    delete board[student].answers[idx];
                }
            });
            return board;
        });

        const payload = await buildLiveStatePayload(cleanId);
        if (payload) {
            payload.forceRefresh = true;
            io.to(cleanId).emit('room-state', payload);
        }
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
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized' });
        const cleanId = path.basename(String(quizId)).trim();

        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (stateStr) {
            const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
            state.status = 'ended';
            await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);
        }

        await loadActiveRoomsFromRedis();
    activeLiveRooms.delete(cleanId);
    await syncActiveRoomsToRedis();
    await stateStore.del(`live:otp:${cleanId}`);
    await emitRoomStateToAll(cleanId);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to end room.' }); }
});
// Admin: Change Question Index
app.post('/api/live/admin/set-index', async (req, res) => {
    try {
        const { adminKey, quizId, index } = req.body;
        if (adminKey !== APPS_SECRET) return res.status(403).json({ error: 'Unauthorized' });

        const cleanId = path.basename(String(quizId)).trim();
        const stateStr = await stateStore.get(`live:state:${cleanId}`);
        if (!stateStr) return res.status(400).json({ error: 'Room not active.' });

        const state = typeof stateStr === 'string' ? JSON.parse(stateStr) : stateStr;
        state.currentIndex = parseInt(index, 10);
        state.questionStartTime = Date.now();
        await stateStore.set(`live:state:${cleanId}`, state, 60 * 60 * 4);

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
        const studentName = `${fName} ${lName}`.trim() || 'Student';

        await updateBoardSecurely(cleanId, (board) => {
            if (!board[studentName]) {
                board[studentName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false };
            }
            board[studentName].disconnected = false;
            return board;
        });

        await emitAdminBoard(cleanId);

        const tokenData = `LIVE|${cleanId}|${encodeURIComponent(fName)}|${encodeURIComponent(lName)}|${Date.now()}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');

        res.json({ success: true, token: `${tokenData}|||${signature}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to join room.' });
    }
});

app.post('/api/live/student/rejoin', async (req, res) => {
    const liveCheck = verifyLiveRoomToken(extractAuthToken(req));
    if (!liveCheck) return res.status(401).json({ error: 'Invalid session' });
    await emitAdminBoard(liveCheck.quizId);
    res.json({ success: true });
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
        const qStart = (state && state.questionStartTime) ? state.questionStartTime : Date.now() - 2000;
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

        await updateBoardSecurely(cleanId, (board) => {
            if (!board[studentName]) {
                board[studentName] = { joinedAt: Date.now(), answers: {}, muted: false, kicked: false };
            }
            board[studentName].answers = board[studentName].answers || {};
            board[studentName].answers[index] = {
                answer: Number(answer),
                optionLabel,
                isCorrect,
                timeSec,
                submittedAt: Date.now()
            };
            return board;
        });

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
        const { quizId, studentName } = req.query;
        if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
            return res.status(500).json({ error: "Missing SFU keys." });
        }
        const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { 
            identity: String(studentName || 'user') + '_' + Math.random().toString(36).substring(2, 6)
        });
        at.addGrant({
            roomJoin: true,
            room: String(quizId || 'default'),
            canPublish: true,
            canSubscribe: true
        });
        res.json({ token: await at.toJwt() });
    } catch (err) {
        res.status(500).json({ error: "Token generation failed." });
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
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
    socket.on("join-room", async ({ quizId, token }) => {
        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return;

        const liveAuth = verifyLiveRoomToken(token);
        const ssoAuth = !liveAuth ? await verifyAuthToken(token, null, false) : null;
        if (!liveAuth && (!ssoAuth || !ssoAuth.valid)) return;

        const studentName = liveAuth
            ? liveAuth.studentName
            : `${ssoAuth.firstName || ''} ${ssoAuth.lastName || ''}`.trim();

        socket.join(cleanId);
        socket.studentName = studentName;
        socket.quizId = cleanId;

        const payload = await buildLiveStatePayload(cleanId, studentName);
        if (payload) socket.emit("room-state", payload);
        await emitAdminBoard(cleanId);
    });

    socket.on("join-admin-room", async ({ quizId }) => {
        const cleanId = path.basename(String(quizId || '')).trim();
        if (!cleanId) return;
        socket.join(`admin-${cleanId}`);
        const payload = await buildLiveStatePayload(cleanId);
        if (payload) socket.emit("room-state", payload);
        await emitAdminBoard(cleanId);
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));