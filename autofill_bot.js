// ==UserScript==
// @name         AFM sef (lite)
// @namespace    http://tampermonkey.net/
// @version      1.6.6
// @description  АФМ
// @author       AFM
// @match        https://websfm.kz/form-fm/*
// @grant        none
// ==/UserScript==

/* =========================
   [0] Глобальное состояние
   ========================= */
const AFM_STATE = { businessKey: "", initiator: "", requestId: "", afmDocId: "", operationNumber: "" };
// Поля, которые только читаем, НО НЕ меняем
const AFM_PROTECTED_NAMES = new Set(["form.form_number"]);
const AFM_BUFFER_ISSUE = { code: "unknown", detail: "" };
const AFM_FORM_NUMBER_KEYS = ["form.form_number", "form_number", "form.number"];
const AFM_OPERATION_NUMBER_KEYS = ["operation.number", "operation_number", "requestId", "request_id"];

function setBufferIssue(code, detail = "") {
    AFM_BUFFER_ISSUE.code = code;
    AFM_BUFFER_ISSUE.detail = String(detail || "");
}

function cleanTextValue(v) {
    if (v === null || v === undefined) return "";
    return String(v).trim();
}

function firstNonEmpty(...values) {
    for (const v of values) {
        const text = cleanTextValue(v);
        if (text) return text;
    }
    return "";
}

// id заявки (GUID из URL) и id опций селектов не должны попадать в AfmDocId:
// селект рендерится как button[name] + скрытый input[name], и в скрытом инпуте лежит id опции.
const AFM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLikelyFormNumber(v) {
    const text = cleanTextValue(v);
    if (!text) return false;
    if (AFM_UUID_RE.test(text)) return false;
    if (text.length > 32) return false;
    if (text === getAppIdFromUrl()) return false;
    return true;
}

/** Первый кандидат, который похож на номер формы, а не на id. */
function pickFormNumber(...values) {
    for (const v of values) {
        const text = cleanTextValue(v);
        if (isLikelyFormNumber(text)) return text;
    }
    return "";
}

