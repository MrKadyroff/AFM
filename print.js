// ==UserScript==
// @name         AFM — авто-печать PDF 100 & 101 (v1.5 popup sync)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Перехватывает /v1/fm1, кеширует form_number→PDF URL. Кнопка «📎 Печать 100&101» открывает синхронно окна, загружает PDF и печатает без блокировок.
// @match        https://websfm.kz/form-fm*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    const IDS = ['100', '101'], API = '/v1/fm1';
    const cache = {};
    const log = (...args) => console.log('[AFM]', ...args);

    // Интсепт fetch
    (function () {
        const orig = window.fetch; window.fetch = (inp, init) => {
            const url = typeof inp === 'string' ? inp : inp.url;
            return orig(inp, init).then(r => { if (r.ok && url.includes(API)) r.clone().json().then(j => j.results.forEach(it => { if (it.form_number && it.form_request_result) cache[it.form_number] = it.form_request_result; }), e => { }); return r; });
        };
    })();
    // XHR
    (function () { const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.open = function (m, u) { this._u = u; return oO.apply(this, arguments); }; XMLHttpRequest.prototype.send = function (b) { this.addEventListener('load', () => { if (this.status === 200 && this._u.includes(API)) { try { JSON.parse(this.responseText).results.forEach(it => { if (it.form_number && it.form_request_result) cache[it.form_number] = it.form_request_result; }); } catch { } } }); return oS.apply(this, arguments); }; })();

    // Синхронное открытие и печать окон
    function startPrint() {
        log('Start printing');
        IDS.forEach(id => {
            const url = cache[id];
            if (!url) { log(`No URL for ${id}`); return; }
            // Синхронно открываем popup
            const w = window.open('', `print_${id}`);
            if (!w) { log('Popup blocked'); return; }
            w.document.write(`<html><body style="margin:0;overflow:hidden"><embed id="pdfEmb" width="100%" height="100%" type="application/pdf"></body></html>`);
            w.document.close();
            // Загружаем PDF
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'blob', onload(res) {
                    const blobUrl = URL.createObjectURL(res.response);
                    const emb = w.document.getElementById('pdfEmb');
                    emb.src = blobUrl;
                    // Ждём полной загрузки PDF, потом авто-печать
                    emb.onload = () => {
                        log(`Auto-printing ${id}`);
                        setTimeout(() => {
                            w.focus();
                            w.print();
                            setTimeout(() => {
                                w.close();
                                URL.revokeObjectURL(blobUrl);
                                log(`Closed ${id}`);
                            }, 2000); // 7 секунд на печать, потом закроется
                        }, 600); // даём 600мс PDF встроиться (можно увеличить)
                    };
                }, onerror(e) { log('XHR error', e); }
            });
        });
    }
    // Кнопка
    function injectBtn() { if (document.getElementById('afm_print')) return; const b = document.createElement('button'); b.id = 'afm_print'; b.textContent = '📎 Печать 100&101'; Object.assign(b.style, { position: 'fixed', bottom: '20px', left: '20px', padding: '8px 12px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', zIndex: 9999 }); b.addEventListener('click', startPrint); document.body.appendChild(b); log('Button injected'); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectBtn); else injectBtn();
})();
