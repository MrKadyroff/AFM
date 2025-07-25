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
async function waitForElement(selector, timeout = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        let el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
}

// Открыть аккордеон по заголовку (если закрыт)
async function openAccordionByHeader(headerText, expectedFieldNames = [], timeout = 50) {
    let p = Array.from(document.querySelectorAll('p'))
        .find(e => e.textContent.trim().toLowerCase().includes(headerText.trim().toLowerCase()));
    if (!p) return false;
    let headerDiv = p.closest('div');
    if (!headerDiv) return false;

    // Клик только если закрыт (по стрелке вниз)
    if (!headerDiv.parentElement?.innerHTML.includes('M10L12')) {
        headerDiv.click();
        await new Promise(r => setTimeout(r, 50));
    }

    // Ждем появления хотя бы одного поля (можно расширить на вложенные)
    const start = Date.now();
    while (Date.now() - start < timeout) {
        let appeared = expectedFieldNames.some(name => document.querySelector(`[name="${name}"]`));
        if (appeared) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

async function realUserType(input, text, delay = 10) {
    input.focus();

    // Начало композиции (IME, как будто ввод с клавиатуры)
    input.dispatchEvent(new CompositionEvent('compositionstart', {
        bubbles: true
    }));

    for (let i = 0; i < text.length; i++) {
        let char = text[i];

        // Keyboard events
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: char,
            code: char,
            bubbles: true
        }));
        input.dispatchEvent(new KeyboardEvent('keypress', {
            key: char,
            code: char,
            bubbles: true
        }));

        // Меняем value через prototype setter (чуть более "нативно", чем напрямую)
        let nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeInputValueSetter.call(input, input.value + char);

        // Input event
        input.dispatchEvent(new InputEvent('input', {
            data: char,
            inputType: 'insertText',
            bubbles: true
        }));

        input.dispatchEvent(new KeyboardEvent('keyup', {
            key: char,
            code: char,
            bubbles: true
        }));

        await new Promise(r => setTimeout(r, delay));
    }

    // Завершение композиции (IME)
    input.dispatchEvent(new CompositionEvent('compositionend', {
        data: text,
        bubbles: true
    }));

    // Paste (на всякий, если слушают ClipboardEvent)
    let dt = new DataTransfer();
    dt.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true
    }));

    // Бросаем input "change" на всякий
    input.dispatchEvent(new Event("change", {
        bubbles: true
    }));
}


// Реакт-инпут, работает всегда
function setReactInputValue(el, value) {
    const lastValue = el.value;
    el.value = value;
    let tracker = el._valueTracker;
    if (tracker) tracker.setValue(lastValue);
    el.dispatchEvent(new Event("input", {
        bubbles: true
    }));
    el.dispatchEvent(new Event("change", {
        bubbles: true
    }));
}

// Симуляция медленного набора
async function typeTextSlowly(input, text, delay = 10) {
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event('input', {
        bubbles: true
    }));
    for (let char of text) {
        input.value += char;
        input.dispatchEvent(new Event('input', {
            bubbles: true
        }));
        await new Promise(r => setTimeout(r, delay));
    }
}

// тут заполнение select ов
async function selectDropdownUniversal(name, value) {
    let opener = document.querySelector(`button[name="${name}"]`);
    if (!opener) return false;
    opener.focus();
    opener.click();
    await new Promise(r => setTimeout(r, 50));

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
    while (Date.now() - start < 1000) {
        let opts = Array.from(document.querySelectorAll(`button[name="${name}"][type="button"]`));
        found = opts.find(btn => {
            if (btn.dataset && btn.dataset.name) {
                return btn.dataset.name.toLowerCase().includes(value.toLowerCase());
            }
            return btn.textContent.trim().toLowerCase().includes(value.toLowerCase());
        });
        if (found) break;
        await new Promise(r => setTimeout(r, 50));
    }
    if (found) {
        found.click();
        await new Promise(r => setTimeout(r, 50));
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
        cb.dispatchEvent(new Event('change', {
            bubbles: true
        }));
        return true;
    }
    return false;
}

