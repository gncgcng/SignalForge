import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const outputDir = fileURLToPath(new URL("../public/icons", import.meta.url));
mkdirSync(outputDir, { recursive: true });

for (const [name, size, safeArea] of [
  ["icon-192.png", 192, 0.12],
  ["icon-512.png", 512, 0.12],
  ["icon-maskable-512.png", 512, 0.2],
  ["apple-touch-icon.png", 180, 0.12]
]) {
  writeFileSync(join(outputDir, name), createIcon(size, safeArea));
}

function createIcon(size, safeArea) {
  const pixels = Buffer.alloc(size * size * 4);
  const padding = Math.round(size * safeArea);
  const radius = Math.round(size * 0.16);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const glow = Math.max(0, 1 - Math.hypot(x - size * 0.28, y - size * 0.18) / size);
      pixels[index] = Math.round(8 + glow * 3);
      pixels[index + 1] = Math.round(10 + glow * 22);
      pixels[index + 2] = Math.round(15 + glow * 29);
      pixels[index + 3] = 255;
    }
  }

  drawRoundedFrame(pixels, size, padding, radius);
  drawLetters(pixels, size, padding);
  return encodePng(size, size, pixels);
}

function drawRoundedFrame(pixels, size, padding, radius) {
  const thickness = Math.max(3, Math.round(size * 0.025));
  for (let y = padding; y < size - padding; y += 1) {
    for (let x = padding; x < size - padding; x += 1) {
      const outer = roundedRectContains(x, y, padding, padding, size - padding * 2, radius);
      const inner = roundedRectContains(
        x,
        y,
        padding + thickness,
        padding + thickness,
        size - (padding + thickness) * 2,
        Math.max(1, radius - thickness)
      );
      if (outer && !inner) setPixel(pixels, size, x, y, [34, 211, 238, 255]);
    }
  }
}

function drawLetters(pixels, size, padding) {
  const scale = Math.max(2, Math.floor((size - padding * 2) / 22));
  const glyphWidth = 5 * scale;
  const gap = 2 * scale;
  const totalWidth = glyphWidth * 2 + gap;
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - 7 * scale) / 2);
  drawGlyph(pixels, size, startX, startY, scale, [
    "11111", "10000", "10000", "11111", "00001", "00001", "11111"
  ], [244, 247, 251, 255]);
  drawGlyph(pixels, size, startX + glyphWidth + gap, startY, scale, [
    "11111", "10000", "10000", "11110", "10000", "10000", "10000"
  ], [248, 193, 74, 255]);
}

function drawGlyph(pixels, size, startX, startY, scale, glyph, color) {
  glyph.forEach((row, y) => {
    [...row].forEach((value, x) => {
      if (value !== "1") return;
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          setPixel(pixels, size, startX + x * scale + px, startY + y * scale + py, color);
        }
      }
    });
  });
}

function roundedRectContains(x, y, left, top, width, radius) {
  const right = left + width - 1;
  const bottom = top + width - 1;
  const closestX = Math.max(left + radius, Math.min(x, right - radius));
  const closestY = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - closestX) ** 2 + (y - closestY) ** 2 <= radius ** 2;
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (y * size + x) * 4;
  pixels.set(color, index);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
