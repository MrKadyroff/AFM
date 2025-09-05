// ==UserScript==
// @name         AFM sef (lite)
// @namespace    http://tampermonkey.net/
// @version      1.6.5
// @description  Автозаполнение AFM через буфер. Многопроходная заливка с жёстким сбросом, блокировка взаимодействия, лёгкий модальный оверлей. Мониторинг Сохранить/Подписать. AfmDocId читаем из form.form_number/URL, НЕ изменяем.
// @author       Ecash
// @match        https://websfm.kz/form-fm/*
// @grant        none
// ==/UserScript==

/* =========================
   [0] Глобальное состояние
   ========================= */
const AFM_STATE = { businessKey: "", initiator: "" };
// Поля, которые только читаем, НО НЕ меняем
const AFM_PROTECTED_NAMES = new Set(["form.form_number"]);

/* =========================
   [1] Хелперы DOM/React
   ========================= */
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

async function selectDropdownUniversal(name, value, opts = {}) {
    const {
        openDelay = 150,
        step = 500,       // шаг прокрутки
        maxScrolls = 40,  // сколько шагов максимум
        findTimeout = 3000
    } = opts;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const opener = document.querySelector(`button[name="${CSS.escape(name)}"]`);
    if (!opener) return false;

    // Открываем дропдаун
    opener.focus();
    opener.click();
    await sleep(openDelay);

    // Если есть поле фильтра — печатаем в него
    let input = opener.closest('div')?.querySelector('input[placeholder]');
    if (!input) {
        input = Array.from(document.querySelectorAll('input[placeholder]'))
            .find(i => i.offsetParent !== null);
    }
    if (input) {
        await realUserType(input, value, 20);
        await sleep(80);
    }

    // Хелпер: ближайший скроллируемый родитель
    function getScrollableParent(el) {
        let node = el;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const canScrollY = /(auto|scroll)/.test(style.overflowY);
            if (canScrollY && node.scrollHeight > node.clientHeight) return node;
            node = node.parentElement;
        }
        // запасной вариант — ищем самый высокий список опций в документе
        const pools = Array.from(document.querySelectorAll('div,ul'))
            .filter(x => x.scrollHeight > x.clientHeight && /(auto|scroll)/.test(getComputedStyle(x).overflowY))
            .sort((a, b) => b.scrollHeight - a.scrollHeight);
        return pools[0] || document.body;
    }

    // Хелпер: получить видимые опции, исключив сам opener
    function getVisibleOptions() {
        const buttons = Array.from(document.querySelectorAll(`button[name="${CSS.escape(name)}"][type="button"]`))
            .filter(b => b !== opener); // исключаем хедер
        // иногда заголовок не имеет type="button" — перестрахуемся
        if (!buttons.length) {
            return Array.from(document.querySelectorAll(`button[name="${CSS.escape(name)}"]`))
                .filter(b => b !== opener);
        }
        return buttons;
    }

    // Нормализуем текст кнопки
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(value);

    // Пытаемся найти на видимой части
    let found = null;
    const t0 = Date.now();
    while (Date.now() - t0 < findTimeout && !found) {
        const optsNow = getVisibleOptions();
        found =
            optsNow.find(btn => norm(btn.dataset?.name || btn.textContent) === target) ||
            optsNow.find(btn => norm(btn.dataset?.name || btn.textContent).includes(target));
        if (found) break;
        await sleep(60);
    }

    // Если не нашли — крутим список вниз и пере-ищем
    if (!found) {
        // найдём контейнер скролла относительно любой видимой опции/инпута/опенера
        const probe = getVisibleOptions()[0] || input || opener;
        const scroller = getScrollableParent(probe);

        let i = 0;
        let lastScrollTop = -1;
        while (i < maxScrolls) {
            // если дальше крутить некуда — выходим
            if (scroller.scrollTop === lastScrollTop) break;
            lastScrollTop = scroller.scrollTop;

            scroller.scrollBy(0, step);
            await sleep(120);

            const optsNow = getVisibleOptions();
            found =
                optsNow.find(btn => norm(btn.dataset?.name || btn.textContent) === target) ||
                optsNow.find(btn => norm(btn.dataset?.name || btn.textContent).includes(target));
            if (found) break;

            i++;
        }
    }

    // План Б: клавиатурная навигация (если список управляемый клавишами)
    if (!found && input) {
        for (let i = 0; i < 50; i++) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await sleep(40);
            const hover = document.querySelector('[aria-selected="true"], [data-highlighted="true"]');
            if (hover) {
                const txt = norm(hover.textContent || hover.dataset?.name);
                if (txt.includes(target)) { found = hover; break; }
            }
        }
    }

    if (found) {
        found.click();
        await sleep(80);
        // закрываем выпадашку кликом в «пустоту»
        document.body.click();
        return true;
    }

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
        await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin]"]);
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

