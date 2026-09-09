let screenHistory = [];

function showScreen(screenId) {
    const screens = document.querySelectorAll('body > div');
    
    // Find the currently active screen before hiding everything
    const activeScreen = Array.from(screens).find(screen => !screen.classList.contains('hidden'));
    if (activeScreen && activeScreen.id !== screenId) {
        screenHistory.push(activeScreen.id);
    }

    // Hide all screens
    screens.forEach(screen => screen.classList.add('hidden'));
    
    // Show the target screen
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
    }
}

function goBack() {
    if (screenHistory.length > 0) {
        const previousScreenId = screenHistory.pop();
        const screens = document.querySelectorAll('body > div');
        screens.forEach(screen => screen.classList.add('hidden'));
        
        const prevScreen = document.getElementById(previousScreenId);
        if (prevScreen) {
            prevScreen.classList.remove('hidden');
        }
    } else {
        goHome();
    }
}

function goHome() {
    screenHistory = [];
    const screens = document.querySelectorAll('body > div');
    screens.forEach(screen => screen.classList.add('hidden'));
    document.getElementById('home-menus').classList.remove('hidden');
}

function startQuiz() {
    const firstName = document.getElementById('first-name').value.trim();
    if (!firstName) {
        alert('Please enter your first name to start the quiz.');
        return;
    }
    showScreen('quiz-screen');
}

function selectOption(button) {
    const container = document.getElementById('options-container');
    const buttons = container.querySelectorAll('.option-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
    button.classList.add('selected');
}

function clearResponse() {
    const buttons = document.querySelectorAll('#options-container .option-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
}

function nextQuestion() {
    // Add your next question loading logic here
}

function prevQuestion() {
    // Add your previous question loading logic here
}

function submitQuiz() {
    showScreen('result-screen');
}
