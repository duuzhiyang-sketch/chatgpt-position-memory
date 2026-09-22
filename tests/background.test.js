'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../src/shared/core.js');

const backgroundSource = fs.readFileSync(
    path.resolve(__dirname, '../src/background.js'),
    'utf8',
);

function createHarness() {
    const storage = {};
    let messageListener;
    let installedListener;
    let startupListener;
    const injections = [];
    const context = {
        console,
        importScripts() {
            context.PositionMemoryCore = Core;
        },
        chrome: {
            runtime: {
                lastError: null,
                onInstalled: {
                    addListener(listener) {
                        installedListener = listener;
                    },
                },
                onStartup: {
                    addListener(listener) {
                        startupListener = listener;
                    },
                },
                onMessage: {
                    addListener(listener) {
                        messageListener = listener;
                    },
                },
            },
            tabs: {
                query(_options, callback) {
                    queueMicrotask(() => callback([{ id: 101 }, { id: 202 }]));
                },
            },
            scripting: {
                executeScript(details, callback) {
                    injections.push(details);
                    queueMicrotask(() => callback([]));
                },
            },
            storage: {
                local: {
                    get(keys, callback) {
                        const result = {};
                        const requested = Array.isArray(keys) ? keys : [keys];
                        for (const key of requested) {
                            if (Object.prototype.hasOwnProperty.call(storage, key)) {
                                result[key] = storage[key];
                            }
                        }
                        queueMicrotask(() => callback(result));
                    },
                    set(values, callback) {
                        Object.assign(storage, values);
                        queueMicrotask(callback);
                    },
                },
            },
        },
    };

    vm.runInNewContext(backgroundSource, context, { filename: 'background.js' });
    assert.equal(typeof messageListener, 'function');
    assert.equal(typeof installedListener, 'function');
    assert.equal(typeof startupListener, 'function');

    function dispatch(action, payload = {}) {
        return new Promise((resolve) => {
            const keepAlive = messageListener({
                namespace: Core.MESSAGE_NAMESPACE,
                action,
                payload,
            }, {}, resolve);
            assert.equal(keepAlive, true);
        });
    }

    async function triggerInstalled() {
        installedListener();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    }

    return { dispatch, injections, storage, triggerInstalled };
}

function record(conversationKey, position, recordedAt) {
    return Core.createRecord({
        conversationKey,
        target: { position, turnTestId: `conversation-turn-${position}` },
        viewport: {
            referenceYRatio: 0.35,
            offsetPx: position,
            scrollRatio: position / 20,
        },
        recordedAt,
    });
}

test('background persists settings and progress through its serialized protocol', async () => {
    const harness = createHarness();
    const settingsResult = await harness.dispatch('settings:set', { enabled: false });
    assert.equal(settingsResult.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(settingsResult.data)), {
        enabled: false,
        showRestoreNotice: true,
    });

    const conversationKey = 'chatgpt:conversation:protocol1';
    const upsertResult = await harness.dispatch('progress:upsert', {
        record: record(conversationKey, 6, 100),
    });
    assert.equal(upsertResult.ok, true);

    const getResult = await harness.dispatch('progress:get', { conversationKey });
    assert.equal(getResult.ok, true);
    assert.equal(getResult.data.target.position, 6);

    const countResult = await harness.dispatch('progress:count');
    assert.equal(countResult.data, 1);
});

test('background keeps the newest record and supports scoped deletion', async () => {
    const harness = createHarness();
    const firstKey = 'chatgpt:conversation:first-key';
    const secondKey = 'chatgpt:conversation:second-key';

    await harness.dispatch('progress:upsert', { record: record(firstKey, 8, 200) });
    await harness.dispatch('progress:upsert', { record: record(firstKey, 2, 100) });
    await harness.dispatch('progress:upsert', { record: record(secondKey, 3, 300) });

    const first = await harness.dispatch('progress:get', { conversationKey: firstKey });
    assert.equal(first.data.target.position, 8);

    const deleted = await harness.dispatch('progress:delete', { conversationKey: firstKey });
    assert.equal(deleted.data, true);
    assert.equal((await harness.dispatch('progress:get', { conversationKey: firstKey })).data, null);
    assert.equal((await harness.dispatch('progress:count')).data, 1);

    await harness.dispatch('progress:clear-all');
    assert.equal((await harness.dispatch('progress:count')).data, 0);
});

test('background injects the automatic listener into already-open ChatGPT tabs', async () => {
    const harness = createHarness();
    await harness.triggerInstalled();

    assert.equal(harness.injections.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.injections)), [
        {
            target: { tabId: 101 },
            files: ['shared/core.js', 'content.js'],
        },
        {
            target: { tabId: 202 },
            files: ['shared/core.js', 'content.js'],
        },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.storage[Core.SETTINGS_KEY])), {
        enabled: true,
        showRestoreNotice: true,
    });
});
