'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));

test('manifest identifies the independent V0.1 project', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, '位置记忆');
    assert.equal(manifest.version, '0.1.1');
    assert.doesNotMatch(JSON.stringify(manifest), /AI-MarkDone|zhaoliangbin42/i);
});

test('manifest requests only local storage, automatic injection, active-tab, and ChatGPT host access', () => {
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
    assert.deepEqual(manifest.host_permissions, [
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
    ]);
    assert.equal(manifest.content_scripts.length, 1);
});

test('all extension icons are original local PNG assets', () => {
    for (const size of [16, 32, 48, 128]) {
        const file = fs.readFileSync(path.join(projectRoot, `assets/icon${size}.png`));
        assert.deepEqual(Array.from(file.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    }
});
