// Generate app icons from the dsh favicon.svg:
//  - App icon (Dock): rounded-rect deep-blue background + white dsh mark
//  - Tray icon: white dsh mark on transparent (adapts to any menu bar)
//  - .icns via iconutil + .png sizes for electron-builder
'use strict';

const sharp = require('sharp');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'resources', 'favicon.svg');
const ICONSET = path.join(ROOT, 'resources', 'icon.iconset');
const OUT_DIR = path.join(ROOT, 'resources');

// Force white mark (the dsh mark renders dark-on-light; menus/Dock want white)
function whiteSvg() {
  let svg = fs.readFileSync(SVG, 'utf8');
  svg = svg.replace(/fill="#000"/g, 'fill="#fff"');
  // Strip the dark-mode media query so we keep the white mark deterministically.
  svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
  return Buffer.from(svg);
}

async function main() {
  fs.mkdirSync(ICONSET, { recursive: true });

  const white = whiteSvg();

  // --- App icon: rounded-rect canvas + centered white mark ---
  // The dsh mark fills ~96% of its 50x50 viewBox; we scale it into a
  // 70% box on a rounded-rect app-tile.
  const canvasSize = 1024;
  const tileBg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}">
       <rect x="0" y="0" width="${canvasSize}" height="${canvasSize}" rx="${canvasSize * 0.223}" fill="#1f2a44"/>
     </svg>`,
  );

  const markPx = Math.round(canvasSize * 0.62); // white mark occupies 62%
  const mark = await sharp(white)
    .resize(markPx, markPx, { fit: 'fill' })
    .toBuffer();

  const appIcon = await sharp(tileBg)
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();

  const appPng = path.join(OUT_DIR, 'app-icon.png');
  fs.writeFileSync(appPng, appIcon);
  console.log(`wrote ${appPng}`);

  // --- Tray icon (Template): white mark, transparent.
  // macOS menu bar standard: 18pt tall (1x) + 36px retina (2x). Electron's
  // Tray picks up the @2x suffix automatically on high-DPI displays.
  const traySizes = [[18, 'tray-icon.png'], [36, 'tray-icon@2x.png']];
  for (const [size, name] of traySizes) {
    const tray = await sharp(white).resize(size, size, { fit: 'fill' }).png().toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, name), tray);
    console.log(`wrote ${path.join(OUT_DIR, name)}`);
  }

  // --- iconset for .icns (macOS) ---
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    const base = s >= 1024 ? 'icon_512x512@2x' : `icon_${s}x${s}`;
    const target = s >= 1024 ? s : s; // 1x
    const name = s >= 1024 ? 'icon_512x512@2x.png' : `icon_${s}x${s}.png`;
    await sharp(appIcon).resize(target, target).png().toBuffer().then((buf) => {
      fs.writeFileSync(path.join(ICONSET, name), buf);
    });
    // also produce @2x entries for sizes below 512 where needed
  }
  // icon_16x16@2x.png = 32, icon_32x32@2x.png = 64, etc.
  const doubled = [[16, 32], [32, 64], [128, 256], [256, 512]];
  for (const [base, px] of doubled) {
    await sharp(appIcon).resize(px, px).png().toBuffer().then((buf) => {
      fs.writeFileSync(path.join(ICONSET, `icon_${base}x${base}@2x.png`), buf);
    });
  }

  // Build .icns
  const icnsPath = path.join(OUT_DIR, 'icon.icns');
  try {
    execSync(`iconutil -c icns "${ICONSET}" -o "${icnsPath}"`);
    console.log(`wrote ${icnsPath}`);
  } catch (err) {
    console.error('iconutil failed:', err.message);
  }

  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
