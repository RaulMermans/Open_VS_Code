import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DESKTOP_ROOT = join(__dirname, '..');

export interface UpstreamSpec {
  distribution: string;
  version: string;
  vscodeVersion: string;
  upstreamCommit: string;
  platform: string;
  artifactName: string;
  downloadUrl: string;
  sha256: string;
  license: string;
}

export function resolveDesktopPlatform(): string {
  if (process.env.OPEN_VS_CODE_DESKTOP_PLATFORM) {
    return process.env.OPEN_VS_CODE_DESKTOP_PLATFORM;
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  return `${process.platform}-${process.arch}`;
}

export function upstreamSpecPath(platform = resolveDesktopPlatform()): string {
  if (platform === 'linux-x64') {
    return join(DESKTOP_ROOT, 'upstream.linux-x64.json');
  }
  return join(DESKTOP_ROOT, 'upstream.json');
}

export function loadUpstreamSpec(): UpstreamSpec {
  const specPath = upstreamSpecPath();
  if (!existsSync(specPath)) {
    throw new Error(`No pinned upstream spec for platform ${resolveDesktopPlatform()} at ${specPath}`);
  }
  return JSON.parse(readFileSync(specPath, 'utf8'));
}

export function computeSha256(filePath: string): string {
  const buffer = readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

export async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`[prepare] Downloading upstream shell from: ${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  mkdirSync(dirname(destPath), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(destPath, buffer);
  console.log(`[prepare] Download complete: ${destPath} (${buffer.length} bytes)`);
}

export async function prepareDesktopShell(): Promise<{
  spec: UpstreamSpec;
  stagedAppPath: string;
  cachedZipPath: string;
}> {
  const spec = loadUpstreamSpec();
  const cacheDir = join(DESKTOP_ROOT, 'cache');
  const stagingDir = join(DESKTOP_ROOT, 'staging');
  const cachedZipPath = join(cacheDir, spec.artifactName);
  const stagedAppPath = spec.platform.startsWith('linux')
    ? join(stagingDir, spec.platform)
    : join(stagingDir, 'VSCodium.app');

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  // 1. Download if not cached
  if (!existsSync(cachedZipPath)) {
    await downloadFile(spec.downloadUrl, cachedZipPath);
  } else {
    console.log(`[prepare] Found cached upstream shell at: ${cachedZipPath}`);
  }

  // 2. Verify SHA-256 checksum
  console.log(`[prepare] Verifying SHA-256 checksum...`);
  const actualHash = computeSha256(cachedZipPath);
  if (actualHash.toLowerCase() !== spec.sha256.toLowerCase()) {
    throw new Error(
      `SHA-256 checksum mismatch for ${cachedZipPath}!\nExpected: ${spec.sha256}\nActual:   ${actualHash}`
    );
  }
  console.log(`[prepare] SHA-256 verified: ${actualHash}`);

  // 3. Extract into staging if not already extracted
  if (!existsSync(stagedAppPath)) {
    console.log(`[prepare] Extracting shell into staging: ${stagingDir}...`);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    if (spec.artifactName.endsWith('.tar.gz')) {
      mkdirSync(stagedAppPath, { recursive: true });
      execSync(`tar -xzf "${cachedZipPath}" -C "${stagedAppPath}"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q "${cachedZipPath}" -d "${stagingDir}"`, { stdio: 'inherit' });
    }
    console.log(`[prepare] Extracted successfully to ${stagedAppPath}`);
  } else {
    console.log(`[prepare] Staged shell already present: ${stagedAppPath}`);
  }

  console.log(`==================================================`);
  console.log(`OPEN VS CODE DESKTOP SHELL PREPARED`);
  console.log(`Distribution:    ${spec.distribution}`);
  console.log(`Version:         ${spec.version} (VS Code ${spec.vscodeVersion})`);
  console.log(`Upstream Commit: ${spec.upstreamCommit}`);
  console.log(`License:         ${spec.license}`);
  console.log(`Staged App:      ${stagedAppPath}`);
  console.log(`==================================================`);

  return { spec, stagedAppPath, cachedZipPath };
}

// CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareDesktopShell().catch((err) => {
    console.error(`[prepare] FAILED:`, err);
    process.exit(1);
  });
}
