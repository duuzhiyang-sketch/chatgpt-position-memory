(function initializePositionMemoryCore(root, factory) {
    'use strict';

    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    root.PositionMemoryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPositionMemoryCore() {
    'use strict';

    const STORE_VERSION = 1;
    const RECORD_VERSION = 1;
    const STORE_KEY = 'positionMemory.progress.v1';
    const SETTINGS_KEY = 'positionMemory.settings.v1';
    const MESSAGE_NAMESPACE = 'position-memory';
    const CONVERSATION_KEY_PREFIX = 'chatgpt:conversation:';
    const SUPPORTED_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        showRestoreNotice: true,
    });

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
        return Number.isFinite(value) ? clamp(value, min, max) : fallback;
    }

    function cleanString(value, maxLength = 256) {
        if (typeof value !== 'string') {
            return undefined;
        }

        const trimmed = value.trim();
        if (!trimmed || trimmed.length > maxLength) {
            return undefined;
        }

        return trimmed;
    }

    function conversationIdFromUrl(value) {
        let parsed;

        try {
            parsed = new URL(value);
        } catch {
            return null;
        }

        if (!SUPPORTED_HOSTS.has(parsed.hostname.toLowerCase())) {
            return null;
        }

        const segments = parsed.pathname
            .split('/')
            .filter(Boolean)
            .map((segment) => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    return segment;
                }
            });

        for (let index = segments.length - 2; index >= 0; index -= 1) {
            if (segments[index] !== 'c') {
                continue;
            }

            const candidate = segments[index + 1];
            if (/^[A-Za-z0-9_-]{6,128}$/.test(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    function conversationKeyFromUrl(value) {
        const conversationId = conversationIdFromUrl(value);
        return conversationId ? `${CONVERSATION_KEY_PREFIX}${conversationId}` : null;
    }

    function parseTurnPosition(testId) {
        const value = cleanString(testId);
        if (!value) {
            return undefined;
        }

        const match = value.match(/(?:conversation-)?turn-(\d+)$/i);
        if (!match) {
            return undefined;
        }

        const position = Number.parseInt(match[1], 10);
        return Number.isSafeInteger(position) && position >= 0 ? position : undefined;
    }

    function normalizeSettings(value) {
        const input = value && typeof value === 'object' ? value : {};
        return {
            enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
            showRestoreNotice:
                typeof input.showRestoreNotice === 'boolean'
                    ? input.showRestoreNotice
                    : DEFAULT_SETTINGS.showRestoreNotice,
        };
    }

    function normalizeTarget(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }

        const target = {};
        const messageId = cleanString(value.messageId);
        const turnTestId = cleanString(value.turnTestId);
        const role = value.role === 'user' || value.role === 'assistant' ? value.role : undefined;

        if (messageId) {
            target.messageId = messageId;
        }
        if (turnTestId) {
            target.turnTestId = turnTestId;
        }
        if (Number.isSafeInteger(value.position) && value.position >= 0) {
            target.position = value.position;
        }
        if (role) {
            target.role = role;
        }

        return Object.keys(target).length > 0 ? target : null;
    }

    function normalizeViewport(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }

        return {
            referenceYRatio: finiteNumber(value.referenceYRatio, 0.35, 0.05, 0.95),
            offsetPx: finiteNumber(value.offsetPx, 0, -100000, 100000),
            scrollRatio: finiteNumber(value.scrollRatio, 0, 0, 1),
        };
    }

    function normalizeRecord(value, expectedKey) {
        if (!value || typeof value !== 'object' || value.version !== RECORD_VERSION) {
            return null;
        }

        if (value.platform !== 'chatgpt') {
            return null;
        }

        const conversationKey = cleanString(value.conversationKey, 256);
        if (!conversationKey || !conversationKey.startsWith(CONVERSATION_KEY_PREFIX)) {
            return null;
        }
        if (expectedKey && conversationKey !== expectedKey) {
            return null;
        }

        const target = normalizeTarget(value.target);
        const viewport = normalizeViewport(value.viewport);
        if (!target || !viewport) {
            return null;
        }

        if (!Number.isFinite(value.recordedAt) || value.recordedAt <= 0) {
            return null;
        }

        return {
            version: RECORD_VERSION,
            platform: 'chatgpt',
            conversationKey,
            target,
            viewport,
            status: value.status === 'completed' ? 'completed' : 'reading',
            recordedAt: value.recordedAt,
            source: value.source === 'manual' ? 'manual' : 'user-scroll',
        };
    }

    function createRecord({ conversationKey, target, viewport, recordedAt = Date.now() }) {
        return normalizeRecord({
            version: RECORD_VERSION,
            platform: 'chatgpt',
            conversationKey,
            target,
            viewport,
            status: 'reading',
            recordedAt,
            source: 'user-scroll',
        }, conversationKey);
    }

    function emptyStore() {
        return { version: STORE_VERSION, records: {} };
    }

    function normalizeStore(value) {
        const store = emptyStore();
        if (!value || typeof value !== 'object' || value.version !== STORE_VERSION) {
            return store;
        }

        if (!value.records || typeof value.records !== 'object' || Array.isArray(value.records)) {
            return store;
        }

        for (const [key, candidate] of Object.entries(value.records)) {
            const record = normalizeRecord(candidate, key);
            if (record) {
                store.records[key] = record;
            }
        }

        return store;
    }

    function upsertRecord(storeValue, recordValue) {
        const store = normalizeStore(storeValue);
        const record = normalizeRecord(recordValue);
        if (!record) {
            return { store, changed: false };
        }

        const previous = store.records[record.conversationKey];
        if (previous && previous.recordedAt > record.recordedAt) {
            return { store, changed: false };
        }

        return {
            store: {
                version: STORE_VERSION,
                records: {
                    ...store.records,
                    [record.conversationKey]: record,
                },
            },
            changed: true,
        };
    }

    function scrollRatio(scrollTop, scrollHeight, clientHeight) {
        const range = Math.max(0, scrollHeight - clientHeight);
        return range === 0 ? 0 : clamp(scrollTop / range, 0, 1);
    }

    function alignedScrollTop({
        scrollTop,
        scrollHeight,
        clientHeight,
        targetTop,
        viewportTop,
        viewportHeight,
        referenceYRatio,
        offsetPx,
    }) {
        const desiredTop = viewportTop + viewportHeight * referenceYRatio - offsetPx;
        const range = Math.max(0, scrollHeight - clientHeight);
        return clamp(scrollTop + targetTop - desiredTop, 0, range);
    }

    function ratioScrollTop(ratio, scrollHeight, clientHeight) {
        const range = Math.max(0, scrollHeight - clientHeight);
        return range * clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1);
    }

    function shouldCaptureAutomatically({ visible, enabled, conversationKey, restoring, needsRestore }) {
        return Boolean(visible && enabled && conversationKey && !restoring && !needsRestore);
    }

    function findRestoreCandidate(candidates, target) {
        if (!Array.isArray(candidates) || !target || typeof target !== 'object') {
            return null;
        }

        if (target.messageId) {
            return candidates.find((candidate) => candidate?.target?.messageId === target.messageId) || null;
        }
        if (target.turnTestId) {
            return candidates.find((candidate) => candidate?.target?.turnTestId === target.turnTestId) || null;
        }
        if (Number.isSafeInteger(target.position)) {
            return candidates.find((candidate) => candidate?.target?.position === target.position) || null;
        }
        return null;
    }

    function targetIdentity(record) {
        if (!record) {
            return '';
        }

        const target = record.target || {};
        return target.messageId || target.turnTestId || `position:${target.position ?? ''}`;
    }

    function isMeaningfulProgress(previousValue, nextValue) {
        const next = normalizeRecord(nextValue);
        if (!next) {
            return false;
        }

        const previous = normalizeRecord(previousValue);
        if (!previous || previous.conversationKey !== next.conversationKey) {
            return true;
        }

        if (targetIdentity(previous) !== targetIdentity(next)) {
            return true;
        }

        if (Math.abs(previous.viewport.offsetPx - next.viewport.offsetPx) >= 18) {
            return true;
        }

        return Math.abs(previous.viewport.scrollRatio - next.viewport.scrollRatio) >= 0.002;
    }

    return Object.freeze({
        CONVERSATION_KEY_PREFIX,
        DEFAULT_SETTINGS,
        MESSAGE_NAMESPACE,
        RECORD_VERSION,
        SETTINGS_KEY,
        STORE_KEY,
        STORE_VERSION,
        alignedScrollTop,
        clamp,
        conversationIdFromUrl,
        conversationKeyFromUrl,
        createRecord,
        emptyStore,
        findRestoreCandidate,
        isMeaningfulProgress,
        normalizeRecord,
        normalizeSettings,
        normalizeStore,
        parseTurnPosition,
        ratioScrollTop,
        scrollRatio,
        shouldCaptureAutomatically,
        upsertRecord,
    });
});
