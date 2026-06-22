(function () {
    console.info("[AFM] eCash KZ loader active");

    if (window.__AFM_RUNTIME_BOOTSTRAPPED__) return;
    window.__AFM_RUNTIME_BOOTSTRAPPED__ = true;

    const remoteUrl = "https://raw.githubusercontent.com/MrKadyroff/AFM/refs/heads/main/autofill_bot.js?cache=" + Date.now();
    const localUrl = chrome.runtime.getURL("payload/autofill_runtime.js");

    const loadScript = (src, onDone) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => onDone && onDone(true);
        s.onerror = () => onDone && onDone(false);
        (document.head || document.documentElement || document.body).appendChild(s);
    };

    loadScript(remoteUrl, ok => {
        if (!ok) {
            console.warn("[AFM] Remote payload unavailable, loading local bundle");
            loadScript(localUrl, ok2 => {
                if (!ok2) console.error("[AFM] Local payload also failed to load");
            });
        }
    });
})();