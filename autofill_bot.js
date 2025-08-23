// ==UserScript==
// @name         AFM sef
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Заполняет форму AFM корректно для React-порталов, стабильно! + ранний мониторинг кнопок
// @author       Ecash
// @match        https://websfm.kz/form-fm/*
// @grant        none
// ==/UserScript==

// === [0] Глобальное состояние для актуальных значений ===
const AFM_STATE = {
    businessKey: "",
    initiator: ""
};

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
async function openAccordionByHeader(headerText, expectedFieldNames = [], timeout = 1500) {
    // Найдём заголовок
    const p = Array.from(document.querySelectorAll('p'))
        .find(e => e.textContent.trim().toLowerCase().includes(headerText.trim().toLowerCase()));
    if (!p) return false;

    // Поднимаемся до ближайшего clickable блока (например, div с role=button или cursor:pointer)
    const headerDiv = p.closest('div');
    if (!headerDiv) return false;

    // Проверим: вложенные expectedFields уже видны?
    const someVisible = expectedFieldNames.some(name => document.querySelector(`[name="${name}"]`));
    if (someVisible) return true; // уже открыт

    // Пробуем кликнуть, если поля не найдены
    headerDiv.click();

    // Ждём появления хотя бы одного ожидаемого поля
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

    // Начало композиции (IME)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (let i = 0; i < text.length; i++) {
        let char = text[i];

        // Keyboard events
        input.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: char, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: char, bubbles: true }));

        // Меняем value через prototype setter
        let nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeInputValueSetter.call(input, input.value + char);

        // Input event
        input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: char, bubbles: true }));

        await new Promise(r => setTimeout(r, delay));
    }

    // Завершение композиции (IME)
    input.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));

    // Имитация paste (если слушают ClipboardEvent)
    let dt = new DataTransfer();
    dt.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));

    // "change" на всякий
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
async function typeTextSlowly(input, text, delay = 5) {
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

        // 1. Точное совпадение
        found = opts.find(btn => {
            const text = (btn.dataset?.name || btn.textContent || "").trim().toLowerCase();
            return text === value.trim().toLowerCase();
        });

        // 2. Частичное совпадение
        if (!found) {
            found = opts.find(btn => {
                const text = (btn.dataset?.name || btn.textContent || "").trim().toLowerCase();
                return text.includes(value.trim().toLowerCase());
            });
        }

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
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    return false;
}

// === [1] Обновление состояния из буфера (инициатор/бизнес-ключ) ===
async function getDataFromBuffer() {
    try {
        const clipboardText = await navigator.clipboard.readText();
        const fields = JSON.parse(clipboardText);

        // поддерживаем актуальность глобального состояния
        if (fields?.initiator) AFM_STATE.initiator = fields.initiator;

        if (fields?.json && Array.isArray(fields.json)) {
            const bk = fields.json.find(f => f.Name === "businessKey")?.Value;
            if (bk) AFM_STATE.businessKey = bk;
        }

        return fields;
    } catch (err) {
        return null; // Чтобы не получить undefined
    }
}

// === [2] UI: затемняющий оверлей ===
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

// === [3] Простая модалка-подтверждение ===
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

