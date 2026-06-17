(function () {
    console.info("[AFM] eCash KZ loader active");

    if (window.__AFM_RUNTIME_BOOTSTRAPPED__) return;
    window.__AFM_RUNTIME_BOOTSTRAPPED__ = true;

    const localUrl = chrome.runtime.getURL("payload/autofill_runtime.js");

    const loadScript = (src, onDone) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => onDone && onDone(true);
        s.onerror = () => onDone && onDone(false);
        (document.head || document.documentElement || document.body).appendChild(s);
    };

    loadScript(localUrl, ok => {
        if (!ok) {
            console.error("[AFM] Local payload failed to load");
        }
    });
})();