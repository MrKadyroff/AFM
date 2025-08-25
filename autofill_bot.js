// ==UserScript==
// @name         AFM
// @namespace    http://tampermonkey.net/
// @version      1.6.3
// @description  Автозаполнение AFM через буфер. Многопроходная заливка, блокировка взаимодействия, лёгкий кометик-анимация. Мониторинг Сохранить/Подписать. AfmDocId из form.form_number.
// @author       Ecash
// @match        https://websfm.kz/form-fm/*
// @grant        none
// ==/UserScript==

const AFM_STATE = { businessKey: "", initiator: "" };

async function waitForElement(selector, timeout = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
}

async function openAccordionByHeader(headerText, expectedFieldNames = [], timeout = 1500) {
    const p = Array.from(document.querySelectorAll('p'))
        .find(e => e.textContent.trim().toLowerCase().includes(headerText.trim().toLowerCase()));
    if (!p) return false;

    const headerDiv = p.closest('div');
    if (!headerDiv) return false;

    const someVisible = expectedFieldNames.some(name => document.querySelector(`[name="${name}"]`));
    if (someVisible) return true;

    headerDiv.click();

    const start = Date.now();
    while (Date.now() - start < timeout) {
        const ready = expectedFieldNames.some(name => document.querySelector(`[name="${name}"]`));
        if (ready) return true;
        await new Promise(r => setTimeout(r, 100));
    }

    console.warn("⛔️ Аккордеон не раскрыл нужные поля:", headerText);
    return false;
}

async function realUserType(input, text, delay = 10) {
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        input.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: char, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: char, bubbles: true }));

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, input.value + char);

        input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: char, bubbles: true }));
        await new Promise(r => setTimeout(r, delay));
    }
    input.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));

    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));

    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setReactInputValue(el, value) {
    const lastValue = el.value;
    el.value = value;
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue(lastValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function typeTextSlowly(input, text, delay = 5) {
    input.focus(); input.value = ""; input.dispatchEvent(new Event('input', { bubbles: true }));
    for (const char of text) {
        input.value += char;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, delay));
    }
}

async function selectDropdownUniversal(name, value) {
    const opener = document.querySelector(`button[name="${name}"]`);
    if (!opener) return false;
    opener.focus(); opener.click();
    await new Promise(r => setTimeout(r, 50));

    let input = opener.closest('div')?.querySelector('input[placeholder]');
    if (!input) input = Array.from(document.querySelectorAll('input[placeholder]')).find(i => i.offsetParent !== null);
    if (input) {
        await realUserType(input, value, 20);
        await new Promise(r => setTimeout(r, 20));
    }

    let found = null;
    const start = Date.now();
    while (Date.now() - start < 1000) {
        const opts = Array.from(document.querySelectorAll(`button[name="${name}"][type="button"]`));
        found = opts.find(btn => ((btn.dataset?.name || btn.textContent || "").trim().toLowerCase() === value.trim().toLowerCase()))
            || opts.find(btn => ((btn.dataset?.name || btn.textContent || "").trim().toLowerCase().includes(value.trim().toLowerCase())));
        if (found) break;
        await new Promise(r => setTimeout(r, 50));
    }

    if (found) { found.click(); await new Promise(r => setTimeout(r, 50)); document.body.click(); return true; }
    return false;
}

