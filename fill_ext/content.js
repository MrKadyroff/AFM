(function () {
    const url = "https://raw.githubusercontent.com/MrKadyroff/AFM/refs/heads/main/autofill_bot.js?cache=" + Date.now();
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => console.log('AFM script loaded');
    script.onerror = (e) => alert('Ошибка загрузки автозаполнения: ' + e);
    document.body.appendChild(script);
})();