/* ---------- Жёсткий сброс поля перед повторным заполнением ---------- */
function clearField(field) {
    if (AFM_PROTECTED_NAMES.has(field.Name)) return;

    if (field.FieldType === "input") {
        const el = document.querySelector(`[name="${field.Name}"]`);
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
            setReactInputValue(el, "");
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            el.dispatchEvent(new Event("focus", { bubbles: true }));
        }
        return;
    }
    if (field.FieldType === "checkbox") {
        const cb = document.querySelector(`input[type="checkbox"][name="${field.Name}"]`);
        if (cb && cb.checked) {
            cb.click();
            cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
    }
    if (field.FieldType === "select") {
        const hidden = document.querySelector(`input[name="${field.Name}"]`);
        if (hidden) {
            const last = hidden.value;
            hidden.value = "";
            const tracker = hidden._valueTracker;
            if (tracker) tracker.setValue(last);
            hidden.dispatchEvent(new Event("input", { bubbles: true }));
            hidden.dispatchEvent(new Event("change", { bubbles: true }));
        }
        document.body.click();
        return;
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

/** Многопроходная заливка: с 2-го прохода предварительно очищаем поля */
async function fillFieldsWithRetries(fields, maxPasses = 3) {
    let queue = fields
        .filter(f => ["input", "select", "checkbox"].includes(f.FieldType))
        .filter(f => !AFM_PROTECTED_NAMES.has(f.Name));

    for (let pass = 1; pass <= maxPasses && queue.length; pass++) {
        const next = [];
        if (pass > 1) await new Promise(r => setTimeout(r, 120));

        for (const field of queue) {
            if (pass > 1) {
                try { clearField(field); } catch (e) { console.warn("[AFM] clearField error:", field.Name, e); }
                await new Promise(r => setTimeout(r, 40));
            }

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

function getAppIdFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("form-fm");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return "";
}

async function getAfmDocId() {
    // читаем form.form_number, НИЧЕГО в него не пишем
    let el = document.querySelector('input[name="form.form_number"]');
    if (!el || !el.value?.trim()) {
        await openAccordionByHeader("форма фм-1", ["form.form_number"]);
        await new Promise(r => setTimeout(r, 100));
        el = document.querySelector('input[name="form.form_number"]');
    }
    const v = el && typeof el.value !== 'undefined' ? String(el.value).trim() : "";
    return v || getAppIdFromUrl(); // fallback к URL, если поле скрыто/пусто
}

/* =========================
   [3] Лёгкий UI: overlay
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
    <div style="padding: 20px 28px; background: #282c34; border-radius: 12px; box-shadow: 0 8px 40px #0007;">
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
    ["pointerdown", "pointerup", "pointermove", "click", "dblclick", "contextmenu", "mousedown", "mouseup", "mousemove", "wheel", "touchstart", "touchmove", "touchend"]
        .forEach(ev => blocker.addEventListener(ev, stop, { passive: false }));
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
    console.log("[AFM] Loaded v1.6.5 (lite: retries+hard-reset + lock + overlay)");

    // Небольшая, но лёгкая кнопка
    const pulseStyle = document.createElement('style');
    pulseStyle.innerHTML = `
    .afm-pulse { position: fixed; left: 50%; top: 10%; transform: translate(-50%, 10px); z-index: 9999; }
    .afm-pulse { box-shadow: 0 0 0 0 #1976d240; transition: box-shadow .2s; }
    .afm-pulse:hover { box-shadow: 0 0 0 6px #1976d220; }
  `;
    document.head.appendChild(pulseStyle);

    const btn = document.createElement("button");
    btn.innerText = "Заполнить";
    btn.className = "afm-pulse";
    btn.style = `
    padding: 12px 26px; font-size: 16px; border: none; border-radius: 8px;
    background: #1976d2; color: #fff; cursor: pointer;
  `;
    const styleActive = 'background:#1976d2;color:#fff;cursor:pointer;';
    const styleProcess = 'background:#ffa726;color:#222;cursor:wait;';
    const styleDone = 'background:#43a047;color:#fff;cursor:pointer;';
    const styleDis = 'background:#ec4141;color:#fff;cursor:not-allowed;';


    observeAndBindActionButtons();

    // Подсказка по буферу
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

        (async () => {
            try {
                const fields = await getDataFromBuffer();
                await new Promise(r => setTimeout(r, 100));

                if (fields?.json == null) {
                    btn.disabled = false;
                    btn.innerText = "Заполнить";
                    btn.style = btn.style.cssText + styleActive;
                    hideOverlay(); unlockInteraction();
                    alert("Нет данных. Нажмите кнопку АФМ в заявке.");
                    return;
                }

                // Авто-раскрытие основных секций
                await openAccordionByHeader("форма фм-1", ["form.operation_state", "form.operation_date"]);
                await openAccordionByHeader("сведения об операции", ["operation.number", "operation.currency"]);
                await new Promise(r => setTimeout(r, 200));

                // Инициатор/бизнес-ключ
                const maybeBK = fields.json.find(f => f.Name === "businessKey")?.Value;
                if (maybeBK) AFM_STATE.businessKey = maybeBK;
                if (fields.initiator) AFM_STATE.initiator = fields.initiator;

                // 🔁 многопроходная заливка с жёстким сбросом
                let notFilled = [];
                try {
                    notFilled = await fillFieldsWithRetries(fields.json, 3);
                } catch (e) {
                    console.error("[AFM] Ошибка в ретраях, fallback legacyFillOnce:", e);
                    await legacyFillOnce(fields.json);
                    notFilled = [];
                }

                if (notFilled.length) {
                    console.warn("Не удалось заполнить поля:", notFilled.map(f => f.Name));
                }

                btn.disabled = false;
                btn.innerText = "Заполнить";
                btn.style = btn.style.cssText + styleDone;
            } catch (e) {
                console.error("[AFM] Autofill error:", e);
            } finally {
                hideOverlay();
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
        if (AFM_PROTECTED_NAMES.has(field.Name)) continue;

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