function setReactCheckbox(name, checked = true) {
    const cb = document.querySelector(`input[type="checkbox"][name="${name}"]`);
    if (cb) {
        if (cb.checked !== checked) cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    return false;
}

/* =========================
   [1.5] Проверка/ретраи полей
   ========================= */
const norm = v => String(v ?? "").trim().toLowerCase();

function isFieldFilled(field) {
    if (field.FieldType === "input") {
        const input = document.querySelector(`[name="${field.Name}"]`);
        if (!input) return false;
        return norm(input.value) === norm(field.Value);
    }
    if (field.FieldType === "checkbox") {
        const cb = document.querySelector(`input[type="checkbox"][name="${field.Name}"]`);
        return !!cb && (cb.checked === !!field.Value);
    }
    if (field.FieldType === "select") {
        const hidden = document.querySelector(`input[name="${field.Name}"]`);
        if (hidden && hidden.value) return norm(hidden.value) === norm(field.Value);
        const btn = document.querySelector(`button[name="${field.Name}"]`);
        if (!btn) return false;
        const btnText = norm(btn.dataset?.name || btn.textContent || "");
        const val = norm(field.Value);
        return btnText.includes(val) || btnText === val;
    }
    return false;
}

async function ensureSectionsForField(field) {
    if (field.Name === "operation.address.house_number") {
        await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
        await openAccordionByHeader("участник 1", ["participants[0].participant"]);
        await openAccordionByHeader("банк участника операции", ["participants[0].bank.country"]);
        await openAccordionByHeader("юридический адрес", ["participants[0].legal_address.country"]);
        await openAccordionByHeader("фактический адрес", ["participants[0].address.country"]);
    }
    if (field.Name === "participants[0].iin") {
        await openAccordionByHeader("фио", ["participants[0].full_name.last_name", "participants[0].full_name.first_name"]);
        await openAccordionByHeader("документ, удостоверяющий личность",
            ["participants[0].document.type_document", "participants[0].document.number", "participants[0].document.issue_date"]);
    }
}

async function fillFieldOnce(field) {
    await ensureSectionsForField(field);

    if (field.FieldType === "input") {
        let el = document.querySelector(`[name="${field.Name}"]`);
        if (!el) {
            const start = Date.now();
            while (!el && Date.now() - start < 2000) {
                await new Promise(r => setTimeout(r, 100));
                el = document.querySelector(`[name="${field.Name}"]`);
            }
        }
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) setReactInputValue(el, field.Value);
    } else if (field.FieldType === "select") {
        await selectDropdownUniversal(field.Name, field.Value);
    } else if (field.FieldType === "checkbox") {
        setReactCheckbox(field.Name, field.Value);
    }

    await new Promise(r => setTimeout(r, 60));
    return isFieldFilled(field);
}

/** Многопроходная заливка */
async function fillFieldsWithRetries(fields, maxPasses = 3) {
    let queue = fields.filter(f => ["input", "select", "checkbox"].includes(f.FieldType));
    for (let pass = 1; pass <= maxPasses && queue.length; pass++) {
        const next = [];
        if (pass > 1) await new Promise(r => setTimeout(r, 120));
        for (const field of queue) {
            const ok = await fillFieldOnce(field);
            if (!ok) next.push(field);
        }
        queue = next;
        console.log(`[AFM] Pass ${pass} done, remaining: ${queue.length}`);
    }
    return queue;
}

/* =========================
   [2] Данные из буфера/DOM
   ========================= */
async function getDataFromBuffer() {
    try {
        const clipboardText = await navigator.clipboard.readText();
        const fields = JSON.parse(clipboardText);
        if (fields?.initiator) AFM_STATE.initiator = fields.initiator;
        if (fields?.json && Array.isArray(fields.json)) {
            const bk = fields.json.find(f => f.Name === "businessKey")?.Value;
            if (bk) AFM_STATE.businessKey = bk;
        }
        return fields;
    } catch {
        return null;
    }
}

async function getAfmDocId() {
    let el = document.querySelector('input[name="form.form_number"]');
    if (!el || !el.value?.trim()) {
        await openAccordionByHeader("форма фм-1", ["form.form_number"]);
        await new Promise(r => setTimeout(r, 100));
        el = document.querySelector('input[name="form.form_number"]');
    }
    return el && typeof el.value !== 'undefined' ? String(el.value).trim() : "";
}

/* =========================
   [3] UI: overlay
   ========================= */
