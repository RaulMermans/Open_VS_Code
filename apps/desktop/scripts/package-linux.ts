import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareDesktopShell, type UpstreamSpec } from './prepare.js';
import { bundleOpenVSCodeExtension, mergeProductJson } from './bundle-extension.js';
import { PRODUCT_VERSION } from './product-version.js';

export interface LinuxPackageResult {
  appPath: string;
  archivePath: string;
  archiveSha256: string;
  bundleIdentifier: string;
  productName: string;
  extensionId: string;
  signingStatus: string;
  spec: UpstreamSpec;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DESKTOP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(DESKTOP_ROOT, '..', '..');

function writeLinuxLauncher(binDir: string, electronName: string): void {
  const launcherPath = join(binDir, 'open-vs-code');
  const script = `#!/usr/bin/env bash
set -euo pipefail
# A parent VS Code or Cursor terminal exports ELECTRON_RUN_AS_NODE=1.
# Leave it set only for the CLI handoff below; never inherit it into the GUI.
unset ELECTRON_RUN_AS_NODE
# Launching this desktop app is the operator authorization to call the
# workspace's configured local endpoint. It does not enable cloud inference.
export OPEN_VS_CODE_REAL_INFERENCE=1
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$ROOT/${electronName}"
CLI="$ROOT/resources/app/out/cli.js"
if [ ! -x "$ELECTRON" ]; then
  echo "open-vs-code: missing Electron binary at $ELECTRON" >&2
  exit 127
fi
if [ -f "$CLI" ]; then
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
  exit $?
fi
exec "$ELECTRON" "$@"
`;
  writeFileSync(launcherPath, script, { mode: 0o755 });
}

function buildDeb(payloadDir: string, distDir: string, archiveSha256: string): string | undefined {
  const debRoot = join(distDir, `open-vs-code_${PRODUCT_VERSION}_amd64`);
  rmSync(debRoot, { recursive: true, force: true });
  const libDir = join(debRoot, 'usr', 'lib', 'open-vs-code');
  const binDir = join(debRoot, 'usr', 'bin');
  const appsDir = join(debRoot, 'usr', 'share', 'applications');
  const iconDir = join(debRoot, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps');
  const debianDir = join(debRoot, 'DEBIAN');
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(appsDir, { recursive: true });
  mkdirSync(iconDir, { recursive: true });
  mkdirSync(debianDir, { recursive: true });

  execSync(`cp -a "${payloadDir}/." "${libDir}/"`);
  writeFileSync(
    join(binDir, 'open-vs-code'),
    `#!/usr/bin/env bash\nexec /usr/lib/open-vs-code/bin/open-vs-code "$@"\n`,
    { mode: 0o755 },
  );
  cpSync(join(DESKTOP_ROOT, 'branding', 'open-vs-code.desktop'), join(appsDir, 'open-vs-code.desktop'));
  const iconSrc = join(DESKTOP_ROOT, 'branding', 'icon.png');
  if (existsSync(iconSrc)) {
    cpSync(iconSrc, join(iconDir, 'open-vs-code.png'));
  }

  const installedSize = execSync(`du -sk "${debRoot}/usr" | cut -f1`).toString().trim();
  writeFileSync(
    join(debianDir, 'control'),
    [
      'Package: open-vs-code',
      `Version: ${PRODUCT_VERSION}`,
      'Section: devel',
      'Priority: optional',
      'Architecture: amd64',
      'Maintainer: Open VS Code <noreply@localhost>',
      `Installed-Size: ${installedSize}`,
      'Depends: libgtk-3-0, libnss3, libxss1, libasound2t64 | libasound2, libgbm1, libdrm2',
      'Description: Local-first AI coding agent on a VSCodium shell',
      ' Open VS Code bundles the local agent extension into a pinned VSCodium',
      ` Linux build. Payload SHA-256: ${archiveSha256}`,
      '',
    ].join('\n'),
  );
  chmodSync(join(debianDir, 'control'), 0o644);
  writeFileSync(
    join(debianDir, 'postinst'),
    [
      '#!/bin/sh',
      'set -e',
      'SANDBOX=/usr/lib/open-vs-code/chrome-sandbox',
      'if [ -f "$SANDBOX" ]; then',
      '  chown root:root "$SANDBOX"',
      '  chmod 4755 "$SANDBOX"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  if (!existsSync('/usr/bin/dpkg-deb')) {
    console.log('[package] dpkg-deb is not installed; wrote Debian tree without building .deb');
    return undefined;
  }
  const debPath = join(distDir, `open-vs-code_${PRODUCT_VERSION}_amd64.deb`);
  rmSync(debPath, { force: true });
  execSync(`dpkg-deb --root-owner-group --build "${debRoot}" "${debPath}"`, { stdio: 'inherit' });
  return debPath;
}

export async function packageLinuxOpenVSCode(): Promise<LinuxPackageResult> {
  console.log('[package] Starting Open VS Code Linux x86-64 packaging...');
  const { spec, stagedAppPath } = await prepareDesktopShell();
  if (!spec.platform.startsWith('linux')) {
    throw new Error(`Linux packager invoked with platform ${spec.platform}`);
  }

  const distDir = join(DESKTOP_ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });
  const buildTmp = mkdtempSync(join(tmpdir(), 'ovsc-linux-'));
  const payloadName = `Open-VS-Code-${spec.platform}-${PRODUCT_VERSION}`;
  const payloadDir = join(buildTmp, payloadName);
  mkdirSync(payloadDir, { recursive: true });
  execSync(`cp -a "${stagedAppPath}/." "${payloadDir}/"`);

  const electronName = existsSync(join(payloadDir, 'codium')) ? 'codium' : 'electron';
  if (!existsSync(join(payloadDir, electronName))) {
    throw new Error(`Linux VSCodium payload is missing ${electronName}`);
  }

  mergeProductJson(
    join(payloadDir, 'resources', 'app', 'product.json'),
    join(DESKTOP_ROOT, 'branding', 'product.json'),
    spec.upstreamCommit,
  );
  bundleOpenVSCodeExtension({
    repoRoot: REPO_ROOT,
    extensionsDir: join(payloadDir, 'resources', 'app', 'extensions'),
  });
  const gitCommit = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const gitDirty = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" }).trim().length > 0;
  writeFileSync(
    join(payloadDir, "resources", "app", "open-vs-code-release.json"),
    `${JSON.stringify({ productVersion: PRODUCT_VERSION, gitCommit, gitDirty, packagedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  writeLinuxLauncher(join(payloadDir, 'bin'), electronName);
  const sandboxHelper = join(payloadDir, 'chrome-sandbox');
  if (existsSync(sandboxHelper)) {
    chmodSync(sandboxHelper, 0o4755);
  }
  cpSync(join(DESKTOP_ROOT, 'branding', 'open-vs-code.desktop'), join(payloadDir, 'open-vs-code.desktop'));
  const iconSrc = join(DESKTOP_ROOT, 'branding', 'icon.png');
  if (existsSync(iconSrc)) {
    cpSync(iconSrc, join(payloadDir, 'open-vs-code.png'));
  }

  const archiveName = `${payloadName}.tar.gz`;
  const archivePath = join(distDir, archiveName);
  rmSync(archivePath, { force: true });
  execSync(`tar -czf "${archivePath}" -C "${buildTmp}" "${payloadName}"`, { stdio: 'inherit' });

  const targetAppPath = join(distDir, payloadName);
  rmSync(targetAppPath, { recursive: true, force: true });
  execSync(`cp -a "${payloadDir}" "${targetAppPath}"`);

  const archiveBuffer = readFileSync(archivePath);
  const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');
  const debPath = buildDeb(payloadDir, distDir, archiveSha256);
  rmSync(buildTmp, { recursive: true, force: true });

  const result: LinuxPackageResult = {
    appPath: targetAppPath,
    archivePath,
    archiveSha256,
    bundleIdentifier: 'com.openvscode.desktop',
    productName: 'Open VS Code',
    extensionId: 'open-vs-code.vscode-integration',
    signingStatus: debPath ? `Linux unsigned; Debian package ${debPath}` : 'Linux unsigned; tar.gz only (dpkg-deb missing)',
    spec,
  };

  console.log('==================================================');
  console.log('OPEN VS CODE LINUX DESKTOP CANDIDATE PACKAGED');
  console.log(`Payload:           ${result.appPath}`);
  console.log(`Archive:           ${result.archivePath} (${archiveBuffer.length} bytes)`);
  console.log(`SHA-256:           ${result.archiveSha256}`);
  console.log(`Bundled Extension: ${result.extensionId} v${PRODUCT_VERSION}`);
  console.log(`Signing Status:    ${result.signingStatus}`);
  console.log(`Upstream Shell:    ${spec.distribution} ${spec.version} (${spec.platform})`);
  console.log('==================================================');
  return result;
}
