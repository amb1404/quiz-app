const backendCssOverrides = `
/* --- Server-Enforced Fixes: Hidden Class, Nav Grid & Mobile Viewport Fit --- */
.hidden {
    display: none !important;
}

#first-name, #last-name {
    text-transform: uppercase;
}
#email-address {
    text-transform: lowercase;
}

.quiz-nav-container {
    display: grid !important;
    grid-template-columns: repeat(2, 145px) !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 12px 16px !important;
    margin-top: 24px !important;
}

.quiz-nav-container button {
    margin: 0 !important;
    width: 100% !important;
    max-width: none !important;
    text-decoration: none !important;
}

.quiz-nav-container button:hover {
    text-decoration: none !important;
}

.quiz-nav-container button:nth-child(1) {
    grid-column: 1 / 2 !important;
    grid-row: 1 !important;
}

.quiz-nav-container button:nth-child(3) {
    grid-column: 2 / 3 !important;
    grid-row: 1 !important;
}

.quiz-nav-container button:nth-child(2) {
    grid-column: 1 / 3 !important;
    grid-row: 2 !important;
}

/* 모바일 화면 전체 맞춤 및 스크롤 방지 최적화 */
@media (max-width: 600px) {
    body {
        padding: 4px !important;
        margin: 0 !important;
        height: 100vh !important;
        height: 100dvh !important;
        overflow: hidden !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
    }

    #class-select-screen, 
    #subject-select-screen, 
    #ix-x-chapter-screen, 
    #xi-xii-unit-screen, 
    #xi-xii-chapter-screen, 
    #xi-xii-topic-screen, 
    #name-screen, 
    #result-screen,
    #download-screen {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        padding: 14px 16px !important;
        border-radius: 0 !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        overflow-y: auto !important;
        margin: 0 !important;
    }

    #quiz-screen {
        width: 100% !important;
        max-width: 100% !important;
        height: 100vh !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
        padding: 10px 12px !important;
        border-radius: 0 !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        margin: 0 !important;
        overflow: hidden !important;
    }

    .quiz-header {
        flex-wrap: nowrap !important;
        margin-bottom: 4px !important;
        gap: 4px !important;
        flex-shrink: 0 !important;
    }

    #time-left {
        font-size: 13px !important;
        white-space: nowrap !important;
    }

    #quiz-stats {
        font-size: 11px !important;
        text-align: center !important;
        white-space: nowrap !important;
    }

    #submit-btn {
        padding: 5px 8px !important;
        font-size: 11px !important;
        white-space: nowrap !important;
        margin: 0 !important;
    }

    .progress-container {
        height: 4px !important;
        margin-bottom: 4px !important;
        flex-shrink: 0 !important;
    }

    #quiz-screen-heading {
        font-size: 15px !important;
        margin: 0 0 4px 0 !important;
        flex-shrink: 0 !important;
    }

    #question-box {
        font-size: 13.5px !important;
        line-height: 1.3 !important;
        margin-bottom: 6px !important;
        flex-shrink: 0 !important;
    }

    #options-container {
        margin-bottom: 4px !important;
        flex-grow: 1 !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
    }

    .option-btn {
        padding: 8px 10px !important;
        margin-bottom: 5px !important;
        font-size: 13px !important;
        line-height: 1.2 !important;
    }

    .quiz-nav-container {
        grid-template-columns: repeat(2, 120px) !important;
        gap: 6px 10px !important;
        margin-top: 2px !important;
        flex-shrink: 0 !important;
    }

    .quiz-nav-container button {
        padding: 7px 10px !important;
        font-size: 12.5px !important;
    }
}
`;
