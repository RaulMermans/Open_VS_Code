import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertLinuxDesktopIdentity, rewriteElectronDesktopIdentity } from './package-linux.ts';

test('Electron desktopName matches the Open VS Code launcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'ovsc-identity-'));
  const app = join(root, 'resources', 'app');
  mkdirSync(join(app, 'out'), { recursive: true });
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'VSCodium', desktopName: 'codium.desktop', license: 'MIT' }, null, 2)}\n`);
  const bundled = 'prefix "desktopName":"codium.desktop" suffix';
  writeFileSync(join(app, 'out', 'main.js'), bundled);
  writeFileSync(join(app, 'out', 'cli.js'), bundled);
  try {
    rewriteElectronDesktopIdentity(root);
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { name: string; desktopName: string; license: string };
    assert.equal(manifest.desktopName, 'open-vs-code.desktop');
    assert.equal(manifest.name, 'VSCodium');
    assert.equal(manifest.license, 'MIT');
    assert.equal(readFileSync(join(app, 'out', 'main.js'), 'utf8'), 'prefix "desktopName":"open-vs-code.desktop" suffix');
    assert.equal(readFileSync(join(app, 'out', 'cli.js'), 'utf8'), 'prefix "desktopName":"open-vs-code.desktop" suffix');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a leftover codium desktop id fails the identity postcondition', () => {
  const root = mkdtempSync(join(tmpdir(), 'ovsc-identity-'));
  const app = join(root, 'resources', 'app');
  mkdirSync(join(app, 'out'), { recursive: true });
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ desktopName: 'open-vs-code.desktop' })}\n`);
  writeFileSync(join(app, 'out', 'main.js'), '"desktopName":"open-vs-code.desktop"');
  writeFileSync(join(app, 'out', 'cli.js'), 'still "codium.desktop"');
  try {
    assert.throws(() => assertLinuxDesktopIdentity(root), /cli\.js still names codium\.desktop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
