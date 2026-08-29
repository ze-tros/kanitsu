import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../../..');

const palette = {
  background: '#181A1F',
  backgroundEdge: '#2A2E37',
  rear: '#C8C1B4',
  middle: '#68749A',
  front: '#E7E3D9',
  tab: '#C46B5C',
};

const shadowDefs = `
  <defs>
    <filter id="card-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000000" flood-opacity="0.20" />
    </filter>
  </defs>`;

const mark = `
  <g id="kanitsu-mark" shape-rendering="geometricPrecision">
    <rect x="184" y="416" width="480" height="420" rx="34" fill="${palette.rear}" filter="url(#card-shadow)" />
    <rect x="282" y="306" width="462" height="474" rx="34" fill="${palette.middle}" filter="url(#card-shadow)" />
    <rect x="754" y="418" width="46" height="106" rx="18" fill="${palette.tab}" />
    <path
      d="M468 194H766A34 34 0 0 1 800 228V398C800 410 795 418 785 424L771 433C763 438 758 447 758 457V483C758 493 763 502 771 507L785 516C795 522 800 530 800 542V684A34 34 0 0 1 766 718H468A34 34 0 0 1 434 684V228A34 34 0 0 1 468 194Z"
      fill="${palette.front}"
      filter="url(#card-shadow)"
    />
  </g>`;

const backgroundSquircle = `
  <path
    d="M248 24C112 24 24 112 24 248V776C24 912 112 1000 248 1000H776C912 1000 1000 912 1000 776V248C1000 112 912 24 776 24H248Z"
    fill="${palette.background}"
    stroke="${palette.backgroundEdge}"
    stroke-width="2"
  />`;

const backgroundCircle = `
  <circle cx="512" cy="512" r="488" fill="${palette.background}" />`;

function wrapSvg(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
${shadowDefs}
${content}
</svg>
`;
}

const appIconSvg = wrapSvg(`${backgroundSquircle}\n${mark}`);
const roundIconSvg = wrapSvg(`${backgroundCircle}\n${mark}`);
const foregroundSvg = wrapSvg(mark);

const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/kanitsu_icon_background" />
    <foreground android:drawable="@mipmap/kanitsu_icon_foreground" />
</adaptive-icon>
`;

const androidColorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="kanitsu_icon_background">${palette.background}</color>
</resources>
`;

async function renderPng(svg, outputPath, size) {
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
}

function buildIco(frames) {
  const headerSize = 6;
  const entrySize = 16;
  const imageOffset = headerSize + entrySize * frames.length;
  const header = Buffer.alloc(imageOffset);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  let offset = imageOffset;
  frames.forEach(({ size, buffer }, index) => {
    const entryOffset = headerSize + index * entrySize;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(buffer.length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += buffer.length;
  });

  return Buffer.concat([header, ...frames.map(({ buffer }) => buffer)]);
}

async function createPreview(iconPath, outputPath) {
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const canvasWidth = 1024;
  const canvasHeight = 360;
  const padding = 44;
  const gap = 34;
  let x = padding;
  const composites = [];

  for (const size of sizes) {
    const buffer = await sharp(iconPath).resize(size, size).png().toBuffer();
    const top = Math.round((canvasHeight - size) / 2) - 12;
    composites.push({ input: buffer, left: x, top });

    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(size, 52)}" height="28">
      <text x="50%" y="19" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="14" fill="#5C6069">${size}px</text>
    </svg>`);
    composites.push({ input: label, left: x + Math.floor((size - Math.max(size, 52)) / 2), top: canvasHeight - 42 });
    x += size + gap;
  }

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: '#F2F0EA',
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function main() {
  const assetsDir = path.join(rootDir, 'assets');
  const webPublicDir = path.join(rootDir, 'apps/web/public');
  const androidResDir = path.join(rootDir, 'apps/mobile/android/app/src/main/res');
  const androidAdaptiveDir = path.join(androidResDir, 'mipmap-anydpi-v26');
  const androidValuesDir = path.join(androidResDir, 'values');
  const obsoleteAndroidForegroundPath = path.join(
    androidResDir,
    'drawable-nodpi',
    'kanitsu_icon_foreground.png',
  );
  const previewDir = path.join(rootDir, 'assets/previews');

  await Promise.all([
    mkdir(assetsDir, { recursive: true }),
    mkdir(webPublicDir, { recursive: true }),
    mkdir(androidAdaptiveDir, { recursive: true }),
    mkdir(androidValuesDir, { recursive: true }),
    mkdir(previewDir, { recursive: true }),
  ]);

  const masterSvgPath = path.join(assetsDir, 'kanitsu-icon.svg');
  const foregroundSvgPath = path.join(assetsDir, 'kanitsu-icon-foreground.svg');
  const masterPngPath = path.join(assetsDir, 'kanitsu-icon.png');

  await Promise.all([
    writeFile(masterSvgPath, appIconSvg),
    writeFile(foregroundSvgPath, foregroundSvg),
    writeFile(path.join(webPublicDir, 'favicon.svg'), appIconSvg),
    writeFile(path.join(androidAdaptiveDir, 'kanitsu_launcher.xml'), adaptiveIconXml),
    writeFile(path.join(androidAdaptiveDir, 'kanitsu_launcher_round.xml'), adaptiveIconXml),
    writeFile(path.join(androidValuesDir, 'kanitsu_colors.xml'), androidColorsXml),
    rm(obsoleteAndroidForegroundPath, { force: true }),
  ]);

  await Promise.all([
    renderPng(appIconSvg, masterPngPath, 1024),
    renderPng(appIconSvg, path.join(webPublicDir, 'favicon-32.png'), 32),
  ]);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoFrames = await Promise.all(icoSizes.map(async (size) => ({
    size,
    buffer: await sharp(Buffer.from(appIconSvg))
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  })));
  await writeFile(path.join(assetsDir, 'kanitsu-icon.ico'), buildIco(icoFrames));

  const densities = {
    mdpi: { launcher: 48, foreground: 108 },
    hdpi: { launcher: 72, foreground: 162 },
    xhdpi: { launcher: 96, foreground: 216 },
    xxhdpi: { launcher: 144, foreground: 324 },
    xxxhdpi: { launcher: 192, foreground: 432 },
  };

  for (const [density, sizes] of Object.entries(densities)) {
    const densityDir = path.join(androidResDir, `mipmap-${density}`);
    await mkdir(densityDir, { recursive: true });
    await Promise.all([
      renderPng(appIconSvg, path.join(densityDir, 'kanitsu_launcher.png'), sizes.launcher),
      renderPng(roundIconSvg, path.join(densityDir, 'kanitsu_launcher_round.png'), sizes.launcher),
      renderPng(
        foregroundSvg,
        path.join(densityDir, 'kanitsu_icon_foreground.png'),
        sizes.foreground,
      ),
    ]);
  }

  await createPreview(masterPngPath, path.join(previewDir, 'kanitsu-icon-sizes.png'));

  console.log('Kanitsu icon assets generated.');
  console.log(`Master SVG: ${masterSvgPath}`);
  console.log(`Master PNG: ${masterPngPath}`);
}

await main();