function showOverlay(text = "Загрузка...") {
    if (document.getElementById("afm-loading-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "afm-loading-overlay";
    overlay.style = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.35);
    z-index: 99999; display: flex; align-items: center; justify-content: center;
    font-size: 1rem; color: white; font-family: inherit; transition: opacity .2s; pointer-events: all;
  `;
    overlay.innerHTML = `
    <div style="padding: 32px 48px; background: #282c34; border-radius: 16px; box-shadow: 0 8px 40px #0007;">
      <span style="display:inline-block; margin-right:18px; vertical-align:middle;">
        <svg width="40" height="40" viewBox="0 0 50 50" style="vertical-align:middle;">
          <circle cx="25" cy="25" r="20" fill="none" stroke="#53e3a6" stroke-width="5" stroke-linecap="round" stroke-dasharray="90 60" stroke-dashoffset="0">
            <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1.2s" repeatCount="indefinite"/>
          </circle>
        </svg>
      </span>
      <span>${text}</span>
    </div>
  `;
    document.body.appendChild(overlay);
}
function hideOverlay() { const overlay = document.getElementById("afm-loading-overlay"); if (overlay) overlay.remove(); }

/* =========================
   [3.5] Блокировка взаимодействия
   ========================= */
const AFM_BLOCKER_ID = "afm-interaction-lock";
let _afm_unbinders = [];
function lockInteraction() {
    if (document.getElementById(AFM_BLOCKER_ID)) return;
    const blocker = document.createElement("div");
    blocker.id = AFM_BLOCKER_ID;
    blocker.style = `position: fixed; inset: 0; z-index: 99998; cursor: wait; background: transparent;`;
    const stop = e => { e.stopPropagation(); e.preventDefault(); };
    ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "contextmenu", "mousedown", "mouseup", "mousemove", "wheel", "touchstart", "touchmove", "touchend"].forEach(ev => {
        blocker.addEventListener(ev, stop, { passive: false });
    });
    document.body.appendChild(blocker);
    const keyHandler = e => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("keypress", keyHandler, true);
    window.addEventListener("keyup", keyHandler, true);
    _afm_unbinders.push(() => {
        window.removeEventListener("keydown", keyHandler, true);
        window.removeEventListener("keypress", keyHandler, true);
        window.removeEventListener("keyup", keyHandler, true);
        blocker.remove();
    });
}
function unlockInteraction() {
    try { _afm_unbinders.forEach(fn => fn()); } catch { }
    _afm_unbinders = [];
    const b = document.getElementById(AFM_BLOCKER_ID);
    if (b) b.remove();
}

/* =========================
   [3.6] Маскот "кометик"
   ========================= */
function ensureMascotStyles() {
    if (document.getElementById("afm-mascot-style")) return;
    const css = document.createElement("style");
    css.id = "afm-mascot-style";
    css.textContent = `
    #afm-mascot {
      position: fixed; inset: 0; z-index: 100001; pointer-events: none;
      width: 100vw; height: 100vh; overflow: visible;
    }
    #afm-mascot .mx, #afm-mascot .my { position: absolute; inset: 0; }
    /* Горизонталь туда-сюда */
    #afm-mascot .mx { animation: afm-move-x 6s ease-in-out infinite alternate; }
    /* Вертикаль с другой частотой — получается "змейка" */
    #afm-mascot .my { animation: afm-move-y 4.2s ease-in-out infinite alternate; }
    @keyframes afm-move-x {
      0% { transform: translateX(-8vw); }
      100% { transform: translateX(88vw); }
    }
    @keyframes afm-move-y {
      0% { transform: translateY(18vh); }
      100% { transform: translateY(72vh); }
    }
    /* Сам спрайт */
    #afm-mascot .sprite {
      width: 42px; height: 42px; position: absolute; left: 0; top: 0;
      transform: translateZ(0); will-change: transform;
      animation: afm-tilt 1.6s ease-in-out infinite alternate;
      filter: drop-shadow(0 6px 14px rgba(0,0,0,.25));
    }
    @keyframes afm-tilt {
      0% { transform: rotate(-8deg) scale(1); }
      100% { transform: rotate(8deg) scale(1.02); }
    }
    /* Хвост — мягкий градиент и "искры" */
    #afm-mascot .trail {
      position: absolute; right: 34px; top: 50%; width: 80px; height: 8px;
      transform: translateY(-50%);
      background: linear-gradient(90deg, rgba(255,255,255,.0) 0%, rgba(100,181,246,.25) 35%, rgba(30,136,229,.6) 100%);
      border-radius: 8px; filter: blur(1px); opacity: .8;
      mask: linear-gradient(90deg, transparent 0%, white 40%, white 100%);
      animation: afm-trail 0.9s ease-in-out infinite;
    }
    @keyframes afm-trail {
      0% { opacity: .55; }
      100% { opacity: .9; }
    }
    #afm-mascot .spark {
      position: absolute; right: 28px; top: 50%; width: 6px; height: 6px;
      border-radius: 50%; background: #90caf9; box-shadow: 0 0 8px #90caf9, 0 0 14px rgba(144,202,249,.7);
      transform: translateY(-50%) scale(1);
      animation: afm-spark 0.8s ease-in-out infinite alternate;
    }
    @keyframes afm-spark {
      0% { transform: translateY(-50%) scale(.9); opacity: .75; }
      100% { transform: translateY(-50%) scale(1.1); opacity: 1; }
    }
    /* SVG-комета: градиентное тело + "клюв" */
    #afm-mascot svg { width: 42px; height: 42px; display: block; }
    @media (max-width: 1024px) {
      #afm-mascot .sprite { width: 34px; height: 34px; }
      #afm-mascot svg { width: 34px; height: 34px; }
      #afm-mascot .trail { width: 66px; right: 26px; }
    }
  `;
    document.head.appendChild(css);
}

function showMascot() {
    if (document.getElementById("afm-mascot")) return;
    ensureMascotStyles();
    const host = document.createElement("div");
    host.id = "afm-mascot";
    host.innerHTML = `
    <div class="mx">
      <div class="my">
        <div class="sprite">
          <div class="trail"></div>
          <div class="spark"></div>
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <defs>
              <radialGradient id="g1" cx="45%" cy="35%" r="70%">
                <stop offset="0%" stop-color="#fff59d"/>
                <stop offset="60%" stop-color="#ffe082"/>
                <stop offset="100%" stop-color="#ffca28"/>
              </radialGradient>
              <linearGradient id="g2" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stop-color="#42a5f5"/>
                <stop offset="100%" stop-color="#1e88e5"/>
              </linearGradient>
            </defs>
            <!-- тело кометы -->
            <circle cx="36" cy="32" r="14" fill="url(#g1)"/>
            <!-- "клюв"/нос -->
            <path d="M22 30 L36 32 L22 34 Z" fill="url(#g2)" opacity=".95"/>
            <!-- блик -->
            <circle cx="41" cy="27" r="3" fill="#ffffff" opacity=".85"/>
          </svg>
        </div>
      </div>
    </div>
  `;
    document.body.appendChild(host);
}
function hideMascot() { const el = document.getElementById("afm-mascot"); if (el) el.remove(); }

/* ==============================================
   [4] Мониторинг и привязка кнопок save/subscribe
   ============================================== */
function bindActionButtonOnce(btn, statusValue) {
    if (!btn || btn.hasAttribute('afm-listener')) return;
    btn.setAttribute('afm-listener', '1');

    btn.addEventListener('click', async () => {
        const afmDocId = await getAfmDocId();
        const payload = {
            requestId: AFM_STATE.businessKey || "",
            AfmDocId: afmDocId || "",
            afmId: afmDocId || "",
            savedByUser: statusValue === 2 ? (AFM_STATE.initiator || "") : "",
            subscribedByUser: statusValue === 3 ? (AFM_STATE.initiator || "") : "",
            saveUserIp: "", subscribeUserIp: "", status: statusValue
        };
        try {
            const resp = await fetch(`https://api.quiq.kz/Application/afmStatus`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            if (!resp.ok) throw new Error('Network response was not ok');
        } catch (err) { console.error('Ошибка запроса:', err); }
    });
}
function observeAndBindActionButtons() {
    const tryBindNow = () => {
        bindActionButtonOnce(document.querySelector('button[name="save"]'), 2);
        bindActionButtonOnce(document.querySelector('button[name="subscribe"]'), 3);
    };
    tryBindNow();
    const observer = new MutationObserver(() => tryBindNow());
    observer.observe(document.body, { childList: true, subtree: true });
}

