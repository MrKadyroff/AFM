// ==UserScript==
// @name         AFM
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Заполняет форму AFM корректно для React-порталов, стабильно!
// @author       Ecash
// @match        https://websfm.kz/form-fm/*
// @grant        none
// ==/UserScript==

// Универсальное ожидание элемента
async function waitForElement(selector, timeout = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        let el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 80));
    }
    return null;
}

// Открыть аккордеон по заголовку (если закрыт)
async function openAccordionByHeader(headerText, expectedFieldNames = [], timeout = 100) {
    console.log("accc", headerText);
    let p = Array.from(document.querySelectorAll('p'))
        .find(e => e.textContent.trim().toLowerCase().includes(headerText.trim().toLowerCase()));
    if (!p) return false;
    let headerDiv = p.closest('div');
    if (!headerDiv) return false;

    // Клик только если закрыт (по стрелке вниз)
    if (!headerDiv.parentElement?.innerHTML.includes('M10L12')) {
        headerDiv.click();
        await new Promise(r => setTimeout(r, 100));
    }

    // Ждем появления хотя бы одного поля (можно расширить на вложенные)
    const start = Date.now();
    while (Date.now() - start < timeout) {
        let appeared = expectedFieldNames.some(name => document.querySelector(`[name="${name}"]`));
        if (appeared) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

async function realUserType(input, text, delay = 10) {
    input.focus();

    // Начало композиции (IME, как будто ввод с клавиатуры)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (let i = 0; i < text.length; i++) {
        let char = text[i];

        // Keyboard events
        input.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: char, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: char, bubbles: true }));

        // Меняем value через prototype setter (чуть более "нативно", чем напрямую)
        let nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeInputValueSetter.call(input, input.value + char);

        // Input event
        input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));

        input.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: char, bubbles: true }));

        await new Promise(r => setTimeout(r, delay));
    }

    // Завершение композиции (IME)
    input.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));

    // Paste (на всякий, если слушают ClipboardEvent)
    let dt = new DataTransfer();
    dt.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true
    }));

    // Бросаем input "change" на всякий
    input.dispatchEvent(new Event("change", { bubbles: true }));
}


// Реакт-инпут, работает всегда
function setReactInputValue(el, value) {
    const lastValue = el.value;
    el.value = value;
    let tracker = el._valueTracker;
    if (tracker) tracker.setValue(lastValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Симуляция медленного набора
async function typeTextSlowly(input, text, delay = 10) {
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let char of text) {
        input.value += char;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, delay));
    }
}

// тут заполнение select ов
async function selectDropdownUniversal(name, value) {
    let opener = document.querySelector(`button[name="${name}"]`);
    if (!opener) return false;
    opener.focus();
    opener.click();
    await new Promise(r => setTimeout(r, 100));

    // Ищем input для поиска
    let input = null;
    let parentDiv = opener.closest('div');
    if (parentDiv) {
        input = parentDiv.querySelector('input[placeholder]');
    }
    if (!input) {
        input = Array.from(document.querySelectorAll('input[placeholder]')).find(i => i.offsetParent !== null);
    }
    if (input) {
        await realUserType(input, value, 20);
        await new Promise(r => setTimeout(r, 20));
    }

    // Ждём появления и кликаем опцию
    let found = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
        let opts = Array.from(document.querySelectorAll(`button[name="${name}"][type="button"]`));
        found = opts.find(btn => {
            if (btn.dataset && btn.dataset.name) {
                return btn.dataset.name.toLowerCase().includes(value.toLowerCase());
            }
            return btn.textContent.trim().toLowerCase().includes(value.toLowerCase());
        });
        if (found) break;
        await new Promise(r => setTimeout(r, 100));
    }
    if (found) {
        found.click();
        await new Promise(r => setTimeout(r, 100));
        document.body.click();
        return true;
    }
    return false;
}

