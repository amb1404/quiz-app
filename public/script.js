let quizQuestions = [];
let currentQuestionIndex = 0;
let userAnswers = {};
let timerInterval;

document.addEventListener("DOMContentLoaded", () => {
  const inputIds = ['firstName', 'lastName', 'email'];
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (sessionStorage.getItem(id)) el.value = sessionStorage.getItem(id);
      el.addEventListener('input', (e) => sessionStorage.setItem(id, e.target.value));
    }
  });

  const savedScreen = sessionStorage.getItem('currentScreen') || 'class-screen';
  showScreen(savedScreen);

  // If refreshed on the quiz screen, silently re-sync with the backend
  if (savedScreen === 'quiz-screen') {
    startQuiz(true);
  }
});

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(screenId).style.display = 'block';
  sessionStorage.setItem('currentScreen', screenId);
}

function selectChapter(chapterId) {
  sessionStorage.setItem('selectedChapter', chapterId);
  showScreen('details-screen');
}

async function startQuiz(isResume = false) {
  const email = document.getElementById('email').value.trim();
  const chapter = sessionStorage.getItem('selectedChapter');
  
  if (!email) {
    alert("Email is required for secure tracking.");
    showScreen('details-screen');
    return;
  }

  try {
    const response = await fetch('/api/quiz/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, chapter })
    });
    
    if (!response.ok) throw new Error("Time expired or session invalid.");
    
    const data = await response.json();
    quizQuestions = data.questions;
    userAnswers = data.savedAnswers || {};
    
    showScreen('quiz-screen');
    startVisualTimer(data.timeLeft);
    renderQuestion();
  } catch (error) {
    alert(error.message);
    showScreen('class-screen');
  }
}

function startVisualTimer(timeLeft) {
  clearInterval(timerInterval);
  const endTime = Date.now() + timeLeft;

  timerInterval = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      document.getElementById('timer-display').textContent = "Time Left: 00:00";
      submitQuiz(); 
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      document.getElementById('timer-display').textContent = 
        `Time Left: ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

function renderQuestion() {
  if (quizQuestions.length === 0) return;
  const q = quizQuestions[currentQuestionIndex];
  document.getElementById('question-text').textContent = `Q.${currentQuestionIndex + 1}: ${q.question}`;
  
  const optionsContainer = document.getElementById('options-container');
  optionsContainer.innerHTML = ''; 
  
  q.options.forEach((opt, index) => {
    const btn = document.createElement('button');
    btn.style.cssText = "padding: 15px; border: 1px solid #ced4da; border-radius: 5px; background: white; text-align: left; cursor: pointer; font-size: 16px; margin-bottom: 10px;";
    btn.textContent = opt;
    
    if (userAnswers[currentQuestionIndex] == index) {
      btn.style.backgroundColor = '#e8f0fe'; 
      btn.style.borderColor = '#4a90e2';
    }

    btn.onclick = () => selectOption(index);
    optionsContainer.appendChild(btn);
  });
  
  document.getElementById('stats-display').textContent = `Attempted: ${Object.keys(userAnswers).length} / ${quizQuestions.length}`;
}

async function selectOption(optionIndex) {
  userAnswers[currentQuestionIndex] = optionIndex;
  renderQuestion(); 

  // Silently save progress to backend
  await fetch('/api/quiz/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      email: document.getElementById('email').value.trim(), 
      questionIndex: currentQuestionIndex, 
      selectedOption: optionIndex 
    })
  });
}

async function clearResponse() {
  delete userAnswers[currentQuestionIndex];
  renderQuestion();
  // Optional: Send a specific save request here to nullify the answer in the backend
}

function nextQuestion() {
  if (currentQuestionIndex < quizQuestions.length - 1) {
    currentQuestionIndex++;
    renderQuestion();
  }
}

function prevQuestion() {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    renderQuestion();
  }
}

async function submitQuiz() {
  clearInterval(timerInterval);
  const email = document.getElementById('email').value.trim();
  
  try {
    const response = await fetch('/api/quiz/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const result = await response.json();
    
    if (result.success) {
      alert(`Quiz Submitted! Your score: ${result.score} out of ${result.total}`);
      sessionStorage.removeItem('currentScreen');
      showScreen('class-screen');
    } else {
      alert(result.error);
    }
  } catch (error) {
    alert("Error submitting quiz.");
  }
}
