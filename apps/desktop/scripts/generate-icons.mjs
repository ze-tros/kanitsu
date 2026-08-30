import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../../..');
const assetsDir = path.join(rootDir, 'assets');
const sourceIconPath = path.join(assetsDir, 'kanitsu-icon.svg');
const webPublicDir = path.join(rootDir, 'apps/web/public');
const androidResDir = path.join(rootDir, 'apps/mobile/android/app/src/main/res');
const androidAdaptiveDir = path.join(androidResDir, 'mipmap-anydpi-v26');
const androidValuesDir = path.join(androidResDir, 'values');
const previewDir = path.join(assetsDir, 'previews');

const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/kanitsu_icon_background" />
    <foreground android:drawable="@mipmap/kanitsu_icon_foreground" />
</adaptive-icon>
`;

const androidColorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="kanitsu_icon_background">#00000000</color>
</resources>
`;

const pngOptions = {
  compressionLevel: 9,
  adaptiveFiltering: true,
};

const densities = {
  mdpi: { launcher: 48, foreground: 108 },
  hdpi: { launcher: 72, foreground: 162 },
  xhdpi: { launcher: 96, foreground: 216 },
  xxhdpi: { launcher: 144, foreground: 324 },
  xxxhdpi: { launcher: 192, foreground: 432 },
};

function renderPng(inputPath, outputPath, size) {
  return sharp(inputPath)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png(pngOptions)
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
    const buffer = await sharp(iconPath)
      .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
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
  const sourceMetadata = await sharp(sourceIconPath).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw new Error(`Unable to read icon source dimensions: ${sourceIconPath}`);
  }
  if (sourceMetadata.width !== sourceMetadata.height) {
    throw new Error(
      `Icon source must be square, got ${sourceMetadata.width}x${sourceMetadata.height}: ${sourceIconPath}`,
    );
  }

  const masterPngPath = path.join(assetsDir, 'kanitsu-icon.png');
  const icoPath = path.join(assetsDir, 'kanitsu-icon.ico');
  const faviconPath = path.join(webPublicDir, 'favicon.png');
  const favicon32Path = path.join(webPublicDir, 'favicon-32.png');
  const appleTouchIconPath = path.join(webPublicDir, 'apple-touch-icon.png');
  const obsoleteGeneratedPaths = [
    path.join(androidResDir, 'drawable-nodpi', 'kanitsu_icon_foreground.png'),
  ];

  await Promise.all([
    mkdir(assetsDir, { recursive: true }),
    mkdir(webPublicDir, { recursive: true }),
    mkdir(androidAdaptiveDir, { recursive: true }),
    mkdir(androidValuesDir, { recursive: true }),
    mkdir(previewDir, { recursive: true }),
    ...obsoleteGeneratedPaths.map((filePath) => rm(filePath, { force: true })),
  ]);

  await Promise.all([
    renderPng(sourceIconPath, masterPngPath, 1024),
    renderPng(sourceIconPath, faviconPath, 256),
    renderPng(sourceIconPath, favicon32Path, 32),
    renderPng(sourceIconPath, appleTouchIconPath, 180),
    writeFile(path.join(androidAdaptiveDir, 'kanitsu_launcher.xml'), adaptiveIconXml),
    writeFile(path.join(androidAdaptiveDir, 'kanitsu_launcher_round.xml'), adaptiveIconXml),
    writeFile(path.join(androidValuesDir, 'kanitsu_colors.xml'), androidColorsXml),
  ]);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoFrames = await Promise.all(icoSizes.map(async (size) => ({
    size,
    buffer: await sharp(sourceIconPath)
      .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png(pngOptions)
      .toBuffer(),
  })));
  await writeFile(icoPath, buildIco(icoFrames));

  for (const [density, sizes] of Object.entries(densities)) {
    const densityDir = path.join(androidResDir, `mipmap-${density}`);
    await mkdir(densityDir, { recursive: true });
    await Promise.all([
      renderPng(sourceIconPath, path.join(densityDir, 'kanitsu_launcher.png'), sizes.launcher),
      renderPng(sourceIconPath, path.join(densityDir, 'kanitsu_launcher_round.png'), sizes.launcher),
      renderPng(sourceIconPath, path.join(densityDir, 'kanitsu_icon_foreground.png'), sizes.foreground),
    ]);
  }

  await createPreview(masterPngPath, path.join(previewDir, 'kanitsu-icon-sizes.png'));

  console.log('Kanitsu icon assets generated from the vector source.');
  console.log(`Source: ${sourceIconPath}`);
  console.log(`Master PNG: ${masterPngPath}`);
}

await main();