// Реакт-чекбокс
function setReactCheckbox(name, checked = true) {
    const cb = document.querySelector(`input[type="checkbox"][name="${name}"]`);
    if (cb) {
        if (cb.checked !== checked) cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    return false;
}

async function getDataFromBuffer() {
    try {
        const clipboardText = await navigator.clipboard.readText();
        const fields = JSON.parse(clipboardText);
        console.log("data", fields);
        return fields;
    } catch (err) {
        return null; // Чтобы не получить undefined
    }
}

function showOverlay(text = "Загрузка...") {
    // Если уже есть — не добавляем второй раз
    if (document.getElementById("afm-loading-overlay")) return;

    let overlay = document.createElement("div");
    overlay.id = "afm-loading-overlay";
    overlay.style = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.35);
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2rem;
        color: white;
        font-family: inherit;
        transition: opacity 0.2s;
    `;
    overlay.innerHTML = `
        <div style="padding: 32px 48px; background: #282c34; border-radius: 16px; box-shadow: 0 8px 40px #0007;">
            <span style="display:inline-block; margin-right:18px; vertical-align:middle;">
                <svg style="vertical-align:middle;" width="40" height="40" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" stroke="#53e3a6" stroke-width="5" fill="none" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" repeatCount="indefinite" dur="1s" from="0 25 25" to="360 25 25"/></circle></svg>
            </span>
            <span>${text}</span>
        </div>
    `;
    document.body.appendChild(overlay);
}

function hideOverlay() {
    let overlay = document.getElementById("afm-loading-overlay");
    if (overlay) overlay.remove();
}

(function () {
    'use strict';

    let btn = document.createElement("button");
    btn.innerText = "Заполнить";
    btn.style = `position:fixed;top:60px;right:20px;z-index:9999;padding:10px 24px;font-size:18px;
    border:none; border-radius:8px; background:#1976d2; color:#fff;
    transition: background 0.2s;
    cursor:pointer;`;
    const styleActive = 'background:#1976d2;color:#fff;cursor:pointer;';
    const styleProcess = 'background:#ffa726;color:#222;cursor:wait;';
    const styleDone = 'background:#43a047;color:#fff;cursor:pointer;';
    const styleDis = 'background:#ec4141;color:#fff;cursor:pointer;';


    setInterval(async () => {
        const fields = await getDataFromBuffer();
        if (fields == null) {
            btn.disabled = true;
            btn.innerText = "Нет данных для заполнения hola";
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
        showOverlay("Автозаполнение...");

        (async () => {
            const fields = await getDataFromBuffer();
            await new Promise(r => setTimeout(r, 100));
            if (fields == null) {
                btn.disabled = false;
                btn.innerText = "Заполнить";
                btn.style = btn.style.cssText + styleActive;
                hideOverlay();
                alert("Нет данных сделки");

                return;

            }
            await openAccordionByHeader("форма фм-1", ["form.operation_state", "form.operation_date"]);
            await openAccordionByHeader("сведения об операции", ["operation.number", "operation.currency"]);
            //await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
            await new Promise(r => setTimeout(r, 200));
            for (const field of fields) {
                if (field.Name == "operation.address.house_number") {
                    await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
                    await openAccordionByHeader("участник 1", ["participants[0].participant"]);
                    await openAccordionByHeader("банк участника операции", ["participants[0].participant_subaccount"]);
                    await openAccordionByHeader("юридический адрес", ["participants[0].legal_address.country"]);
                    await openAccordionByHeader("фактический адрес", ["participants[0].address.country"]);

                }
                if (field.Name == "participants[0].birthday") {
                    await openAccordionByHeader("фио", ["participants[0].full_name.last_name"]);
                    await openAccordionByHeader("документ, удостоверяющий личность", ["participants[0].document.type_document"]);
                }

                if (field.FieldType == "input") {
                    const el = document.querySelector(`[name="${field.Name}"]`);
                    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
                        setReactInputValue(el, field.Value);
                        continue;
                    }

                }
                if (field.FieldType == "select") {
                    await selectDropdownUniversal(field.Name, field.Value);
                    continue;
                }
                if (field.FieldType == "checkbox") {
                    setReactCheckbox(field.Name, field.Value);
                    continue;
                }
            }
            btn.disabled = false;
            btn.style = btn.style.cssText + styleDone;
            btn.innerText = "Заполнить";
            hideOverlay();
        })();
        await new Promise(r => setTimeout(r, 200));



    };

    document.body.appendChild(btn);
})();
