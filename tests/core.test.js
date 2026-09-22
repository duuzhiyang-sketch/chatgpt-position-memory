'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/shared/core.js');

test('extracts a ChatGPT conversation id and ignores query and hash', () => {
    const plain = Core.conversationKeyFromUrl('https://chatgpt.com/c/abc12345');
    const decorated = Core.conversationKeyFromUrl('https://chatgpt.com/c/abc12345?model=auto#response-2');

    assert.equal(plain, 'chatgpt:conversation:abc12345');
    assert.equal(decorated, plain);
});

test('supports legacy host and nested GPT conversation routes', () => {
    assert.equal(
        Core.conversationKeyFromUrl('https://chat.openai.com/c/12345678-abcd'),
        'chatgpt:conversation:12345678-abcd',
    );
    assert.equal(
        Core.conversationKeyFromUrl('https://chatgpt.com/g/g-example/c/abcdef12-3456'),
        'chatgpt:conversation:abcdef12-3456',
    );
});

test('rejects non-conversation and lookalike hosts', () => {
    assert.equal(Core.conversationKeyFromUrl('https://chatgpt.com/'), null);
    assert.equal(Core.conversationKeyFromUrl('https://chatgpt.com/g/g-example'), null);
    assert.equal(Core.conversationKeyFromUrl('https://chatgpt.example/c/abc12345'), null);
    assert.equal(Core.conversationKeyFromUrl('not a url'), null);
});

test('keeps conversation records isolated', () => {
    const first = Core.createRecord({
        conversationKey: 'chatgpt:conversation:first123',
        target: { position: 3, turnTestId: 'conversation-turn-3' },
        viewport: { referenceYRatio: 0.35, offsetPx: 20, scrollRatio: 0.2 },
        recordedAt: 100,
    });
    const second = Core.createRecord({
        conversationKey: 'chatgpt:conversation:second12',
        target: { position: 8, messageId: 'message-8' },
        viewport: { referenceYRatio: 0.35, offsetPx: 14, scrollRatio: 0.8 },
        recordedAt: 200,
    });

    let store = Core.upsertRecord(Core.emptyStore(), first).store;
    store = Core.upsertRecord(store, second).store;

    assert.equal(store.records[first.conversationKey].target.position, 3);
    assert.equal(store.records[second.conversationKey].target.position, 8);
    assert.equal(Object.keys(store.records).length, 2);
});

test('last-write-wins rejects an older tab update', () => {
    const conversationKey = 'chatgpt:conversation:stable123';
    const recent = Core.createRecord({
        conversationKey,
        target: { position: 10 },
        viewport: { referenceYRatio: 0.35, offsetPx: 0, scrollRatio: 0.9 },
        recordedAt: 200,
    });
    const stale = Core.createRecord({
        conversationKey,
        target: { position: 2 },
        viewport: { referenceYRatio: 0.35, offsetPx: 0, scrollRatio: 0.1 },
        recordedAt: 100,
    });

    const initial = Core.upsertRecord(Core.emptyStore(), recent).store;
    const result = Core.upsertRecord(initial, stale);

    assert.equal(result.changed, false);
    assert.equal(result.store.records[conversationKey].target.position, 10);
});

test('normalizes settings and rejects malformed progress records', () => {
    assert.deepEqual(Core.normalizeSettings({ enabled: false }), {
        enabled: false,
        showRestoreNotice: true,
    });
    assert.equal(Core.normalizeRecord({ version: 1 }), null);
    assert.equal(Core.normalizeRecord({
        version: 1,
        platform: 'chatgpt',
        conversationKey: 'wrong-prefix',
        target: { position: 1 },
        viewport: {},
        recordedAt: 10,
    }), null);
});

test('detects meaningful reading movement without storing message content', () => {
    const conversationKey = 'chatgpt:conversation:privacy12';
    const first = Core.createRecord({
        conversationKey,
        target: { position: 4, messageId: 'message-4', role: 'assistant' },
        viewport: { referenceYRatio: 0.35, offsetPx: 10, scrollRatio: 0.4 },
        recordedAt: 100,
    });
    const tinyMove = Core.createRecord({
        conversationKey,
        target: { position: 4, messageId: 'message-4', role: 'assistant' },
        viewport: { referenceYRatio: 0.35, offsetPx: 12, scrollRatio: 0.4005 },
        recordedAt: 101,
    });
    const nextMessage = Core.createRecord({
        conversationKey,
        target: { position: 5, messageId: 'message-5', role: 'assistant' },
        viewport: { referenceYRatio: 0.35, offsetPx: 2, scrollRatio: 0.5 },
        recordedAt: 102,
    });

    assert.equal(Core.isMeaningfulProgress(first, tinyMove), false);
    assert.equal(Core.isMeaningfulProgress(first, nextMessage), true);
    assert.equal(JSON.stringify(nextMessage).includes('private message body'), false);
});

test('calculates ratio and offset-based restoration within scroll bounds', () => {
    assert.equal(Core.scrollRatio(900, 2000, 1000), 0.9);
    assert.equal(Core.ratioScrollTop(0.9, 2000, 1000), 900);
    assert.equal(Core.ratioScrollTop(2, 2000, 1000), 1000);

    const aligned = Core.alignedScrollTop({
        scrollTop: 500,
        scrollHeight: 3000,
        clientHeight: 1000,
        targetTop: 620,
        viewportTop: 0,
        viewportHeight: 1000,
        referenceYRatio: 0.35,
        offsetPx: 50,
    });
    assert.equal(aligned, 820);
});

test('parses stable turn positions', () => {
    assert.equal(Core.parseTurnPosition('conversation-turn-42'), 42);
    assert.equal(Core.parseTurnPosition('turn-7'), 7);
    assert.equal(Core.parseTurnPosition('message-7'), undefined);
});

test('automatic capture does not require a popup click or recent wheel event', () => {
    const base = {
        visible: true,
        enabled: true,
        conversationKey: 'chatgpt:conversation:auto1234',
        restoring: false,
        needsRestore: false,
    };

    assert.equal(Core.shouldCaptureAutomatically(base), true);
    assert.equal(Core.shouldCaptureAutomatically({ ...base, visible: false }), false);
    assert.equal(Core.shouldCaptureAutomatically({ ...base, restoring: true }), false);
    assert.equal(Core.shouldCaptureAutomatically({ ...base, needsRestore: true }), false);
});

test('strong message identity never falls back to a stale turn position', () => {
    const candidates = [
        { target: { messageId: 'old-message', turnTestId: 'conversation-turn-8', position: 8 } },
    ];

    assert.equal(Core.findRestoreCandidate(candidates, {
        messageId: 'new-message',
        turnTestId: 'conversation-turn-8',
        position: 8,
    }), null);
    assert.equal(Core.findRestoreCandidate(candidates, {
        messageId: 'old-message',
        turnTestId: 'conversation-turn-8',
        position: 8,
    }), candidates[0]);
});
