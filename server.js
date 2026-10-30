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
// 1. HARDENED PROXY, SECRETS & RAZORPAY CONFIG
// ============================================================================
const TRUST_PROXY_DEPTH = process.env.TRUST_PROXY !== undefined
    ? (isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
    : 1;
app.set('trust proxy', TRUST_PROXY_DEPTH);

function loadOrGenerateMasterSecret() {
    if (process.env.TIMER_SECRET && process.env.TIMER_SECRET.trim().length >= 32) return process.env.TIMER_SECRET.trim();
    const secretFilePath = path.join(__dirname, '.runtime_secret');
    try {
        if (fs.existsSync(secretFilePath)) {
            const existing = fs.readFileSync(secretFilePath, 'utf8').trim();
            if (existing.length >= 64) return existing;
        }
        const generated = crypto.randomBytes(64).toString('hex');
        fs.writeFileSync(secretFilePath, generated, { mode: 0o600 });
        return generated;
    } catch { return crypto.randomBytes(64).toString('hex'); }
}

const SECRET = loadOrGenerateMasterSecret();
const APPS_SECRET = process.env.APPS_SCRIPT_SECRET || '';
const ADMIN_EMAIL = process.env.TARGET_EMAIL || 'anibanerjee699@gmail.com';

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('[Finance] Razorpay SDK initialized successfully.');
} else {
    console.warn('[Finance Warning] Razorpay credentials missing. Payments will fail.');
}

// ============================================================================
// 2. REDIS DISTRIBUTED STATE ENGINE
// ============================================================================
const MAX_MAP_SIZE = 5000;
const TOKEN_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const TOKEN_MAX_AGE_SEC = Math.ceil(TOKEN_MAX_AGE_MS / 1000);
const CACHE_TTL_MS = 60 * 1000;
const AUTH_COOKIE_NAME = 'pioneers_auth_token';

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
            if (this.password) this.sendRaw(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password]).catch(()=>{});
            if (this.db > 0) this.sendRaw(['SELECT', String(this.db)]).catch(() => {});
        });
        this.socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.processBuffer();
        });
        this.socket.on('error', (err) => {
            this.connected = false;
            while (this.queue.length > 0) this.queue.shift().reject(err);
        });
        this.socket.on('close', () => { this.connected = false; setTimeout(() => this.connect(), 3000); });
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
            const start = lineEnd + 2, end = start + len;
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
            if (parsed.error) req.reject(parsed.error); else req.resolve(parsed.value);
        }
    }
    sendRaw(args) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Redis disconnected'));
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
        if (this.upstashUrl && this.upstashToken) console.log('[StateStore] Connected to Upstash Redis REST API.');
        else if (process.env.REDIS_URL) {
            try { this.redisClient = new NativeRedisClient(process.env.REDIS_URL); console.log('[StateStore] Initialized native Redis client.'); } 
            catch (e) { console.warn('[StateStore] Native client failed:', e.message); }
        }
    }
    setFallback(key, value, ttlSec) {
        if (!this.fallbackMap.has(key) && this.fallbackMap.size >= MAX_MAP_SIZE) this.fallbackMap.delete(this.fallbackMap.keys().next().value);
        this.fallbackMap.set(key, { value, expiresAt: Date.now() + (ttlSec * 1000) });
    }
    getFallback(key) {
        const entry = this.fallbackMap.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) { this.fallbackMap.delete(key); return null; }
        return entry.value;
    }
    async execCommand(args) {
        if (this.upstashUrl && this.upstashToken) {
            const res = await fetch(this.upstashUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${this.upstashToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
            if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
            return (await res.json()).result;
        }
        if (this.redisClient && this.redisClient.connected) return await this.redisClient.sendRaw(args);
        throw new Error('No external Redis active');
    }
    async get(key) {
        try { return await this.execCommand(['GET', key]); } catch { return this.getFallback(key); }
    }
    async set(key, value, ttlSec) {
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        this.setFallback(key, strVal, ttlSec);
        try { await this.execCommand(['SET', key, strVal, 'EX', String(ttlSec)]); } catch {}
    }
    async setNx(key, value, ttlSec) {
        try { return await this.execCommand(['SET', key, String(value), 'EX', String(ttlSec), 'NX']) === 'OK'; } 
        catch {
            if (this.getFallback(key) !== null) return false;
            this.setFallback(key, String(value), ttlSec);
            return true;
        }
    }
    async del(key) {
        this.fallbackMap.delete(key);
        try { await this.execCommand(['DEL', key]); } catch {}
    }
    async checkRateLimit(bucket, ip, maxRequests, windowSec) {
        const key = `rl:${bucket}:${ip}`;
        try {
            const count = Number(await this.execCommand(['INCR', key]));
            if (count === 1) await this.execCommand(['EXPIRE', key, String(windowSec)]);
            return count <= maxRequests;
        } catch {
            const entry = this.fallbackMap.get(key);
            const count = entry ? Number(entry.value) + 1 : 1;
            const remainingSec = entry ? Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : windowSec;
            this.setFallback(key, String(count), remainingSec);
            return count <= maxRequests;
        }
    }
}
const stateStore = new StateStore();

// ============================================================================
// 3. ZERO-TRUST UNIVERSAL ACCESS GATE
// ============================================================================
async function checkContentAccess(email, itemID, isPremium) {
    if (!isPremium) return true;
    
    // 1. Master VIP Whitelist Check
    const isVip = await stateStore.get(`whitelist:vip:${email}`);
    if (isVip) return true;

    // 2. Item-Specific Whitelist Check
    const isWhitelisted = await stateStore.get(`whitelist:item:${itemID}:${email}`);
    if (isWhitelisted) return true;

    // 3. Purchase Ledger Check
    const hasPurchased = await stateStore.get(`user:purchases:${email}:${itemID}`);
    if (hasPurchased) return true;

    return false;
}

// ============================================================================
// 4. GENERAL APP HELPERS & PARSERS
// ============================================================================
function setBoundedMap(map, key, value) {
    if (!map.has(key) && map.size >= MAX_MAP_SIZE) map.delete(map.keys().next().value);
    map.set(key, value);
}

function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp.trim().slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
        if (ips.length > 0) return ips[Math.max(0, ips.length - (Number(TRUST_PROXY_DEPTH) || 1))].slice(0, 64);
    }
    return String(req.ip || req.socket?.remoteAddress || 'unknown').trim().slice(0, 64);
}

