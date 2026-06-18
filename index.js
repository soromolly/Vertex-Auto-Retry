import { eventSource, event_types } from '/script.js';
import * as slashModule from '/scripts/slash-commands.js';

const MODULE_NAME = 'vertex_auto_retry';
let retryCount = 0;
const MAX_RETRIES = 3;
let isTimeoutActive = false;

let settings = {
    enabled: true,
    interval: 5
};

function loadSettings() {
    const saved = localStorage.getItem(MODULE_NAME);
    if (saved) {
        try {
            settings = { ...settings, ...JSON.parse(saved) };
        } catch (e) {
            console.error('Ошибка загрузки настроек автоповтора:', e);
        }
    }
}

function saveSettings() {
    localStorage.setItem(MODULE_NAME, JSON.stringify(settings));
}

function isGoogleProvider() {
    const apiSelector = document.getElementById('api_selector');
    if (!apiSelector) return true; 
    const currentApiText = apiSelector.options[apiSelector.selectedIndex]?.text?.toLowerCase() || '';
    return currentApiText.includes('vertex') || currentApiText.includes('google') || currentApiText.includes('gemini');
}

eventSource.on(event_types.MESSAGE_SENT, () => {
    retryCount = 0;
});

async function triggerRetry() {
    const command = '/retry';
    if (slashModule && slashModule.executeSlashCommandsAsync) {
        await slashModule.executeSlashCommandsAsync(command);
    } else if (slashModule && slashModule.executeSlashCommands) {
        await slashModule.executeSlashCommands(command);
    } else {
        const textarea = document.getElementById('send_textarea');
        const sendBtn = document.getElementById('send_btn');
        if (textarea && sendBtn) {
            textarea.value = command;
            sendBtn.click();
        }
    }
}

// Единый обработчик команды перезапуска
function handleFailureDetected(reasonText) {
    if (!settings.enabled || isTimeoutActive || !isGoogleProvider()) return;

    if (retryCount >= MAX_RETRIES) {
        console.warn(`[${MODULE_NAME}] Превышен лимит автоповторов (${MAX_RETRIES}).`);
        retryCount = 0;
        return;
    }

    retryCount++;
    isTimeoutActive = true;

    console.log(`[${MODULE_NAME}] СЕТЕВОЙ ПЕРЕХВАТ: ${reasonText}. Ждем ${settings.interval} сек...`);

    // Мягко закрываем всплывающие окна ошибок в интерфейсе, если они вылезли
    setTimeout(() => {
        const toast = document.querySelector('.toast-error, .toastr-error, #toast-container');
        if (toast && typeof toast.click === 'function') toast.click();
    }, 200);

    setTimeout(async () => {
        await triggerRetry();
        isTimeoutActive = false;
    }, settings.interval * 1000);
}

// ГЛОБАЛЬНЫЙ ПЕРЕХВАТ СЕТЕВЫХ ЗАПРОСОВ (Глушит любые сбои Node.js на корню)
function initNetworkHook() {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        try {
            const response = await originalFetch.apply(this, args);
            
            // Если сервер вернул HTTP-код 429 (Too Many Requests), реагируем мгновенно
            if (response.status === 429) {
                handleFailureDetected('Сервер вернул HTTP статус 429');
                return response;
            }

            // Проверяем ответы от API генерации SillyTavern
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url.includes('/api/')) {
                // Клонируем поток ответа, чтобы не нарушать работу основного кода ST
                const clone = response.clone();
                
                clone.text().then(text => {
                    if (text) {
                        const lowText = text.toLowerCase();
                        // Ищем маркеры критической ошибки Google прямо внутри сырых данных от сервера
                        if (lowText.includes('429') || lowText.includes('capacity') || lowText.includes('api_error')) {
                            handleFailureDetected('Обнаружена ошибка 429/Capacity в теле ответа сервера');
                        }
                    }
                }).catch(() => {});
            }

            return response;
        } catch (error) {
            // Перехват падения сети (например, если Термукс на секунду потерял коннект)
            handleFailureDetected(`Сбой сетевого запроса: ${error.message}`);
            throw error;
        }
    };

    console.log(`[${MODULE_NAME}] Сетевой анализатор трафика успешно запущен.`);
}

function createUI() {
    const extensionsSettings = document.getElementById('extensions_settings');
    if (!extensionsSettings) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-header">
                <div class="inline-drawer-title">
                    <i class="fa-solid fa-triangle-exclamation text_accent"></i> Автоповтор Vertex/Gemini AI
                </div>
                <div class="inline-drawer-icon fa-solid fa-chevron-down"></div>
            </div>
            <div class="inline-drawer-content" style="display: none; padding: 10px 14px;">
                <div class="setup-block" style="display: flex; flex-direction: column; gap: 12px;">
                    
                    <label class="checkbox_label" style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin: 5px 0;">
                        <input type="checkbox" id="vertex_retry_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Активировать автоматический перезапуск</span>
                    </label>
                    
                    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 4px 0;" />
                    
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <label for="vertex_retry_interval" style="font-size: 0.95em; opacity: 0.9;">Интервал отправки сообщения (в секундах):</label>
                        <input type="number" id="vertex_retry_interval" class="text_accent" min="1" max="120" step="1" value="${settings.interval}" 
                            style="width: 100%; padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 4px; box-sizing: border-box;">
                        <small style="opacity: 0.55; font-size: 0.8em; line-height: 1.2;">Скрипт перехватывает трафик между браузером и Термуксом, автоматизируя ретрай.</small>
                    </div>
                    
                </div>
            </div>
        </div>
    `;

    const $drawer = $(html);
    $(extensionsSettings).append($drawer);

    $drawer.find('.inline-drawer-header').on('click', function() {
        const $content = $drawer.find('.inline-drawer-content');
        const $icon = $drawer.find('.inline-drawer-icon');
        if ($content.is(':visible')) {
            $content.slideUp(150);
            $icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            $content.slideDown(150);
            $icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    $drawer.find('#vertex_retry_enabled').on('change', function() {
        settings.enabled = this.checked;
        saveSettings();
    });

    $drawer.find('#vertex_retry_interval').on('input', function() {
        let val = parseInt($(this).val());
        if (!isNaN(val) && val > 0) {
            settings.interval = val;
            saveSettings();
        }
    });
}

function init() {
    loadSettings();
    createUI();
    initNetworkHook();
    console.log(`[${MODULE_NAME}] Сетевое расширение полностью готово.`);
}

eventSource.on(event_types.APP_READY, init);
