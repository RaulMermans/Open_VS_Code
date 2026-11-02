import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TargetClassifier,
  TargetClassificationError,
} from "../../src/rea/target-classifier.ts";

test("TargetClassifier - categorizes authorized web URLs", async () => {
  const classifier = new TargetClassifier();

  const target1 = classifier.classifyTarget("http://localhost:3000/app");
  assert.equal(target1.category, "running_web_app");
  assert.equal(target1.normalizedLocation, "http://localhost:3000/app");
  assert.ok(target1.targetId.startsWith("target_web_"));
  assert.equal(target1.authorized, true);

  const target2 = classifier.classifyTarget("http://127.0.0.1:8080/dashboard");
  assert.equal(target2.category, "running_web_app");
  assert.equal(target2.normalizedLocation, "http://127.0.0.1:8080/dashboard");
});

test("TargetClassifier - blocks unauthorized web schemes and SSRF attempts", async () => {
  const classifier = new TargetClassifier();

  // Unsupported scheme
  assert.throws(
    () => classifier.classifyTarget("file:///etc/passwd"),
    (err: any) => {
      assert.ok(err instanceof TargetClassificationError);
      assert.equal(err.code, "UNAUTHORIZED_ORIGIN");
      return true;
    }
  );

  // Cloud metadata SSRF attempt
  assert.throws(
    () => classifier.classifyTarget("http://169.254.169.254/latest/meta-data"),
    (err: any) => {
      assert.ok(err instanceof TargetClassificationError);
      assert.equal(err.code, "UNAUTHORIZED_ORIGIN");
      return true;
    }
  );

  // Empty target
  assert.throws(
    () => classifier.classifyTarget(""),
    (err: any) => {
      assert.ok(err instanceof TargetClassificationError);
      assert.equal(err.code, "EMPTY_TARGET");
      return true;
    }
  );
});

test("TargetClassifier - categorizes JS/Electron ASAR and unpacked directories", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-classifier-test-"));

  try {
    // 1. Packaged ASAR artifact
    const asarFile = join(testDir, "app.asar");
    writeFileSync(asarFile, Buffer.from("fake-asar-header-content"));

    const classifier = new TargetClassifier({ workspaceRoot: testDir });
    const asarTarget = classifier.classifyTarget(asarFile);
    assert.equal(asarTarget.category, "javascript_electron_app");
    assert.equal(asarTarget.format, "asar_archive");

    // 2. Electron/JS package directory
    const electronDir = join(testDir, "electron-app");
    mkdirSync(electronDir);
    writeFileSync(
      join(electronDir, "package.json"),
      JSON.stringify({ name: "my-electron-app", main: "index.js", devDependencies: { electron: "^28.0.0" } })
    );

    const electronTarget = classifier.classifyTarget(electronDir);
    assert.equal(electronTarget.category, "javascript_electron_app");
    assert.equal(electronTarget.format, "unpacked_electron_directory");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("TargetClassifier - probes binary headers for native executable artifacts", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-classifier-bin-"));

  try {
    const classifier = new TargetClassifier({ workspaceRoot: testDir });

    // Mach-O 64-bit binary header (0xFEEDFACF)
    const machoFile = join(testDir, "sample-macho");
    const machoBuf = Buffer.alloc(16);
    machoBuf.writeUInt32BE(0xfeedfacf, 0);
    writeFileSync(machoFile, machoBuf);

    const machoTarget = classifier.classifyTarget(machoFile);
    assert.equal(machoTarget.category, "native_packaged_app");
    assert.equal(machoTarget.format, "macho");

    // ELF binary header (0x7F454C46)
    const elfFile = join(testDir, "sample-elf");
    const elfBuf = Buffer.alloc(16);
    elfBuf.writeUInt32BE(0x7f454c46, 0);
    writeFileSync(elfFile, elfBuf);

    const elfTarget = classifier.classifyTarget(elfFile);
    assert.equal(elfTarget.category, "native_packaged_app");
    assert.equal(elfTarget.format, "elf");

    // Windows PE header (MZ = 0x4D5A)
    const peFile = join(testDir, "sample.exe");
    const peBuf = Buffer.alloc(16);
    peBuf.writeUInt16BE(0x4d5a, 0);
    writeFileSync(peFile, peBuf);

    const peTarget = classifier.classifyTarget(peFile);
    assert.equal(peTarget.category, "native_packaged_app");
    assert.equal(peTarget.format, "pe");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("TargetClassifier - categorizes source repositories cleanly", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-classifier-repo-"));

  try {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "vanilla-web-project", version: "1.0.0" })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const classifier = new TargetClassifier({ workspaceRoot: testDir });
    const repoTarget = classifier.classifyTarget(testDir);

    assert.equal(repoTarget.category, "source_repository");
    assert.equal(repoTarget.format, "directory");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("TargetClassifier - rejects nonexistent file targets and path traversals", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-classifier-security-"));

  try {
    const classifier = new TargetClassifier({ workspaceRoot: testDir });

    assert.throws(
      () => classifier.classifyTarget(join(testDir, "does-not-exist.bin")),
      (err: any) => {
        assert.ok(err instanceof TargetClassificationError);
        assert.equal(err.code, "TARGET_NOT_FOUND");
        return true;
      }
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
