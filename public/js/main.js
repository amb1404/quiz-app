// public/js/main.js

// 1. CENTRALIZED HEADER & FOOTER LAYOUT ENGINE
const LayoutEngine = {
    render() {
        const path = window.location.pathname.toLowerCase();
        const isHome = path === '/' || path.endsWith('/index.html') || path === '';
        const isTests = path.includes('test-portal') || path.includes('mock-tests');
        const isNotes = path.includes('notes');
        const isDesc = path.includes('descriptive');

        // Centralized Header Template
        const headerHTML = `
            <div class="nav-container">
                <a href="/" class="brand-logo" onclick="sessionStorage.removeItem('pioneers_prep_state')">
                    <span class="brand-title">PIONEERS PREP</span>
                    <span class="brand-subtitle">Guided by <strong>Aniruddha Banerjee</strong>, with an experience of 8+ years in coaching.</span>
                </a>
                <nav class="site-nav" aria-label="Main Navigation">
                    <a href="/" class="nav-link ${isHome ? 'active' : ''}" onclick="sessionStorage.removeItem('pioneers_prep_state')">Home</a>
                    <a href="/test-portal.html" class="nav-link ${isTests ? 'active' : ''}" onclick="sessionStorage.removeItem('pioneers_prep_state')">Mock Tests</a>
                    <a href="/notes.html" class="nav-link ${isNotes ? 'active' : ''}" onclick="sessionStorage.removeItem('pioneers_prep_state')">Study Notes</a>
                    <a href="/descriptive.html" class="nav-link nav-link-yellow ${isDesc ? 'active' : ''}" onclick="sessionStorage.removeItem('pioneers_prep_state')">Descriptive Papers</a>
                </nav>
            </div>
        `;

        // Centralized Footer Template
        const footerHTML = `
            <div class="footer-profile-container">
                <div class="footer-brand-info">
                    <h3>Pioneers Prep</h3>
                    <p>Founded and managed by <strong>Aniruddha Banerjee</strong></p>
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
                <div class="footer-links">
                    <a href="/sitemap.xml">Sitemap</a>
                </div>
            </div>
        `;

        const headerEl = document.getElementById('site-header');
        const footerEl = document.getElementById('site-footer');
        if (headerEl) headerEl.innerHTML = headerHTML;
        if (footerEl) footerEl.innerHTML = footerHTML;
    }
};

// Render layout elements immediately as soon as the DOM is available
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => LayoutEngine.render());
} else {
    LayoutEngine.render();
}

// 2. SESSION & EXAM MODE STATE MANAGER
const MainNav = {
    normalizeRoute(route) {
        if (!route) return '/';
        if (route === '/mock-tests' || route === '/test-portal.html') return '/test-portal.html';
        if (route === '/notes' || route === '/study-notes' || route === '/notes.html') return '/notes.html';
        if (route === '/descriptive' || route === '/descriptive-papers' || route === '/descriptive.html') return '/descriptive.html';
        return route;
    },

    saveSessionState(CURRENT_ROUTE, currentQuizId, activeQuizTitle, currentQuestionIndex, timeRemaining, quizDuration, serverStartTime, timerSignature, studentAuthToken, userAnswers, skippedQuestions, screenHistory, options = {}) {
        const activeScreen = document.querySelector('.app-screen:not(.hidden)')?.id || 'home-dashboard';
        const state = {
            route: this.normalizeRoute(CURRENT_ROUTE),
            activeScreen,
            screenHistory,
            currentQuizId,
            activeQuizTitle,
            currentQuestionIndex,
            timeRemaining,
            quizDuration,
            serverStartTime,
            timerSignature,
            studentAuthToken,
            otpSent: !!document.getElementById('otp-input'),
            userAnswers: Object.fromEntries(Object.entries(userAnswers)),
            skippedQuestions: Array.from(skippedQuestions),
            firstName: document.getElementById('first-name')?.value || '',
            lastName: document.getElementById('last-name')?.value || '',
            email: document.getElementById('email-address')?.value || '',
            ...options
        };
        sessionStorage.setItem('pioneers_prep_state', JSON.stringify(state));
    },

    getSavedState(CURRENT_ROUTE) {
        const savedRaw = sessionStorage.getItem('pioneers_prep_state');
        if (!savedRaw) return null;
        try {
            const state = JSON.parse(savedRaw);
            if (this.normalizeRoute(state.route) === this.normalizeRoute(CURRENT_ROUTE)) {
                return state;
            }
        } catch {
            return null;
        }
        return null;
    },

    clearExamMode() {
        document.body.classList.remove('exam-mode');
    },

    applyExamMode() {
        document.body.classList.add('exam-mode');
    }
};