function findJsonFieldValue(jsonFields, names) {
    if (!Array.isArray(jsonFields) || !jsonFields.length) return "";
    const wanted = new Set((names || []).map(n => String(n || "").trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return "";

    for (const field of jsonFields) {
        const name = cleanTextValue(field?.Name ?? field?.name).toLowerCase();
        if (!wanted.has(name)) continue;
        const value = firstNonEmpty(field?.Value, field?.value);
        if (value) return value;
    }
    return "";
}

function readByFieldNames(...names) {
    for (const name of names) {
        const value = getFieldValueByName(name);
        if (value) return value;
    }
    return "";
}

function readByFieldNamesFromDomRich(...names) {
    for (const name of names) {
        const nodes = document.querySelectorAll(`[name="${name}"]`);
        for (const el of nodes) {
            const value = firstNonEmpty(
                el?.value,
                el?.getAttribute?.("value"),
                el?.dataset?.value,
                el?.dataset?.name,
                el?.textContent
            );
            if (value) return value;
        }
    }
    return "";
}

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

const _raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

function _nativeSet(el, v = "") {
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    d && d.set ? d.set.call(el, v) : (el.value = v);
}

function _touchTracker(el, prev) {
    try { el._valueTracker && el._valueTracker.setValue(prev); } catch { }
}

async function hardClearInput(el, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        const prev = el.value;
        el.focus();
        // select all
        try { el.select(); el.setSelectionRange(0, prev.length); } catch { }
        // пустим через нативный setter
        _nativeSet(el, "");
        _touchTracker(el, prev);
        // события удаления/изменения
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // даём React примениться
        await _raf();

        if ((el.value || "") === "") return true;

        // крайний случай — имитация Backspace по выделенному
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
        await _raf();
        if ((el.value || "") === "") return true;
    }
    return (el.value || "") === "";
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

/* ---------- Определение языка интерфейса ---------- */
// Все селекторы полей и заголовки аккордеонов завязаны на русскую локаль,
// поэтому на казахской версии заполнение не находит секции — предупреждаем пользователя.
const AFM_RU_MARKERS = ["форма фм-1", "сведения об операции", "участники"];
// Буквы, которых нет в русском алфавите — надёжный признак казахской локали.
const AFM_KK_LETTERS = /[әғқңөұүһі]/;

const AFM_LANG_LABEL_RE = /^(рус|русский|ru|қаз|каз|kk|kz)\.?$/i;

/** Переключатель языка в шапке. Хэш в классе (HeaderMenu_language-toggle__xxxxx)
 *  меняется при пересборке фронта, поэтому ищем по подстроке класса, а не целиком. */
function findLanguageToggleEl() {
    const byClass = Array.from(document.querySelectorAll('[class*="language-toggle"], [class*="language"], [class*="lang-"]'))
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    const labeled = byClass.find(el => AFM_LANG_LABEL_RE.test((el.textContent || "").trim()));
    if (labeled) return labeled;
    if (byClass.length) return byClass[byClass.length - 1];

    return Array.from(document.querySelectorAll("div, span, a, button")).find(el =>
        el.offsetParent !== null
        && AFM_LANG_LABEL_RE.test((el.textContent || "").trim())
        && el.getBoundingClientRect().width > 0
    ) || null;
}

function detectUiLanguage() {
    const texts = Array.from(document.querySelectorAll("p"))
        .map(p => p.textContent.trim().toLowerCase())
        .filter(Boolean);
    if (!texts.length) return "unknown";
    if (AFM_RU_MARKERS.some(m => texts.some(t => t.includes(m)))) return "ru";
    if (texts.some(t => AFM_KK_LETTERS.test(t))) return "kk";
    return "unknown";
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

    // Хелперы
    function getScrollableParent(el) {
        let node = el;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const canScrollY = /(auto|scroll)/.test(style.overflowY);
            if (canScrollY && node.scrollHeight > node.clientHeight) return node;
            node = node.parentElement;
        }
        const pools = Array.from(document.querySelectorAll('div,ul'))
            .filter(x => x.scrollHeight > x.clientHeight && /(auto|scroll)/.test(getComputedStyle(x).overflowY))
            .sort((a, b) => b.scrollHeight - a.scrollHeight);
        return pools[0] || document.body;
    }

    function getVisibleOptions() {
        const buttons = Array.from(document.querySelectorAll(`button[name="${CSS.escape(name)}"][type="button"]`))
            .filter(b => b !== opener);
        if (!buttons.length) {
            return Array.from(document.querySelectorAll(`button[name="${CSS.escape(name)}"]`))
                .filter(b => b !== opener);
        }
        return buttons;
    }

    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(value);

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

    if (!found) {
        const probe = getVisibleOptions()[0] || input || opener;
        const scroller = getScrollableParent(probe);

        let i = 0;
        let lastScrollTop = -1;
        while (i < maxScrolls) {
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
async function clearField(field) {
    if (AFM_PROTECTED_NAMES.has(field.Name)) return;

    if (field.FieldType === "input") {
        const el = document.querySelector(`[name="${field.Name}"]`);
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
            await hardClearInput(el);
            // короткий цикл фокуса — некоторые формы коммитят только на blur
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
            await _raf();
        }
        return;
    }
    if (field.FieldType === "select") {
        const hidden = document.querySelector(`input[name="${field.Name}"]`);
        if (hidden) {
            const last = hidden.value;
            _nativeSet(hidden, "");
            _touchTracker(hidden, last);
            hidden.dispatchEvent(new Event("input", { bubbles: true }));
            hidden.dispatchEvent(new Event("change", { bubbles: true }));
            await _raf();
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

/** Многопроходная заливка: с 2-го прохода предварительно очищаем поля
 *  + UI: обновляем счётчики в модалке (заполнено/осталось/всего)
 */
async function fillFieldsWithRetries(fields, maxPasses = 3) {
    let queue = fields
        .filter(f => ["input", "select", "checkbox"].includes(f.FieldType))
        .filter(f => !AFM_PROTECTED_NAMES.has(f.Name));

    const TOTAL = queue.length;
    let doneNames = new Set();
    updateOverlayCounters({ total: TOTAL, filled: 0 }); // инициализация

    for (let pass = 1; pass <= maxPasses && queue.length; pass++) {
        const next = [];
        if (pass > 1) await new Promise(r => setTimeout(r, 120));

        for (const field of queue) {
            if (pass > 1) {
                try { await clearField(field); } catch (e) { console.warn("[AFM] clearField error:", field.Name, e); }
                await new Promise(r => setTimeout(r, 40));
            }

            const ok = await fillFieldOnce(field);
            if (!ok) {
                next.push(field);
            } else {
                doneNames.add(field.Name);
                updateOverlayCounters({ total: TOTAL, filled: doneNames.size });
            }
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
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        setBufferIssue("clipboard_unavailable", "navigator.clipboard.readText is not available");
        return null;
    }

    let clipboardText = "";
    try {
        clipboardText = await navigator.clipboard.readText();
    } catch (err) {
        const name = err?.name || "Error";
        const message = err?.message || "Clipboard read failed";
        if (name === "NotAllowedError" || name === "SecurityError" || /denied|not allowed|permission/i.test(message)) {
            setBufferIssue("clipboard_blocked", `${name}: ${message}`);
        } else {
            setBufferIssue("clipboard_error", `${name}: ${message}`);
        }
        return null;
    }

    if (!clipboardText || !clipboardText.trim()) {
        setBufferIssue("empty_clipboard", "Clipboard is empty");
        return null;
    }

    try {
        const fields = JSON.parse(clipboardText);
        if (!fields?.json || !Array.isArray(fields.json) || fields.json.length === 0) {
            setBufferIssue("missing_payload", "JSON has no fields.json payload");
            return null;
        }

        if (fields?.initiator) AFM_STATE.initiator = fields.initiator;
        if (fields?.json && Array.isArray(fields.json)) {
            const bk = findJsonFieldValue(fields.json, ["businessKey"]);
            if (bk) AFM_STATE.businessKey = bk;

            // Сбрасываем afmDocId при каждом новом JSON из буфера — иначе старый ID
            // от предыдущей формы мог бы «прилипнуть» если в новом JSON нет form_number
            AFM_STATE.afmDocId = pickFormNumber(findJsonFieldValue(fields.json, AFM_FORM_NUMBER_KEYS));

            const operationNumberFromJson = findJsonFieldValue(fields.json, AFM_OPERATION_NUMBER_KEYS);
            if (operationNumberFromJson) {
                AFM_STATE.operationNumber = operationNumberFromJson;
                AFM_STATE.requestId = operationNumberFromJson;
            }
        }
        setBufferIssue("ok", "");
        return fields;
    } catch (err) {
        const message = err?.message || "Invalid JSON";
        setBufferIssue("invalid_json", message);
        return null;
    }
}

function getAppIdFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("form-fm");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return "";
}

function getFieldValueByName(name) {
    const nodes = document.querySelectorAll(`[name="${name}"]`);
    for (const el of nodes) {
        if (typeof el.value !== "undefined") {
            const v = String(el.value).trim();
            if (v) return v;
        }
        const attrV = (el.getAttribute("value") || "").trim();
        if (attrV) return attrV;
        // Для disabled-инпутов react-hook-form не синхронизирует el.value с internal state.
        // Читаем напрямую из React fiber memoizedProps.
        const fiberKey = Object.keys(el).find(k =>
            k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
        );
        if (fiberKey) {
            const reactVal = String(el[fiberKey]?.memoizedProps?.value ?? "").trim();
            if (reactVal) return reactVal;
        }
    }
    return "";
}

async function getAfmDocId(retries = 5, delay = 120) {
    if (AFM_STATE.afmDocId) return AFM_STATE.afmDocId;

    let v = pickFormNumber(
        readByFieldNames(...AFM_FORM_NUMBER_KEYS),
        readByFieldNamesFromDomRich(...AFM_FORM_NUMBER_KEYS)
    );
    if (!v) {
        await openAccordionByHeader("форма фм-1", ["form.form_number"]);
        for (let i = 0; i < retries && !v; i++) {
            await new Promise(r => setTimeout(r, delay));
            await getDataFromBuffer();
            v = pickFormNumber(
                AFM_STATE.afmDocId,
                readByFieldNames(...AFM_FORM_NUMBER_KEYS),
                readByFieldNamesFromDomRich(...AFM_FORM_NUMBER_KEYS)
            );
        }
    }

    if (v) {
        AFM_STATE.afmDocId = v;
        return v;
    }

    // Раньше сюда падал id заявки из URL и кэшировался в AFM_STATE.afmDocId,
    // после чего все последующие чтения возвращали id вместо form_number.
    console.warn("[AFM] form_number не прочитан, AfmDocId уйдёт пустым");
    return "";
}

async function getRequestId() {
    if (AFM_STATE.operationNumber) return AFM_STATE.operationNumber;

    let v = readByFieldNames(...AFM_OPERATION_NUMBER_KEYS);
    if (!v) {
        await openAccordionByHeader("сведения об операции", ["operation.number"]);
        for (let i = 0; i < 5 && !v; i++) {
            await new Promise(r => setTimeout(r, 100));
            v = readByFieldNames(...AFM_OPERATION_NUMBER_KEYS);
        }
    }

    if (v) {
        AFM_STATE.operationNumber = v;
        AFM_STATE.requestId = v;
        return v;
    }

    const fallback = firstNonEmpty(AFM_STATE.requestId, AFM_STATE.afmDocId, getAppIdFromUrl());
    if (fallback) AFM_STATE.requestId = fallback;
    return fallback; // fallback к уже известным значениям, если поле скрыто/пусто
}

async function getRequestIdForStatus() {
    if (AFM_STATE.operationNumber) return AFM_STATE.operationNumber;
    const operationNumber = await getRequestId();
    if (operationNumber) return operationNumber;

    const formNumber = await getAfmDocId();
    if (formNumber) {
        if (!AFM_STATE.requestId) AFM_STATE.requestId = formNumber;
        return formNumber;
    }

    const urlFallback = getAppIdFromUrl();
    if (urlFallback && !AFM_STATE.requestId) AFM_STATE.requestId = urlFallback;
    return urlFallback;
}

async function waitForStatusIdentifiers(retries = 6, delay = 120) {
    let afmDocId = "";
    let operationNumber = "";

    for (let i = 0; i < retries; i++) {
        await getDataFromBuffer();

        afmDocId = pickFormNumber(
            AFM_STATE.afmDocId,
            readByFieldNames(...AFM_FORM_NUMBER_KEYS),
            readByFieldNamesFromDomRich(...AFM_FORM_NUMBER_KEYS)
        );
        operationNumber = firstNonEmpty(AFM_STATE.operationNumber, readByFieldNames(...AFM_OPERATION_NUMBER_KEYS));

        if (afmDocId && operationNumber) break;

        if (!afmDocId) {
            await openAccordionByHeader("форма фм-1", ["form.form_number"]);
        }
        if (!operationNumber) {
            await openAccordionByHeader("сведения об операции", ["operation.number"]);
        }

        await new Promise(r => setTimeout(r, delay));
    }

    afmDocId = afmDocId || await getAfmDocId(2, 80);
    operationNumber = operationNumber || await getRequestId();

    if (afmDocId) AFM_STATE.afmDocId = afmDocId;
    if (operationNumber) {
        AFM_STATE.operationNumber = operationNumber;
        AFM_STATE.requestId = operationNumber;
    }

    return { afmDocId, operationNumber };
}

async function waitForAfmDocIdBeforeSubmit(retries = 14, delay = 180) {
    let afmDocId = pickFormNumber(
        AFM_STATE.afmDocId,
        readByFieldNames(...AFM_FORM_NUMBER_KEYS),
        readByFieldNamesFromDomRich(...AFM_FORM_NUMBER_KEYS)
    );
    if (afmDocId) {
        AFM_STATE.afmDocId = afmDocId;
        return afmDocId;
    }

    for (let i = 0; i < retries; i++) {
        await getDataFromBuffer();
        await openAccordionByHeader("форма фм-1", ["form.form_number"]);
        await new Promise(r => setTimeout(r, delay));

        afmDocId = pickFormNumber(
            AFM_STATE.afmDocId,
            readByFieldNames(...AFM_FORM_NUMBER_KEYS),
            readByFieldNamesFromDomRich(...AFM_FORM_NUMBER_KEYS)
        );
        if (afmDocId) break;
    }

    if (afmDocId) {
        AFM_STATE.afmDocId = afmDocId;
        return afmDocId;
    }

    // Без фолбэка на URL: id заявки уезжает отдельным полем afmId.
    return "";
}

/* =========================
   [3]  модалка + таймер + счётчики
   ========================= */
let _afmTimerId = null;
let _afmStartTs = 0;

function ensureOverlayStyles() {
    if (document.getElementById("afm-style")) return;
    const s = document.createElement("style");
    s.id = "afm-style";
    s.textContent = `
    :root{
      --afm-overlay-bg: rgba(14,18,26,.26);
      --afm-card-grad-top:#1f2530; --afm-card-grad-bot:#1b212b;
      --afm-card-border:#2e3644; --afm-text-main:#fff; --afm-text-sub:#d0d6e2;
      --afm-accent-1:#1fd1f9; --afm-accent-2:#b621fe; --afm-spinner:#7da2ff;
    }
    #afm-loading-overlay{
      position:fixed; inset:0; background:var(--afm-overlay-bg); z-index:99999;
      display:flex; align-items:center; justify-content:center;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; color:var(--afm-text-main);
      animation:afm-fade-in .12s ease-out;
    }
    #afm-loading-overlay .afm-card{
      width:min(680px,94vw); /* больше карточка */
      background:linear-gradient(180deg,var(--afm-card-grad-top),var(--afm-card-grad-bot));
      border:1px solid var(--afm-card-border); border-radius:16px;
      padding:26px 26px; /* чуть больше отступы */
      box-shadow:0 14px 60px rgba(0,0,0,.38);
    }
    #afm-loading-overlay .afm-row{display:flex;align-items:center;gap:14px;}
    #afm-loading-overlay .afm-title{font-size:18px;font-weight:700;} /* +2px */
    #afm-loading-overlay .afm-sub{font-size:14px;color:var(--afm-text-sub);opacity:.9;margin-top:4px;} /* +1px */
    #afm-loading-overlay .afm-kpi{margin-top:12px;font-size:14px;opacity:.95;display:flex;gap:18px;flex-wrap:wrap;} /* +1px */
    #afm-loading-overlay .afm-kpi b{color:#fff;}
    #afm-loading-overlay .afm-bar{margin-top:16px;width:100%;height:10px;background:#2a3240;border-radius:999px;overflow:hidden;} /* выше и толще */
    #afm-loading-overlay .afm-bar>div{height:100%;width:0%;background:linear-gradient(90deg,var(--afm-accent-1),var(--afm-accent-2));transition:width .25s ease;}
    #afm-loading-overlay .afm-spin{width:26px;height:26px;flex:0 0 26px;border-radius:50%;border:3px solid var(--afm-spinner);border-top-color:transparent;animation:afm-rot .8s linear infinite;} /* больше спиннер */
    @keyframes afm-rot{to{transform:rotate(360deg);}}
    @keyframes afm-fade-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
  `;
    document.head.appendChild(s);
}

function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = n => (n < 10 ? "0" + n : "" + n);
    return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function showOverlay(text = "Загрузка...") {
    ensureOverlayStyles();
    if (document.getElementById("afm-loading-overlay")) return;

    _afmStartTs = Date.now();
    const overlay = document.createElement("div");
    overlay.id = "afm-loading-overlay";
    overlay.innerHTML = `
    <div class="afm-card">
      <div class="afm-row">
        <div class="afm-spin"></div>
        <div>
          <div class="afm-title">Автозаполнение формы</div>
          <div class="afm-sub" id="afm-sub">${text}</div>
        </div>
      </div>
      <div class="afm-kpi">
        <div>Время: <b id="afm-time">00:00</b></div>
        <div>Заполнено: <b id="afm-filled">0</b> из <b id="afm-total">0</b></div>
        <div>Осталось: <b id="afm-left">0</b></div>
      </div>
      <div class="afm-bar"><div id="afm-bar-inner" style="width:0%"></div></div>
    </div>
  `;
    document.body.appendChild(overlay);

    // таймер времени
    const tick = () => {
        const el = document.getElementById("afm-time");
        if (!el) return;
        el.textContent = fmt(Date.now() - _afmStartTs);
    };
    _afmTimerId = setInterval(tick, 1000);
    tick();
}

function updateOverlayCounters({ total, filled }) {
    const totalEl = document.getElementById("afm-total");
    const filledEl = document.getElementById("afm-filled");
    const leftEl = document.getElementById("afm-left");
    const bar = document.getElementById("afm-bar-inner");
    if (!totalEl || !filledEl || !leftEl || !bar) return;

    const t = Math.max(0, total | 0);
    const f = Math.min(Math.max(0, filled | 0), t);
    const left = Math.max(0, t - f);
    const pct = t === 0 ? 0 : Math.round((f / t) * 100);

    totalEl.textContent = String(t);
    filledEl.textContent = String(f);
    leftEl.textContent = String(left);
    bar.style.width = `${pct}%`;
}

function hideOverlay() {
    if (_afmTimerId) { clearInterval(_afmTimerId); _afmTimerId = null; }
    const overlay = document.getElementById("afm-loading-overlay");
    if (overlay) overlay.remove();
}

/* =========================
   [3.5] СУПЕР-блокировка взаимодействия
   ========================= */
const AFM_BLOCKER_ID = "afm-interaction-lock";
let _afm_unbinders = [];
let _afm_prevBody = null;
function lockInteraction() {
    if (document.getElementById(AFM_BLOCKER_ID)) return;

    // Сохраняем стили скролла/тача, чтобы вернуть потом
    if (!_afm_prevBody) {
        _afm_prevBody = {
            bodyOverflow: document.body.style.overflow,
            htmlOverflow: document.documentElement.style.overflow,
            userSelect: document.body.style.userSelect,
            touchAction: document.body.style.touchAction,
            overscroll: document.documentElement.style.overscrollBehavior,
        };
    }
    // Вырубаем скролл, тач и выделение
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";

    // Прокладка над всей страницей
    const blocker = document.createElement("div");
    blocker.id = AFM_BLOCKER_ID;
    blocker.style = `position: fixed; inset: 0; z-index: 99998; cursor: wait; background: transparent;`;
    const stop = e => { e.stopPropagation(); e.preventDefault(); };
    [
        "pointerdown", "pointerup", "pointermove", "click", "dblclick", "contextmenu",
        "mousedown", "mouseup", "mousemove", "wheel", "touchstart", "touchmove", "touchend",
        "dragstart", "selectstart"
    ].forEach(ev => blocker.addEventListener(ev, stop, { passive: false }));
    document.body.appendChild(blocker);

    // Клавиатура — тоже стоп
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

    // Возвращаем стили страницы
    if (_afm_prevBody) {
        document.body.style.overflow = _afm_prevBody.bodyOverflow ?? "";
        document.documentElement.style.overflow = _afm_prevBody.htmlOverflow ?? "";
        document.body.style.userSelect = _afm_prevBody.userSelect ?? "";
        document.body.style.touchAction = _afm_prevBody.touchAction ?? "";
        document.documentElement.style.overscrollBehavior = _afm_prevBody.overscroll ?? "";
        _afm_prevBody = null;
    }
}

/* ==============================================
   [4] Мониторинг и привязка кнопок save/subscribe
   ============================================== */
function bindActionButtonOnce(btn, statusValue) {
    if (!btn || btn.hasAttribute('afm-listener')) return;
    btn.setAttribute('afm-listener', '1');

    btn.addEventListener('click', async () => {
        const strictAfmDocId = await waitForAfmDocIdBeforeSubmit(18, 160);
        const ids = await waitForStatusIdentifiers(8, 140);
        let afmDocId = pickFormNumber(strictAfmDocId, ids.afmDocId);
        if (!afmDocId) afmDocId = pickFormNumber(await getAfmDocId());
        const requestId = ids.operationNumber || await getRequestIdForStatus();
        const operationNumber = firstNonEmpty(ids.operationNumber, AFM_STATE.operationNumber, requestId);
        const payload = {
            requestId: firstNonEmpty(operationNumber, AFM_STATE.requestId, afmDocId, getAppIdFromUrl()),
            // AfmDocId — только номер формы; id заявки из URL идёт отдельно в afmId.
            AfmDocId: afmDocId || "",
            afmId: getAppIdFromUrl(),
            savedByUser: statusValue === 2 ? (AFM_STATE.initiator || "") : "",
            subscribedByUser: statusValue === 3 ? (AFM_STATE.initiator || "") : "",
            saveUserIp: "", subscribeUserIp: "", status: statusValue
        };
        console.log("[AFM] afmStatus payload", payload);
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

    const isFormPage = () => /^\/form-fm\/[^/]+/.test(location.pathname);
    const tryInitAfmUi = () => {
        if (!isFormPage()) return false;
        if (!document.body) return false;
        if (document.getElementById("afm-fill-btn")) return true;
        initAfmUi();
        return true;
    };

    // SPA case: script can be loaded before /form-fm route appears.
    if (!tryInitAfmUi()) {
        const routeWatcherId = setInterval(() => {
            if (tryInitAfmUi()) clearInterval(routeWatcherId);
        }, 400);
    }

    function initAfmUi() {
        console.log("[AFM] Loaded v1.6.6 (lite: stronger lock + bigger modal)");

        // Кнопку «Заполнить» НЕ трогаю — как у тебя
        const pulseStyle = document.createElement('style');
        pulseStyle.innerHTML = `
    .afm-pulse { position: fixed; left: 50%; top: 10%; transform: translate(-50%, 10px); z-index: 9999; }
    .afm-pulse { box-shadow: 0 0 0 0 #1976d240; transition: box-shadow .2s; }
    .afm-pulse:hover { box-shadow: 0 0 0 6px #1976d220; }
  `;
        document.head.appendChild(pulseStyle);

        function ensureHintStyles() {
            if (document.getElementById("afm-hint-style")) return;
            const s = document.createElement("style");
            s.id = "afm-hint-style";
            s.textContent = `
            #afm-user-hint {
                position: fixed;
                left: 50%;
                top: calc(10% + 86px);
                transform: translateX(-50%) translateY(-6px);
                width: min(560px, 94vw);
                z-index: 10000;
                display: none;
                opacity: 0;
                transition: opacity .22s ease, transform .22s ease;
                font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
                --afm-hint-bg: linear-gradient(135deg, rgba(11, 121, 96, .92), rgba(15, 69, 139, .92));
                --afm-hint-border: rgba(130, 231, 205, .46);
                --afm-hint-badge-bg: rgba(16, 185, 129, .95);
            }
            #afm-user-hint.show {
                display: block;
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
            #afm-user-hint .afm-hint-card {
                position: relative;
                border-radius: 20px;
                border: 1px solid var(--afm-hint-border);
                background: var(--afm-hint-bg);
                color: #fff;
                padding: 14px 15px;
                box-shadow: 0 16px 36px rgba(0, 0, 0, .28);
                backdrop-filter: blur(18px) saturate(170%);
                -webkit-backdrop-filter: blur(18px) saturate(170%);
            }
            #afm-user-hint .afm-hint-arrow-up {
                width: 0;
                height: 0;
                margin: 0 auto;
                border-left: 10px solid transparent;
                border-right: 10px solid transparent;
                border-bottom: 10px solid #ef4444;
                filter: drop-shadow(0 -1px 0 rgba(248, 113, 113, .85));
            }
            #afm-user-hint .afm-hint-head {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            #afm-user-hint .afm-hint-badge {
                width: 30px;
                height: 30px;
                border-radius: 999px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 17px;
                font-weight: 700;
                color: #fff;
                background: var(--afm-hint-badge-bg);
                box-shadow: inset 0 -5px 12px rgba(0, 0, 0, .18), 0 6px 12px rgba(0, 0, 0, .18);
            }
            #afm-user-hint .afm-hint-title {
                font-size: 15px;
                font-weight: 700;
            }
            #afm-user-hint .afm-hint-text {
                margin-top: 4px;
                font-size: 13px;
                opacity: .92;
            }
            #afm-user-hint .afm-hint-img {
                display: block;
                width: 190px;
                max-width: 70%;
                margin: 10px 0 0;
                border-radius: 7px;
                border: 1px solid rgba(255, 255, 255, .28);
                box-shadow: 0 6px 14px rgba(0, 0, 0, .28);
            }
            #afm-user-hint .afm-hint-list {
                margin: 10px 0 0;
                padding: 0;
                list-style: none;
                display: grid;
                gap: 7px;
            }
            #afm-user-hint .afm-hint-list li {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                font-size: 13px;
                line-height: 1.35;
            }
            #afm-user-hint .afm-step-num {
                width: 20px;
                height: 20px;
                border-radius: 999px;
                flex: 0 0 20px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-top: 1px;
                font-size: 11px;
                font-weight: 700;
                color: #fff;
                background: rgba(255, 255, 255, .20);
            }
            #afm-user-hint.error {
                --afm-hint-border: rgba(255, 156, 156, .56);
                --afm-hint-badge-bg: rgba(235, 67, 89, .92);
            }
            #afm-user-hint.warn {
                --afm-hint-border: rgba(255, 211, 132, .58);
                --afm-hint-badge-bg: rgba(245, 158, 11, .95);
            }
            #afm-user-hint.info {
                --afm-hint-border: rgba(144, 215, 255, .56);
                --afm-hint-badge-bg: rgba(59, 130, 246, .95);
            }
            #afm-lock-guide {
                position: fixed;
                left: 10%;
                top: 10px;
                z-index: 10001;
                display: none;
                align-items: center;
                gap: 7px;
                pointer-events: none;
                font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
            }
            #afm-lock-guide .afm-lock-arrow {
                font-size: 24px;
                line-height: 1;
                color: #ef4444;
                animation: afm-lock-bounce .9s ease-in-out infinite;
                text-shadow: 0 8px 24px rgba(0, 0, 0, .42);
            }
            #afm-lock-guide .afm-lock-chip {
                max-width: min(320px, 70vw);
                padding: 6px 10px;
                border-radius: 999px;
                font-size: 12px;
                font-weight: 600;
                color: #fff1f2;
                background: rgba(127, 29, 29, .86);
                border: 1px solid rgba(248, 113, 113, .64);
                box-shadow: 0 10px 18px rgba(0, 0, 0, .25);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
            }
            @keyframes afm-lock-bounce {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-4px); }
            }

            /* Указатель на переключатель языка в шапке сайта */
            #afm-lang-pointer {
                position: fixed;
                z-index: 10002;
                display: none;
                pointer-events: none;
                font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
            }
            #afm-lang-pointer .afm-lang-ring {
                position: fixed;
                border-radius: 10px;
                border: 2px solid #ef4444;
                box-shadow: 0 0 0 4px rgba(239, 68, 68, .22), 0 0 0 9999px rgba(9, 12, 20, .45);
                animation: afm-lang-pulse 1.2s ease-in-out infinite;
            }
            #afm-lang-pointer .afm-lang-callout {
                position: fixed;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 2px;
            }
            #afm-lang-pointer .afm-lang-arrow {
                font-size: 26px;
                line-height: 1;
                color: #ef4444;
                animation: afm-lock-bounce .9s ease-in-out infinite;
                text-shadow: 0 8px 24px rgba(0, 0, 0, .42);
            }
            #afm-lang-pointer .afm-lang-chip {
                max-width: min(300px, 70vw);
                padding: 8px 12px;
                border-radius: 12px;
                font-size: 13px;
                font-weight: 600;
                line-height: 1.35;
                text-align: center;
                color: #fff1f2;
                background: rgba(127, 29, 29, .92);
                border: 1px solid rgba(248, 113, 113, .64);
                box-shadow: 0 12px 26px rgba(0, 0, 0, .34);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
            }
            @keyframes afm-lang-pulse {
                0%, 100% { box-shadow: 0 0 0 4px rgba(239, 68, 68, .22), 0 0 0 9999px rgba(9, 12, 20, .45); }
                50% { box-shadow: 0 0 0 9px rgba(239, 68, 68, .10), 0 0 0 9999px rgba(9, 12, 20, .45); }
            }
        `;
            document.head.appendChild(s);
        }

        let _afmLangPointerTimer = null;
        // После клика указатель нужно убрать: затемнение и плашка перекрывают
        // и сам переключатель, и выпадающий список с языками.
        let _afmLangPointerMutedUntil = 0;
        let _afmLangDismissBound = false;

        function isLanguagePointerMuted() {
            return Date.now() < _afmLangPointerMutedUntil;
        }

        function muteLanguagePointer(ms = 8000) {
            _afmLangPointerMutedUntil = Date.now() + ms;
            hideLanguagePointer();
            const card = document.getElementById("afm-user-hint");
            if (card) {
                card.classList.remove("show");
                card.style.zIndex = "";
            }
        }

        function bindLanguagePointerDismiss() {
            if (_afmLangDismissBound) return;
            _afmLangDismissBound = true;
            // Capture, чтобы успеть скрыться до того, как сайт отработает свой клик.
            document.addEventListener("click", () => {
                const root = document.getElementById("afm-lang-pointer");
                if (root && root.style.display !== "none") muteLanguagePointer();
            }, true);
        }

        function showLanguagePointer() {
            if (isLanguagePointerMuted()) return;
            ensureHintStyles();
            bindLanguagePointerDismiss();

            let root = document.getElementById("afm-lang-pointer");
            if (!root) {
                root = document.createElement("div");
                root.id = "afm-lang-pointer";
                root.innerHTML = `
                    <div class="afm-lang-ring"></div>
                    <div class="afm-lang-callout">
                        <div class="afm-lang-arrow">↑</div>
                        <div class="afm-lang-chip">Нажмите сюда и выберите «Рус»</div>
                    </div>
                `;
                document.body.appendChild(root);
            }

            // Шапка — часть SPA и может перерисоваться, поэтому позицию пересчитываем по таймеру.
            const place = () => {
                const target = findLanguageToggleEl();
                const rect = target?.getBoundingClientRect();
                if (!rect || !rect.width || !rect.height) {
                    root.style.display = "none";
                    return;
                }
                root.style.display = "block";

                const pad = 6;
                const ring = root.querySelector(".afm-lang-ring");
                ring.style.left = `${rect.left - pad}px`;
                ring.style.top = `${rect.top - pad}px`;
                ring.style.width = `${rect.width + pad * 2}px`;
                ring.style.height = `${rect.height + pad * 2}px`;

                const callout = root.querySelector(".afm-lang-callout");
                callout.style.top = `${rect.bottom + 10}px`;
                const width = callout.offsetWidth || 220;
                const left = Math.min(
                    Math.max(8, rect.left + rect.width / 2 - width / 2),
                    Math.max(8, window.innerWidth - width - 8)
                );
                callout.style.left = `${left}px`;
            };

            place();
            if (!_afmLangPointerTimer) _afmLangPointerTimer = setInterval(place, 400);
        }

        function hideLanguagePointer() {
            if (_afmLangPointerTimer) {
                clearInterval(_afmLangPointerTimer);
                _afmLangPointerTimer = null;
            }
            const root = document.getElementById("afm-lang-pointer");
            if (root) root.style.display = "none";
        }

        // Скриншот кнопки «Скопировать данные» с quiq.kz (инлайн, ~1.5 КБ):
        // скрипт грузится в контекст страницы и файлы расширения ему недоступны.
        const AFM_COPY_BTN_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAARAAAAA6CAMAAABPlPbDAAABR2lDQ1BJQ0MgUHJvZmlsZQAAeJx9kF8rg2EYxn+zsZkVB04UteRwNMMmZ7MiRa2hzInevZtN7c/j3SspX0E5cejMRxBy5NCBM6WUDyCnainW6342bIj76e7+dT1Xd3cXdPgMpYoeoFS2rdT8bHAtvR70PuHDTzddDBtmVcWTyUWx8Dm/V+0Ol563o3rX7/9/y5/NVU2Zb9JhU1k2uELCyV1bad4X7rfkKOFDzfkmn2jONPmi4VlJJYRvhPvMgpEVfhAOZdr0fBuXijvmxw36+kCuvLqs90gPskSEGGnGmROakhf7wz/Z8CeooNjDYos8BWyCxEVRFMkJL1DGZIyQcISwdFTn/DO/llaZgelrcB+1tMwjnN/DQE9LGzmF3g04O1CGZXyl6qp5qpsTkSYHLOh8cZznIfBeQt1ynNdjx6lLhm7Zd7X9DlXbWxhCHvNtAAAAYFBMVEX////+/v79/v39/f37/fv7/Pv6+vr5/Pn5+fn4+Pj3+Pf29vby9/Ly8/Ls7Ozk7uTn6OfZ4NnV1dW61rqyurKpqamIuIhjo2NUmlVCj0MrgiwifCIRchIHbQgHbAgGbAenvPXHAAAD4klEQVR42u2ba5OjKhCGdVaj0SghuCAXx///L5cGQbxkdqYq2VOnoD/MEHyB5gEbTDDLkiVLluxVlkdpX9D4FaU9YaJxlNoukRn0+dcZEeBxqa8NWBuJmc5e68sZEeBRP8bPOTr7HB/1CRHgQSLEYZAQILIHUl7acY7UxvZS5ocJcu0+YwXy2V33U0QDafo5WuubEyBtzEDaI5BLe48XyL29JCAJyE+BdDED6RKQBCQBSUD+OZBJcGkTy2f7X3LlPlsLFC7X17ERr7liCiuY5uBaWPdGvWkkbM+X2fr0ciCs10IsdApRaIoU8DTIOpfLXGV8Fpl5UKSZFiKoHlHDYRULEBaYWc97o1euAjIPeNs2dTWvat2eqZOv7c2Vbs8XlTpT+BpfD4RlhMsRd9ICmYYPZjwdILfhIGBg1DsoKgOE6ExS0K1YZBSybUfGrBmgp6a0/sOPQNBS86r+JhBqnOKvB6I6AvNOQpsAhObMfdQXMTlxkOByEev0bSu2iqm3FxG9KYfdJA5AHkvNgfp7QMZ3xZDRejMzZvqoR9I42il/de/g+MErDwQuhuLFUwwXVUO5c/wJkIF4IF79HwOhtzWNqIkOMFrLzan0/bNzUGkSHshE0FYsMialoDcTfHI5IbIDwjkXyrdIViBezbJRizgz7VFI8oIGRS0Q3Yw29Xog4ZghlCOkZhdel8QOCNUKAwQTQm4F24qXaEfk0ltaqQ2QvKqKrGeuRTOTLBCvZlkFVpr2CpOGYfJFw6D6hhhCUQCkYOJmhhQPS1azByJgDbJAKKVM7MRaoZTiEE5kTkwwPdwykpTCfWHhgazqr24ZKBrOkDcsuzS3exA62KFmpgdu3oBHWwfNJF9jyLwTC7d0ypkWegqRjhxjiFgo6QV5dEBW9ZcxBEi8N4ZIs3DO8ub6SBoB3tgGBzRtHSSNPAAJxQ7Ih5qxQUELeQDiQ+2YSQdkVX8JRBd9MxDYZQk9x7Fa+qgQJGkFuUPFdyNmg+4WSCg2YXCkt8H5vMyGMKgybAPVLAiy4ZPKQP0UyFJ02YeYaMvftVPNTRS0feS52WzB/vXB98sgnk6ABGIT7UpEp9ltQfAjBAKXO7KEEOL9pIH6GRBXNAyq+L3PMt/I/VEVfzMyrMtTetpNQI7GxT6Rvg9JXxAlIAlIApKA/L+BpJ8yE5AE5CdAyvYe75Gqe3t6gojHCoSfnSDSZ8yGWI9lDsczZvpYZt3dBxHjwV0x3Lu6PDm42/aY/I7QCD7eMeZod931d/yIzvC97+rzw+6XtusjtA7W3CevQ5R1fY3M6vrJ6yHpBaL0itnfXjFLluzE/gDQbBSeUN6mywAAAABJRU5ErkJggg==";

        function getHintForIssue(issueCode) {
            if (issueCode === "kk_language") {
                return {
                    tone: "warn",
                    target: "language-toggle",
                    title: "Сайт на казахском",
                    steps: [
                        "Нажмите подсвеченный переключатель — «Рус»"
                    ]
                };
            }
            if (issueCode === "clipboard_blocked") {
                return {
                    tone: "warn",
                    target: "browser-lock",
                    title: "Нет доступа к буферу обмена",
                    steps: [
                        "Нажмите замок слева от адреса",
                        "«Буфер обмена» → «Разрешить»",
                        "Обновите страницу"
                    ]
                };
            }
            if (issueCode === "empty_clipboard" || issueCode === "missing_payload") {
                return {
                    tone: "error",
                    target: "button",
                    title: "Данные заявки не скопированы",
                    image: AFM_COPY_BTN_IMG,
                    steps: [
                        "Нажмите эту кнопку в заявке на quiq.kz",
                        "Вернитесь сюда и нажмите «Заполнить»"
                    ]
                };
            }
            if (issueCode === "invalid_json") {
                return {
                    tone: "error",
                    target: "button",
                    title: "Скопировано не то",
                    image: AFM_COPY_BTN_IMG,
                    steps: [
                        "Нажмите эту кнопку в заявке на quiq.kz",
                        "Вернитесь сюда и нажмите «Заполнить»"
                    ]
                };
            }
            if (issueCode === "clipboard_unavailable" || issueCode === "clipboard_error") {
                return {
                    tone: "info",
                    target: "button",
                    title: "Не читается буфер обмена",
                    steps: [
                        "Обновите страницу",
                        "Проверьте разрешение «Буфер обмена»"
                    ]
                };
            }
            return null;
        }

        function showHintForIssue(issueCode) {
            const hint = getHintForIssue(issueCode);
            if (!hint) return;
            ensureHintStyles();

            let root = document.getElementById("afm-user-hint");
            if (!root) {
                root = document.createElement("div");
                root.id = "afm-user-hint";
                document.body.appendChild(root);
            }

            let lockGuide = document.getElementById("afm-lock-guide");
            if (!lockGuide) {
                lockGuide = document.createElement("div");
                lockGuide.id = "afm-lock-guide";
                document.body.appendChild(lockGuide);
            }

            const stepsHtml = (hint.steps || []).map((step, idx) => `
                <li>
                    <span class="afm-step-num">${idx + 1}</span>
                    <span>${step}</span>
                </li>
            `).join("");

            root.className = `${hint.tone} show`;
            root.style.display = "";
            root.innerHTML = `
            <div class="afm-hint-arrow-up"></div>
            <div class="afm-hint-card">
                <div class="afm-hint-head">
                    <div class="afm-hint-badge">i</div>
                    <div>
                        <div class="afm-hint-title">${hint.title}</div>
                        ${hint.text ? `<div class="afm-hint-text">${hint.text}</div>` : ""}
                    </div>
                </div>
                ${hint.image ? `<img class="afm-hint-img" src="${hint.image}" alt="Кнопка «Скопировать данные»">` : ""}
                ${stepsHtml ? `<ol class="afm-hint-list">${stepsHtml}</ol>` : ""}
            </div>
        `;
            if (hint.target === "browser-lock") {
                lockGuide.innerHTML = `
                    <div class="afm-lock-arrow">↑</div>
                    <div class="afm-lock-chip">Замок → «Буфер обмена» → «Разрешить»</div>
                `;
                lockGuide.style.display = "flex";
            } else {
                lockGuide.style.display = "none";
            }

            if (hint.target === "language-toggle") {
                // Затемнение рисует сам указатель, поэтому карточку с шагами поднимаем над ним.
                root.style.zIndex = "10003";
                showLanguagePointer();
            } else {
                root.style.zIndex = "";
                hideLanguagePointer();
            }
        }

        function hideHint() {
            const root = document.getElementById("afm-user-hint");
            if (root) {
                root.classList.remove("show");
                root.style.zIndex = "";
            }
            const lockGuide = document.getElementById("afm-lock-guide");
            if (lockGuide) lockGuide.style.display = "none";
            hideLanguagePointer();
        }

        const btn = document.createElement("button");
        btn.id = "afm-fill-btn";
        btn.innerText = "Заполнить";
        btn.className = "afm-pulse";
        const baseBtnStyle = `
    padding: 12px 26px; font-size: 16px; border: none; border-radius: 8px;
        background: #1976d2; color: #fff;
  `;
        btn.style = baseBtnStyle;
        const styleActive = 'background:#1976d2;color:#fff;cursor:pointer;';
        const styleProcess = 'background:#ffa726;color:#222;cursor:wait;';
        const styleDone = 'background:#43a047;color:#fff;cursor:pointer;';
        const styleDis = 'background:#ec4141;color:#fff;cursor:not-allowed;';

        function setButtonState(mode, text) {
            const map = {
                active: { disabled: false, style: styleActive, text: "Заполнить" },
                process: { disabled: true, style: styleProcess, text: "Заполняется..." },
                done: { disabled: false, style: styleDone, text: "Заполнить" },
                disabled: { disabled: true, style: styleDis, text: "Нет данных" }
            };
            const cfg = map[mode] || map.active;
            btn.disabled = cfg.disabled;
            btn.innerText = text || cfg.text;
            btn.style.cssText = baseBtnStyle + cfg.style;
        }

        // Для проверки подсказок из консоли:
        // __afmHint("missing_payload") / "invalid_json" / "kk_language" / "clipboard_blocked"
        window.__afmHint = showHintForIssue;
        window.__afmHintOff = hideHint;

        observeAndBindActionButtons();

        // Подсказка по языку и буферу
        setInterval(async () => {
            // Казахская локаль важнее проблем с буфером: без русского не сработает ничего.
            if (detectUiLanguage() === "kk") {
                setButtonState("disabled", "Переключите язык на русский");
                // Пока пользователь возится с переключателем — не мешаем ему подсказкой.
                if (!isLanguagePointerMuted()) showHintForIssue("kk_language");
                return;
            }

            const fields = await getDataFromBuffer();
            if (fields == null) {
                setButtonState("disabled", "Данные не скопированы");
                showHintForIssue(AFM_BUFFER_ISSUE.code);
            } else {
                setButtonState("active", "Заполнить");
                hideHint();
            }
        }, 1500);

        btn.onclick = async () => {
            if (detectUiLanguage() === "kk") {
                setButtonState("disabled", "Переключите язык на русский");
                // Нажали «Заполнить» — значит подсказка нужна прямо сейчас, снимаем паузу.
                _afmLangPointerMutedUntil = 0;
                showHintForIssue("kk_language");
                return;
            }

            setButtonState("process", "Заполняется...");
            hideHint();
            showOverlay("Идёт автозаполнение формы. Пожалуйста, не кликайте и не используйте клавиатуру.");
            lockInteraction();

            (async () => {
                try {
                    const fields = await getDataFromBuffer();
                    await new Promise(r => setTimeout(r, 100));

                    if (fields?.json == null) {
                        setButtonState("active", "Заполнить");
                        showHintForIssue(AFM_BUFFER_ISSUE.code);
                        hideOverlay(); unlockInteraction();
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

                    // 🔁 многопроходная заливка с жёстким сбросом (+ счётчики)
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

                    setButtonState("done", "Заполнить");
                } catch (e) {
                    console.error("[AFM] Autofill error:", e);
                    setButtonState("active", "Заполнить");
                } finally {
                    hideOverlay();
                    unlockInteraction();
                }
            })();

            await new Promise(r => setTimeout(r, 50));
        };

        document.body.appendChild(btn);
    }
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