import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareDesktopShell, loadUpstreamSpec, UpstreamSpec } from './prepare.js';
import { bundleOpenVSCodeExtension, mergeProductJson } from './bundle-extension.js';
import { packageLinuxOpenVSCode } from './package-linux.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DESKTOP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(DESKTOP_ROOT, '..', '..');

export interface PackageResult {
  appPath: string;
  archivePath: string;
  archiveSha256: string;
  bundleIdentifier: string;
  productName: string;
  extensionId: string;
  signingStatus: string;
  spec: UpstreamSpec;
}

export async function packageOpenVSCode(): Promise<PackageResult> {
  console.log(`[package] Starting Open VS Code desktop packaging...`);
  const requested = loadUpstreamSpec();
  if (requested.platform.startsWith('linux')) {
    return packageLinuxOpenVSCode();
  }

  // 1. Ensure upstream shell is ready
  const { spec, stagedAppPath } = await prepareDesktopShell();

  const distDir = join(DESKTOP_ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });

  // 3. Assemble in isolated temporary directory to avoid macOS Desktop extended attributes
  const buildTmp = mkdtempSync(join(tmpdir(), 'ovsc-build-'));
  const tempAppPath = join(buildTmp, 'Open VS Code.app');

  console.log(`[package] Assembling app in staging environment: ${tempAppPath}...`);
  execSync(`cp -R "${stagedAppPath}" "${tempAppPath}"`, { stdio: 'inherit' });

  // 4. Update Info.plist
  const infoPlistPath = join(tempAppPath, 'Contents', 'Info.plist');
  if (existsSync(infoPlistPath)) {
    console.log(`[package] Patching Info.plist with Open VS Code branding...`);
    let plistContent = readFileSync(infoPlistPath, 'utf8');

    // CFBundleName & CFBundleDisplayName
    plistContent = plistContent.replace(
      /<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
      `<key>CFBundleName</key>\n\t<string>Open VS Code</string>`
    );
    plistContent = plistContent.replace(
      /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
      `<key>CFBundleDisplayName</key>\n\t<string>Open VS Code</string>`
    );

    // CFBundleIdentifier
    plistContent = plistContent.replace(
      /<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
      `<key>CFBundleIdentifier</key>\n\t<string>com.openvscode.desktop</string>`
    );

    // CFBundleExecutable
    plistContent = plistContent.replace(
      /<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/,
      `<key>CFBundleExecutable</key>\n\t<string>Open VS Code</string>`
    );

    writeFileSync(infoPlistPath, plistContent, 'utf8');
  }

  // 5. Update executable binary name and CLI scripts
  const macOsDir = join(tempAppPath, 'Contents', 'MacOS');
  const vscodiumExePath = join(macOsDir, 'VSCodium');
  const targetExePath = join(macOsDir, 'Open VS Code');

  if (existsSync(vscodiumExePath)) {
    execSync(`cp -p "${vscodiumExePath}" "${targetExePath}"`);
  } else {
    const electronExePath = join(macOsDir, 'Electron');
    if (existsSync(electronExePath)) {
      execSync(`cp -p "${electronExePath}" "${targetExePath}"`);
    }
  }

  // 5b. Rename helper apps in Contents/Frameworks so Electron macOS can find them
  const frameworksDir = join(tempAppPath, 'Contents', 'Frameworks');
  const helperMappings = [
    {
      origApp: 'VSCodium Helper.app',
      newApp: 'Open VS Code Helper.app',
      origExe: 'VSCodium Helper',
      newExe: 'Open VS Code Helper',
      bundleId: 'com.openvscode.helper',
    },
    {
      origApp: 'VSCodium Helper (GPU).app',
      newApp: 'Open VS Code Helper (GPU).app',
      origExe: 'VSCodium Helper (GPU)',
      newExe: 'Open VS Code Helper (GPU)',
      bundleId: 'com.openvscode.helper.gpu',
    },
    {
      origApp: 'VSCodium Helper (Plugin).app',
      newApp: 'Open VS Code Helper (Plugin).app',
      origExe: 'VSCodium Helper (Plugin)',
      newExe: 'Open VS Code Helper (Plugin)',
      bundleId: 'com.openvscode.helper.plugin',
    },
    {
      origApp: 'VSCodium Helper (Renderer).app',
      newApp: 'Open VS Code Helper (Renderer).app',
      origExe: 'VSCodium Helper (Renderer)',
      newExe: 'Open VS Code Helper (Renderer)',
      bundleId: 'com.openvscode.helper.renderer',
    },
  ];

  for (const h of helperMappings) {
    const oldAppPath = join(frameworksDir, h.origApp);
    const newAppPath = join(frameworksDir, h.newApp);
    if (existsSync(oldAppPath)) {
      execSync(`mv "${oldAppPath}" "${newAppPath}"`);
      const oldExe = join(newAppPath, 'Contents', 'MacOS', h.origExe);
      const newExe = join(newAppPath, 'Contents', 'MacOS', h.newExe);
      if (existsSync(oldExe)) {
        execSync(`mv "${oldExe}" "${newExe}"`);
      }
      const helperPlist = join(newAppPath, 'Contents', 'Info.plist');
      if (existsSync(helperPlist)) {
        let content = readFileSync(helperPlist, 'utf8');
        content = content.replace(new RegExp(h.origExe, 'g'), h.newExe);
        content = content.replace(
          /<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
          `<key>CFBundleIdentifier</key>\n\t<string>${h.bundleId}</string>`
        );
        writeFileSync(helperPlist, content, 'utf8');
      }
    }
  }

  // Configure bin/open-vs-code CLI launcher
  const binDir = join(tempAppPath, 'Contents', 'Resources', 'app', 'bin');
  const openVsCodeCliPath = join(binDir, 'open-vs-code');
  const cliScript = `#!/usr/bin/env bash
function app_realpath() {
	SOURCE=$1
	while [ -h "$SOURCE" ]; do
		DIR=$(dirname "$SOURCE")
		SOURCE=$(readlink "$SOURCE")
		[[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
	done
	SOURCE_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
	echo "\${SOURCE_DIR%%\${SOURCE_DIR#*.app}}"
}
APP_PATH="$(app_realpath "\${BASH_SOURCE[0]}")"
CONTENTS="$APP_PATH/Contents"
ELECTRON="$CONTENTS/MacOS/Open VS Code"
if [ ! -f "$ELECTRON" ]; then
  ELECTRON="$CONTENTS/MacOS/VSCodium"
fi
CLI="$CONTENTS/Resources/app/out/cli.js"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
`;
  writeFileSync(openVsCodeCliPath, cliScript, { mode: 0o755 });

  // 6. Update product.json
  const productJsonPath = join(tempAppPath, 'Contents', 'Resources', 'app', 'product.json');
  const customProductPath = join(DESKTOP_ROOT, 'branding', 'product.json');
  console.log(`[package] Merging Open VS Code product metadata...`);
  mergeProductJson(productJsonPath, customProductPath, spec.upstreamCommit);

  // 7. Bundle Open VS Code Extension
  const extensionsDir = join(tempAppPath, 'Contents', 'Resources', 'app', 'extensions');
  console.log(`[package] Bundling Open VS Code extension into ${extensionsDir}...`);
  bundleOpenVSCodeExtension({ repoRoot: REPO_ROOT, extensionsDir });

  // 8. Clear quarantine/extended attributes and apply ad-hoc code signature
  console.log(`[package] Signing application bundle with ad-hoc signature...`);
  let signingStatus = 'Unsigned (not executed)';
  try {
    execSync(`xattr -cr "${tempAppPath}"`);
    execSync(`codesign --force --deep --sign - "${tempAppPath}"`, { stdio: 'pipe' });
    execSync(`codesign --verify --deep --strict "${tempAppPath}"`, { stdio: 'pipe' });
    signingStatus = 'Ad-hoc signed and verified (Local V1 Candidate)';
    console.log(`[package] Ad-hoc signature verified strictly.`);
  } catch (err: any) {
    signingStatus = `Unsigned (Signing failed: ${err.message})`;
    console.error(`[package] Signing error: ${err.message}`);
    throw new Error(`Application codesigning failed: ${err.message}`);
  }

  // 9. Package distribution archive (.tar.gz) from signed temp build
  const archiveName = `Open-VS-Code-darwin-arm64-0.1.0.tar.gz`;
  const archivePath = join(distDir, archiveName);
  console.log(`[package] Creating distribution archive: ${archivePath}...`);
  rmSync(archivePath, { force: true });
  execSync(`tar -czf "${archivePath}" -C "${buildTmp}" "Open VS Code.app"`, { stdio: 'inherit' });

  // 10. Copy signed app to distDir
  const targetAppPath = join(distDir, 'Open VS Code.app');
  rmSync(targetAppPath, { recursive: true, force: true });
  execSync(`cp -R "${tempAppPath}" "${distDir}"`, { stdio: 'inherit' });

  // Clean temp
  rmSync(buildTmp, { recursive: true, force: true });

  const archiveBuffer = readFileSync(archivePath);
  const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');

  const result: PackageResult = {
    appPath: targetAppPath,
    archivePath,
    archiveSha256,
    bundleIdentifier: 'com.openvscode.desktop',
    productName: 'Open VS Code',
    extensionId: 'open-vs-code.vscode-integration',
    signingStatus,
    spec,
  };

  console.log(`==================================================`);
  console.log(`OPEN VS CODE V1 DESKTOP CANDIDATE PACKAGED`);
  console.log(`App Bundle:        ${result.appPath}`);
  console.log(`Archive:           ${result.archivePath} (${archiveBuffer.length} bytes)`);
  console.log(`SHA-256:           ${result.archiveSha256}`);
  console.log(`Bundle Identifier: ${result.bundleIdentifier}`);
  console.log(`Bundled Extension: ${result.extensionId} v0.1.0`);
  console.log(`Signing Status:    ${result.signingStatus}`);
  console.log(`Upstream Shell:    ${spec.distribution} ${spec.version} (VS Code ${spec.vscodeVersion})`);
  console.log(`==================================================`);

  return result;
}

export function verifyAppSignature(appPath: string): { verified: boolean; error?: string } {
  try {
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'pipe' });
    return { verified: true };
  } catch (err: any) {
    return { verified: false, error: err.message };
  }
}

// CLI execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  packageOpenVSCode().catch((err) => {
    console.error(`[package] FAILED:`, err);
    process.exit(1);
  });
}
