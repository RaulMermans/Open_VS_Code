import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareDesktopShell, UpstreamSpec } from './prepare.js';

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

  // 1. Ensure upstream shell is ready
  const { spec, stagedAppPath } = await prepareDesktopShell();

  // 2. Ensure extension bundle exists
  const extensionDistPath = join(REPO_ROOT, 'packages', 'vscode-integration', 'dist', 'extension.js');
  const extensionManifestPath = join(REPO_ROOT, 'packages', 'vscode-integration', 'package.json');
  if (!existsSync(extensionDistPath)) {
    console.log(`[package] Extension bundle not found at ${extensionDistPath}. Building...`);
    execSync('npm --workspace=@open-vs-code/vscode-integration run build', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }

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
  if (existsSync(productJsonPath) && existsSync(customProductPath)) {
    console.log(`[package] Merging Open VS Code product metadata...`);
    const upstreamProduct = JSON.parse(readFileSync(productJsonPath, 'utf8'));
    const customProduct = JSON.parse(readFileSync(customProductPath, 'utf8'));

    const mergedProduct = {
      ...upstreamProduct,
      ...customProduct,
      commit: spec.upstreamCommit,
      date: new Date().toISOString(),
    };

    writeFileSync(productJsonPath, JSON.stringify(mergedProduct, null, 2) + '\n', 'utf8');
  }

  // 7. Bundle Open VS Code Extension
  const extensionsDir = join(tempAppPath, 'Contents', 'Resources', 'app', 'extensions');
  const bundledExtDir = join(extensionsDir, 'open-vs-code.vscode-integration');
  mkdirSync(join(bundledExtDir, 'dist'), { recursive: true });

  console.log(`[package] Bundling Open VS Code extension into ${bundledExtDir}...`);
  const rawManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'));
  const bundledManifest = {
    ...rawManifest,
    name: 'vscode-integration',
    publisher: 'open-vs-code',
    displayName: 'Open VS Code Agent',
    description: 'Integrated local-first AI coding agent for Open VS Code desktop',
  };
  writeFileSync(join(bundledExtDir, 'package.json'), JSON.stringify(bundledManifest, null, 2) + '\n', 'utf8');

  const extensionJsContent = readFileSync(extensionDistPath);
  writeFileSync(join(bundledExtDir, 'dist', 'extension.js'), extensionJsContent);

  // Curated built-in skills (ADR-029) are Markdown data read lazily at runtime, not bundled code.
  const builtinSkillsPath = join(REPO_ROOT, 'packages', 'agent-core', 'skills', 'builtins');
  cpSync(builtinSkillsPath, join(bundledExtDir, 'dist', 'skills', 'builtins'), { recursive: true });

  // Sprint 9B: Bundle playwright-core JS driver + browsers.json (excluding bin/ install scripts)
  // so standalone extracted Open VS Code.app resolves playwright-core without uncontrolled downloads.
  const playwrightCoreSrc = join(REPO_ROOT, 'node_modules', 'playwright-core');
  if (existsSync(playwrightCoreSrc)) {
    const playwrightCoreDest = join(bundledExtDir, 'node_modules', 'playwright-core');
    mkdirSync(join(bundledExtDir, 'node_modules'), { recursive: true });
    cpSync(playwrightCoreSrc, playwrightCoreDest, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(playwrightCoreSrc.length);
        return rel !== '/bin' && !rel.startsWith('/bin/') && rel !== '\\bin' && !rel.startsWith('\\bin\\');
      },
    });
  }

  // Maintain compatibility alias directory 'open-vs-code'
  const compatExtDir = join(extensionsDir, 'open-vs-code');
  rmSync(compatExtDir, { recursive: true, force: true });
  try {
    execSync(`ln -s "open-vs-code.vscode-integration" "${compatExtDir}"`);
  } catch {
    execSync(`cp -R "${bundledExtDir}" "${compatExtDir}"`);
  }

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