async function getDataFromBuffer() {
    try {
        const clipboardText = await navigator.clipboard.readText();
        const fields = JSON.parse(clipboardText);
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
    font-size: 1rem;
    color: white;
    font-family: inherit;
    transition: opacity 0.2s;
    pointer-events: all; /* <--- блокирует все клики */`;
    overlay.innerHTML = `
    <div style="padding: 32px 48px; background: #282c34; border-radius: 16px; box-shadow: 0 8px 40px #0007;">
   <span style="display:inline-block; margin-right:18px; vertical-align:middle;">
  <svg width="40" height="40" viewBox="0 0 50 50" style="vertical-align:middle;">
    <circle
      cx="25"
      cy="25"
      r="20"
      fill="none"
      stroke="#53e3a6"
      stroke-width="5"
      stroke-linecap="round"
      stroke-dasharray="90 60"
      stroke-dashoffset="0">
      <animateTransform
        attributeName="transform"
        type="rotate"
        from="0 25 25"
        to="360 25 25"
        dur="1.2s"
        repeatCount="indefinite"/>
    </circle>
  </svg>
</span>
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
function showModal(message, onOk) {
    // Если модалка уже открыта, не добавлять повторно
    if (document.getElementById('afm-check-modal')) return;
    // Стили для затемнения и центра
    const style = `
        #afm-check-modal-backdrop {
            position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.3); z-index: 99999;
            display:flex; align-items:center; justify-content:center;
        }
        #afm-check-modal {
            background: #fff; border-radius: 12px; padding: 32px 36px; font-size: 1.2rem;
            box-shadow: 0 8px 40px #0005; min-width:260px; text-align:center;
        }
        #afm-check-modal button {
            margin-top: 22px; background:#1976d2; color:#fff; border:none; border-radius:6px; padding:10px 34px; font-size:1rem; cursor:pointer;
            transition: background .2s;
        }
        #afm-check-modal button:hover { background:#0e57a1;}
    `;
    const styleTag = document.createElement('style');
    styleTag.innerHTML = style;
    document.head.appendChild(styleTag);

    // Разметка модалки
    const modal = document.createElement('div');
    modal.id = 'afm-check-modal-backdrop';
    modal.innerHTML = `
        <div id="afm-check-modal">
            <div>${message}</div>
            <button id="afm-check-modal-ok">OK</button>
        </div>
    `;
    document.body.appendChild(modal);

    // Закрытие по кнопке OK
    document.getElementById('afm-check-modal-ok').onclick = function () {
        modal.remove();
        styleTag.remove();
        if (typeof onOk === "function") onOk();
    };
}

function waitForSaveButton(businessKey) {
    const btn = document.querySelector('button[name="save"]');
    if (btn) {
        // Чтобы не было двойных обработчиков
        if (!btn.hasAttribute('afm-listener')) {
            btn.setAttribute('afm-listener', '1');
            btn.addEventListener('click', async function () {
                // Вызов GET API
                try {
                    const formNumberInput = document.querySelector('input[name="form.form_number"]');
                    const formNumber = formNumberInput ? formNumberInput.value : null;

                    if (!formNumber) {
                        console.warn("Не удалось получить номер формы (form.form_number)");
                    }
                    const response = await fetch(`https://api-dev.quiq.kz/Application/afmStatus/${businessKey}/2/${formNumber}`, {
                        method: 'GET'
                    });
                    if (!response.ok) throw new Error('Network response was not ok');
                    const data = await response.json(); // Или response.text() если не JSON
                    // Здесь можешь делать что угодно с результатом
                } catch (err) {
                    console.error('Ошибка запроса:', err);
                }
            });
        }
    } else {
        // Кнопка еще не появилась — проверим чуть позже
        setTimeout(waitForSaveButton, 500);
    }
}


(function () {
    'use strict';

    const pulseStyle = document.createElement('style');
    pulseStyle.innerHTML = `
        .afm-pulse {
        animation: afm-pulse-btn 1.3s infinite;
        position: fixed;
        left: 50%;
        top: 10%;
        transform: translate(-50%, 10px); /* по центру и на 10px ниже */
        z-index: 9999;
        }
        @keyframes afm-pulse-btn {
        0% { box-shadow: 0 0 0 0 #1976d280; }
        70% { box-shadow: 0 0 0 12px #1976d200; }
        100% { box-shadow: 0 0 0 0 #1976d200; }
        }
        `;
    document.head.appendChild(pulseStyle);

    let btn = document.createElement("button");
    btn.innerText = "Заполнить";
    btn.className = "afm-pulse";
    btn.style = `
            padding: 14px 32px;
            font-size: 18px;
            border: none;
            border-radius: 8px;
            background: #1976d2;
            color: #fff;
            transition: background 0.2s;
            cursor: pointer;
        `;

    const styleActive = 'background:#1976d2;color:#fff;cursor:pointer;';
    const styleProcess = 'background:#ffa726;color:#222;cursor:wait;';
    const styleDone = 'background:#43a047;color:#fff;cursor:pointer;';
    const styleDis = 'background:#ec4141;color:#fff;cursor:pointer;';


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
        showOverlay("Идёт автозаполнение формы. Пожалуйста, не кликайте, не используйте клавиатуру и не переходите в другие окна или вкладки до завершения.");


        (async () => {
            const fields = await getDataFromBuffer();
            await new Promise(r => setTimeout(r, 100));
            var businessKey = "";
            if (fields == null) {
                btn.disabled = false;
                btn.innerText = "Заполнить";
                btn.style = btn.style.cssText + styleActive;
                hideOverlay();
                alert("Нет данных. Нажмите кнопку АФМ в заявке.");

                return;

            }

            await openAccordionByHeader("форма фм-1", ["form.operation_state", "form.operation_date"]);
            await openAccordionByHeader("сведения об операции", ["operation.number", "operation.currency"]);
            //await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
            await new Promise(r => setTimeout(r, 200));
            for (const field of fields) {
                if (field.Name == "businessKey") {
                    businessKey = field.Value;
                }
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
            waitForSaveButton(businessKey);
            btn.disabled = false;
            btn.style = btn.style.cssText + styleDone;
            btn.innerText = "Заполнить";
            hideOverlay();
            showModal("Проверьте корректность данных с заявки");
        })();
        await new Promise(r => setTimeout(r, 50));
    };

    document.body.appendChild(btn);
})();