/* =========================
   [5] Главный запуск (IIFE)
   ========================= */
(function () {
    'use strict';
    console.log("[AFM] Loaded v1.6.3 (clipboard-only, retries + lock + comet)");

    // Стили и кнопка
    const pulseStyle = document.createElement('style');
    pulseStyle.innerHTML = `
    .afm-pulse {
      animation: afm-pulse-btn 1.3s infinite; position: fixed; left: 50%; top: 10%;
      transform: translate(-50%, 10px); z-index: 9999;
    }
    @keyframes afm-pulse-btn { 0% { box-shadow: 0 0 0 0 #1976d280; } 70% { box-shadow: 0 0 0 12px #1976d200; } 100% { box-shadow: 0 0 0 0 #1976d200; } }
  `;
    document.head.appendChild(pulseStyle);

    const btn = document.createElement("button");
    btn.innerText = "Заполнить";
    btn.className = "afm-pulse";
    btn.style = `
    padding: 14px 32px; font-size: 18px; border: none; border-radius: 8px;
    background: #1976d2; color: #fff; transition: background .2s; cursor: pointer;
  `;
    const styleActive = 'background:#1976d2;color:#fff;cursor:pointer;';
    const styleProcess = 'background:#ffa726;color:#222;cursor:wait;';
    const styleDone = 'background:#43a047;color:#fff;cursor:pointer;';
    const styleDis = 'background:#ec4141;color:#fff;cursor:pointer;';

    observeAndBindActionButtons();

    // как раньше — периодически подсказка по буферу
    setInterval(async () => {
        const fields = await getDataFromBuffer();
        if (fields == null) {
            btn.disabled = true;
            btn.innerText = "Нет данных. Нажмите кнопку АФМ в заявке.";
            btn.style = btn.style.cssText + styleDis;
        } else {
            btn.disabled = false;
            btn.innerText = "Заполнить";
            btn.style = btn.style.cssText + styleActive;
        }
    }, 1500);

    btn.onclick = async () => {
        btn.disabled = true;
        btn.innerText = "Заполняется...";
        btn.style = btn.style.cssText + styleProcess;
        showOverlay("Идёт автозаполнение формы. Пожалуйста, не кликайте и не используйте клавиатуру.");
        lockInteraction();
        showMascot();

        (async () => {
            try {
                const fields = await getDataFromBuffer();
                await new Promise(r => setTimeout(r, 100));

                if (fields?.json == null) {
                    btn.disabled = false;
                    btn.innerText = "Заполнить";
                    btn.style = btn.style.cssText + styleActive;
                    hideOverlay(); unlockInteraction(); hideMascot();
                    alert("Нет данных. Нажмите кнопку АФМ в заявке.");
                    return;
                }

                // Авто-раскрытие
                await openAccordionByHeader("форма фм-1", ["form.operation_state", "form.operation_date"]);
                await openAccordionByHeader("сведения об операции", ["operation.number", "operation.currency"]);
                await new Promise(r => setTimeout(r, 200));

                // Инициатор/бизнес-ключ
                const maybeBK = fields.json.find(f => f.Name === "businessKey")?.Value;
                if (maybeBK) AFM_STATE.businessKey = maybeBK;
                if (fields.initiator) AFM_STATE.initiator = fields.initiator;

                // 🔁 многопроходная заливка
                let notFilled = [];
                try {
                    notFilled = await fillFieldsWithRetries(fields.json, 3);
                } catch (e) {
                    console.error("[AFM] Ошибка в ретраях, fallback legacyFillOnce:", e);
                    await legacyFillOnce(fields.json);
                    notFilled = [];
                }

                // без финальных модалок — только лог
                if (notFilled.length) {
                    console.warn("Не удалось заполнить поля:", notFilled.map(f => f.Name));
                }

                btn.disabled = false;
                btn.innerText = "Заполнить";
                btn.style = btn.style.cssText + styleDone;
                hideOverlay(); hideMascot();
            } catch (e) {
                console.error("[AFM] Autofill error:", e);
                hideOverlay(); hideMascot();
            } finally {
                unlockInteraction();
            }
        })();

        await new Promise(r => setTimeout(r, 50));
    };

    document.body.appendChild(btn);
})();

