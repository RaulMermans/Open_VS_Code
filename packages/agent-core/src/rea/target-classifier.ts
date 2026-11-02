/**
 * Sprint 9D — Deterministic Target Classification & Validation Engine.
 *
 * Inspects authorized software inputs, enforces security boundaries,
 * and categorizes targets into the four primary REA investigation workflows.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { InvestigationTarget } from "./contracts.ts";
import { isBrowserUrlPermitted } from "../browser/browser-network-policy.ts";

export interface TargetClassifierOptions {
  readonly workspaceRoot?: string;
  readonly allowedOrigins?: readonly string[];
  readonly requireExplicitAuthorization?: boolean;
}

export class TargetClassificationError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_TARGET"
      | "UNAUTHORIZED_ORIGIN"
      | "TARGET_NOT_FOUND"
      | "UNSAFE_PATH"
      | "UNAUTHORIZED_TARGET"
      | "UNKNOWN_TARGET_FORMAT",
    message: string
  ) {
    super(message);
    this.name = "TargetClassificationError";
  }
}

/**
 * Checks magic bytes of a file to detect native binaries and archive formats.
 */
function probeBinaryHeader(filePath: string): { isNative: boolean; format?: string } {
  try {
    const fd = readFileSync(filePath);
    if (fd.length < 4) return { isNative: false };
    const slice = fd.subarray(0, 16);

    // Mach-O: 0xFEEDFACE (32-bit), 0xFEEDFACF (64-bit), 0xCEFAEDFE (reverse 32), 0xCFFAEDFE (reverse 64), 0xCAFEBABE (fat)
    const magic32 = slice.readUInt32BE(0);
    const magic32LE = slice.readUInt32LE(0);
    if (
      magic32 === 0xfeedface ||
      magic32 === 0xfeedfacf ||
      magic32 === 0xcafebabe ||
      magic32LE === 0xfeedface ||
      magic32LE === 0xfeedfacf
    ) {
      return { isNative: true, format: "macho" };
    }

    // ELF: 0x7F 'E' 'L' 'F'
    if (slice[0] === 0x7f && slice[1] === 0x45 && slice[2] === 0x4c && slice[3] === 0x46) {
      return { isNative: true, format: "elf" };
    }

    // PE: 'M' 'Z'
    if (slice[0] === 0x4d && slice[1] === 0x5a) {
      return { isNative: true, format: "pe" };
    }

    // ZIP / APK / IPA / JAR: 'P' 'K' 0x03 0x04
    if (slice[0] === 0x50 && slice[1] === 0x4b && slice[2] === 0x03 && slice[3] === 0x04) {
      const ext = extname(filePath).toLowerCase();
      if (ext === ".apk") return { isNative: true, format: "apk" };
      if (ext === ".ipa") return { isNative: true, format: "ipa" };
      return { isNative: true, format: "zip_package" };
    }

    return { isNative: false };
  } catch {
    return { isNative: false };
  }
}

/**
 * Deterministically classifies an investigation target into one of four supported categories:
 * - running_web_app
 * - javascript_electron_app
 * - native_packaged_app
 * - source_repository
 */
