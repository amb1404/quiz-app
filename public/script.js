let questions = [];
let currentIndex = 0;
let userAnswers = [];
let timeLeft = 300; 
let timerInterval;
let highestIndexReached = 0;
let currentQuizId = '';
let allSubjectsData = [];
let isPaused = false;

window.onload = function() {
    fetch('/api/quizzes')
        .then(res => res.json())
        .then(data => {
            allSubjectsData = data;
            let subjectList = document.getElementById('subject-list');
            subjectList.innerHTML = '';
            
            data.forEach((subj, index) => {
                let btn = document.createElement('button');
                btn.innerText = subj.subject;
                btn.className = 'option-btn';
                btn.onclick = () => showChapters(index);
                subjectList.appendChild(btn);
            });
        })
        .catch(err => console.error('Error loading subjects:', err));
};

function showChapters(subjectIndex) {
    let subj = allSubjectsData[subjectIndex];
    document.getElementById('selected-subject-title').innerText = `${subj.subject} - Select Chapter`;
    
    let chapterList = document.getElementById('chapter-list');
    chapterList.innerHTML = '';
    
    subj.chapters.forEach(ch => {
        let btn = document.createElement('button');
        btn.innerText = ch.title;
        btn.className = 'option-btn';
        btn.onclick = () => loadQuiz(ch.id, ch.duration);
        chapterList.appendChild(btn);
    });

    document.getElementById('subject-menu').classList.add('hidden');
    document.getElementById('chapter-menu').classList.remove('hidden');
}

function backToSubjects() {
    document.getElementById('chapter-menu').classList.add('hidden');
    document.getElementById('subject-menu').classList.remove('hidden');
}

function loadQuiz(quizId, duration) {
    currentQuizId = quizId;
    timeLeft = duration || 300;
    isPaused = false;
    document.getElementById('pause-overlay').classList.add('hidden');
    document.getElementById('pause-btn').innerText = 'Pause';
    
    fetch(`/api/quiz/${quizId}`)
        .then(res => res.json())
        .then(data => {
            questions = data;
            userAnswers = new Array(questions.length).fill(null);
            currentIndex = 0;
            highestIndexReached = 0;
            document.getElementById('chapter-menu').classList.add('hidden');
            document.getElementById('quiz-screen').classList.remove('hidden');
            startQuiz();
        })
        .catch(err => console.error('Error loading questions:', err));
}

function startQuiz() {
    startTimer();
    showQuestion();
}

function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (isPaused) return;
        if (timeLeft > 0) {
            timeLeft--;
            let minutes = Math.floor(timeLeft / 60);
            let seconds = timeLeft % 60;
            document.getElementById('timer').innerText = `Time: ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        } else {
            clearInterval(timerInterval);
            alert("Time is up!");
            showReviewScreen();
        }
    }, 1000);
}

function togglePause() {
    isPaused = !isPaused;
    let overlay = document.getElementById('pause-overlay');
    let pauseBtn = document.getElementById('pause-btn');
    
    if (isPaused) {
        overlay.classList.remove('hidden');
        pauseBtn.innerText = 'Resume';
    } else {
        overlay.classList.add('hidden');
        pauseBtn.innerText = 'Pause';
    }
}

function updateStats() {
    let attempted = userAnswers.filter(ans => ans !== null).length;
    let skipped = 0;
    for (let i = 0; i <= highestIndexReached; i++) {
        if (userAnswers[i] === null) skipped++;
    }
    
    document.getElementById('counter-stats').innerText = `Attempted: ${attempted} | Skipped: ${skipped}`;
}

function showQuestion() {
    if (isPaused) return;
    if (currentIndex > highestIndexReached) highestIndexReached = currentIndex;
    updateStats();
    
    document.getElementById('prev-btn').style.display = currentIndex === 0 ? 'none' : 'block';
    
    if (currentIndex === questions.length - 1) {
        document.getElementById('next-btn').style.display = 'none';
    } else {
        document.getElementById('next-btn').style.display = 'block';
    }

    let q = questions[currentIndex];
    document.getElementById('question-box').innerText = `Q${currentIndex + 1}: ${q.question}`;
    
    let optionsBox = document.getElementById('options-box');
    optionsBox.innerHTML = '';
    
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    q.options.forEach((opt, idx) => {
        let btn = document.createElement('button');
        let prefix = letters[idx] ? `${letters[idx]}. ` : '';
        btn.innerText = prefix + opt;
        btn.className = 'option-btn';
        if (userAnswers[currentIndex] === idx) {
            btn.classList.add('selected');
        }
        btn.onclick = () => selectAnswer(idx);
        optionsBox.appendChild(btn);
    });
}

function selectAnswer(idx) {
    if (isPaused) return;
    userAnswers[currentIndex] = idx;
    showQuestion();
}

function skipQuestion() {
    if (isPaused) return;
    if (currentIndex < questions.length - 1) {
        currentIndex++;
        showQuestion();
    } else {
        alert("This is the last question. You can use 'Submit Quiz' at the top when ready.");
    }
}

function nextQuestion() {
    if (isPaused) return;
    if (currentIndex < questions.length - 1) {
        currentIndex++;
        showQuestion();
    }
}

function prevQuestion() {
    if (isPaused) return;
    if (currentIndex > 0) {
        currentIndex--;
        showQuestion();
    }
}

function confirmSubmit() {
    if (isPaused) return;
    let unanswered = userAnswers.filter(ans => ans === null).length;
    let message = "Are you sure you want to submit your quiz?";
    if (unanswered > 0) {
        message = `You have ${unanswered} unanswered question(s). Are you sure you want to submit?`;
    }
    
    if (confirm(message)) {
        showReviewScreen();
    }
}

function showReviewScreen() {
    clearInterval(timerInterval);
    isPaused = false;
    
    let score = 0;
    questions.forEach((q, i) => {
        if (userAnswers[i] === q.answer) score++;
    });

    fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quizId: currentQuizId,
            score: score,
            total: questions.length,
            answers: userAnswers
        })
    }).catch(err => console.error('Error saving submission:', err));

    let container = document.querySelector('.quiz-container');
    let reviewHTML = `<h2>Quiz Completed!</h2><p>Your Score: ${score} / ${questions.length}</p><div style="max-height: 400px; overflow-y: auto;">`;

    questions.forEach((q, i) => {
        let userAns = userAnswers[i];
        let isCorrect = userAns === q.answer;
        reviewHTML += `
            <div class="review-item">
                <p><strong>Q${i + 1}: ${q.question}</strong></p>
                <p>Your Answer: <span class="${isCorrect ? 'correct-text' : 'incorrect-text'}">${userAns !== null ? q.options[userAns] : 'Not Answered'}</span></p>
                <p>Correct Answer: <span class="correct-text">${q.options[q.answer]}</span></p>
                ${q.explanation ? `<div class="explanation"><strong>Explanation:</strong> ${q.explanation}</div>` : ''}
            </div>
        `;
    });

    reviewHTML += `</div><button onclick="location.reload()" style="margin-top: 15px;">Back to Menu</button>`;
    container.innerHTML = reviewHTML;
}