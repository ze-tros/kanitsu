import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const checksumFilename = 'SHA256SUMS.txt';
const minimumExecutableSize = 20 * 1024 * 1024;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function readOption(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex !== -1) {
    const value = process.argv[exactIndex + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  }

  const prefix = `${name}=`;
  const inlineOption = process.argv.find((argument) => argument.startsWith(prefix));
  return inlineOption?.slice(prefix.length);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

const [rootPackage, desktopPackage] = await Promise.all([
  readJson(path.join(repoRoot, 'package.json')),
  readJson(path.join(desktopDir, 'package.json')),
]);

if (rootPackage.version !== desktopPackage.version) {
  throw new Error(
    `Version mismatch: root is ${rootPackage.version}, desktop is ${desktopPackage.version}`,
  );
}

const tag = readOption('--tag')
  ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
if (tag && tag !== `v${desktopPackage.version}`) {
  throw new Error(`Tag ${tag} does not match desktop version v${desktopPackage.version}`);
}

const outputDirOption = readOption('--output-dir');
const artifactNameOption = readOption('--artifact-name');
const writeChecksum = process.argv.includes('--write-checksum');
const outputDir = outputDirOption
  ? path.resolve(outputDirOption)
  : path.join(desktopDir, 'release', 'portable');
const executableFilename = artifactNameOption ?? `Kanitsu-Portable-${desktopPackage.version}-x64.exe`;
const executablePath = path.join(outputDir, executableFilename);
const checksumPath = path.join(outputDir, checksumFilename);

let entries;
try {
  entries = await readdir(outputDir, { withFileTypes: true });
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(`Artifact output directory does not exist: ${outputDir}`);
  }
  throw error;
}

const executables = entries.filter(
  (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe',
);
if (executables.length !== 1 || executables[0].name !== executableFilename) {
  const found = executables.map((entry) => entry.name).join(', ') || 'none';
  throw new Error(`Expected only ${executableFilename}; found: ${found}`);
}

const allowedFiles = new Set([executableFilename, checksumFilename]);
const unexpectedEntries = entries.filter(
  (entry) => !entry.isFile() || !allowedFiles.has(entry.name),
);
if (unexpectedEntries.length > 0) {
  throw new Error(
    `Unexpected portable output entries: ${unexpectedEntries.map((entry) => entry.name).join(', ')}`,
  );
}

const executableStats = await stat(executablePath);
if (executableStats.size < minimumExecutableSize) {
  throw new Error(
    `${executableFilename} is unexpectedly small (${executableStats.size} bytes)`,
  );
}

const handle = await open(executablePath, 'r');
try {
  const dosHeader = Buffer.alloc(64);
  const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
  if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${executableFilename} does not have a valid Windows executable header`);
  }

  const peOffset = dosHeader.readUInt32LE(0x3c);
  if (peOffset < dosHeader.length || peOffset > executableStats.size - 24) {
    throw new Error(`${executableFilename} has an invalid PE header offset`);
  }

  const peHeader = Buffer.alloc(24);
  const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
  if (peRead.bytesRead !== peHeader.length || peHeader.toString('ascii', 0, 4) !== 'PE\0\0') {
    throw new Error(`${executableFilename} does not have a valid PE signature`);
  }

  const machine = peHeader.readUInt16LE(4);
  const sectionCount = peHeader.readUInt16LE(6);
  const optionalHeaderSize = peHeader.readUInt16LE(20);
  const characteristics = peHeader.readUInt16LE(22);
  const supportedMachine = machine === 0x014c || machine === 0x8664;
  const sectionTableEnd = peOffset + peHeader.length + optionalHeaderSize + sectionCount * 40;
  if (
    !supportedMachine
    || sectionCount < 1
    || sectionCount > 96
    || optionalHeaderSize < 2
    || optionalHeaderSize > 4096
    || (characteristics & 0x0002) === 0
    || sectionTableEnd > executableStats.size
  ) {
    throw new Error(`${executableFilename} has an invalid PE/COFF structure`);
  }

  const optionalMagicBuffer = Buffer.alloc(2);
  const optionalMagicRead = await handle.read(
    optionalMagicBuffer,
    0,
    optionalMagicBuffer.length,
    peOffset + peHeader.length,
  );
  const optionalMagic = optionalMagicBuffer.readUInt16LE(0);
  if (
    optionalMagicRead.bytesRead !== optionalMagicBuffer.length
    || (optionalMagic !== 0x010b && optionalMagic !== 0x020b)
  ) {
    throw new Error(`${executableFilename} has an invalid PE optional header`);
  }
} finally {
  await handle.close();
}

const digest = await sha256(executablePath);
const expectedChecksum = `${digest}  ${executableFilename}\n`;
if (writeChecksum) {
  await writeFile(checksumPath, expectedChecksum, 'ascii');
} else {
  let actualChecksum;
  try {
    actualChecksum = await readFile(checksumPath, 'ascii');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Checksum file does not exist: ${checksumPath}`);
    }
    throw error;
  }
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`${checksumFilename} does not match ${executableFilename}`);
  }
}

console.log(`Verified ${executableFilename} (${executableStats.size} bytes)`);
console.log(`SHA-256: ${digest}`);
