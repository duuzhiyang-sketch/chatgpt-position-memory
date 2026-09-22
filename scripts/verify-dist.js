'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'dist-chrome');
const expectedFiles = new Set([
    'background.js',
    'content.js',
    'icons/icon128.png',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'manifest.json',
    'popup/index.html',
    'popup/popup.css',
    'popup/popup.js',
    'shared/core.js',
]);

function listFiles(directory, relative = '') {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const nextRelative = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
            result.push(...listFiles(path.join(directory, entry.name), nextRelative));
        } else {
            result.push(nextRelative);
        }
    }
    return result.sort();
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

const actualFiles = listFiles(outputRoot);
assert(
    actualFiles.length === expectedFiles.size
        && actualFiles.every((file) => expectedFiles.has(file)),
    `Unexpected build contents: ${actualFiles.join(', ')}`,
);

const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
assert(manifest.manifest_version === 3, 'Manifest must use MV3');
assert(manifest.name === '位置记忆', 'Unexpected extension name');
assert(manifest.version === '0.1.1', 'Unexpected extension version');
assert(
    JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage']),
    'Extension permissions changed unexpectedly',
);
assert(
    manifest.host_permissions.every((value) => value.startsWith('https://chatgpt.com/')
        || value.startsWith('https://chat.openai.com/')),
    'Unexpected host permission',
);

const textFiles = actualFiles.filter((file) => !file.endsWith('.png'));
const text = textFiles
    .map((file) => fs.readFileSync(path.join(outputRoot, file), 'utf8'))
    .join('\n');
assert(!/AI-MarkDone|zhaoliangbin42/i.test(text), 'Build contains upstream project branding');
assert(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/i.test(text), 'Build contains a network client');
assert(!/<script[^>]*>\s*[^<\s]/i.test(text), 'Popup contains inline script');

console.log(`Verified Chrome MV3 package: ${actualFiles.length} files, no upstream branding, no network client`);
