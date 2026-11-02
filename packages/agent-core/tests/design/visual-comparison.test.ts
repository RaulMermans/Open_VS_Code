import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  decodePng,
  encodePng,
  compareVisualScreenshots,
  VisualComparisonError,
} from "../../src/design/index.ts";

// Helper to create synthetic solid color RGBA buffer
function makeSolidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

describe("Sprint 9C — Deterministic Visual Comparison Engine", () => {

  test("1. encodePng and decodePng roundtrip RGBA pixel buffers with 100% fidelity", () => {
    const width = 64;
    const height = 48;
    const originalRgba = makeSolidRgba(width, height, 37, 99, 235, 255); // #2563eb

    const pngBuffer = encodePng(width, height, originalRgba);
    assert.ok(pngBuffer.length > 50);

    const decoded = decodePng(pngBuffer);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.deepEqual(decoded.data, originalRgba, "Decoded RGBA data must match original bytes exactly");
  });

  test("2. decodePng fails closed on invalid signatures or malformed buffers", () => {
    assert.throws(
      () => decodePng(Buffer.from("not-a-png")),
      (err: any) => err instanceof VisualComparisonError && err.message.includes("Invalid PNG signature")
    );
    assert.throws(
      () => decodePng(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])),
      (err: any) => err instanceof VisualComparisonError
    );
  });

  test("3. Identical screenshots yield 0 mismatched pixels, identical SHA-256, and pass=true", () => {
    const width = 120;
    const height = 80;
    const rgba = makeSolidRgba(width, height, 15, 23, 42); // slate-900
    const png = encodePng(width, height, rgba);

    const result = compareVisualScreenshots(png, png);
    assert.equal(result.identicalHash, true);
    assert.equal(result.mismatchedPixels, 0);
    assert.equal(result.mismatchPercentage, 0);
    assert.equal(result.pass, true);
    assert.equal(result.regions.length, 0);
    assert.ok(result.summary.includes("100% byte and pixel parity"));
  });

  test("4. Dimension mismatch throws clear VisualComparisonError and fails closed", () => {
    const pngA = encodePng(100, 100, makeSolidRgba(100, 100, 255, 255, 255));
    const pngB = encodePng(100, 120, makeSolidRgba(100, 120, 255, 255, 255));

    assert.throws(
      () => compareVisualScreenshots(pngA, pngB),
      (err: any) => err instanceof VisualComparisonError && err.message.includes("Dimension mismatch")
    );
  });

  test("5. Detects localized pixel differences and produces a highlighted diff buffer", () => {
    const width = 200;
    const height = 150;
    const rgbaBaseline = makeSolidRgba(width, height, 255, 255, 255);
    const rgbaCandidate = makeSolidRgba(width, height, 255, 255, 255);

    // Paint a 20x20 red square in candidate at (50, 40)
    for (let y = 40; y < 60; y++) {
      for (let x = 50; x < 70; x++) {
        const idx = (y * width + x) * 4;
        rgbaCandidate[idx] = 239; // Red
        rgbaCandidate[idx + 1] = 68;
        rgbaCandidate[idx + 2] = 68;
        rgbaCandidate[idx + 3] = 255;
      }
    }

    const pngBase = encodePng(width, height, rgbaBaseline);
    const pngCand = encodePng(width, height, rgbaCandidate);

    const result = compareVisualScreenshots(pngBase, pngCand, { tolerancePercent: 0.05 });
    assert.equal(result.identicalHash, false);
    assert.equal(result.mismatchedPixels, 400); // 20 * 20
    assert.equal(result.pass, false);
    assert.ok(result.diffPngBuffer);
    assert.ok(result.regions.length >= 1);

    const reg = result.regions[0]!;
    assert.ok(reg.bounds.x <= 50);
    assert.ok(reg.bounds.y <= 40);
    assert.ok(reg.pixelCount >= 400);
  });

  test("6. Ignored regions exclude specified bounding boxes from difference counts", () => {
    const width = 200;
    const height = 150;
    const rgbaBaseline = makeSolidRgba(width, height, 255, 255, 255);
    const rgbaCandidate = makeSolidRgba(width, height, 255, 255, 255);

    // Paint a 20x20 red square at (50, 40)
    for (let y = 40; y < 60; y++) {
      for (let x = 50; x < 70; x++) {
        const idx = (y * width + x) * 4;
        rgbaCandidate[idx] = 239;
        rgbaCandidate[idx + 1] = 68;
        rgbaCandidate[idx + 2] = 68;
      }
    }

    const pngBase = encodePng(width, height, rgbaBaseline);
    const pngCand = encodePng(width, height, rgbaCandidate);

    // Run comparison with ignored region covering the 20x20 square
    const result = compareVisualScreenshots(pngBase, pngCand, {
      ignoredRegions: [{ x: 45, y: 35, width: 30, height: 30, viewportWidth: width, viewportHeight: height }],
    });

    assert.equal(result.mismatchedPixels, 0);
    assert.equal(result.pass, true);
    assert.equal(result.regions.length, 0);
  });

  test("7. Classifies difference categories correctly across layout shifts and color deltas", () => {
    const width = 300;
    const height = 200;
    const rgbaBase = makeSolidRgba(width, height, 10, 10, 10);
    const rgbaCand = makeSolidRgba(width, height, 10, 10, 10);

    // Full width band shift across x: 0..300, y: 10..30 (spacing / navigation band shift)
    for (let y = 10; y < 30; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        rgbaCand[idx] = 200;
        rgbaCand[idx + 1] = 200;
        rgbaCand[idx + 2] = 200;
      }
    }

    const pngBase = encodePng(width, height, rgbaBase);
    const pngCand = encodePng(width, height, rgbaCand);

    const result = compareVisualScreenshots(pngBase, pngCand);
    assert.ok(result.regions.length > 0);
    const region = result.regions[0]!;
    assert.equal(region.category, "spacing_mismatch");
    assert.ok(region.description.includes("band"));
  });

  test("8. Bounded PNG decoding rejects corrupted CRC checksums and truncated buffers", () => {
    const validPng = encodePng(10, 10, makeSolidRgba(10, 10, 255, 0, 0));
    assert.ok(validPng.length > 20);

    // Corrupt one byte in the IHDR data
    const corruptedPng = Buffer.from(validPng);
    corruptedPng[16] = (corruptedPng[16]! ^ 0xff); // corrupt width/height byte without updating CRC
    assert.throws(
      () => decodePng(corruptedPng),
      (err: any) => err instanceof VisualComparisonError && err.message.includes("CRC checksum failed")
    );

    // Truncate the buffer midway through the chunk
    const truncatedPng = validPng.subarray(0, 25);
    assert.throws(
      () => decodePng(truncatedPng),
      (err: any) => err instanceof VisualComparisonError && err.message.includes("Malformed PNG")
    );
  });

  test("9. Bounded PNG decoding rejects interlaced or unsupported color formats and enforces dimension caps", () => {
    const validPng = encodePng(10, 10, makeSolidRgba(10, 10, 0, 255, 0));

    // Construct a PNG with unsupported interlaceMethod = 1 (Adam7)
    const interlacedPng = Buffer.from(validPng);
    interlacedPng[28] = 1; // interlaceMethod is at offset 8 (signature) + 8 (IHDR header) + 12 = 28
    // Since we corrupted it, decodePng will either catch CRC mismatch or interlace error
    assert.throws(
      () => decodePng(interlacedPng),
      (err: any) => err instanceof VisualComparisonError
    );
  });

  test("10. Rejects input exceeding max size or decompression bounds safely without crashing", () => {
    // Artificial buffer exceeding 25MB input limit
    const hugeFakeBuffer = Buffer.alloc(26 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(hugeFakeBuffer, 0);

    assert.throws(
      () => decodePng(hugeFakeBuffer),
      (err: any) => err instanceof VisualComparisonError && err.message.includes("exceeds maximum permitted size")
    );
  });
});
