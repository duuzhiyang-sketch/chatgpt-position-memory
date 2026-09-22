'use strict';

importScripts('shared/core.js');

const Core = globalThis.PositionMemoryCore;
const CHATGPT_URL_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
let storageQueue = Promise.resolve();

function enqueueStorage(task) {
    const result = storageQueue.then(task, task);
    storageQueue = result.catch(() => undefined);
    return result;
}

function storageGet(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve(result);
        });
    });
}

function storageSet(value) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(value, () => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve();
        });
    });
}

async function readSettings() {
    const stored = await storageGet(Core.SETTINGS_KEY);
    return Core.normalizeSettings(stored[Core.SETTINGS_KEY]);
}

async function readStore() {
    const stored = await storageGet(Core.STORE_KEY);
    return Core.normalizeStore(stored[Core.STORE_KEY]);
}

function queryOpenChatGptTabs() {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: CHATGPT_URL_PATTERNS }, (tabs) => {
            const error = chrome.runtime.lastError;
            resolve(error ? [] : tabs.filter((tab) => Number.isInteger(tab.id)));
        });
    });
}

function injectContentScripts(tabId) {
    return new Promise((resolve) => {
        chrome.scripting.executeScript({
            target: { tabId },
            files: ['shared/core.js', 'content.js'],
        }, () => {
            const error = chrome.runtime.lastError;
            resolve(!error);
        });
    });
}

async function ensureContentScriptsInOpenTabs() {
    const tabs = await queryOpenChatGptTabs();
    await Promise.all(tabs.map((tab) => injectContentScripts(tab.id)));
}

async function handleMessage(message) {
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};

    switch (message.action) {
        case 'settings:get':
            return readSettings();

        case 'settings:set': {
            const current = await readSettings();
            const next = Core.normalizeSettings({ ...current, ...payload });
            await storageSet({ [Core.SETTINGS_KEY]: next });
            return next;
        }

        case 'progress:get': {
            const key = typeof payload.conversationKey === 'string' ? payload.conversationKey : '';
            const store = await readStore();
            return Core.normalizeRecord(store.records[key], key);
        }

        case 'progress:upsert': {
            const store = await readStore();
            const result = Core.upsertRecord(store, payload.record);
            if (result.changed) {
                await storageSet({ [Core.STORE_KEY]: result.store });
            }
            return Core.normalizeRecord(payload.record);
        }

        case 'progress:delete': {
            const key = typeof payload.conversationKey === 'string' ? payload.conversationKey : '';
            const store = await readStore();
            if (!Object.prototype.hasOwnProperty.call(store.records, key)) {
                return false;
            }
            delete store.records[key];
            await storageSet({ [Core.STORE_KEY]: store });
            return true;
        }

        case 'progress:clear-all':
            await storageSet({ [Core.STORE_KEY]: Core.emptyStore() });
            return true;

        case 'progress:count': {
            const store = await readStore();
            return Object.keys(store.records).length;
        }

        default:
            throw new Error('Unsupported message action');
    }
}

chrome.runtime.onInstalled.addListener(() => {
    void enqueueStorage(async () => {
        const settings = await readSettings();
        await storageSet({ [Core.SETTINGS_KEY]: settings });
    });
    void ensureContentScriptsInOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
    void ensureContentScriptsInOpenTabs();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.namespace !== Core.MESSAGE_NAMESPACE) {
        return false;
    }

    void enqueueStorage(() => handleMessage(message))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }));

    return true;
});
