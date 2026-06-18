import { eventSource, event_types } from '/script.js';
import * as slashModule from '/scripts/slash-commands.js';

const MODULE_NAME = 'vertex_auto_retry';
let retryCount = 0;
const MAX_RETRIES = 5;
let isTimeoutActive = false;
let userAborted = false;

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
    userAborted = false;
});

$(document).on('click', '#stop_generation, .stop_generation_btn, [id*="stop"]', () => {
    userAborted = true;
    console.log(`[${MODULE_NAME}] Пользователь вручную остановил генерацию. Автоповтор заблокирован.`);
    setTimeout(() => { userAborted = false; }, 3000);
});

async function triggerRetry() {
    if (userAborted) return;
    const command = '/regenerate';
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

function handleFailureDetected(reasonText) {
    if (!settings.enabled || isTimeoutActive || !isGoogleProvider() || userAborted) {
        return;
    }

    if (retryCount >= MAX_RETRIES) {
        console.warn(`[${MODULE_NAME}] Превышен лимит автоповторов (${MAX_RETRIES}).`);
        retryCount = 0;
        return;
    }

    retryCount++;
    isTimeoutActive = true;

    console.log(`[${MODULE_NAME}] ПЕРЕХВАТ СБОЯ: ${reasonText}. Попытка ${retryCount}/${MAX_RETRIES}. Ждем ${settings.interval} сек...`);

    setTimeout(() => {
        const toast = document.querySelector('.toast-error, .toastr-error, #toast-container');
        if (toast && typeof toast.click === 'function') toast.click();
    }, 200);

    setTimeout(async () => {
        if (!userAborted) {
            await triggerRetry();
        }
        isTimeoutActive = false;
    }, settings.interval * 1000);
}

function initGlobalErrorCatch() {
    window.addEventListener('unhandledrejection', (event) => {
        if (!settings.enabled || isTimeoutActive || userAborted) return;
        
        const errorMsg = event.reason?.message || String(event.reason || '');
        if (errorMsg.toLowerCase().includes('candidate text empty')) {
            handleFailureDetected('Цензура Google Vertex (Candidate text empty)');
        }
    });

    window.addEventListener('error', (event) => {
        if (!settings.enabled || isTimeoutActive || userAborted) return;
        
        const errorMsg = event.message || '';
        if (errorMsg.toLowerCase().includes('candidate text empty')) {
            handleFailureDetected('Цензура Google Vertex (Candidate text empty)');
        }
    });
}

function initNetworkHook() {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const isGenerationUrl = url.includes('/api/backends/') || url.includes('/generate');

        try {
            const response = await originalFetch.apply(this, args);
            
            if (isGenerationUrl) {
                if (response.status === 429) {
                    handleFailureDetected('Сервер вернул статус 429 (Превышение лимитов)');
                    return response;
                }

                if (!response.ok && response.status !== 200) {
                    const clone = response.clone();
                    clone.text().then(text => {
                        if (text) {
                            const lowText = text.toLowerCase();
                            if (lowText.includes('429') || lowText.includes('capacity') || lowText.includes('api_error')) {
                                handleFailureDetected('Ошибка сервера в структуре JSON ответа');
                            }
                        }
                    }).catch(() => {});
                }
            }

            return response;
        } catch (error) {
            if (isGenerationUrl) {
                if (error.name === 'AbortError' || error.message?.toLowerCase().includes('abort') || userAborted) {
                    userAborted = true;
                    throw error;
                }
                handleFailureDetected(`Критический обрыв соединения: ${error.message}`);
            }
            throw error;
        }
    };
}

async function handleGenerationEnded() {
    await new Promise(resolve => setTimeout(resolve, 600));
    if (!settings.enabled || isTimeoutActive || !isGoogleProvider() || userAborted) return;

    let currentChat = null;
    if (typeof getContext === 'function') {
        currentChat = getContext().chat;
    } else if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        currentChat = window.SillyTavern.getContext().chat;
    } else if (typeof chat !== 'undefined') {
        currentChat = chat;
    } else if (window.chat) {
        currentChat = window.chat;
    }

    if (!currentChat || currentChat.length === 0) return;

    const lastMessage = currentChat[currentChat.length - 1];
    const isEmpty = lastMessage.is_user === false && (!lastMessage.mes || lastMessage.mes.trim() === '');

    if (isEmpty) {
        handleFailureDetected('Цензура или обрыв стрима (абсолютно пустой ответ)');
    } else if (lastMessage.is_user === false) {
        retryCount = 0;
    }
}

function createUI() {
    const extensionsSettings = document.getElementById('extensions_settings');
    if (!extensionsSettings) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-header">
                <div class="inline-drawer-title">
                    <i class="fa-solid fa-rotate text_accent"></i> Авторерол
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
    initGlobalErrorCatch();
    eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);
    console.log(`[${MODULE_NAME}] Расширение переименовано в Авторерол и успешно запущено.`);
}

eventSource.on(event_types.APP_READY, init);
