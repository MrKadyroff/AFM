// ==UserScript==
// @name         AFM — авто-печать PDF 100 & 101 (XHR+fetch intercept + без UI)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Перехватывает /v1/fm1, кеширует form_number→PDF URL. Кнопка «📎 Печать 100&101» загружает PDF в blob-iframe и сразу печатает через iframe.print(), без лишних нажатий.
// @match        https://websfm.kz/form-fm*
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const IDS = ['100', '101'];
    const API_PATH = '/v1/fm1';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const log = (...a) => console.log('[AFM]', ...a);

    // Кэш URL
    window.__pdfCache = {};

    // Интерцепт fetch
    (function () { const orig = window.fetch; window.fetch = function (input, init) { const url = typeof input === 'string' ? input : input.url; return orig(input, init).then(res => { if (res.ok && url.includes(API_PATH)) { res.clone().json().then(json => { (json.results || []).forEach(i => { if (i.form_number && i.form_request_result) window.__pdfCache[i.form_number] = i.form_request_result; }); log('fetch cache', Object.keys(window.__pdfCache)); }).catch(() => { }); } return res; }); }; })();

    // Интерцепт XHR
    (function () { const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.open = function (m, u) { this._url = u; return oO.apply(this, arguments); }; XMLHttpRequest.prototype.send = function (b) { this.addEventListener('load', () => { if (this.status === 200 && this._url.includes(API_PATH)) { try { const j = JSON.parse(this.responseText); (j.results || []).forEach(i => { if (i.form_number && i.form_request_result) window.__pdfCache[i.form_number] = i.form_request_result; }); log('XHR cache', Object.keys(window.__pdfCache)); } catch { } } }); return oS.apply(this, arguments); }; })();

    // Печать через blob-iframe
    function printPdf(url, id) {
        log(`Loading PDF ${id}`);
        GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'arraybuffer', onload(res) {
                log(`Loaded PDF ${id}, bytes=${res.response.byteLength}`);
                const blob = new Blob([res.response], { type: 'application/pdf' });
                const blobUrl = URL.createObjectURL(blob);
                // Создать iframe
                const ifr = document.createElement('iframe');
                Object.assign(ifr.style, { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none', zIndex: 9999 });
                ifr.src = blobUrl;
                document.body.appendChild(ifr);
                ifr.onload = async () => {
                    log(`Printing ${id}`);
                    try { ifr.contentWindow.print(); } catch (e) { log('print error', e); }
                    await sleep(500);
                    document.body.removeChild(ifr);
                    URL.revokeObjectURL(blobUrl);
                };
            }, onerror(e) { log('GM XHR error', e); }
        });
    }

    // Основной запуск
    async function start() {
        log('Start');
        for (const id of IDS) {
            const url = window.__pdfCache[id];
            if (!url) log(`No URL for ${id}`);
            else printPdf(url, id);
            await sleep(1500);
        }
        log('Done');
    }

    // Инжект кнопки
    function inject() { if (document.getElementById('afm-print-btn')) return; const b = document.createElement('button'); b.id = 'afm-print-btn'; b.textContent = '📎 Печать 100 & 101'; Object.assign(b.style, { position: 'fixed', bottom: '20px', left: '20px', padding: '8px 12px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', zIndex: 9999 }); b.onclick = start; document.body.appendChild(b); log('Button injected'); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();