const fsCache = {
    quizzesList: { data: null, expiresAt: 0 }, quizPaths: { data: null, expiresAt: 0 }, quizContentByPath: new Map(),
    notesList: { data: null, expiresAt: 0 }, notePaths: { data: null, expiresAt: 0 },
    descList: { data: null, expiresAt: 0 }, descPaths: { data: null, expiresAt: 0 }
};

function verifyJsonComplexity(req, res, buf) {
    if (!buf || buf.length === 0) return;
    let depth = 0, maxDepth = 0, inString = false, escaped = false;
    for (let i = 0; i < buf.length; i++) {
        if (escaped) { escaped = false; continue; }
        if (buf[i] === 0x5c) { escaped = true; continue; }
        if (buf[i] === 0x22) { inString = !inString; continue; }
        if (!inString && (buf[i] === 0x7b || buf[i] === 0x5b)) { depth++; if (depth > 12) throw new Error('JSON nesting depth exceeded.'); } 
        else if (!inString && (buf[i] === 0x7d || buf[i] === 0x5d)) depth--;
    }
}

const defaultJsonParser = express.json({ limit: '50kb', verify: verifyJsonComplexity });
const submitJsonParser = express.json({ limit: '15mb', verify: verifyJsonComplexity });

app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    const cspPolicy = `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://razorpay.com; worker-src 'self' blob:; connect-src 'self' https://api.razorpay.com https://lumberjack-cx.razorpay.com; frame-src https://api.razorpay.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Content-Security-Policy', cspPolicy);
    next();
});

app.use((req, res, next) => {
    if (req.path === '/api/submit' || req.path === '/api/payment-webhook') return next();
    return defaultJsonParser(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, error: 'Malformed JSON.' });
        next();
    });
});

function isSecureConnection(req) { return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'); }
function extractAuthToken(req) {
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
        const pairs = cookieHeader.split(';');
        for (let pair of pairs) {
            pair = pair.trim();
            if (pair.startsWith(AUTH_COOKIE_NAME + '=')) {
                try {
                    const decoded = decodeURIComponent(pair.slice(AUTH_COOKIE_NAME.length + 1)).trim();
                    if (decoded.includes('|||')) return decoded;
                } catch { /* ignore */ }
            }
        }
    }
    const headerToken = req.get('Authorization')?.replace('Bearer ', '').trim();
    if (headerToken && headerToken.includes('|||')) return headerToken;
    return null;
}

// ============================================================================
// ============================================================================
// 5. DYNAMIC HTML INTERCEPTOR (CLEAN URLS, NONCE INJECTION & EVENT DELEGATION)
// ============================================================================
function serveDynamicHtml(req, res, fileName, canonicalBaseRoute) {
    const isHome = canonicalBaseRoute === '/';
    const nonce = res.locals.cspNonce;

    if (!isHome) {
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
                    <a href="mailto:anibanerjee699@gmail.com" class="contact-item">
                        <svg class="contact-icon" viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
                        <span>anibanerjee699@gmail.com</span>
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

                    if (isHome) {
                        sessionStorage.setItem('pioneers_active_route', '/');
                        sessionStorage.removeItem('pioneers_nav_ok');
                        if (window.location.pathname !== '/') {
                            history.replaceState({ app: 'pioneers' }, document.title, '/' + window.location.search);
                        }
                    } else {
                        if (!isRecentClick && !isReload && window.location.search === '') {
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

                var originalFetch = window.fetch;
                if (originalFetch) {
                    window.fetch = function(input, init) {
                        try {
                            var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
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
                        return originalFetch.call(this, input, init);
                    };
                }

                document.addEventListener('click', function(e) {
                    var target = e.target ? e.target.closest('[data-action], [data-csp-action]') : null;
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
                        } else if (action === 'select-descriptive-subject' && typeof selectDescriptiveSubject === 'function') {
                            selectDescriptiveSubject(arg);
                        } else if (action === 'go-back' && typeof goBack === 'function') {
                            goBack();
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

                    var legacyExpr = target.getAttribute('data-csp-action');
                    if (!legacyExpr) return;
                    if (legacyExpr.indexOf("sessionStorage.removeItem('pioneers_prep_state')") !== -1) {
                        try { sessionStorage.removeItem('pioneers_prep_state'); } catch (err) {}
                        return;
                    }
                    var fnMatch = /^([a-zA-Z0-9_]+)\\((.*)\\)$/.exec(legacyExpr.trim());
                    if (!fnMatch) return;
                    var fnName = fnMatch[1];
                    var rawArg = fnMatch[2].trim().replace(/^['"]|['"]$/g, '');
                    if (fnName === 'selectClass' && typeof selectClass === 'function') selectClass(rawArg);
                    else if (fnName === 'selectSubject' && typeof selectSubject === 'function') selectSubject(rawArg);
                    else if (fnName === 'selectNotesClass' && typeof selectNotesClass === 'function') selectNotesClass(rawArg);
                    else if (fnName === 'selectDescriptiveClass' && typeof selectDescriptiveClass === 'function') selectDescriptiveClass(rawArg);
                    else if (fnName === 'selectDescriptiveSubject' && typeof selectDescriptiveSubject === 'function') selectDescriptiveSubject(rawArg);
                    else if (fnName === 'goBack' && typeof goBack === 'function') goBack();
                    else if (fnName === 'goHome' && typeof goHome === 'function') goHome();
                    else if (fnName === 'startQuiz' && typeof startQuiz === 'function') startQuiz();
                    else if (fnName === 'submitQuiz' && typeof submitQuiz === 'function') submitQuiz(rawArg === 'true');
                    else if (fnName === 'prevQuestion' && typeof prevQuestion === 'function') prevQuestion();
                    else if (fnName === 'clearResponse' && typeof clearResponse === 'function') clearResponse();
                    else if (fnName === 'nextQuestion' && typeof nextQuestion === 'function') nextQuestion();
                });
            })();

            try {
                var s = sessionStorage.getItem('pioneers_prep_state');
                if (s) {
                    var st = JSON.parse(s);
                    var a = st.activeScreen;
                    if (a === 'result-screen') {
                        sessionStorage.removeItem('pioneers_prep_state');
                    } else if (a && a !== 'home-dashboard') {
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

                window.addEventListener('popstate', function() {
                    var activeScreen = document.querySelector('.app-screen:not(.hidden)');
                    if (activeScreen && activeScreen.id === 'quiz-screen') {
                        history.pushState({ app: 'pioneers', screen: 'quiz-screen' }, document.title, getCleanUrlForScreen('quiz-screen'));
                        alert("Please use the 'Submit Quiz' button to exit.");
                        return;
                    }
                    if (activeScreen && activeScreen.id !== 'home-dashboard') {
                        var backBtn = activeScreen.querySelector('.back-btn');
                        if (backBtn) {
                            backEventTriggered = true;
                            backBtn.click();
                        } else {
                            sessionStorage.setItem('pioneers_nav_ok', Date.now().toString());
                            window.location.href = '/';
                        }
                    }
                });

                document.addEventListener('click', function(e) {
                    if (e.target && e.target.classList && e.target.classList.contains('back-btn')) {
                        backEventTriggered = true;
                    }
                }, true);
            });
        </script>`;

        let dynamicHtml = data
            .replace(/\sonclick="([^"]*)"/gi, ' data-csp-action="$1"')
            .replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
            .replace(/<head>/i, `<head>\n${headRouteGuardScript}\n<script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>\n`)
            .replace(/(['"\s=])\/?test-portal\.html/gi, '$1/mock-tests')
            .replace(/(['"\s=])\/?notes\.html/gi, '$1/study-notes')
            .replace(/(['"\s=])\/?descriptive\.html/gi, '$1/descriptive-papers')
            .replace(/(['"\s=])\/?index\.html/gi, '$1/')
            .replace(/(src="\/js\/main\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(src="\/js\/quiz\.js)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/(href="\/css\/style\.css)([^"]*)(")/g, `$1?v=${APP_VERSION}$3`)
            .replace(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/canvas-confetti@1\.5\.1\/dist\/confetti\.browser\.min\.js"[^>]*><\/script>/i,
                `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js" integrity="sha384-H308P2b1p2sE2tCj7ZzVbV/f0c4U02yU53pI+rW1+e/K6p+m2a2Y5F5B/Yp3tZp0" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`)
            .replace(/<meta name="viewport"[^>]*>/i, '<meta name="viewport" content="width=1280">')
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
app.get('/mock-tests', (req, res) => serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests'));
app.get('/test-portal.html', (req, res) => serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests'));
app.get('/study-notes', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/notes', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/notes.html', (req, res) => serveDynamicHtml(req, res, 'notes.html', '/study-notes'));
app.get('/descriptive-papers', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));
app.get('/descriptive', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));
app.get('/descriptive.html', (req, res) => serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers'));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ============================================================================
// 6. CRYPTO, FILESYSTEM & CONTENT PARSERS
// ============================================================================
function escapeHtml(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function maskEmail(email) { const [user, domain] = (email||'').split('@'); return user && domain ? `${user.slice(0, 2)}***@${domain}` : 'unknown'; }
function safeCompareHex(a, b) { try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; } }
function safeCompareStrings(a, b) { try { return crypto.timingSafeEqual(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8')); } catch { return false; } }
function xorCipher(text, key) {
    const textBuf = Buffer.from(text, 'utf8'), keyBuf = Buffer.from(key, 'utf8'), out = Buffer.alloc(textBuf.length);
    for (let i = 0; i < textBuf.length; i++) out[i] = textBuf[i] ^ keyBuf[i % keyBuf.length];
    return out.toString('base64');
}

function getAllJsonFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) getAllJsonFiles(filePath, fileList);
        else if (file.toLowerCase().endsWith('.json')) fileList.push(filePath);
    });
    return fileList;
}
function getCachedQuizFiles() {
    const now = Date.now();
    if (fsCache.quizPaths.data && now < fsCache.quizPaths.expiresAt) return fsCache.quizPaths.data;
    const qDir = path.join(__dirname, 'quizzes'); if (!fs.existsSync(qDir)) fs.mkdirSync(qDir);
    const files = getAllJsonFiles(qDir);
    fsCache.quizPaths = { data: files, expiresAt: now + CACHE_TTL_MS }; return files;
}
function getCachedQuizContent(filePath) {
    if (!filePath) return null;
    const now = Date.now(), cached = fsCache.quizContentByPath.get(filePath);
    if (cached && now < cached.expiresAt) return cached.content;
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    setBoundedMap(fsCache.quizContentByPath, filePath, { content, expiresAt: now + CACHE_TTL_MS }); return content;
}
function resolveSafeQuizPath(rawId) {
    const cleanId = path.basename(String(rawId || '')).trim();
    if (!/^[a-zA-Z0-9_\-\s\(\)\.]+$/.test(cleanId) || new Set(['submissions']).has(cleanId.toLowerCase())) return null;
    return getCachedQuizFiles().find(fp => { const fn = path.basename(fp); return fn === cleanId + '.json' || fn === cleanId + '-questions.json' || fn === cleanId; }) || null;
}
function getOfficialQuizDuration(quizId, fallback) {
    const fp = resolveSafeQuizPath(quizId);
    if (fp) { try { const c = getCachedQuizContent(fp); if (Number(c.duration) > 0) return Number(c.duration); } catch {} }
    const p = parseInt(fallback, 10); return (!isNaN(p) && p >= 60 && p <= 10800) ? p : 900;
}

function getAllPdfFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) getAllPdfFiles(filePath, fileList);
        else if (file.toLowerCase().endsWith('.pdf')) fileList.push(filePath);
    });
    return fileList;
}
function getCachedNoteFiles() {
    const now = Date.now();
    if (fsCache.notePaths.data && now < fsCache.notePaths.expiresAt) return fsCache.notePaths.data;
    const nDir = path.join(__dirname, 'notes'); if (!fs.existsSync(nDir)) fs.mkdirSync(nDir);
    const files = getAllPdfFiles(nDir);
    fsCache.notePaths = { data: files, expiresAt: now + CACHE_TTL_MS }; return files;
}
function getCachedDescFiles() {
    const now = Date.now();
    if (fsCache.descPaths.data && now < fsCache.descPaths.expiresAt) return fsCache.descPaths.data;
    const dDir = path.join(__dirname, 'descriptive'); if (!fs.existsSync(dDir)) fs.mkdirSync(dDir);
    ['IX', 'X', 'XI', 'XII'].forEach(c => { const cDir = path.join(dDir, c); if (!fs.existsSync(cDir)) fs.mkdirSync(cDir); });
    const files = getAllPdfFiles(dDir);
    fsCache.descPaths = { data: files, expiresAt: now + CACHE_TTL_MS }; return files;
}
function resolveSafeNotePath(rawName) { return getCachedNoteFiles().find(fp => path.basename(fp).toLowerCase() === path.basename(String(rawName)).toLowerCase()) || null; }
function resolveSafeDescriptivePath(rawName) { return getCachedDescFiles().find(fp => path.basename(fp).toLowerCase() === path.basename(String(rawName)).toLowerCase()) || null; }

async function verifyAuthToken(authToken, expectedEmail = null, checkReplay = false) {
    if (!authToken || typeof authToken !== 'string' || !authToken.includes('|||')) return { valid: false, error: 'Invalid token.' };
    const [tokenData, authSignature] = authToken.split('|||');
    if (!safeCompareHex(authSignature, crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex'))) return { valid: false, error: 'Tampered session.' };
    const dataParts = tokenData.split('|');
    if (dataParts.length < 2) return { valid: false, error: 'Outdated token.' };
    const tokenEmail = dataParts[0];
    const issuedAt = parseInt(dataParts[dataParts.length >= 5 ? 3 : 1], 10);
    if (isNaN(issuedAt) || (Date.now() - issuedAt) > TOKEN_MAX_AGE_MS) return { valid: false, error: 'Session expired.' };
    if (expectedEmail && tokenEmail !== expectedEmail.trim().toLowerCase()) return { valid: false, error: 'Email mismatch.' };
    if (checkReplay && await stateStore.get(`auth:used:${authSignature}`)) return { valid: false, error: 'Session already submitted.' };
    return { valid: true, email: tokenEmail, firstName: decodeURIComponent(dataParts[1] || ''), lastName: decodeURIComponent(dataParts[2] || ''), signature: authSignature };
}

// ============================================================================
// 7. PAYMENT & AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/send-otp', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        if (!await stateStore.checkRateLimit('otp', clientIp, 10, 15 * 60)) return res.status(429).json({ error: 'Wait 15 minutes.' });
        const firstName = String(req.body.firstName||'').trim().toUpperCase(), lastName = String(req.body.lastName||'').trim().toUpperCase(), email = String(req.body.email||'').trim().toLowerCase();
        if (!firstName || !lastName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid fields required.' });

        const otpKey = `otp:pending:${email}`, rawExisting = await stateStore.get(otpKey);
        if (rawExisting) { try { if ((Date.now() - JSON.parse(rawExisting).lastSentAt) < 60000) return res.status(429).json({ error: 'Wait 60 seconds.' }); } catch {} }

        const otp = crypto.randomInt(100000, 1000000).toString();
        await stateStore.set(otpKey, { otp, firstName, lastName, expiresAt: Date.now() + 300000, attempts: 0, lastSentAt: Date.now() }, 300);

        if (process.env.APP_SCRIPT_URL && APPS_SECRET) fetch(process.env.APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'otp', targetEmail: email, subject: 'Verification Code', secretKey: APPS_SECRET, breakdown: `<h2>Hello ${escapeHtml(firstName)},</h2><h1>${otp}</h1>` })}).catch(()=>{});
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'OTP failed.' }); }
});

app.post('/api/verify-otp', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        if (!await stateStore.checkRateLimit('verify', clientIp, 15, 15 * 60)) return res.status(429).json({ error: 'Wait 15 minutes.' });
        const email = String(req.body.email||'').trim().toLowerCase(), otp = String(req.body.otp||'').trim();
        const otpKey = `otp:pending:${email}`, rawRecord = await stateStore.get(otpKey);
        
        if (!rawRecord) return res.status(400).json({ error: 'Code expired.' });
        const record = typeof rawRecord === 'string' ? JSON.parse(rawRecord) : rawRecord;
        if (Date.now() > record.expiresAt) { await stateStore.del(otpKey); return res.status(400).json({ error: 'Code expired.' }); }

        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5) { await stateStore.del(otpKey); return res.status(429).json({ error: 'Too many attempts.' }); }
        if (!safeCompareStrings(record.otp, otp)) { await stateStore.set(otpKey, record, Math.ceil((record.expiresAt - Date.now())/1000)); return res.status(400).json({ error: 'Invalid code.' }); }

        await stateStore.del(otpKey);
        const tokenData = `${email}|${encodeURIComponent(record.firstName)}|${encodeURIComponent(record.lastName)}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`;
        const signature = crypto.createHmac('sha256', SECRET).update(tokenData).digest('hex');
        res.cookie(AUTH_COOKIE_NAME, `${tokenData}|||${signature}`, { httpOnly: true, secure: isSecureConnection(req), sameSite: 'strict', maxAge: TOKEN_MAX_AGE_MS, path: '/' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Verification failed.' }); }
});

// Create Razorpay Order
// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        if (!razorpay) return res.status(503).json({ error: 'Payments disabled.' });
        const authCheck = await verifyAuthToken(extractAuthToken(req));
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        const { itemId, amount } = req.body;
        if (!itemId || !amount || isNaN(amount) || amount < 1) return res.status(400).json({ error: 'Invalid order.' });

        const order = await razorpay.orders.create({
            amount: Math.round(Number(amount) * 100),
            currency: "INR",
            receipt: `rcpt_${Date.now().toString().slice(-8)}`
        });
        res.json({ success: true, orderId: order.id, amount: order.amount, keyId: process.env.RAZORPAY_KEY_ID });
    } catch (err) { res.status(500).json({ error: 'Order creation failed.' }); }
});

// Verify Payment and Grant Access
app.post('/api/verify-payment', async (req, res) => {
    try {
        const authCheck = await verifyAuthToken(extractAuthToken(req));
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, itemId } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !itemId) return res.status(400).json({ error: 'Missing details.' });

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(body.toString()).digest('hex');

        if (expectedSignature === razorpay_signature) {
            await stateStore.set(`user:purchases:${authCheck.email}:${itemId}`, '1', 60 * 60 * 24 * 365 * 10);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Invalid payment signature.' });
        }
    } catch (err) { res.status(500).json({ error: 'Payment verification failed.' }); }
});

