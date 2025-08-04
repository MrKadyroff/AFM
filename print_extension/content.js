const IDS = ['100', '101'], API = '/v1/fm1';
const cache = {};
let printReady = false;
let btn;

const log = (...args) => console.log('[AFM]', ...args);

(function () {
    // Перехват fetch
    const orig = window.fetch;
    window.fetch = (inp, init) => {
        const url = typeof inp === 'string' ? inp : inp.url;
        return orig(inp, init).then(r => {
            if (r.ok && url.includes(API))
                r.clone().json().then(j => {
                    j.results.forEach(it => {
                        if (it.form_number && it.form_request_result) {
                            cache[it.form_number] = it.form_request_result;
                            checkBtn();
                        }
                    })
                });
            return r;
        });
    };

    // Перехват XHR
    const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this._u = u; return oO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
        this.addEventListener('load', () => {
            if (this.status === 200 && this._u.includes(API)) {
                try {
                    JSON.parse(this.responseText).results.forEach(it => {
                        if (it.form_number && it.form_request_result) {
                            cache[it.form_number] = it.form_request_result;
                            checkBtn();
                        }
                    });
                } catch { }
            }
        });
        return oS.apply(this, arguments);
    };

    function checkBtn() {
        if (IDS.every(id => cache[id]) && !printReady) {
            printReady = true;
            injectBtn();
        }
    }

    function startPrint() {
        IDS.forEach(id => {
            const url = cache[id];
            if (!url) { log(`No URL for ${id}`); return; }
            const w = window.open('', `print_${id}`);
            if (!w) { alert('Браузер заблокировал всплывающие окна. Разреши popups для сайта!'); return; }
            w.document.write(`<html><body style="margin:0;overflow:hidden"><embed id="pdfEmb" width="100%" height="100%" type="application/pdf"></body></html>`);
            w.document.close();
            fetch(url)
                .then(response => response.blob())
                .then(blob => {
                    const blobUrl = URL.createObjectURL(blob);
                    const emb = w.document.getElementById('pdfEmb');
                    emb.src = blobUrl;
                    emb.onload = () => {
                        setTimeout(() => {
                            w.focus();
                            w.print();
                            setTimeout(() => {
                                w.close();
                                URL.revokeObjectURL(blobUrl);
                            }, 2000);
                        }, 600);
                    };
                });
        });
    }
    console.log("HELLO");

    function injectBtn() {
        if (document.getElementById('afm_print')) return;
        btn = document.createElement('button');
        btn.id = 'afm_print';
        btn.textContent = '🖨️ Печать 100&101';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '30px',
            left: '30px',
            padding: '20px 36px',
            background: '#1976d2',
            color: '#fff',
            border: 'none',
            borderRadius: '12px',
            fontSize: '1.3em',
            fontWeight: 'bold',
            cursor: 'pointer',
            zIndex: 9999,
            boxShadow: '0 0 12px #555'
        });
        btn.addEventListener('click', startPrint);
        document.body.appendChild(btn);
        log('Кнопка расширения создана!');
    }
})();
