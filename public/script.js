let quizData = {};
let currentQuizId = null;
let questions = [];
let currentQuestionIndex = 0;
let answers = [];
let timerInterval;
let timeLeft = 0;

// Fetch course structure on load
window.onload = async () => {
    try {
        const response = await fetch('/api/quizzes');
        quizData = await response.json();
        renderSubjects();
    } catch (error) {
        document.getElementById('subject-list').innerHTML = "<li>Error loading subjects.</li>";
    }
};

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
        screen.classList.add('hidden');
    });
    document.getElementById(screenId).classList.remove('hidden');
    document.getElementById(screenId).classList.add('active');
}

function renderSubjects() {
    const list = document.getElementById('subject-list');
    list.innerHTML = '';
    Object.keys(quizData).forEach(subject => {
        const li = document.createElement('li');
        li.textContent = subject;
        li.onclick = () => renderChapters(subject);
        list.appendChild(li);
    });
}

function renderChapters(subject) {
    const list = document.getElementById('chapter-list');
    list.innerHTML = '';
    quizData[subject].forEach(chapter => {
        const li = document.createElement('li');
        li.textContent = chapter.title;
        li.onclick = () => {
            currentQuizId = chapter.id;
            timeLeft = (chapter.duration || 10) * 60; 
            showScreen('name-screen');
        };
        list.appendChild(li);
    });
    showScreen('chapter-screen');
}

async function startQuiz() {
    const nameInput = document.getElementById('student-name').value.trim();
    if (!nameInput) return alert("Please enter your name.");

    try {
        const response = await fetch(`/api/quiz/${currentQuizId}`);
        questions = await response.json();
        answers = new Array(questions.length).fill(null);
        currentQuestionIndex = 0;
        
        showScreen('quiz-screen');
        startTimer();
        renderQuestion();
    } catch (error) {
        alert("Failed to load questions for this chapter.");
    }
}

function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        let minutes = Math.floor(timeLeft / 60);
        let seconds = timeLeft % 60;
        document.getElementById('timer').textContent = `Time: ${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            submitQuiz();
        }
    }, 1000);
}

function updateCounter() {
    let attempted = answers.filter(a => a !== null).length;
    let skipped = currentQuestionIndex + 1 - attempted; 
    // Shows skipped based on how many questions they have navigated past without answering
    if (skipped < 0) skipped = 0;
    
    document.getElementById('counter').textContent = `Attempted: ${attempted} | Skipped: ${skipped}`;
}

function renderQuestion() {
    const q = questions[currentQuestionIndex];
    document.getElementById('question-text').textContent = `Q${currentQuestionIndex + 1}: ${q.question}`;
    
    const optionsList = document.getElementById('options-list');
    optionsList.innerHTML = '';
    
    q.options.forEach((opt, index) => {
        const li = document.createElement('li');
        li.textContent = opt;
        li.className = 'option-btn';
        if (answers[currentQuestionIndex] === index) {
            li.classList.add('selected');
        }
        li.onclick = () => selectOption(index);
        optionsList.appendChild(li);
    });

    document.getElementById('prev-btn').disabled = currentQuestionIndex === 0;
    document.getElementById('next-btn').disabled = currentQuestionIndex === questions.length - 1;
    
    updateCounter();
}

function selectOption(index) {
    answers[currentQuestionIndex] = index;
    renderQuestion(); 
}

function prevQuestion() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderQuestion();
    }
}

function nextQuestion() {
    if (currentQuestionIndex < questions.length - 1) {
        currentQuestionIndex++;
        renderQuestion();
    }
}

async function submitQuiz() {
    clearInterval(timerInterval);
    const studentName = document.getElementById('student-name').value.trim();
    
    let score = 0;
    answers.forEach((ans, idx) => {
        if (ans === questions[idx].answer) score++;
    });

    document.getElementById('score-display').textContent = `Score: ${score} / ${questions.length}`;
    document.getElementById('submission-status').textContent = "Submitting your results...";
    showScreen('result-screen');

    try {
        const res = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentName,
                quizId: currentQuizId,
                score,
                total: questions.length,
                answers
            })
        });
        const data = await res.json();
        if(data.success) {
            document.getElementById('submission-status').textContent = "Results successfully emailed!";
        } else {
            document.getElementById('submission-status').textContent = "Failed to email results.";
        }
    } catch (err) {
        document.getElementById('submission-status').textContent = "Network error during submission.";
    }
}

function reviewAnswers() {
    alert("Review logic can be built here reading the answers array and questions array!");
}
