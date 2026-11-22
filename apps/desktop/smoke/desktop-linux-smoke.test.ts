import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT_VERSION } from '../scripts/product-version.ts';

const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(DESKTOP_ROOT, 'dist');
const PAYLOAD = join(DIST_DIR, `Open-VS-Code-linux-x64-${PRODUCT_VERSION}`);
const ARCHIVE = join(DIST_DIR, `Open-VS-Code-linux-x64-${PRODUCT_VERSION}.tar.gz`);
const DEB = join(DIST_DIR, `open-vs-code_${PRODUCT_VERSION}_amd64.deb`);

describe('Linux x64 desktop package', { skip: process.platform !== 'linux' }, () => {
  test('payload, archive, and debian package exist', () => {
    assert.ok(existsSync(PAYLOAD), `missing ${PAYLOAD}`);
    assert.ok(existsSync(ARCHIVE), `missing ${ARCHIVE}`);
    assert.ok(existsSync(DEB), `missing ${DEB}`);
  });

  test('branded product.json and bundled extension are present', () => {
    const product = JSON.parse(readFileSync(join(PAYLOAD, 'resources', 'app', 'product.json'), 'utf8'));
    assert.equal(product.nameShort, 'Open VS Code');
    assert.equal(product.applicationName, 'open-vs-code');
    const electronPackage = JSON.parse(readFileSync(join(PAYLOAD, 'resources', 'app', 'package.json'), 'utf8'));
    assert.equal(electronPackage.desktopName, 'open-vs-code.desktop');
    assert.equal(product.dataFolderName, '.open-vs-code-desktop');
    assert.equal(product.enableTelemetry, false);
    assert.ok(
      existsSync(join(PAYLOAD, 'resources', 'app', 'extensions', 'open-vs-code.vscode-integration', 'dist', 'extension.js')),
    );
    assert.ok(existsSync(join(PAYLOAD, 'bin', 'open-vs-code')));
    assert.ok(existsSync(join(PAYLOAD, 'open-vs-code.desktop')));
  });

  test('CLI reports the pinned VSCodium version without opening a window', () => {
    const electron = join(PAYLOAD, 'codium');
    const cli = join(PAYLOAD, 'resources', 'app', 'out', 'cli.js');
    const output = execFileSync(electron, [cli, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    });
    assert.match(output, /1\.135\.06055/);
    assert.match(output, /5a73682ca091082675b10c9dc3f348c1d824d94f/);
    assert.match(output, /x64/);
  });

  test('debian package installs launcher and desktop entry paths', () => {
    const listing = execFileSync('dpkg-deb', ['-c', DEB], { encoding: 'utf8' });
    assert.match(listing, /usr\/bin\/open-vs-code/);
    assert.match(listing, /usr\/share\/applications\/open-vs-code\.desktop/);
    assert.match(listing, /usr\/share\/icons\/hicolor\/256x256\/apps\/open-vs-code\.png/);
    assert.match(listing, /rwsr-xr-x root\/root .*chrome-sandbox/);
  });

  test('launcher clears inherited Electron node mode and does not disable the sandbox', () => {
    const launcher = readFileSync(join(PAYLOAD, 'bin', 'open-vs-code'), 'utf8');
    assert.match(launcher, /unset ELECTRON_RUN_AS_NODE/);
    assert.match(launcher, /export OPEN_VS_CODE_REAL_INFERENCE=1/);
    assert.match(launcher, /CHROME_DESKTOP="open-vs-code\.desktop"/);
    assert.match(launcher, /ELECTRON="\$ROOT\/open-vs-code"/);
    assert.doesNotMatch(launcher, /--no-sandbox/);
  });

  test('debian postinst restores chrome-sandbox setuid root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovsc-deb-ctrl-'));
    try {
      execFileSync('dpkg-deb', ['-e', DEB, dir]);
      const script = readFileSync(join(dir, 'postinst'), 'utf8');
      assert.match(script, /chrome-sandbox/);
      assert.match(script, /chmod 4755/);
      assert.match(script, /chown root:root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
