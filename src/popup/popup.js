(function startPopup() {
    'use strict';

    const Core = globalThis.PositionMemoryCore;
    const enabledInput = document.querySelector('#enabled');
    const noticeInput = document.querySelector('#showRestoreNotice');
    const clearCurrentButton = document.querySelector('#clearCurrent');
    const clearAllButton = document.querySelector('#clearAll');
    const statusText = document.querySelector('#statusText');
    const savedAt = document.querySelector('#savedAt');
    const countBadge = document.querySelector('#countBadge');

    let currentConversationKey = null;
    let currentRecord = null;

    function sendMessage(action, payload = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                namespace: Core.MESSAGE_NAMESPACE,
                action,
                payload,
            }, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message));
                    return;
                }
                if (!response || response.ok !== true) {
                    reject(new Error(response?.error || '操作失败'));
                    return;
                }
                resolve(response.data);
            });
        });
    }

    function activeTab() {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                resolve(tabs[0] || null);
            });
        });
    }

    function contentStatus(tabId) {
        return new Promise((resolve) => {
            if (!Number.isInteger(tabId)) {
                resolve(null);
                return;
            }
            chrome.tabs.sendMessage(tabId, {
                namespace: Core.MESSAGE_NAMESPACE,
                action: 'content:status',
            }, (response) => {
                const error = chrome.runtime.lastError;
                resolve(error || !response?.ok ? null : response.data);
            });
        });
    }

    function setStatus(message, detail = '') {
        statusText.textContent = message;
        savedAt.textContent = detail;
    }

    function formatRecordedAt(timestamp) {
        if (!Number.isFinite(timestamp)) {
            return '';
        }
        return `最后保存：${new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(timestamp))}`;
    }

    async function refreshCount() {
        const count = await sendMessage('progress:count');
        countBadge.textContent = `${count} 个记录`;
    }

    async function refreshCurrentPage() {
        const tab = await activeTab();
        currentConversationKey = Core.conversationKeyFromUrl(tab?.url || '');
        currentRecord = null;

        if (!currentConversationKey) {
            clearCurrentButton.disabled = true;
            setStatus('这不是 ChatGPT 对话页面', '打开一个对话后即可自动记录');
            return;
        }

        currentRecord = Core.normalizeRecord(
            await sendMessage('progress:get', { conversationKey: currentConversationKey }),
            currentConversationKey,
        );
        clearCurrentButton.disabled = !currentRecord;

        const runtimeStatus = await contentStatus(tab?.id);
        if (!runtimeStatus?.loaded) {
            setStatus('自动监听尚未进入此页面', '重新加载扩展后通常会自动接入；必要时刷新此页面一次');
            return;
        }
        if (!runtimeStatus.enabled) {
            setStatus('自动记忆目前已关闭', '打开上方开关即可恢复自动运行');
            return;
        }

        if (currentRecord) {
            setStatus('正在自动记忆当前对话', formatRecordedAt(currentRecord.recordedAt));
        } else {
            setStatus('自动运行中', '无需点击；当前可见位置将在数秒内保存');
        }
    }

    async function updateSettings() {
        const settings = await sendMessage('settings:set', {
            enabled: enabledInput.checked,
            showRestoreNotice: noticeInput.checked,
        });
        enabledInput.checked = settings.enabled;
        noticeInput.checked = settings.showRestoreNotice;
        noticeInput.disabled = !settings.enabled;
        await refreshCurrentPage();
    }

    enabledInput.addEventListener('change', () => {
        void updateSettings().catch(() => setStatus('设置保存失败，请重试'));
    });

    noticeInput.addEventListener('change', () => {
        void updateSettings().catch(() => setStatus('设置保存失败，请重试'));
    });

    clearCurrentButton.addEventListener('click', () => {
        if (!currentConversationKey || !currentRecord) {
            return;
        }

        void sendMessage('progress:delete', { conversationKey: currentConversationKey })
            .then(async () => {
                currentRecord = null;
                clearCurrentButton.disabled = true;
                setStatus('当前对话记录已清除');
                await refreshCount();
            })
            .catch(() => setStatus('清除失败，请重试'));
    });

    clearAllButton.addEventListener('click', () => {
        if (!window.confirm('确定清除全部对话的阅读位置记录吗？')) {
            return;
        }

        void sendMessage('progress:clear-all')
            .then(async () => {
                currentRecord = null;
                clearCurrentButton.disabled = true;
                setStatus('全部阅读记录已清除');
                await refreshCount();
            })
            .catch(() => setStatus('清除失败，请重试'));
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || (!changes[Core.STORE_KEY] && !changes[Core.SETTINGS_KEY])) {
            return;
        }
        window.setTimeout(() => {
            void Promise.all([refreshCount(), refreshCurrentPage()]);
        }, 0);
    });

    async function initialize() {
        try {
            const settings = Core.normalizeSettings(await sendMessage('settings:get'));
            enabledInput.checked = settings.enabled;
            noticeInput.checked = settings.showRestoreNotice;
            noticeInput.disabled = !settings.enabled;
            await Promise.all([refreshCount(), refreshCurrentPage()]);
        } catch {
            setStatus('扩展初始化失败，请重新加载');
        }
    }

    void initialize();
})();
