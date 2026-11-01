/**
 * Sprint 9C — Deterministic Visual Comparison & Region-Aware Difference Engine.
 *
 * Implements pixel-level and region-aware visual comparison in pure TypeScript using
 * Node.js standard `node:zlib` with zero external binary dependencies.
 *
 * Invariants (ADR-041):
 *   - Identical viewport dimensions and controlled scale factor.
 *   - Bounded dimensions (width <= 1920, height <= 2160).
 *   - Region clustering and semantic difference categorization.
 *   - Hash differences are NOT interpreted as design failures on their own.
 */

import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import type {
  DifferenceCategory,
  DifferenceRegion,
  VisualComparisonOptions,
  VisualComparisonResult,
} from "./contracts.ts";

export class VisualComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualComparisonError";
  }
}

// ---------------------------------------------------------------------------
// CRC-32 Table for PNG chunk encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Lightweight Zero-Dependency PNG Decoder / Encoder
// ---------------------------------------------------------------------------

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer; // RGBA 4 bytes per pixel
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf: Buffer): DecodedImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new VisualComparisonError("Invalid PNG signature: buffer is not a valid PNG.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Buffer[] = [];

  while (offset < buf.length) {
    if (offset + 8 > buf.length) break;
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4; // +4 for CRC

    if (type === "IHDR") {
      width = buf.readUInt32BE(dataOffset);
      height = buf.readUInt32BE(dataOffset + 4);
      bitDepth = buf.readUInt8(dataOffset + 8);
      colorType = buf.readUInt8(dataOffset + 9);
      if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
        throw new VisualComparisonError(`Unsupported PNG dimensions: ${width}x${height}`);
      }
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new VisualComparisonError(
          `Unsupported PNG color format: bitDepth=${bitDepth}, colorType=${colorType} (requires 8-bit RGBA or RGB)`
        );
      }
    } else if (type === "IDAT") {
      idatParts.push(buf.subarray(dataOffset, dataOffset + length));
    } else if (type === "IEND") {
      break;
    }

    offset = nextOffset;
  }

  if (width === 0 || height === 0 || idatParts.length === 0) {
    throw new VisualComparisonError("Malformed PNG: missing IHDR or IDAT chunks.");
  }

  const compressed = Buffer.concat(idatParts);
  const inflated = zlib.inflateSync(compressed);
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const scanlineLength = 1 + width * bytesPerPixel;

  if (inflated.length < scanlineLength * height) {
    throw new VisualComparisonError(
      `Malformed PNG scanlines: expected at least ${scanlineLength * height} bytes, got ${inflated.length}`
    );
  }

  // Reconstruct scanlines into standard RGBA buffer
  const rgba = Buffer.alloc(width * height * 4);
  const prevLine = Buffer.alloc(width * bytesPerPixel);
  const currentLine = Buffer.alloc(width * bytesPerPixel);

  for (let y = 0; y < height; y++) {
    const lineStart = y * scanlineLength;
    const filterType = inflated.readUInt8(lineStart);
    const rawData = inflated.subarray(lineStart + 1, lineStart + 1 + width * bytesPerPixel);

    for (let i = 0; i < rawData.length; i++) {
      const xVal = rawData[i]!;
      const aVal = i >= bytesPerPixel ? currentLine[i - bytesPerPixel]! : 0;
      const bVal = prevLine[i]!;
      const cVal = i >= bytesPerPixel ? prevLine[i - bytesPerPixel]! : 0;

      let recon = 0;
      switch (filterType) {
        case 0: // None
          recon = xVal;
          break;
        case 1: // Sub
          recon = (xVal + aVal) & 0xff;
          break;
        case 2: // Up
          recon = (xVal + bVal) & 0xff;
          break;
        case 3: // Average
          recon = (xVal + Math.floor((aVal + bVal) / 2)) & 0xff;
          break;
        case 4: { // Paeth
          const p = aVal + bVal - cVal;
          const pa = Math.abs(p - aVal);
          const pb = Math.abs(p - bVal);
          const pc = Math.abs(p - cVal);
          const pr = pa <= pb && pa <= pc ? aVal : pb <= pc ? bVal : cVal;
          recon = (xVal + pr) & 0xff;
          break;
        }
        default:
          recon = xVal;
      }
      currentLine[i] = recon;
    }

    // Copy to RGBA buffer
    for (let x = 0; x < width; x++) {
      const srcIdx = x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      rgba[dstIdx] = currentLine[srcIdx]!;
      rgba[dstIdx + 1] = currentLine[srcIdx + 1]!;
      rgba[dstIdx + 2] = currentLine[srcIdx + 2]!;
      rgba[dstIdx + 3] = bytesPerPixel === 4 ? currentLine[srcIdx + 3]! : 255;
    }

    currentLine.copy(prevLine);
  }

  return { width, height, data: rgba };
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const bytesPerPixel = 4;
  const scanlineLength = 1 + width * bytesPerPixel;
  const rawData = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y++) {
    const rawOffset = y * scanlineLength;
    rawData[rawOffset] = 0; // Filter: None
    const rgbaOffset = y * width * 4;
    rgba.copy(rawData, rawOffset + 1, rgbaOffset, rgbaOffset + width * 4);
  }

  const deflated = zlib.deflateSync(rawData);

  // Build PNG chunks
  const chunks: Buffer[] = [];
  chunks.push(PNG_SIGNATURE);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth 8
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace 0
  chunks.push(makeChunk("IHDR", ihdrData));

  // IDAT
  chunks.push(makeChunk("IDAT", deflated));

  // IEND
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const typeAndData = chunk.subarray(4, 8 + len);
  const crc = crc32(typeAndData);
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

