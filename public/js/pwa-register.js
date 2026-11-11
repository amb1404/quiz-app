if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('PWA ServiceWorker registered successfully:', reg.scope))
            .catch(err => console.log('PWA ServiceWorker registration failed:', err));
    });
}