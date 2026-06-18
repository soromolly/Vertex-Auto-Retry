import { eventSource, event_types, getContext } from '/script.js';
import * as slashModule from '/scripts/slash-commands.js';

const MODULE_NAME = 'vertex_auto_retry';
let retryCount = 0;
const MAX_RETRIES = 3;
let isTimeoutActive = false;

// Настройки по умолчанию
let settings = {
    enabled: true,
    interval: 5 // Интервал в секундах по умолчанию
};

// Загрузка сохраненных настроек из браузера
function loadSettings() {
    const saved = localStorage.getItem(MODULE_NAME);
    if (saved) {
        try {
            settings = { ...settings, ...JSON.parse(saved) };
        } catch (e) {
            console.error('Ошибка загрузки настроек Vertex Auto-Retry:', e);
        }
    }
}

// Сохранение настроек
function saveSettings() {
    localStorage.setItem(MODULE_NAME, JSON.stringify(settings));
}

// Проверка провайдера Vertex
function isVertexAI() {
    const apiSelector = document.getElementById('api_selector');
    if (!apiSelector) return false;
    const currentApiText = apiSelector.options[apiSelector.selectedIndex]?.text?.toLowerCase() || '';
    return currentApiText.includes('vertex') || currentApiText.includes('google');
}

// Сброс счетчика при ручной отправке сообщения
eventSource.on(event_types.MESSAGE_SENT, () => {
    retryCount = 0;
});

// Безопасный вызов команды перезапуска без привязки к жестким экспортам API
async function triggerRetry() {
    const command = '/retry';
    if (slashModule && slashModule.executeSlashCommandsAsync) {
        await slashModule.executeSlashCommandsAsync(command);
    } else if (slashModule && slashModule.executeSlashCommands) {
        await slashModule.executeSlashCommands(command);
    } else {
        // Жесткий фолбек через симуляцию интерфейса ввода, если модули недоступны
        const textarea = document.getElementById('send_textarea');
        const sendBtn = document.getElementById('send_btn');
        if (textarea && sendBtn) {
            textarea.value = command;
            sendBtn.click();
        }
    }
}

async function handleGenerationEnded() {
    if (!settings.enabled || isTimeoutActive) return;

    // Пауза перед анализом ответа чата
    await new Promise(resolve => setTimeout(resolve, 600));

    if (!isVertexAI()) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];

    const isNoResponse = lastMessage.is_user === true;
    const isEmptyResponse = lastMessage.is_user === false && (!lastMessage.mes || lastMessage.mes.trim() === '');
    const isErrorText = lastMessage.is_user === false && lastMessage.mes && (
        lastMessage.mes.includes('API Error') ||
        lastMessage.mes.includes('Generation failed') ||
        lastMessage.mes.includes('status code 400') ||
        lastMessage.mes.includes('status code 429')
    );

    if (isNoResponse || isEmptyResponse || isErrorText) {
        if (retryCount >= MAX_RETRIES) {
            console.warn(`[${MODULE_NAME}] Превышен лимит автоповторов (${MAX_RETRIES}).`);
            retryCount = 0;
            return;
        }

        retryCount++;
        isTimeoutActive = true;
        
        console.log(`[${MODULE_NAME}] Зафиксирован сбой. Ждем ${settings.interval} сек. перед повторной генерацией...`);
        
        // Задержка на основе кастомной настройки пользователя
        setTimeout(async () => {
            await triggerRetry();
            isTimeoutActive = false;
        }, settings.interval * 1000);
    } else {
        if (lastMessage.is_user === false && lastMessage.mes && lastMessage.mes.trim().length > 0) {
            retryCount = 0;
        }
    }
}

// Отрисовка интерфейса внутри вкладки расширений
function createUI() {
    const extensionsSettings = document.getElementById('extensions_settings');
    if (!extensionsSettings) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-header">
                <div class="inline-drawer-title">
                    <i class="fa-solid fa-triangle-exclamation text_accent"></i> Автоповтор Vertex AI
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
                    
                    <!-- Тонкая настройка интервала строго в самом низу конфигурационного блока -->
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <label for="vertex_retry_interval" style="font-size: 0.95em; opacity: 0.9;">Интервал отправки сообщения (в секундах):</label>
                        <input type="number" id="vertex_retry_interval" class="text_accent" min="1" max="120" step="1" value="${settings.interval}" 
                            style="width: 100%; padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 4px; box-sizing: border-box;">
                        <small style="opacity: 0.55; font-size: 0.8em; line-height: 1.2;">Вы можете настроить тайм-аут вручную, указав любое число (например: 5, 10, 15, 20, 30).</small>
                    </div>
                    
                </div>
            </div>
        </div>
    `;

    const $drawer = $(html);
    $(extensionsSettings).append($drawer);

    // Логика сворачивания / разворачивания плашки меню
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

    // Изменение состояния галочки
    $drawer.find('#vertex_retry_enabled').on('change', function() {
        settings.enabled = this.checked;
        saveSettings();
    });

    // Ручной ввод интервала
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
    eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);
    console.log(`[${MODULE_NAME}] Расширение успешно инициализировано и встроено в панель.`);
}

eventSource.on(event_types.APP_READY, init);