// === [4] Универсальная привязка обработчика к кнопке (save/subscribe) ===
// handlerStatus = 2 для save, 3 для subscribe
function waitAndBindActionButton({ buttonName, statusValue }) {
    const tryBind = () => {
        const btn = document.querySelector(`button[name="${buttonName}"]`);
        if (!btn) {
            // кнопка ещё не дорисована — проверим чуть позже
            setTimeout(tryBind, 500);
            return;
        }
        if (btn.hasAttribute('afm-listener')) return; // уже повесили

        btn.setAttribute('afm-listener', '1');
        btn.addEventListener('click', async () => {
            // Обновим state на случай, если пользователь переключал заявки
            await getDataFromBuffer();

            // Попробуем взять номер формы из DOM
            const formNumberInput = document.querySelector('input[name="form.form_number"]');
            const formNumber = formNumberInput ? formNumberInput.value : null;

            const payload = {
                requestId: AFM_STATE.businessKey || "",
                afmId: formNumber || "",
                savedByUser: statusValue === 2 ? (AFM_STATE.initiator || "") : "",
                subscribedByUser: statusValue === 3 ? (AFM_STATE.initiator || "") : "",
                saveUserIp: "",
                subscribeUserIp: "",
                status: statusValue
            };

            try {
                const response = await fetch(`https://api.quiq.kz/Application/afmStatus`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) throw new Error('Network response was not ok');
                // const data = await response.json();
            } catch (err) {
                console.error('Ошибка запроса:', err);
            }
        });
    };

    tryBind();
}

// Обёртки для обратной совместимости
function waitForSaveButton() { waitAndBindActionButton({ buttonName: 'save', statusValue: 2 }); }
function waitForSubscribeButton() { waitAndBindActionButton({ buttonName: 'subscribe', statusValue: 3 }); }

// === [5] Главный запуск ===
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

    // 🔥 слушаем кнопки сразу (без зависимости от автозаполнения)
    waitForSaveButton();
    waitForSubscribeButton();

    // Периодически тянем буфер и обновляем состояние/надпись
    setInterval(async () => {
        const fields = await getDataFromBuffer(); // обновляет AFM_STATE
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
            const fields = await getDataFromBuffer(); // также актуализирует AFM_STATE
            await new Promise(r => setTimeout(r, 100));
            var businessKey = "";
            var initiator = "";

            if (fields?.json == null) {
                initiator = fields?.initiator || "";
                btn.disabled = false;
                btn.innerText = "Заполнить";
                btn.style = btn.style.cssText + styleActive;
                hideOverlay();
                alert("Нет данных. Нажмите кнопку АФМ в заявке.");
                return;
            }

            await openAccordionByHeader("форма фм-1", ["form.operation_state", "form.operation_date"]);
            await openAccordionByHeader("сведения об операции", ["operation.number", "operation.currency"]);
            await new Promise(r => setTimeout(r, 200));

            initiator = fields.initiator || "";
            const maybeBK = fields.json.find(f => f.Name === "businessKey")?.Value;
            if (maybeBK) {
                businessKey = maybeBK;
                AFM_STATE.businessKey = maybeBK; // фиксируем в state
            }
            if (initiator) AFM_STATE.initiator = initiator;

            for (const field of fields.json) {
                if (field.Name == "operation.address.house_number") {
                    await openAccordionByHeader("участники", ["participants[0].participant", "participants[0].iin"]);
                    await openAccordionByHeader("участник 1", ["participants[0].participant"]);
                    await openAccordionByHeader("банк участника операции", ["participants[0].bank.country"]);
                    await openAccordionByHeader("юридический адрес", ["participants[0].legal_address.country"]);
                    await openAccordionByHeader("фактический адрес", ["participants[0].address.country"]);
                }
                if (field.Name == "participants[0].iin") {
                    await openAccordionByHeader("фио", ["participants[0].full_name.last_name", "participants[0].full_name.first_name"]);
                    await openAccordionByHeader("документ, удостоверяющий личность", ["participants[0].document.type_document", "participants[0].document.number", "participants[0].document.issue_date"]);
                }

                if (field.FieldType === "input") {
                    let el = document.querySelector(`[name="${field.Name}"]`);

                    // ДОЖДАТЬСЯ, если поле не найдено
                    if (!el) {
                        const start = Date.now();
                        while (!el && Date.now() - start < 2000) {
                            await new Promise(r => setTimeout(r, 100));
                            el = document.querySelector(`[name="${field.Name}"]`);
                        }
                    }

                    // Если появилось — заполняем
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

            // слушатели уже были навешаны заранее — ничего больше делать не нужно
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
