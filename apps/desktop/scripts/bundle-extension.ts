import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { PRODUCT_VERSION } from './product-version.js';

export function bundleOpenVSCodeExtension(options: {
  repoRoot: string;
  extensionsDir: string;
}): void {
  const { repoRoot, extensionsDir } = options;
  const extensionDistPath = join(repoRoot, 'packages', 'vscode-integration', 'dist', 'extension.js');
  const extensionManifestPath = join(repoRoot, 'packages', 'vscode-integration', 'package.json');
  execSync('npm --workspace=@open-vs-code/vscode-integration run build', {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const bundledExtDir = join(extensionsDir, 'open-vs-code.vscode-integration');
  mkdirSync(join(bundledExtDir, 'dist'), { recursive: true });

  const rawManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'));
  const bundledManifest = {
    ...rawManifest,
    name: 'vscode-integration',
    version: PRODUCT_VERSION,
    publisher: 'open-vs-code',
    displayName: 'Open VS Code Agent',
    description: 'Integrated local-first AI coding agent for Open VS Code desktop',
  };
  writeFileSync(join(bundledExtDir, 'package.json'), JSON.stringify(bundledManifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(bundledExtDir, 'dist', 'extension.js'), readFileSync(extensionDistPath));

  const builtinSkillsPath = join(repoRoot, 'packages', 'agent-core', 'skills', 'builtins');
  cpSync(builtinSkillsPath, join(bundledExtDir, 'dist', 'skills', 'builtins'), { recursive: true });

  const playwrightCoreSrc = join(repoRoot, 'node_modules', 'playwright-core');
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

  const compatExtDir = join(extensionsDir, 'open-vs-code');
  rmSync(compatExtDir, { recursive: true, force: true });
  try {
    execSync(`ln -s "open-vs-code.vscode-integration" "${compatExtDir}"`);
  } catch {
    execSync(`cp -R "${bundledExtDir}" "${compatExtDir}"`);
  }
}

export function mergeProductJson(productJsonPath: string, customProductPath: string, upstreamCommit: string): void {
  if (!existsSync(productJsonPath) || !existsSync(customProductPath)) {
    throw new Error(`product.json missing at ${productJsonPath} or ${customProductPath}`);
  }
  const upstreamProduct = JSON.parse(readFileSync(productJsonPath, 'utf8'));
  const customProduct = JSON.parse(readFileSync(customProductPath, 'utf8'));
  const mergedProduct = {
    ...upstreamProduct,
    ...customProduct,
    commit: upstreamCommit,
    date: new Date().toISOString(),
  };
  writeFileSync(productJsonPath, JSON.stringify(mergedProduct, null, 2) + '\n', 'utf8');
}
