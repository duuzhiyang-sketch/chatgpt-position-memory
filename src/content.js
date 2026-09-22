(function startPositionMemoryContentScript() {
    'use strict';

    const Core = globalThis.PositionMemoryCore;
    if (!Core || globalThis.__positionMemoryStarted) {
        return;
    }
    globalThis.__positionMemoryStarted = true;

    const SAVE_DEBOUNCE_MS = 750;
    const AUTO_SNAPSHOT_MS = 2500;
    const RESTORE_TIMEOUT_MS = 15000;
    const RESTORE_SETTLE_MS = 650;
    const RESTORE_STABILITY_STEPS = 5;
    const RESTORE_STABILITY_STEP_MS = 180;
    const ROUTE_CHECK_MS = 500;
    const REFERENCE_Y_RATIO = 0.35;
    const SCROLL_KEYS = new Set([
        'ArrowDown',
        'ArrowUp',
        'End',
        'Home',
        'PageDown',
        'PageUp',
        ' ',
        'Spacebar',
    ]);

    const state = {
        conversationKey: null,
        settings: Core.normalizeSettings(),
        lastSavedRecord: null,
        pendingRecord: null,
        saveTimer: 0,
        captureFrame: 0,
        restoreRun: 0,
        restoring: false,
        needsRestore: false,
        routeChangedAt: 0,
        restoreBaselineSignature: null,
        toastHost: null,
        activeScroller: null,
    };

    function sendMessage(action, payload = {}) {
        return new Promise((resolve, reject) => {
            try {
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
                        reject(new Error(response?.error || 'No response from extension'));
                        return;
                    }
                    resolve(response.data);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async function safeMessage(action, payload = {}) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await sendMessage(action, payload);
            } catch {
                if (attempt === 0) {
                    await new Promise((resolve) => window.setTimeout(resolve, 120));
                }
            }
        }
        return null;
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    }

    function cancelRestoreForUserIntent() {
        state.needsRestore = false;
        if (state.restoring) {
            state.restoreRun += 1;
            state.restoring = false;
        }
    }

    function collectMessageElements() {
        const root = document.querySelector('main') || document;
        const elements = new Set();

        for (const element of root.querySelectorAll('[data-testid^="conversation-turn-"]')) {
            elements.add(element);
        }

        if (elements.size === 0) {
            for (const roleElement of root.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')) {
                const turn = roleElement.closest('[data-testid^="conversation-turn-"], article')
                    || roleElement.parentElement;
                if (turn) {
                    elements.add(turn);
                }
            }
        }

        return Array.from(elements)
            .filter((element) => element.isConnected)
            .sort((left, right) => {
                if (left === right) {
                    return 0;
                }
                return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
    }

    function firstAttribute(element, attributeName) {
        const ownValue = element.getAttribute(attributeName);
        if (ownValue) {
            return ownValue;
        }

        const descendant = element.querySelector(`[${attributeName}]`);
        return descendant?.getAttribute(attributeName) || undefined;
    }

    function describeMessage(element, fallbackPosition) {
        const turnTestId = firstAttribute(element, 'data-testid');
        const parsedPosition = Core.parseTurnPosition(turnTestId);
        const messageId = firstAttribute(element, 'data-message-id')
            || firstAttribute(element, 'data-turn-id');
        const roleValue = firstAttribute(element, 'data-message-author-role');
        const target = {
            position: parsedPosition ?? fallbackPosition,
        };

        if (messageId) {
            target.messageId = messageId;
        }
        if (turnTestId) {
            target.turnTestId = turnTestId;
        }
        if (roleValue === 'user' || roleValue === 'assistant') {
            target.role = roleValue;
        }

        return target;
    }

    function conversationDomSignature(messages = collectMessageElements()) {
        const identities = messages.map((element, index) => {
            const target = describeMessage(element, index);
            return target.messageId || target.turnTestId || `position:${target.position}`;
        });
        const edges = identities.length <= 6
            ? identities
            : [...identities.slice(0, 3), ...identities.slice(-3)];
        return `${identities.length}:${edges.join('|')}`;
    }

    function isScrollableElement(element) {
        if (!(element instanceof Element)) {
            return false;
        }

        const style = getComputedStyle(element);
        const permitsScroll = /(auto|scroll|overlay)/.test(style.overflowY);
        return permitsScroll && element.scrollHeight - element.clientHeight > 48;
    }

    function findConversationScroller(messages) {
        const candidates = new Set();
        const sampledMessages = messages.length > 2
            ? [messages[0], messages[Math.floor(messages.length / 2)], messages[messages.length - 1]]
            : messages;

        for (const message of sampledMessages) {
            let current = message.parentElement;
            while (current && current !== document.body) {
                if (isScrollableElement(current)) {
                    candidates.add(current);
                }
                current = current.parentElement;
            }
        }

        let best = null;
        let bestScore = -1;
        for (const candidate of candidates) {
            const range = candidate.scrollHeight - candidate.clientHeight;
            const score = range + candidate.clientHeight * 0.25;
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }

        return best || document.scrollingElement || document.documentElement;
    }

    function isDocumentScroller(scroller) {
        return scroller === document.scrollingElement
            || scroller === document.documentElement
            || scroller === document.body;
    }

    function scrollerMetrics(scroller) {
        if (isDocumentScroller(scroller)) {
            const scrollElement = document.scrollingElement || document.documentElement;
            return {
                top: 0,
                height: Math.max(1, window.innerHeight),
                scrollTop: window.scrollY || scrollElement.scrollTop || 0,
                scrollHeight: scrollElement.scrollHeight,
                clientHeight: Math.max(1, window.innerHeight),
            };
        }

        const rect = scroller.getBoundingClientRect();
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        return {
            top,
            height: Math.max(1, bottom - top || scroller.clientHeight),
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
        };
    }

    function setScrollerTop(scroller, value) {
        const metrics = scrollerMetrics(scroller);
        const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
        const next = Core.clamp(value, 0, maximum);

        if (isDocumentScroller(scroller)) {
            window.scrollTo({ top: next, behavior: 'auto' });
        } else {
            scroller.scrollTo({ top: next, behavior: 'auto' });
        }
    }

    function captureProgressRecord() {
        const liveConversationKey = Core.conversationKeyFromUrl(location.href);
        if (
            !state.conversationKey
            || liveConversationKey !== state.conversationKey
            || !state.settings.enabled
        ) {
            return null;
        }

        const messages = collectMessageElements();
        if (messages.length === 0) {
            return null;
        }

        const scroller = findConversationScroller(messages);
        const metrics = scrollerMetrics(scroller);
        const referenceY = metrics.top + metrics.height * REFERENCE_Y_RATIO;
        let selected = null;
        let selectedDistance = Infinity;

        messages.forEach((message, index) => {
            const rect = message.getBoundingClientRect();
            if (rect.height <= 0) {
                return;
            }

            const distance = referenceY < rect.top
                ? rect.top - referenceY
                : referenceY > rect.bottom
                    ? referenceY - rect.bottom
                    : 0;
            if (distance < selectedDistance) {
                selected = { element: message, index, rect };
                selectedDistance = distance;
            }
        });

        if (!selected) {
            return null;
        }

        return Core.createRecord({
            conversationKey: state.conversationKey,
            target: describeMessage(selected.element, selected.index),
            viewport: {
                referenceYRatio: REFERENCE_Y_RATIO,
                offsetPx: referenceY - selected.rect.top,
                scrollRatio: Core.scrollRatio(
                    metrics.scrollTop,
                    metrics.scrollHeight,
                    metrics.clientHeight,
                ),
            },
        });
    }

    function queueProgressCapture() {
        if (state.captureFrame) {
            return;
        }

        state.captureFrame = requestAnimationFrame(() => {
            state.captureFrame = 0;
            const record = captureProgressRecord();
            if (record) {
                state.pendingRecord = record;
            }

            window.clearTimeout(state.saveTimer);
            state.saveTimer = window.setTimeout(flushPendingRecord, SAVE_DEBOUNCE_MS);
        });
    }

    function flushPendingRecord() {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = 0;

        const record = state.pendingRecord;
        state.pendingRecord = null;
        if (!record || !Core.isMeaningfulProgress(state.lastSavedRecord, record)) {
            return;
        }

        void safeMessage('progress:upsert', { record }).then((saved) => {
            const normalized = Core.normalizeRecord(saved, record.conversationKey);
            if (normalized && (!state.lastSavedRecord || normalized.recordedAt >= state.lastSavedRecord.recordedAt)) {
                state.lastSavedRecord = normalized;
            } else if (record.conversationKey === state.conversationKey && state.settings.enabled) {
                state.pendingRecord = record;
                window.clearTimeout(state.saveTimer);
                state.saveTimer = window.setTimeout(flushPendingRecord, 1000);
            }
        });
    }

    function onScroll() {
        checkRoute();
        if (!state.settings.enabled || state.restoring || state.needsRestore) {
            return;
        }

        queueProgressCapture();
    }

    function refreshScrollerBinding() {
        const messages = collectMessageElements();
        const nextScroller = messages.length > 0 ? findConversationScroller(messages) : null;
        const directScroller = nextScroller && !isDocumentScroller(nextScroller) ? nextScroller : null;

        if (directScroller === state.activeScroller) {
            return;
        }
        if (state.activeScroller) {
            state.activeScroller.removeEventListener('scroll', onScroll);
        }
        state.activeScroller = directScroller;
        if (state.activeScroller) {
            state.activeScroller.addEventListener('scroll', onScroll, { passive: true });
        }
    }

    function captureVisiblePositionAutomatically() {
        checkRoute();
        refreshScrollerBinding();
        if (Core.shouldCaptureAutomatically({
            visible: document.visibilityState === 'visible',
            enabled: state.settings.enabled,
            conversationKey: state.conversationKey,
            restoring: state.restoring,
            needsRestore: state.needsRestore,
        })) {
            queueProgressCapture();
        }
    }

    function onKeyDown(event) {
        if (!SCROLL_KEYS.has(event.key) || isEditableTarget(event.target)) {
            return;
        }
        cancelRestoreForUserIntent();
    }

    function onWheelOrTouch() {
        cancelRestoreForUserIntent();
    }

    function locateTarget(messages, record) {
        const descriptions = messages.map((element, index) => ({
            element,
            target: describeMessage(element, index),
        }));

        return Core.findRestoreCandidate(descriptions, record.target);
    }

    function alignTarget(scroller, element, viewport) {
        const metrics = scrollerMetrics(scroller);
        const rect = element.getBoundingClientRect();
        setScrollerTop(scroller, Core.alignedScrollTop({
            scrollTop: metrics.scrollTop,
            scrollHeight: metrics.scrollHeight,
            clientHeight: metrics.clientHeight,
            targetTop: rect.top,
            viewportTop: metrics.top,
            viewportHeight: metrics.height,
            referenceYRatio: viewport.referenceYRatio,
            offsetPx: viewport.offsetPx,
        }));
    }

    function applyRatio(scroller, ratio) {
        const metrics = scrollerMetrics(scroller);
        const range = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
        if (range <= 0) {
            return false;
        }
        setScrollerTop(scroller, Core.ratioScrollTop(
            ratio,
            metrics.scrollHeight,
            metrics.clientHeight,
        ));
        return true;
    }

    function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function stabilizeTarget(scroller, element, viewport, run, conversationKey) {
        for (let step = 0; step < RESTORE_STABILITY_STEPS; step += 1) {
            if (
                run !== state.restoreRun
                || state.conversationKey !== conversationKey
                || !element.isConnected
            ) {
                return false;
            }
            alignTarget(scroller, element, viewport);
            await wait(RESTORE_STABILITY_STEP_MS);
        }
        return run === state.restoreRun && element.isConnected;
    }

    function removeToast() {
        if (state.toastHost) {
            state.toastHost.remove();
            state.toastHost = null;
        }
    }

    function showRestoreNotice(text) {
        if (!state.settings.showRestoreNotice || !document.documentElement) {
            return;
        }

        removeToast();
        const host = document.createElement('div');
        host.setAttribute('data-position-memory-ui', 'restore-notice');
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            .notice {
                position: fixed;
                top: 18px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                box-sizing: border-box;
                max-width: min(420px, calc(100vw - 32px));
                padding: 10px 14px;
                border: 1px solid rgba(15, 118, 110, 0.32);
                border-radius: 999px;
                background: rgba(240, 253, 250, 0.96);
                box-shadow: 0 8px 28px rgba(15, 23, 42, 0.16);
                color: #115e59;
                font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                text-align: center;
                backdrop-filter: blur(8px);
                pointer-events: none;
                animation: enter 160ms ease-out both;
            }
            @keyframes enter {
                from { opacity: 0; transform: translate(-50%, -6px); }
                to { opacity: 1; transform: translate(-50%, 0); }
            }
            @media (prefers-color-scheme: dark) {
                .notice {
                    border-color: rgba(45, 212, 191, 0.34);
                    background: rgba(19, 78, 74, 0.96);
                    color: #ccfbf1;
                }
            }
            @media (prefers-reduced-motion: reduce) {
                .notice { animation: none; }
            }
        `;
        const notice = document.createElement('div');
        notice.className = 'notice';
        notice.textContent = text;
        shadow.append(style, notice);
        document.documentElement.append(host);
        state.toastHost = host;
        window.setTimeout(() => {
            if (state.toastHost === host) {
                removeToast();
            }
        }, 2600);
    }

    async function restoreCurrentConversation() {
        const conversationKey = state.conversationKey;
        if (!conversationKey || !state.settings.enabled || document.visibilityState !== 'visible') {
            return;
        }

        state.needsRestore = false;
        const run = ++state.restoreRun;
        state.restoring = true;
        const recordValue = await safeMessage('progress:get', { conversationKey });
        const record = Core.normalizeRecord(recordValue, conversationKey);

        if (run !== state.restoreRun || state.conversationKey !== conversationKey || !state.settings.enabled) {
            state.restoring = false;
            return;
        }
        if (!record) {
            state.lastSavedRecord = null;
            state.restoring = false;
            return;
        }

        state.lastSavedRecord = record;
        const settleRemaining = state.routeChangedAt + RESTORE_SETTLE_MS - Date.now();
        if (settleRemaining > 0) {
            await wait(settleRemaining);
        }
        if (run !== state.restoreRun || state.conversationKey !== conversationKey) {
            return;
        }

        const deadline = Date.now() + RESTORE_TIMEOUT_MS;
        let ratioApplied = false;
        let attempts = 0;

        while (Date.now() < deadline && run === state.restoreRun && state.conversationKey === conversationKey) {
            if (document.visibilityState !== 'visible') {
                await wait(250);
                continue;
            }

            const messages = collectMessageElements();
            if (messages.length > 0) {
                if (state.restoreBaselineSignature) {
                    const currentSignature = conversationDomSignature(messages);
                    if (currentSignature === state.restoreBaselineSignature) {
                        attempts += 1;
                        await wait(200);
                        continue;
                    }
                    state.restoreBaselineSignature = null;
                }

                const scroller = findConversationScroller(messages);
                const located = locateTarget(messages, record);
                if (located) {
                    const stable = await stabilizeTarget(
                        scroller,
                        located.element,
                        record.viewport,
                        run,
                        conversationKey,
                    );
                    if (stable) {
                        state.restoring = false;
                        showRestoreNotice('已自动恢复到上次阅读位置');
                        return;
                    }
                    continue;
                }

                if (!ratioApplied || attempts % 4 === 0) {
                    ratioApplied = applyRatio(scroller, record.viewport.scrollRatio) || ratioApplied;
                }
            }

            attempts += 1;
            await wait(320);
        }

        if (run === state.restoreRun) {
            state.restoring = false;
            if (ratioApplied) {
                showRestoreNotice('已恢复到接近上次的位置');
            }
        }
    }

    function scheduleRestore() {
        if (!state.settings.enabled || !state.conversationKey) {
            return;
        }
        state.needsRestore = true;
        if (document.visibilityState === 'visible') {
            void restoreCurrentConversation();
        }
    }

    function switchConversation(nextKey) {
        if (nextKey === state.conversationKey) {
            return;
        }

        const previousKey = state.conversationKey;
        const previousSignature = previousKey ? conversationDomSignature() : null;
        flushPendingRecord();
        state.restoreRun += 1;
        state.restoring = false;
        state.needsRestore = false;
        state.lastSavedRecord = null;
        state.conversationKey = nextKey;
        state.routeChangedAt = Date.now();
        state.restoreBaselineSignature = previousSignature;
        removeToast();

        if (nextKey) {
            scheduleRestore();
        }
    }

    function checkRoute() {
        switchConversation(Core.conversationKeyFromUrl(location.href));
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            const record = captureProgressRecord();
            if (record) {
                state.pendingRecord = record;
            }
            flushPendingRecord();
            return;
        }

        if (state.needsRestore) {
            void restoreCurrentConversation();
        }
    }

    function onPageHide() {
        const record = captureProgressRecord();
        if (record) {
            state.pendingRecord = record;
        }
        flushPendingRecord();
    }

    function onStorageChanged(changes, areaName) {
        if (areaName !== 'local' || !changes[Core.SETTINGS_KEY]) {
            return;
        }

        const previousEnabled = state.settings.enabled;
        state.settings = Core.normalizeSettings(changes[Core.SETTINGS_KEY].newValue);
        if (!state.settings.enabled) {
            state.restoreRun += 1;
            state.restoring = false;
            state.needsRestore = false;
            state.pendingRecord = null;
            window.clearTimeout(state.saveTimer);
            removeToast();
        } else if (!previousEnabled && state.conversationKey) {
            scheduleRestore();
        }
    }

    function onRuntimeMessage(message, _sender, sendResponse) {
        if (!message || message.namespace !== Core.MESSAGE_NAMESPACE || message.action !== 'content:status') {
            return false;
        }

        const newestRecord = state.pendingRecord || state.lastSavedRecord;
        sendResponse({
            ok: true,
            data: {
                loaded: true,
                conversationKey: state.conversationKey,
                enabled: state.settings.enabled,
                restoring: state.restoring,
                recordedAt: newestRecord?.recordedAt || null,
            },
        });
        return false;
    }

    async function initialize() {
        const settings = await safeMessage('settings:get');
        state.settings = Core.normalizeSettings(settings);

        document.addEventListener('wheel', onWheelOrTouch, { capture: true, passive: true });
        document.addEventListener('touchmove', onWheelOrTouch, { capture: true, passive: true });
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('popstate', checkRoute);
        window.addEventListener('hashchange', checkRoute);
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibilityChange);
        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.runtime.onMessage.addListener(onRuntimeMessage);

        checkRoute();
        refreshScrollerBinding();
        window.setInterval(checkRoute, ROUTE_CHECK_MS);
        window.setInterval(captureVisiblePositionAutomatically, AUTO_SNAPSHOT_MS);
    }

    void initialize();
})();
