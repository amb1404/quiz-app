// public/js/main.js

// Note: Visual layout (header/footer) is now injected server-side by server.js to prevent rendering flicker.
// This file now exclusively manages Session State tracking and Exam Mode persistence.

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
