import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const releaseRoot = path.join(desktopDir, 'release');
const finalOutputDir = path.join(releaseRoot, 'portable');
const verifyScript = path.join(scriptDir, 'verify-portable.mjs');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${options.label ?? args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${options.label ?? command} failed with ${outcome}`));
    });
  });
}

function runNpm(args, label) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], { label });
  }

  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(command, args, {
    label,
    shell: process.platform === 'win32',
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function removeTemporaryDirectory(directory, label) {
  if (!directory) return;
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  } catch (error) {
    console.warn(`Warning: could not clean ${label} ${directory}: ${error.message}`);
  }
}

if (process.platform !== 'win32') {
  throw new Error('Windows Portable builds must run on Windows');
}

const signAndEditValue = process.env.KANITSU_SIGN_AND_EDIT_EXECUTABLE ?? 'false';
if (signAndEditValue !== 'true' && signAndEditValue !== 'false') {
  throw new Error('KANITSU_SIGN_AND_EDIT_EXECUTABLE must be true or false');
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
if (
  process.env.GITHUB_REF_TYPE === 'tag'
  && process.env.GITHUB_REF_NAME !== `v${desktopPackage.version}`
) {
  throw new Error(
    `Tag ${process.env.GITHUB_REF_NAME} does not match desktop version v${desktopPackage.version}`,
  );
}

const executableFilename = `Kanitsu-Portable-${desktopPackage.version}-x64.exe`;
const electronBuilderCli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
await stat(electronBuilderCli);

let stagingDir;
let publishDir;
try {
  await runNpm(['run', 'build:web'], 'Build production web bundle');
  await runNpm(['run', 'build:desktop'], 'Compile Electron main and preload code');

  stagingDir = await mkdtemp(path.join(desktopDir, '.portable-staging-'));
  const builderEnvironment = {
    ...process.env,
  };
  if (!builderEnvironment.ELECTRON_MIRROR && process.env.npm_config_electron_mirror) {
    builderEnvironment.ELECTRON_MIRROR = process.env.npm_config_electron_mirror;
  }
  if (
    !builderEnvironment.ELECTRON_BUILDER_BINARIES_MIRROR
    && process.env.npm_config_electron_builder_binaries_mirror
  ) {
    builderEnvironment.ELECTRON_BUILDER_BINARIES_MIRROR =
      process.env.npm_config_electron_builder_binaries_mirror;
  }
  await run(
    process.execPath,
    [
      electronBuilderCli,
      '--win',
      'portable',
      '--x64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
      `--config.win.signAndEditExecutable=${signAndEditValue}`,
      `--config.directories.output=${stagingDir}`,
    ],
    {
      cwd: desktopDir,
      env: builderEnvironment,
      label: `Package Portable x64 (resource editing: ${signAndEditValue})`,
    },
  );

  const stagingEntries = await readdir(stagingDir, { withFileTypes: true });
  const topLevelExecutables = stagingEntries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe',
  );
  if (topLevelExecutables.length !== 1 || topLevelExecutables[0].name !== executableFilename) {
    const found = topLevelExecutables.map((entry) => entry.name).join(', ') || 'none';
    throw new Error(`Expected only ${executableFilename} in staging; found: ${found}`);
  }

  await mkdir(releaseRoot, { recursive: true });
  publishDir = await mkdtemp(path.join(releaseRoot, '.portable-publish-'));
  await copyFile(
    path.join(stagingDir, executableFilename),
    path.join(publishDir, executableFilename),
  );
  await run(
    process.execPath,
    [verifyScript, '--output-dir', publishDir, '--write-checksum'],
    { label: 'Verify Portable artifact and generate SHA-256' },
  );

  await rm(finalOutputDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 500,
  });
  await rename(publishDir, finalOutputDir);
  publishDir = undefined;

  console.log(`\nPortable release ready: ${path.join(finalOutputDir, executableFilename)}`);
  console.log(`Checksum file: ${path.join(finalOutputDir, 'SHA256SUMS.txt')}`);
} finally {
  await removeTemporaryDirectory(publishDir, 'publish directory');
  await removeTemporaryDirectory(stagingDir, 'builder staging directory');
}