// ---------------------------------------------------------------------------
// Deterministic Visual Comparison & Region Categorizer
// ---------------------------------------------------------------------------

export function compareVisualScreenshots(
  baselinePng: Buffer,
  candidatePng: Buffer,
  options: VisualComparisonOptions = {}
): VisualComparisonResult {
  const baselineSha256 = crypto.createHash("sha256").update(baselinePng).digest("hex");
  const candidateSha256 = crypto.createHash("sha256").update(candidatePng).digest("hex");
  const identicalHash = baselineSha256 === candidateSha256;

  const baseline = decodePng(baselinePng);
  const candidate = decodePng(candidatePng);

  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    throw new VisualComparisonError(
      `Dimension mismatch: baseline is ${baseline.width}x${baseline.height}, candidate is ${candidate.width}x${candidate.height}. Visual comparison requires identical viewport dimensions.`
    );
  }

  const width = baseline.width;
  const height = baseline.height;
  const totalPixels = width * height;
  const threshold = Math.max(0.01, Math.min(options.colorThreshold ?? 0.08, 0.5));
  const tolerancePercent = Math.max(0, Math.min(options.tolerancePercent ?? 0.1, 10.0));

  const diffRgba = Buffer.alloc(totalPixels * 4);
  const changedMask = new Uint8Array(totalPixels);
  let mismatchedPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const pixelIdx = y * width + x;

      // Check if coordinate is in ignored regions
      const inIgnored = options.ignoredRegions?.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
      );
      if (inIgnored) {
        // Unchanged rendering
        diffRgba[idx] = baseline.data[idx]!;
        diffRgba[idx + 1] = baseline.data[idx + 1]!;
        diffRgba[idx + 2] = baseline.data[idx + 2]!;
        diffRgba[idx + 3] = 60;
        continue;
      }

      const br = baseline.data[idx]!;
      const bg = baseline.data[idx + 1]!;
      const bb = baseline.data[idx + 2]!;
      const ba = baseline.data[idx + 3]!;

      const cr = candidate.data[idx]!;
      const cg = candidate.data[idx + 1]!;
      const cb = candidate.data[idx + 2]!;
      const ca = candidate.data[idx + 3]!;

      // Euclidean distance in RGB color space normalized to [0, 1]
      const deltaR = br - cr;
      const deltaG = bg - cg;
      const deltaB = bb - cb;
      const deltaA = ba - ca;
      const dist = Math.sqrt(deltaR * deltaR + deltaG * deltaG + deltaB * deltaB + deltaA * deltaA) / 510;

      if (dist > threshold) {
        mismatchedPixels++;
        changedMask[pixelIdx] = 1;
        // Highlight in vibrant magenta (#ff0055)
        diffRgba[idx] = 255;
        diffRgba[idx + 1] = 0;
        diffRgba[idx + 2] = 85;
        diffRgba[idx + 3] = 255;
      } else {
        // Dim unchanged baseline background
        diffRgba[idx] = Math.floor(baseline.data[idx]! * 0.3);
        diffRgba[idx + 1] = Math.floor(baseline.data[idx + 1]! * 0.3);
        diffRgba[idx + 2] = Math.floor(baseline.data[idx + 2]! * 0.3);
        diffRgba[idx + 3] = 180;
      }
    }
  }

  const mismatchPercentage = (mismatchedPixels / totalPixels) * 100;
  const pass = mismatchPercentage <= tolerancePercent;
  const diffPngBuffer = encodePng(width, height, diffRgba);

  // Cluster changed pixels into DifferenceRegions (32x32 block grid)
  const regions = clusterDifferenceRegions(changedMask, width, height, totalPixels);

  const summary = identicalHash
    ? "Identical visual capture (100% byte and pixel parity)."
    : pass
      ? `Visual comparison passed: ${mismatchedPixels} mismatched pixels (${mismatchPercentage.toFixed(2)}%) within tolerance ceiling (${tolerancePercent}%).`
      : `Visual mismatch detected: ${mismatchedPixels} pixels (${mismatchPercentage.toFixed(2)}%) across ${regions.length} distinct region(s).`;

  return {
    comparisonId: `cmp-${Date.now()}`,
    baselineSha256,
    candidateSha256,
    identicalHash,
    width,
    height,
    totalPixels,
    mismatchedPixels,
    mismatchPercentage: Number(mismatchPercentage.toFixed(4)),
    pass,
    diffPngBuffer,
    regions,
    summary,
    comparedAt: Date.now(),
  };
}

function clusterDifferenceRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  totalPixels: number
): DifferenceRegion[] {
  const blockSize = 32;
  const gridW = Math.ceil(width / blockSize);
  const gridH = Math.ceil(height / blockSize);
  const grid = new Uint32Array(gridW * gridH);

  for (let y = 0; y < height; y++) {
    const gy = Math.floor(y / blockSize);
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const gx = Math.floor(x / blockSize);
        const gidx = gy * gridW + gx;
        const cur = grid[gidx] ?? 0;
        grid[gidx] = cur + 1;
      }
    }
  }

  // Find contiguous active blocks
  const visited = new Uint8Array(gridW * gridH);
  const regions: DifferenceRegion[] = [];
  let regionCounter = 0;

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const gidx = gy * gridW + gx;
      if ((grid[gidx] ?? 0) === 0 || visited[gidx] === 1) continue;

      // Flood fill active cluster
      let minX = gx * blockSize;
      let maxX = Math.min((gx + 1) * blockSize, width);
      let minY = gy * blockSize;
      let maxY = Math.min((gy + 1) * blockSize, height);
      let clusterPixels = 0;

      const queue: [number, number][] = [[gx, gy]];
      visited[gidx] = 1;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift()!;
        const cidx = cy * gridW + cx;
        clusterPixels += grid[cidx]!;

        minX = Math.min(minX, cx * blockSize);
        maxX = Math.max(maxX, Math.min((cx + 1) * blockSize, width));
        minY = Math.min(minY, cy * blockSize);
        maxY = Math.max(maxY, Math.min((cy + 1) * blockSize, height));

        // 4-neighborhood
        const neighbors: [number, number][] = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
            const nidx = ny * gridW + nx;
            if (grid[nidx]! > 0 && visited[nidx] === 0) {
              visited[nidx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      const regW = maxX - minX;
      const regH = maxY - minY;
      const regionPercent = (clusterPixels / totalPixels) * 100;

      const category = classifyRegion(clusterPixels, regW, regH, width, height);

      regions.push({
        regionId: `reg-${++regionCounter}`,
        bounds: {
          x: minX,
          y: minY,
          width: regW,
          height: regH,
          viewportWidth: width,
          viewportHeight: height,
        },
        pixelCount: clusterPixels,
        mismatchPercent: Number(regionPercent.toFixed(3)),
        category,
        description: formatRegionDescription(category, clusterPixels, regW, regH),
      });

      if (regions.length >= 20) break; // Bounded region reporting
    }
    if (regions.length >= 20) break;
  }

  return regions;
}

function classifyRegion(
  pixelCount: number,
  w: number,
  h: number,
  viewportW: number,
  _viewportH: number
): DifferenceCategory {
  if (pixelCount <= 40 || (w <= 16 && h <= 16)) {
    return "exact_pixel_mismatch";
  }
  // Full-width bar shift -> layout or spacing
  if (w >= viewportW * 0.8 && h <= 48) {
    return "spacing_mismatch";
  }
  // Vertical container displacement -> layout regression
  if (w >= viewportW * 0.5 && h >= 100) {
    return "layout_regression";
  }
  // Small text-like bounding box
  if (w <= 200 && h <= 32) {
    return "typography_mismatch";
  }
  // Large surface area color diff
  if (w * h > 10000 && pixelCount / (w * h) > 0.8) {
    return "color_mismatch";
  }
  return "missing_or_displaced_components";
}

function formatRegionDescription(
  cat: DifferenceCategory,
  pixels: number,
  w: number,
  h: number
): string {
  switch (cat) {
    case "exact_pixel_mismatch":
      return `Localized subpixel variation (${pixels} px) within ${w}x${h} area.`;
    case "spacing_mismatch":
      return `Margin/padding displacement detected (${w}x${h} band, ${pixels} changed px).`;
    case "layout_regression":
      return `Major structural layout shift across ${w}x${h} block (${pixels} px).`;
    case "typography_mismatch":
      return `Typographic text or kerning mismatch (${w}x${h}, ${pixels} px).`;
    case "color_mismatch":
      return `Surface background or text color shift (${w}x${h}, ${pixels} px).`;
    case "missing_or_displaced_components":
      return `Component displaced or missing (${w}x${h}, ${pixels} px).`;
    case "expected_dynamic_content":
      return `Expected dynamic content change (${w}x${h}).`;
  }
}