// ============================================================================
// 8. CONTENT DELIVERY ENDPOINTS (PDFs AND QUIZZES)
// ============================================================================

function processFileLists(files, isNote) {
    const grouped = { 'IX': {}, 'X': {}, 'XI': {}, 'XII': {} };
    ['IX', 'X', 'XI', 'XII'].forEach(c => { grouped[c] = { Physics: [], Chemistry: [], Biology: [] }; });

    files.forEach(fullPath => {
        const fileName = path.basename(fullPath), lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
        let cls = 'XI';
        if (lowerPath.includes('/ix/') || lowerPath.includes('class9')) cls = 'IX';
        else if (lowerPath.includes('/x/') || lowerPath.includes('class10')) cls = 'X';
        else if (lowerPath.includes('/xii/') || lowerPath.includes('class12')) cls = 'XII';

        let subject = 'Biology';
        if (lowerPath.includes('physics')) subject = 'Physics';
        else if (lowerPath.includes('chemistry')) subject = 'Chemistry';

        let isAvailable = true, isPremium = false, price = 0, cleanFileName = fileName;

        if (cleanFileName.toUpperCase().startsWith('SOON_')) {
            isAvailable = false;
            cleanFileName = cleanFileName.replace(/^SOON_/i, '');
        } else if (cleanFileName.toUpperCase().startsWith('PRO_')) {
            isPremium = true;
            const priceMatch = cleanFileName.match(/^PRO_(\d+)_/i);
            if (priceMatch) { price = parseInt(priceMatch[1], 10); cleanFileName = cleanFileName.replace(/^PRO_\d+_/i, ''); } 
            else { price = 49; cleanFileName = cleanFileName.replace(/^PRO_/i, ''); }
        }

        const title = path.basename(cleanFileName, '.pdf').replace(/[_]/g, ' ').replace(/-/g, ' ').replace(/class\s*(9|10|11|12|ix|x|xi|xii)/gi, '').replace(/(physics|chemistry|biology)/gi, '').trim().replace(/\b\w/g, c => c.toUpperCase());
        if (grouped[cls] && grouped[cls][subject]) grouped[cls][subject].push({ name: title || cleanFileName, fileName, isAvailable, isPremium, price });
    });

    const formatted = [];
    for (const [cls, subjects] of Object.entries(grouped)) {
        for (const [sub, list] of Object.entries(subjects)) {
            if (list.length > 0) formatted.push({ class: cls, subject: sub, [isNote ? 'notes' : 'papers']: list });
        }
    }
    return formatted;
}

