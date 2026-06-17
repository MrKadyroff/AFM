(function () {
    console.info("[AFM] eCash KZ loader active");

    if (window.__AFM_RUNTIME_BOOTSTRAPPED__) return;
    window.__AFM_RUNTIME_BOOTSTRAPPED__ = true;

    const remoteUrl = "https://raw.githubusercontent.com/MrKadyroff/AFM/refs/heads/main/autofill_obs.js";
    const localUrl = chrome.runtime.getURL("payload/autofill_runtime.js");

    const loadScript = (src, onDone) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => onDone && onDone(true);
        s.onerror = () => onDone && onDone(false);
        (document.head || document.documentElement || document.body).appendChild(s);
    };

    // Cache-busting once per hour prevents stale CDN cache while reducing request spam.
    const cacheToken = Math.floor(Date.now() / (60 * 60 * 1000));
    loadScript(`${remoteUrl}?v=${cacheToken}`, ok => {
        if (ok) {
            console.info("[AFM] Remote runtime loaded");
            return;
        }
        console.warn("[AFM] Remote runtime failed, fallback to local payload");
        loadScript(localUrl, localOk => {
            if (!localOk) console.error("[AFM] Local payload also failed to load");
        });
    });
})();