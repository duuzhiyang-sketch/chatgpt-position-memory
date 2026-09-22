'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'dist-chrome');
const files = [
    ['manifest.json', 'manifest.json'],
    ['src/background.js', 'background.js'],
    ['src/content.js', 'content.js'],
    ['src/shared/core.js', 'shared/core.js'],
    ['src/popup/index.html', 'popup/index.html'],
    ['src/popup/popup.css', 'popup/popup.css'],
    ['src/popup/popup.js', 'popup/popup.js'],
    ['assets/icon16.png', 'icons/icon16.png'],
    ['assets/icon32.png', 'icons/icon32.png'],
    ['assets/icon48.png', 'icons/icon48.png'],
    ['assets/icon128.png', 'icons/icon128.png'],
];

async function build() {
    await fs.mkdir(outputRoot, { recursive: true });

    for (const [sourceRelative, outputRelative] of files) {
        const source = path.join(projectRoot, sourceRelative);
        const output = path.join(outputRoot, outputRelative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.copyFile(source, output);
    }

    console.log(`Built ${files.length} files in ${outputRoot}`);
}

build().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