/* =========================
   [LEGACY] Однопроходная заливка (фолбэк)
   ========================= */
async function legacyFillOnce(fieldsJson) {
    for (const field of fieldsJson) {
        if (field.Name === "operation.address.house_number") {
            await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
            await openAccordionByHeader("участник 1", ["participants[0].participant"]);
            await openAccordionByHeader("банк участника операции", ["participants[0].bank.country"]);
            await openAccordionByHeader("юридический адрес", ["participants[0].legal_address.country"]);
            await openAccordionByHeader("фактический адрес", ["participants[0].address.country"]);
        }
        if (field.Name === "participants[0].iin") {
            await openAccordionByHeader("фио", ["participants[0].full_name.last_name", "participants[0].full_name.first_name"]);
            await openAccordionByHeader("документ, удостоверяющий личность",
                ["participants[0].document.type_document", "participants[0].document.number", "participants[0].document.issue_date"]);
        }

        if (field.FieldType === "input") {
            let el = document.querySelector(`[name="${field.Name}"]`);
            if (!el) {
                const start = Date.now();
                while (!el && Date.now() - start < 2000) {
                    await new Promise(r => setTimeout(r, 100));
                    el = document.querySelector(`[name="${field.Name}"]`);
                }
            }
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { setReactInputValue(el, field.Value); continue; }
        }

        if (field.FieldType === "select") { await selectDropdownUniversal(field.Name, field.Value); continue; }
        if (field.FieldType === "checkbox") { setReactCheckbox(field.Name, field.Value); continue; }
    }
}
