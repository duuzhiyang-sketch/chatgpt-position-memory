'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'assets');
const sizes = [16, 32, 48, 128];
const palette = {
    teal: [15, 118, 110, 255],
    white: [236, 254, 255, 255],
    accent: [153, 246, 228, 255],
};

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
}

const crcTable = makeCrcTable();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;

    const scanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y += 1) {
        const targetOffset = y * (1 + width * 4);
        scanlines[targetOffset] = 0;
        pixels.copy(scanlines, targetOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    if (x < left || x > right || y < top || y > bottom) {
        return false;
    }

    const centerX = Math.min(Math.max(x, left + radius), right - radius);
    const centerY = Math.min(Math.max(y, top + radius), bottom - radius);
    return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
    let inside = false;
    for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
        const [currentX, currentY] = points[current];
        const [previousX, previousY] = points[previous];
        const intersects = (currentY > y) !== (previousY > y)
            && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function renderIcon(size) {
    const scale = 4;
    const width = size * scale;
    const samples = Buffer.alloc(width * width * 4);
    const shapes = [
        {
            color: palette.teal,
            contains: (x, y) => insideRoundedRect(x, y, 0, 0, 1, 1, 0.23),
        },
        {
            color: palette.white,
            contains: (x, y) => insideRoundedRect(x, y, 0.22, 0.23, 0.58, 0.47, 0.1),
        },
        {
            color: palette.accent,
            contains: (x, y) => insidePolygon(x, y, [[0.43, 0.67], [0.43, 0.83], [0.59, 0.67]]),
        },
        {
            color: palette.teal,
            contains: (x, y) => insideRoundedRect(x, y, 0.35, 0.38, 0.32, 0.065, 0.03),
        },
        {
            color: palette.teal,
            contains: (x, y) => insideRoundedRect(x, y, 0.35, 0.52, 0.23, 0.065, 0.03),
        },
    ];

    for (let y = 0; y < width; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const normalizedX = (x + 0.5) / width;
            const normalizedY = (y + 0.5) / width;
            let color = [0, 0, 0, 0];
            for (const shape of shapes) {
                if (shape.contains(normalizedX, normalizedY)) {
                    color = shape.color;
                }
            }
            const offset = (y * width + x) * 4;
            samples[offset] = color[0];
            samples[offset + 1] = color[1];
            samples[offset + 2] = color[2];
            samples[offset + 3] = color[3];
        }
    }

    const output = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const sums = [0, 0, 0, 0];
            for (let sampleY = 0; sampleY < scale; sampleY += 1) {
                for (let sampleX = 0; sampleX < scale; sampleX += 1) {
                    const sourceOffset = ((y * scale + sampleY) * width + x * scale + sampleX) * 4;
                    for (let channel = 0; channel < 4; channel += 1) {
                        sums[channel] += samples[sourceOffset + channel];
                    }
                }
            }
            const targetOffset = (y * size + x) * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                output[targetOffset + channel] = Math.round(sums[channel] / (scale * scale));
            }
        }
    }

    return encodePng(size, size, output);
}

for (const size of sizes) {
    fs.writeFileSync(path.join(outputDirectory, `icon${size}.png`), renderIcon(size));
}

console.log(`Generated ${sizes.length} original icons in ${outputDirectory}`);