export function classifyInvestigationTarget(
  rawInput: string,
  options: TargetClassifierOptions = {}
): InvestigationTarget {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new TargetClassificationError("EMPTY_TARGET", "Target input cannot be empty");
  }

  // Check for unsupported URL schemes
  if (trimmed.includes("://")) {
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      throw new TargetClassificationError(
        "UNAUTHORIZED_ORIGIN",
        `Only http:// and https:// URLs are supported for investigation: ${trimmed}`
      );
    }
  }

  // 1. Check for Running Web Application (URL)
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      throw new TargetClassificationError("UNKNOWN_TARGET_FORMAT", `Invalid URL target: ${trimmed}`);
    }

    // Enforce origin permission checks using browser network policy
    const policy = isBrowserUrlPermitted(trimmed, {
      allowedOrigins: options.allowedOrigins ? [...options.allowedOrigins] : ["http://localhost:*", "http://127.0.0.1:*", "http://0.0.0.0:*"],
    });

    if (!policy.allowed) {
      throw new TargetClassificationError(
        "UNAUTHORIZED_ORIGIN",
        `Target URL "${trimmed}" is not authorized for investigation: ${policy.reason ?? "disallowed origin"}`
      );
    }

    const targetId = `target_web_${createHash("sha256").update(parsedUrl.origin + parsedUrl.pathname).digest("hex").slice(0, 16)}`;

    return {
      targetId,
      category: "running_web_app",
      rawInput: trimmed,
      normalizedLocation: parsedUrl.href,
      format: "http_endpoint",
      authorized: true,
      metadata: {
        origin: parsedUrl.origin,
        pathname: parsedUrl.pathname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80"),
        protocol: parsedUrl.protocol,
      },
    };
  }

  // 2. Local File or Directory Targets
  const resolvedPath = resolve(options.workspaceRoot ?? process.cwd(), trimmed);
  if (!existsSync(resolvedPath)) {
    throw new TargetClassificationError("TARGET_NOT_FOUND", `Target path does not exist on disk: ${resolvedPath}`);
  }

  const stat = statSync(resolvedPath);
  const targetId = `target_${stat.isDirectory() ? "dir" : "file"}_${createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16)}`;

  // 2A. Check for JavaScript / Electron Application (ASAR or Electron directory)
  const ext = extname(resolvedPath).toLowerCase();
  if (ext === ".asar") {
    return {
      targetId,
      category: "javascript_electron_app",
      rawInput: trimmed,
      normalizedLocation: resolvedPath,
      format: "asar_archive",
      authorized: true,
      metadata: {
        fileName: basename(resolvedPath),
        bytes: stat.size,
      },
    };
  }

  if (stat.isDirectory()) {
    const pkgPath = resolve(resolvedPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.electron || deps["@electron/core"] || pkg.main?.includes("electron")) {
          return {
            targetId,
            category: "javascript_electron_app",
            rawInput: trimmed,
            normalizedLocation: resolvedPath,
            format: "unpacked_electron_directory",
            authorized: true,
            metadata: {
              packageName: pkg.name ?? basename(resolvedPath),
              version: pkg.version ?? "unknown",
              mainEntry: pkg.main,
            },
          };
        }
      } catch {
        // Fall through to repository detection
      }
    }

    // Check if it's an Apple .app bundle (which can contain Electron or Native)
    if (ext === ".app") {
      const asarChild = resolve(resolvedPath, "Contents/Resources/app.asar");
      if (existsSync(asarChild)) {
        return {
          targetId,
          category: "javascript_electron_app",
          rawInput: trimmed,
          normalizedLocation: resolvedPath,
          format: "electron_app_bundle",
          authorized: true,
          metadata: {
            bundleName: basename(resolvedPath),
            asarPath: asarChild,
          },
        };
      }
      return {
        targetId,
        category: "native_packaged_app",
        rawInput: trimmed,
        normalizedLocation: resolvedPath,
        format: "apple_app_bundle",
        authorized: true,
        metadata: {
          bundleName: basename(resolvedPath),
        },
      };
    }

    // Default directory with build manifests is a source_repository
    return {
      targetId,
      category: "source_repository",
      rawInput: trimmed,
      normalizedLocation: resolvedPath,
      format: "directory",
      authorized: true,
      metadata: {
        dirName: basename(resolvedPath),
      },
    };
  }

  // 2B. Check for Native / Packaged Binary
  const probe = probeBinaryHeader(resolvedPath);
  if (probe.isNative) {
    return {
      targetId,
      category: "native_packaged_app",
      rawInput: trimmed,
      normalizedLocation: resolvedPath,
      format: probe.format ?? "native_binary",
      authorized: true,
      metadata: {
        fileName: basename(resolvedPath),
        bytes: stat.size,
        detectedFormat: probe.format,
      },
    };
  }

  if ([".dmg", ".pkg", ".zip", ".tar", ".gz", ".apk", ".ipa"].includes(ext)) {
    return {
      targetId,
      category: "native_packaged_app",
      rawInput: trimmed,
      normalizedLocation: resolvedPath,
      format: ext.slice(1),
      authorized: true,
      metadata: {
        fileName: basename(resolvedPath),
        bytes: stat.size,
      },
    };
  }

  // Single source file target
  return {
    targetId,
    category: "source_repository",
    rawInput: trimmed,
    normalizedLocation: resolvedPath,
    format: "source_file",
    authorized: true,
    metadata: {
      fileName: basename(resolvedPath),
      bytes: stat.size,
    },
  };
}

export class TargetClassifier {
  constructor(private readonly options: TargetClassifierOptions = {}) {}

  classifyTarget(rawInput: string): InvestigationTarget {
    return classifyInvestigationTarget(rawInput, this.options);
  }
}