app.get('/api/descriptive-questions', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.descList.data && now < fsCache.descList.expiresAt) return res.json(fsCache.descList.data);
        const formatted = processFileLists(getCachedDescFiles(), false);
        fsCache.descList = { data: formatted, expiresAt: now + CACHE_TTL_MS }; res.json(formatted);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/notes', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.notesList.data && now < fsCache.notesList.expiresAt) return res.json(fsCache.notesList.data);
        const formatted = processFileLists(getCachedNoteFiles(), true);
        fsCache.notesList = { data: formatted, expiresAt: now + CACHE_TTL_MS }; res.json(formatted);
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/download-descriptive/:fileName', async (req, res) => {
    const rawFileName = req.params.fileName;
    if (rawFileName.toUpperCase().startsWith('SOON_')) return res.status(403).send("This paper is not yet available.");
    
    if (rawFileName.toUpperCase().startsWith('PRO_')) {
        const authCheck = await verifyAuthToken(extractAuthToken(req));
        if (!authCheck.valid) return res.status(401).send("Authentication required to download premium content.");
        const hasAccess = await checkContentAccess(authCheck.email, rawFileName, true);
        if (!hasAccess) return res.status(402).send("Payment required to access this content.");
    }

    if (!await stateStore.checkRateLimit('dl', getClientIp(req), 10, 15 * 60)) return res.status(429).send("Rate limit exceeded.");
    const referer = req.get('Referer') || '';
    if (!referer.includes('pioneersprep.in') && !referer.includes(req.get('Host'))) return res.status(403).send("Direct downloads blocked.");

    const filePath = resolveSafeDescriptivePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Paper not found.");
    res.download(filePath, path.basename(filePath), (err) => { if (err && !res.headersSent) res.status(500).send("Download failed."); });
});

