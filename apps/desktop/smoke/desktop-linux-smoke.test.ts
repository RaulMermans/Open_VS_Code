import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(DESKTOP_ROOT, 'dist');
const PAYLOAD = join(DIST_DIR, 'Open-VS-Code-linux-x64-0.1.0');
const ARCHIVE = join(DIST_DIR, 'Open-VS-Code-linux-x64-0.1.0.tar.gz');
const DEB = join(DIST_DIR, 'open-vs-code_0.1.0_amd64.deb');

describe('Linux x64 desktop package', () => {
  test('payload, archive, and debian package exist', () => {
    assert.ok(existsSync(PAYLOAD), `missing ${PAYLOAD}`);
    assert.ok(existsSync(ARCHIVE), `missing ${ARCHIVE}`);
    assert.ok(existsSync(DEB), `missing ${DEB}`);
  });

  test('branded product.json and bundled extension are present', () => {
    const product = JSON.parse(readFileSync(join(PAYLOAD, 'resources', 'app', 'product.json'), 'utf8'));
    assert.equal(product.nameShort, 'Open VS Code');
    assert.equal(product.applicationName, 'open-vs-code');
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
  });
});
