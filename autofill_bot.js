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
// API: расширение (afm-ext / afm-ext-dev) выставляет data-afm-api-base на <html> до загрузки скрипта.
// Без расширения (Tampermonkey) — бой.
const AFM_API_BASE = (document.documentElement.dataset.afmApiBase || "https://api.quiq.kz").replace(/\/+$/, "");
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
   [PROF] Профилировщик автозаполнения
   Таблица в консоли: console.table после заполнения, данные в window.__AFM_PROF
   Отключить: localStorage.afm_prof = "0"
   ========================= */
const AFM_PROF = {
    on: (() => { try { return localStorage.getItem("afm_prof") !== "0"; } catch { return true; } })(),
    cur: null, records: [], stages: [], t0: 0, mut: 0, longMs: 0, longN: 0, _mo: null, _lo: null,
    _now: () => performance.now(),
    start() {
        if (!this.on) return;
        this.records = []; this.stages = []; this.cur = null; this.mut = 0; this.longMs = 0; this.longN = 0;
        this.t0 = this._now();
        try {
            this._mo && this._mo.disconnect();
            this._mo = new MutationObserver(m => { this.mut += m.length; });
            this._mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch { }
        try {
            this._lo && this._lo.disconnect();
            this._lo = new PerformanceObserver(l => { for (const e of l.getEntries()) { this.longMs += e.duration; this.longN++; } });
            this._lo.observe({ entryTypes: ["longtask"] });
        } catch { }
    },
    stop() {
        try { this._mo && this._mo.takeRecords(); this._mo && this._mo.disconnect(); } catch { }
        try { this._lo && this._lo.disconnect(); } catch { }
    },
    stage(name, ms) { if (this.on) this.stages.push({ stage: name, ms: Math.round(ms) }); },
    begin(field, pass) {
        if (!this.on) return;
        this.cur = {
            pass, field: field.Name, type: field.FieldType, t0: this._now(), ph: {}, sleep: 0,
            mut0: this.mut, long0: this.longMs, dom0: document.getElementsByTagName("*").length, notes: {}
        };
    },
    add(name, ms) {
        if (!this.on || !this.cur) return;
        this.cur.ph[name] = (this.cur.ph[name] || 0) + ms;
    },
    note(k, v) { if (this.on && this.cur) this.cur.notes[k] = v; },
    lapper() {
        let last = this._now();
        return (name) => { const n = this._now(); this.add(name, n - last); last = n; };
    },
    end(ok) {
        if (!this.on || !this.cur) return;
        const c = this.cur, total = this._now() - c.t0;
        const r = {
            pass: c.pass, field: c.field, type: c.type, ok: ok ? "✓" : "✗",
            total: Math.round(total), sleep: Math.round(c.sleep), work: Math.round(total - c.sleep),
            mut: this.mut - c.mut0, long: Math.round(this.longMs - c.long0),
            dom: document.getElementsByTagName("*").length, domΔ: document.getElementsByTagName("*").length - c.dom0,
        };
        for (const k of Object.keys(c.ph)) r[k] = Math.round(c.ph[k]);
        Object.assign(r, c.notes);
        this.records.push(r);
        this.cur = null;
        console.log(`[AFM-PROF] #${this.records.length} p${r.pass} ${r.ok} ${r.type} ${r.field} — ${r.total}мс (sleep ${r.sleep}, mut ${r.mut}, long ${r.long})`);
    },
    report() {
        if (!this.on) return;
        this.stop();
        const R = this.records, wall = Math.round(this._now() - this.t0);
        const sum = (a, k) => a.reduce((x, r) => x + (r[k] || 0), 0);
        const PH = ["accordion", "find", "set", "clear", "settle", "verify", "dd_open", "dd_type", "dd_find", "dd_scroll", "dd_arrow", "dd_click"];
        const rows = R.map((r, i) => {
            const o = { "#": i + 1, pass: r.pass, field: r.field, type: r.type, ok: r.ok, total: r.total, sleep: r.sleep, work: r.work };
            for (const k of PH) if (r[k] !== undefined) o[k] = r[k];
            o.scrollSteps = r.scrollSteps; o.opts = r.opts; o.domHit = r.domHit; o.via = r.via; o.noType = r.preTyped; o.skip = r.skip; o.got = r.got; o.want = r.want;
            o.mut = r.mut; o.long = r.long; o.dom = r.dom;
            return o;
        });
        console.groupCollapsed(`[AFM-PROF] Автозаполнение: ${wall}мс, полей-попыток: ${R.length}`);
        console.log("Этапы:"); console.table(this.stages);
        console.log("По полям (в порядке заполнения):"); console.table(rows);
        console.log("Топ-15 самых медленных:");
        console.table([...rows].sort((a, b) => b.total - a.total).slice(0, 15));

        const grp = (keyFn) => {
            const m = {};
            for (const r of R) {
                const k = keyFn(r), g = m[k] || (m[k] = { n: 0, total: 0, sleep: 0, work: 0, mut: 0, long: 0, fail: 0 });
                g.n++; g.total += r.total; g.sleep += r.sleep; g.work += r.work; g.mut += r.mut; g.long += r.long; if (r.ok === "✗") g.fail++;
            }
            for (const g of Object.values(m)) g.avg = Math.round(g.total / g.n);
            return m;
        };
        console.log("По типу поля:"); console.table(grp(r => r.type));
        console.log("По проходу (pass):"); console.table(grp(r => "pass " + r.pass));
        const ph = {};
        for (const k of PH) { const v = sum(R, k); if (v) ph[k] = v; }
        console.log("Суммарно по фазам, мс:"); console.table(ph);

        const fails = R.filter(r => r.ok === "✗");
        const totalMs = sum(R, "total"), sleepMs = sum(R, "sleep");
        const summary = {
            wall_ms: wall, fields_attempts: R.length, fields_ok: R.length - fails.length, fails: fails.length,
            fill_total_ms: totalMs, sleep_ms: sleepMs, sleep_pct: totalMs ? Math.round(sleepMs / totalMs * 100) : 0,
            work_ms: totalMs - sleepMs, mutations: this.mut, longtasks_n: this.longN, longtasks_ms: Math.round(this.longMs),
            retry_ms: sum(R.filter(r => r.pass > 1), "total"),
            dom_nodes_end: document.getElementsByTagName("*").length,
            cores: navigator.hardwareConcurrency, mem_gb: navigator.deviceMemory,
            ua: navigator.userAgent, url: location.pathname, ts: new Date().toISOString(),
        };
        console.log("Итог:"); console.table(summary);
        console.log("Копировать в буфер для анализа: copy(JSON.stringify(window.__AFM_PROF))");
        console.groupEnd();
        window.__AFM_PROF = { summary, stages: this.stages, records: R };
        // таблица видна сразу, не только внутри свёрнутой группы
        console.log("[AFM-PROF] ИТОГ"); console.table(summary);
        console.table([...rows].sort((a, b) => b.total - a.total).slice(0, 10));
    },
};
const psleep = async (ms) => {
    if (AFM_PROF.cur) AFM_PROF.cur.sleep += ms;
    await new Promise(r => setTimeout(r, ms));
};

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
    const _t = performance.now();
    try { return await _openAccordionByHeader(headerText, expectedFieldNames, timeout); }
    finally {
        const ms = performance.now() - _t;
        if (ms > 5) AFM_PROF.stage(`accordion «${headerText}»`, ms);
    }
}
async function _openAccordionByHeader(headerText, expectedFieldNames = [], timeout = 1500) {
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
        await new Promise(r => setTimeout(r, 30));
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
        openDelay = 80,
        step = 500,       // шаг прокрутки
        maxScrolls = 40,  // сколько шагов максимум
        findTimeout = 2000
    } = opts;

    const sleep = psleep;
    const lap = AFM_PROF.lapper();

    const opener = document.querySelector(`button[name="${CSS.escape(name)}"]`);
    AFM_PROF.note("domHit", !!opener);
    if (!opener) return false;

    // Открываем дропдаун
    opener.focus();
    opener.click();
    await sleep(openDelay);
    lap("dd_open");

    // Если есть поле фильтра — печатаем в него
    let input = opener.closest('div')?.querySelector('input[placeholder]');
    if (!input) {
        input = Array.from(document.querySelectorAll('input[placeholder]'))
            .find(i => i.offsetParent !== null);
    }
    // В фильтр печатаем только короткий ключ: для «КОД - Описание» — код, иначе первые 30 символов.
    const codeM = String(value ?? "").match(/^\s*([^\s]{1,20})\s+-(\s|$)/);
    const code = codeM ? codeM[1] : "";
    const query = code || String(value ?? "").trim().slice(0, 30);

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
    const codeLc = code.toLowerCase();
    const matchOpt = (list) =>
        list.find(btn => norm(btn.dataset?.name || btn.textContent) === target) ||
        list.find(btn => norm(btn.dataset?.name || btn.textContent).includes(target)) ||
        (codeLc && list.find(btn => {
            const t = norm(btn.dataset?.name || btn.textContent);
            return t === codeLc || t.startsWith(codeLc + " -") || t.startsWith(codeLc + " ");
        })) || null;

    // Сначала пробуем найти вариант в уже открытом списке — без ввода в фильтр
    let found = matchOpt(getVisibleOptions());
    AFM_PROF.note("preTyped", !!found);
    if (!found && input && query) {
        await realUserType(input, query, 4);
        await sleep(40);
    }
    lap("dd_type");

    const t0 = Date.now();
    AFM_PROF.note("opts", getVisibleOptions().length);
    while (Date.now() - t0 < findTimeout && !found) {
        const optsNow = getVisibleOptions();
        found = matchOpt(optsNow);
        if (found) break;
        // фильтр применён, а вариантов нет вовсе — дальше ждать нечего
        if (!optsNow.length && Date.now() - t0 > 700) break;
        await sleep(30);
    }
    lap("dd_find");

    if (!found && getVisibleOptions().length) {
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
            found = matchOpt(optsNow);
            if (found) break;

            i++;
        }
        AFM_PROF.note("scrollSteps", i);
        lap("dd_scroll");
    }

    if (!found && input && getVisibleOptions().length) {
        for (let i = 0; i < 15; i++) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await sleep(40);
            const hover = document.querySelector('[aria-selected="true"], [data-highlighted="true"]');
            if (hover) {
                const txt = norm(hover.textContent || hover.dataset?.name);
                if (txt.includes(target)) { found = hover; break; }
            }
        }
        lap("dd_arrow");
    }

    AFM_PROF.note("via", found ? (found.getAttribute?.("aria-selected") || found.dataset?.highlighted ? "arrow" : "list") : "none");
    if (found) {
        // Список мог перерисоваться (подгрузка с сервера) и клик ушёл в «протухший» элемент —
        // поэтому проверяем, что значение реально выбрано, и при необходимости кликаем заново.
        const isSelected = () => {
            const h = document.querySelector(`input[name="${CSS.escape(name)}"]`);
            if (h) return !!h.value;
            const t = norm(opener.dataset?.name || opener.textContent);
            return !!t && !t.startsWith("выберите");
        };
        let clicks = 0;
        for (; clicks < 3; clicks++) {
            found.click();
            await sleep(40);
            for (let i = 0; i < 8 && !isSelected(); i++) await sleep(25);
            if (isSelected()) break;
            const again = matchOpt(getVisibleOptions());
            if (!again) break;
            found = again;
        }
        AFM_PROF.note("clicks", clicks + 1);
        document.body.click();
        lap("dd_click");
        return isSelected();
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
        if (norm(input.value) === norm(field.Value)) return true;
        // Даты сайт показывает в своём формате (08/10/2026 18:42:14, а время у дат без времени отбрасывает):
        // сравниваем только цифры, допуская что одна запись — начало другой.
        const dRe = /^\d{2}[./]\d{2}[./]\d{4}/;
        if (dRe.test(String(input.value)) && dRe.test(String(field.Value))) {
            const a = String(input.value).replace(/\D/g, ""), b = String(field.Value).replace(/\D/g, "");
            return a.length >= 8 && (b.startsWith(a) || a.startsWith(b));
        }
        return false;
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

    // Поле само открывает свою секцию, если его нет в DOM (на повторных проходах ИИН уже не в очереди,
    // и ФИО/документ иначе остаются закрытыми).
    if (!document.querySelector(`[name="${field.Name}"]`)) {
        if (field.Name.startsWith("participants[0].full_name.")) {
            await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
            await openAccordionByHeader("участник 1", ["participants[0].participant"]);
            await openAccordionByHeader("фио", [field.Name]);
        } else if (field.Name.startsWith("participants[0].document.")) {
            await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
            await openAccordionByHeader("участник 1", ["participants[0].participant"]);
            await openAccordionByHeader("документ, удостоверяющий личность", [field.Name]);
        }
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
async function fillFieldOnce(field, pass = 1) {
    const lap = AFM_PROF.lapper();
    const emptyVal = field.Value === "" || field.Value == null;
    // Секции открываем ДО пропуска пустых: ИИН пуст, но именно он раскрывает «ФИО» и «Документ»
    await ensureSectionsForField(field);
    lap("accordion");
    // Пустое значение: если поле уже пустое или его нет в DOM — делать нечего
    if (emptyVal && field.FieldType !== "checkbox") {
        const exists = field.FieldType === "select"
            ? document.querySelector(`button[name="${CSS.escape(field.Name)}"]`)
            : document.querySelector(`[name="${field.Name}"]`);
        if (!exists || isFieldFilled(field)) { AFM_PROF.note("skip", "empty"); return true; }
    }

    if (field.FieldType === "input") {
        let el = document.querySelector(`[name="${field.Name}"]`);
        AFM_PROF.note("domHit", !!el);
        if (!el) {
            // поля может не быть вовсе (условное) — долго не ждём, на повторных проходах не ждём совсем
            const maxWait = pass > 1 ? 0 : 400;
            const start = Date.now();
            while (!el && Date.now() - start < maxWait) {
                await psleep(50);
                el = document.querySelector(`[name="${field.Name}"]`);
            }
        }
        lap("find");
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) setReactInputValue(el, field.Value);
        lap("set");
    } else if (field.FieldType === "select") {
        await selectDropdownUniversal(field.Name, field.Value);
        lap("dd_other");
    } else if (field.FieldType === "checkbox") {
        setReactCheckbox(field.Name, field.Value);
        lap("set");
    }

    // вместо фиксированных 60 мс: проверяем сразу и ждём только если не встало
    let ok = isFieldFilled(field);
    const present = field.FieldType === "select"
        ? document.querySelector(`button[name="${CSS.escape(field.Name)}"]`)
        : document.querySelector(`[name="${field.Name}"]`);
    // Если элемента нет в DOM — ждать проверку бессмысленно
    for (let i = 0; !ok && present && i < 6; i++) {
        await psleep(25);
        ok = isFieldFilled(field);
    }
    lap("settle");
    if (!ok) {
        try {
            const el = field.FieldType === "select"
                ? (document.querySelector(`input[name="${field.Name}"]`) || document.querySelector(`button[name="${field.Name}"]`))
                : document.querySelector(`[name="${field.Name}"]`);
            AFM_PROF.note("got", el ? String(el.value || el.dataset?.name || el.textContent || "").slice(0, 60) : "<нет элемента>");
            AFM_PROF.note("want", String(field.Value ?? "").slice(0, 60));
        } catch { }
    }
    return ok;
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
    const _tFill = performance.now();

    for (let pass = 1; pass <= maxPasses && queue.length; pass++) {
        const next = [];
        if (pass > 1) await new Promise(r => setTimeout(r, 120));

        for (const field of queue) {
            AFM_PROF.begin(field, pass);
            if (pass > 1) {
                const lapC = AFM_PROF.lapper();
                try { await clearField(field); } catch (e) { console.warn("[AFM] clearField error:", field.Name, e); }
                await psleep(40);
                lapC("clear");
            }

            const ok = await fillFieldOnce(field, pass);
            AFM_PROF.end(ok);
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
    AFM_PROF.stage("fillFieldsWithRetries (всего)", performance.now() - _tFill);
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
function readStoredValue(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function decodeJwt(token) {
    try {
        const part = (token.split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/");
        const json = decodeURIComponent(atob(part).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
        return JSON.parse(json);
    } catch { return null; }
}

// org_id лежит в payload JWT из localStorage.access_token (claim organization_id).
function readOrgId() {
    const claims = decodeJwt(readStoredValue("access_token")) || {};
    const key = Object.keys(claims).find(k => /(^|[/:._-])(organization_id|org_id|organizationid|orgid)$/i.test(k));
    if (key && claims[key] != null) return String(claims[key]);
    console.warn("[AFM] organization_id не найден в JWT, claims:", Object.keys(claims));
    return "";
}

function afmStatusHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = readStoredValue("access_token");
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function showOrgMismatchModal() {
    document.getElementById("afm-org-mismatch")?.remove();
    const root = document.createElement("div");
    root.id = "afm-org-mismatch";
    root.style.cssText = "position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);";
    root.innerHTML = `
        <div style="max-width:420px;padding:22px;border-radius:14px;background:#1f2937;color:#fff;font-family:sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);">
            <div style="font-size:18px;font-weight:700;margin-bottom:10px;">Выбран некорректный ЭЦП</div>
            <div style="font-size:14px;line-height:1.45;">ЭЦП не соответствует вашей организации, статус заявки не обновлён.
            Выберите корректный ЭЦП и повторите действие.</div>
            <div style="text-align:right;margin-top:16px;">
                <button style="padding:9px 18px;border:none;border-radius:10px;background:#ef4444;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Закрыть</button>
            </div>
        </div>`;
    root.addEventListener("click", e => {
        if (e.target === root || e.target.tagName === "BUTTON") root.remove();
    });
    document.body.appendChild(root);
}

// Плашка с ошибкой отправки статуса. Показывает, на какой API ушёл запрос (бой/dev).
function showAfmError(title, detail = "") {
    try {
        document.getElementById("afm-status-error")?.remove();
        const host = (() => { try { return new URL(AFM_API_BASE).host; } catch { return AFM_API_BASE; } })();
        const root = document.createElement("div");
        root.id = "afm-status-error";
        root.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100003;max-width:min(560px,94vw);padding:14px 16px;border-radius:12px;background:#7f1d1d;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:pointer;";
        const esc = t => String(t ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
        root.innerHTML = `<div style="font-weight:700;margin-bottom:4px;">${esc(title)}</div>`
            + (detail ? `<div style="opacity:.92;word-break:break-word;">${esc(detail)}</div>` : "")
            + `<div style="opacity:.7;font-size:12px;margin-top:6px;">API: ${esc(host)} · нажмите, чтобы закрыть</div>`;
        root.addEventListener("click", () => root.remove());
        document.body.appendChild(root);
        setTimeout(() => root.remove(), 15000);
    } catch { }
}

// Предпроверка: сначала шлём статус в наш API, и только если ЭЦП подходит —
// пропускаем клик к обработчику сайта. При "org mismatch" клик гасится.
// Сетевые сбои проверку не блокируют (как и раньше, только пишем в консоль).
async function sendAfmStatus(statusValue) {
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
        saveUserIp: "", subscribeUserIp: "", status: statusValue,
        org_id: readOrgId()
    };
    console.log("[AFM] afmStatus payload", payload);
    const what = statusValue === 2 ? "сохранения" : "подписи/отправки";
    if (!payload.requestId) {
        showAfmError(`Статус ${what} не отправлен`, "Не найден номер заявки на странице. Проверьте, что форма заполнена и номер операции указан.");
    }
    try {
        const resp = await fetch(`${AFM_API_BASE}/Application/afmStatus`, {
            method: 'POST', headers: afmStatusHeaders(), body: JSON.stringify(payload)
        });
        let body = null;
        try { body = await resp.json(); } catch { }
        if (body && body.code === "org mismatch") return false;
        if (!resp.ok) {
            const msg = typeof body === "string" ? body : (body?.message || body?.title || "");
            showAfmError(`Статус ${what} не отправлен (HTTP ${resp.status})`, msg);
            throw new Error('Network response was not ok: ' + resp.status);
        }
        // Бэкенд отвечает 200 и строкой: "updated" — успех, остальное ("not found", "error", ...) — ошибка.
        if (typeof body === "string" && body !== "updated") {
            showAfmError(`Статус ${what} не обновлён`, `Ответ сервера: ${body}`);
        }
    } catch (err) {
        console.error('Ошибка запроса:', err);
        if (!document.getElementById("afm-status-error")) {
            showAfmError(`Статус ${what} не отправлен`, err?.message || String(err));
        }
    }
    return true;
}

function bindActionButtonOnce(btn, statusValue) {
    if (!btn || btn.hasAttribute('afm-listener')) return;
    btn.setAttribute('afm-listener', '1');

    let passThrough = false;
    let busy = false;
    // capture + stopImmediatePropagation: наш обработчик идёт раньше обработчиков сайта.
    btn.addEventListener('click', async (e) => {
        if (passThrough) { passThrough = false; return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (busy) return;
        busy = true;
        try {
            const ok = await sendAfmStatus(statusValue);
            if (!ok) { showOrgMismatchModal(); return; }
            passThrough = true;
            btn.click();
            passThrough = false;
        } finally { busy = false; }
    }, true);
}
// Нормализация подписи кнопки: нижний регистр, ё→е, неразрывные пробелы,
// схлопывание пробелов и удаление пунктуации. «Отправить в АФМ», «ОТПРАВИТЬ  В АФМ»,
// «Отправить в АФМ РК» и т.п. приводятся к одному виду.
function normAfmLabel(s) {
    return (s || "")
        .replace(/ /g, " ")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function isSubmitToAfmLabel(text) {
    const t = normAfmLabel(text);
    if (!t) return false;
    // Основной вариант: есть и «отправить», и «афм» (в любом регистре и порядке слов).
    if (t.includes("отправ") && t.includes("афм")) return true;
    // Запасной вариант: кнопка подписана просто «Отправить».
    return t === "отправить" || t === "отправка";
}

// Кнопка «Подписать» (точная подпись, чтобы не зацепить заголовки и ссылки с этим словом).
function isSignLabel(text) {
    const t = normAfmLabel(text);
    return t === "подписать" || t.startsWith("подписать ");
}

function findSubmitToAfmButtons() {
    const selector = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
    return Array.from(document.querySelectorAll(selector)).filter(el => {
        const label = el.tagName === "INPUT"
            ? el.value
            : (el.innerText || el.textContent);
        return isSubmitToAfmLabel(label) || isSignLabel(label)
            || isSubmitToAfmLabel(el.getAttribute("aria-label")) || isSignLabel(el.getAttribute("aria-label"))
            || isSubmitToAfmLabel(el.getAttribute("title")) || isSignLabel(el.getAttribute("title"));
    });
}

function observeAndBindActionButtons() {
    const tryBindNow = () => {
        bindActionButtonOnce(document.querySelector('button[name="save"]'), 2);
        // Статус «подписан» ставим по кнопкам «Отправить в АФМ» и «Подписать».
        findSubmitToAfmButtons().forEach(btn => bindActionButtonOnce(btn, 3));
    };
    tryBindNow();
    const observer = new MutationObserver(() => tryBindNow());
    observer.observe(document.body, { childList: true, subtree: true });
}

/* ==================================================
   [4.1] Блокировка удаления уже отправленной заявки
   ================================================== */
// Статус читаем со страницы websfm: если заявка уже ушла в АФМ — удалять нельзя.
// Разблокировать удаление может только админ, введя PIN (действует 15 минут).
const AFM_ADMIN_PIN = "9090";
const AFM_ADMIN_UNLOCK_KEY = "afm_admin_unlock_until";
const AFM_ADMIN_UNLOCK_MS = 1 * 60 * 1000;
// Подписи статуса, при которых заявка считается отправленной.
const AFM_SENT_STATUS_RE = /(отправлен|подписан|зарегистрирован|принят|на рассмотрении)/;

function isAdminUnlocked() {
    try {
        const until = Number(localStorage.getItem(AFM_ADMIN_UNLOCK_KEY) || 0);
        return Number.isFinite(until) && Date.now() < until;
    } catch { return false; }
}

function unlockAdmin() {
    try { localStorage.setItem(AFM_ADMIN_UNLOCK_KEY, String(Date.now() + AFM_ADMIN_UNLOCK_MS)); } catch { }
}

// Текст статуса заявки со страницы. Разметку websfm не фиксируем жёстко:
// ищем узел с подписью «Статус» и берём значение из него самого или из соседа.
function readFormStatusText() {
    const nodes = document.querySelectorAll("div, span, p, td, th, li, label, dt, dd, h1, h2, h3, h4");
    for (const el of nodes) {
        if (el.querySelector("div, span, p, td, li")) continue; // только листовые узлы
        const t = normAfmLabel(el.textContent);
        if (!t || t.length > 160) continue;
        if (!/^статус\b/.test(t)) continue;
        const inline = t.replace(/^статус\s*/, "").trim();
        if (inline) return inline;
        const sibling = el.nextElementSibling || el.parentElement?.nextElementSibling;
        const st = normAfmLabel(sibling?.textContent);
        if (st && st.length <= 160) return st;
    }
    return "";
}

function isApplicationSent() {
    return AFM_SENT_STATUS_RE.test(readFormStatusText());
}

function isDeleteLabel(text) {
    const t = normAfmLabel(text);
    if (!t || t.length > 40) return false;
    return /\bудал/.test(t) || /\bdelete\b|\bremove\b/.test(t);
}

// Кнопка удаления под курсором: сам элемент или ближайший родитель-кнопка.
function findDeleteControl(target) {
    const selector = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
    let el = target instanceof Element ? target.closest(selector) : null;
    if (!el) return null;
    const label = el.tagName === "INPUT" ? el.value : (el.innerText || el.textContent);
    const isDelete = isDeleteLabel(label)
        || isDeleteLabel(el.getAttribute("aria-label"))
        || isDeleteLabel(el.getAttribute("title"))
        || isDeleteLabel(el.getAttribute("name"))
        || isDeleteLabel(el.dataset?.action);
    return isDelete ? el : null;
}

function ensureDeleteGuardStyles() {
    if (document.getElementById("afm-delete-guard-style")) return;
    const s = document.createElement("style");
    s.id = "afm-delete-guard-style";
    s.textContent = `
        #afm-delete-guard {
            position: fixed; inset: 0; z-index: 100000; display: flex;
            align-items: center; justify-content: center;
            background: rgba(9, 12, 20, .52); backdrop-filter: blur(4px);
            font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
        }
        #afm-delete-guard .afm-dg-card {
            width: min(420px, 92vw); border-radius: 18px; padding: 20px;
            color: #fff; background: linear-gradient(135deg, rgba(127, 29, 29, .96), rgba(69, 26, 15, .96));
            border: 1px solid rgba(248, 113, 113, .5); box-shadow: 0 18px 40px rgba(0, 0, 0, .38);
        }
        #afm-delete-guard .afm-dg-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
        #afm-delete-guard .afm-dg-text { font-size: 13px; line-height: 1.45; opacity: .92; }
        #afm-delete-guard input {
            width: 100%; margin-top: 14px; padding: 10px 12px; border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, .28); background: rgba(0, 0, 0, .25);
            color: #fff; font-size: 15px; letter-spacing: 3px; box-sizing: border-box;
        }
        #afm-delete-guard .afm-dg-err { min-height: 16px; margin-top: 6px; font-size: 12px; color: #fecaca; }
        #afm-delete-guard .afm-dg-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
        #afm-delete-guard button {
            padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .24);
            background: rgba(255, 255, 255, .12); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
        }
        #afm-delete-guard button.afm-dg-primary { background: #ef4444; border-color: #ef4444; }
    `;
    document.head.appendChild(s);
}

// Окно с отказом и полем для PIN администратора.
function showDeleteBlockedModal(onUnlocked) {
    ensureDeleteGuardStyles();
    document.getElementById("afm-delete-guard")?.remove();

    const root = document.createElement("div");
    root.id = "afm-delete-guard";
    root.innerHTML = `
        <div class="afm-dg-card">
            <div class="afm-dg-title">Удаление запрещено</div>
            <div class="afm-dg-text">Заявка уже отправлена в АФМ, поэтому удалить её нельзя.
            Если удаление всё же необходимо — введите код администратора.</div>
            <input type="password" inputmode="numeric" autocomplete="off" placeholder="Код администратора">
            <div class="afm-dg-err"></div>
            <div class="afm-dg-row">
                <button data-afm-dg="cancel">Закрыть</button>
                <button class="afm-dg-primary" data-afm-dg="ok">Разблокировать</button>
            </div>
        </div>`;
    document.body.appendChild(root);

    const input = root.querySelector("input");
    const err = root.querySelector(".afm-dg-err");
    const close = () => root.remove();

    const submit = () => {
        if (input.value.trim() !== AFM_ADMIN_PIN) {
            err.textContent = "Неверный код";
            input.value = "";
            input.focus();
            return;
        }
        unlockAdmin();
        close();
        onUnlocked && onUnlocked();
    };

    root.addEventListener("click", e => {
        const act = e.target?.getAttribute?.("data-afm-dg");
        if (act === "cancel" || e.target === root) close();
        if (act === "ok") submit();
    });
    input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") submit();
        if (e.key === "Escape") close();
    });
    setTimeout(() => input.focus(), 0);
}

function installDeleteGuard() {
    let replaying = false;

    const guard = e => {
        if (replaying) return;
        if (isAdminUnlocked()) return;
        const btn = findDeleteControl(e.target);
        if (!btn) return;
        if (!isApplicationSent()) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        // Модалку показываем один раз — по клику, а не на каждом pointerdown.
        if (e.type !== "click") return;
        showDeleteBlockedModal(() => {
            // После успешного PIN повторяем исходное нажатие уже без блокировки.
            replaying = true;
            try { btn.click(); } finally { replaying = false; }
        });
    };

    ["pointerdown", "mousedown", "mouseup", "click"].forEach(type => {
        window.addEventListener(type, guard, true);
    });
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
                    title: "Скопируйте данные с Quiq.kz",
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
        // Отладка блокировки удаления: __afmStatus() — что прочитали со страницы,
        // __afmSent() — считается ли заявка отправленной, __afmAdminOff() — сбросить PIN-доступ.
        window.__afmStatus = readFormStatusText;
        window.__afmSent = isApplicationSent;
        window.__afmAdminOff = () => localStorage.removeItem(AFM_ADMIN_UNLOCK_KEY);

        observeAndBindActionButtons();
        installDeleteGuard();

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
                AFM_PROF.start();
                let _t = performance.now();
                try {
                    const fields = await getDataFromBuffer();
                    AFM_PROF.stage("getDataFromBuffer (clipboard)", performance.now() - _t);
                    await new Promise(r => setTimeout(r, 100));
                    AFM_PROF.stage("пауза после буфера (фикс.)", 100);
                    _t = performance.now();

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
                    AFM_PROF.stage("раскрытие основных секций (вкл. фикс. 200)", performance.now() - _t);

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
                    try { AFM_PROF.report(); } catch (e) { console.warn("[AFM-PROF] report error", e); }
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