app.get('/api/download-note/:fileName', async (req, res) => {
    const rawFileName = req.params.fileName;
    if (rawFileName.toUpperCase().startsWith('SOON_')) return res.status(403).send("This note is not yet available.");
    
    if (rawFileName.toUpperCase().startsWith('PRO_')) {
        const authCheck = await verifyAuthToken(extractAuthToken(req));
        if (!authCheck.valid) return res.status(401).send("Authentication required to download premium content.");
        const hasAccess = await checkContentAccess(authCheck.email, rawFileName, true);
        if (!hasAccess) return res.status(402).send("Payment required to access this content.");
    }

    if (!await stateStore.checkRateLimit('dl', getClientIp(req), 10, 15 * 60)) return res.status(429).send("Rate limit exceeded.");
    const referer = req.get('Referer') || '';
    if (!referer.includes('pioneersprep.in') && !referer.includes(req.get('Host'))) return res.status(403).send("Direct downloads blocked.");

    const filePath = resolveSafeNotePath(rawFileName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Note not found.");
    res.download(filePath, path.basename(filePath), (err) => { if (err && !res.headersSent) res.status(500).send("Download failed."); });
});

app.get('/api/quizzes', (req, res) => {
    try {
        const now = Date.now();
        if (fsCache.quizzesList.data && now < fsCache.quizzesList.expiresAt) return res.json({ success: true, quizzes: fsCache.quizzesList.data });

        const list = getCachedQuizFiles().map(fp => {
            try {
                const c = getCachedQuizContent(fp), fileBase = path.basename(fp, '.json');
                return {
                    id: fileBase, title: c.title || fileBase, category: c.category || 'general',
                    classLevel: c.classLevel || 'xi', subject: c.subject || 'general', unit: c.unit || '',
                    chapter: c.chapter || '', topic: c.topic || '', duration: c.duration || 900, totalQuestions: c.questions ? c.questions.length : 0,
                    isAvailable: c.isAvailable !== false, isPremium: c.isPremium === true, price: c.price || 49
                };
            } catch { return null; }
        }).filter(Boolean);

        fsCache.quizzesList = { data: list, expiresAt: now + CACHE_TTL_MS }; res.json({ success: true, quizzes: list });
    } catch { res.status(500).json({ success: false, quizzes: [] }); }
});

app.get('/api/quiz/:id', async (req, res) => {
    try {
        if (req.get('X-Requested-With') !== 'PioneersPrepApp') return res.status(403).json({ error: "Forbidden" });
        const authCheck = await verifyAuthToken(extractAuthToken(req), null, true);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        const cleanId = path.basename(String(req.params.id || '')).trim(), filePath = resolveSafeQuizPath(cleanId);
        if (!filePath) return res.status(404).json({ error: "Not found" });

        const content = getCachedQuizContent(filePath);
        if (content.isAvailable === false) return res.status(403).json({ error: "This test is not yet available." });
        if (content.isPremium === true) {
            const hasAccess = await checkContentAccess(authCheck.email, cleanId, true);
            if (!hasAccess) return res.status(402).json({ error: "Payment required to access this content." });
        }

        const session = await getOrCreateExamSession(authCheck.signature, cleanId, null);
        if (session.error) return res.status(403).json({ error: session.error });

        const rawQuestions = content.questions || [];
        const qOrder = getDeterministicPermutation(rawQuestions.length, `${authCheck.signature}:${cleanId}:q`);
        const sanitizedQuestions = qOrder.map(origIdx => {
            const q = rawQuestions[origIdx], qType = q.type || 'mcq';
            let clientOptions = q.options || [];
            if (qType === 'mcq' && Array.isArray(q.options) && q.options.length > 1) clientOptions = getSafeOptionPermutation(q.options, `${authCheck.signature}:${cleanId}:opt:${origIdx}`).map(oIdx => q.options[oIdx]);
            return { type: qType, question: q.question, options: clientOptions };
        });

        res.json({ payload: xorCipher(JSON.stringify(sanitizedQuestions), session.xorKey) });
    } catch { res.status(500).json({ error: "Failed to read quiz." }); }
});

app.post('/api/start-quiz', async (req, res) => {
    try {
        const authCheck = await verifyAuthToken(extractAuthToken(req), null, true);
        if (!authCheck.valid) return res.status(401).json({ error: authCheck.error });

        const cleanId = path.basename(String(req.body.quizId || '')).trim(), filePath = resolveSafeQuizPath(cleanId);
        if (!filePath) return res.status(400).json({ error: "Invalid quiz ID." });
        
        const content = getCachedQuizContent(filePath);
        if (content.isAvailable === false) return res.status(403).json({ error: "Not yet available." });
        if (content.isPremium === true && !(await checkContentAccess(authCheck.email, cleanId, true))) return res.status(402).json({ error: "Payment required." });

        const session = await getOrCreateExamSession(authCheck.signature, cleanId, req.body.duration);
        if (session.error) return res.status(403).json({ error: session.error });

        res.json({ startTime: session.startTime, duration: session.duration, signature: session.signature, cipherKey: session.xorKey });
    } catch { res.status(500).json({ error: "Failed to start quiz." }); }
});

// ============================================================================
// 9. SUBMISSION & GRADING
// ============================================================================
app.post('/api/submit', async (req, res) => {
    const rawEmail = req.body.email ? String(req.body.email).trim().toLowerCase().slice(0, 120) : 'no-email';
    const { className, chapterTitle, quizId, userAnswers, serverStartTime, timerSignature, quizDuration } = req.body;
    const authCheck = await verifyAuthToken(extractAuthToken(req), rawEmail, true);
    if (!authCheck.valid) return res.status(403).json({ success: false, error: authCheck.error });

    const lockKey = `sub:lock:${authCheck.signature}`;
    if (!await stateStore.setNx(lockKey, '1', 60)) return res.status(429).json({ success: false, error: 'Submission in progress.' });

    const cleanQuizId = path.basename(String(quizId || '')).trim(), filePath = resolveSafeQuizPath(cleanQuizId);
    if (!filePath) { await stateStore.del(lockKey); return res.status(400).json({ success: false, error: 'Invalid ID.' }); }

    const sessionKey = `exam:session:${authCheck.signature}`;
    const rawLocked = await stateStore.get(sessionKey);
    const lockedSession = rawLocked ? (typeof rawLocked === 'string' ? JSON.parse(rawLocked) : rawLocked) : null;
    
    if (lockedSession && lockedSession.quizId !== cleanQuizId) { await stateStore.del(lockKey); return res.status(400).json({ success: false, error: 'Quiz mismatch.' }); }

    const eStart = lockedSession ? lockedSession.startTime : Number(serverStartTime), eDur = lockedSession ? lockedSession.duration : Number(quizDuration);
    if (!eStart || !timerSignature || !eDur) { await stateStore.del(lockKey); return res.status(400).json({ success: false, error: 'Missing timer logic.' }); }
    if (!safeCompareHex(timerSignature, crypto.createHmac('sha256', SECRET).update(`${cleanQuizId}:${eDur}:${eStart}`).digest('hex'))) { await stateStore.del(lockKey); return res.status(400).json({ success: false, error: 'Tampered token.' }); }

    const elapsed = (Date.now() - eStart) / 1000;
    if (elapsed < 0 || elapsed > eDur + 120) { await stateStore.del(lockKey); return res.status(400).json({ success: false, error: 'Time limit exceeded.' }); }
    if (!await stateStore.setNx(`auth:used:${authCheck.signature}`, '1', TOKEN_MAX_AGE_SEC)) { await stateStore.del(lockKey); return res.status(403).json({ success: false, error: 'Already submitted.' }); }
    await stateStore.del(sessionKey);

    try {
        const safeUserAnswers = (userAnswers && typeof userAnswers === 'object') ? userAnswers : {};
        const content = getCachedQuizContent(filePath), realQuestions = content.questions || [];
        let correctCount = 0, incorrectCount = 0, attemptedCount = 0;
        const qOrder = getDeterministicPermutation(realQuestions.length, `${authCheck.signature}:${cleanQuizId}:q`), origToClientIndex = new Array(realQuestions.length);
        qOrder.forEach((origIdx, clientIdx) => { origToClientIndex[origIdx] = clientIdx; });

        let breakdownHtml = `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;"><tr style="background-color:#f1f5f9;text-align:left;"><th>#</th><th>Question</th><th>Student's Selection</th><th>Correct Option</th><th>Status</th></tr>`;

        realQuestions.forEach((q, origIndex) => {
            const response = safeUserAnswers[origToClientIndex[origIndex].toString()];
            const attempted = response !== undefined && response !== null && response !== "";
            if (attempted) attemptedCount++;
            let isCorrect = false, selText = "Skipped", corrText = "N/A", rawStatus = "Skipped", statusColor = "yellow";

            if (q.type === 'descriptive' || q.type === 'diagram') {
                selText = attempted ? escapeHtml(String(response).slice(0, 2000)) : "Skipped";
                corrText = escapeHtml(q.model_answer || "Refer to marking scheme");
                if (attempted) { rawStatus = "Needs Review"; statusColor = "orange"; }
            } else if (q.type === 'fill_in_the_blanks' || q.type === 'fib') {
                selText = attempted ? escapeHtml(String(response).slice(0, 500)) : "Skipped";
                corrText = escapeHtml(q.answer_text || q.model_answer || "Refer to marking scheme");
                isCorrect = attempted && String(response).trim().toLowerCase() === String(q.answer_text || q.model_answer || '').trim().toLowerCase();
                if (isCorrect) correctCount++; else if (attempted) incorrectCount++;
                rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
            } else {
                const clientOptIdx = parseInt(response, 10), optOrder = getSafeOptionPermutation(q.options || [], `${authCheck.signature}:${cleanQuizId}:opt:${origIndex}`);
                const actualOptIdx = (attempted && !isNaN(clientOptIdx) && optOrder[clientOptIdx] !== undefined) ? optOrder[clientOptIdx] : clientOptIdx;
                isCorrect = attempted && actualOptIdx === q.answer;
                if (isCorrect) correctCount++; else if (attempted) incorrectCount++;
                selText = attempted ? escapeHtml(q.options?.[actualOptIdx] || "Unknown") : "Skipped";
                corrText = q.options?.[q.answer] !== undefined ? escapeHtml(q.options[q.answer]) : "N/A";
                rawStatus = isCorrect ? "Correct" : (attempted ? "Incorrect" : "Skipped");
                statusColor = isCorrect ? "lightgreen" : (attempted ? "lightcoral" : "yellow");
            }
            breakdownHtml += `<tr><td>${origIndex + 1}</td><td>${escapeHtml(q.question || "N/A")}</td><td>${selText}</td><td>${corrText}</td><td style="text-align:center;"><span style="background-color:${statusColor};color:black;font-weight:bold;padding:4px 8px;border-radius:4px;">${rawStatus}</span></td></tr>`;
        });
        breakdownHtml += `</table>`;

        const cleanClass = escapeHtml(String(className || '').trim().slice(0, 40)), cleanChap = escapeHtml(String(chapterTitle || content.title || 'Quiz').trim().slice(0, 120));
        const fullTitle = (cleanClass && !cleanChap.startsWith(cleanClass)) ? `${cleanClass} - ${cleanChap}` : cleanChap;
        const payload = { firstName: escapeHtml(authCheck.firstName || 'UNKNOWN'), lastName: escapeHtml(authCheck.lastName || 'NAME'), email: escapeHtml(email), className: cleanClass, chapterTitle: fullTitle, subject: `New Quiz Submission - ${fullTitle} - ${authCheck.firstName}`, score: correctCount, total: realQuestions.length, attempted: attemptedCount, skipped: realQuestions.length - attemptedCount, correct: correctCount, incorrect: incorrectCount, breakdown: breakdownHtml, targetEmail: ADMIN_EMAIL, secretKey: APPS_SECRET };

        res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, secure: isSecureConnection(req), sameSite: 'strict', path: '/' });
        res.json({ success: true, score: correctCount, total: realQuestions.length });
        if (process.env.APP_SCRIPT_URL && APPS_SECRET) fetch(process.env.APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(()=>{});
    } catch (err) { res.status(500).json({ success: false, error: 'Grading failed.' }); } finally { await stateStore.del(lockKey); }
});

app.get(/.*/, (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
    const p = req.path.toLowerCase();
    if (p.includes('mock-tests') || p.includes('test-portal')) return serveDynamicHtml(req, res, 'test-portal.html', '/mock-tests');
    if (p.includes('study-notes') || p.includes('notes')) return serveDynamicHtml(req, res, 'notes.html', '/study-notes');
    if (p.includes('descriptive')) return serveDynamicHtml(req, res, 'descriptive.html', '/descriptive-papers');
    res.redirect(302, '/');
});

const PING_INTERVAL = 14 * 60 * 1000;
const PING_URL = process.env.PING_URL || 'https://pioneersprep.in/ping';
setInterval(() => {
    const handler = PING_URL.startsWith('https') ? https : http;
    handler.get(PING_URL, (res) => console.log(`[Keep-Awake] Ping Status: ${res.statusCode} at ${new Date().toISOString()}`)).on('error', (err) => console.warn(`[Keep-Awake] Ping failed: ${err.message}`));
}, PING_INTERVAL);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
