# Open VS Code Desktop Portability & Cross-Platform Roadmap

This document outlines the cross-platform architecture of Open VS Code desktop packaging.

---

## 1. Platform-Neutral Architecture

The core packaging and integration architecture is completely cross-platform:

1. **Extension-First Invariant**:
   - The bundled extension (`@open-vs-code/vscode-integration`) is pure JavaScript (CommonJS) bundled via esbuild (`dist/extension.js`).
   - It runs identically on macOS, Linux, and Windows.
2. **Product Configuration**:
   - `product.json` defines application identity (`Open VS Code`), data folder name (`.open-vs-code-desktop`), telemetry suppression, and Open VSX gallery endpoints across all operating systems.
3. **Extension Bundling Layout**:
   - In all VS Code / VSCodium distributions on any OS, built-in extensions reside in `resources/app/extensions/<extension-name>/`.
   - The extension manifest and bundle are placed in this exact location on all platforms.
4. **Offline and Security Invariants**:
   - Zero proprietary cloud fallback, zero automatic model downloads, and designated inference-host gates are enforced identically by `@open-vs-code/agent-core`.

---

## 2. Platform Targets

### A. macOS (Apple Silicon arm64 & Intel x64) — V1 Production Target

- **Current Implementation**: Implemented and verified in Sprint 4F.
- **Upstream Shell**: `VSCodium-darwin-arm64-1.135.06055.zip` (pinned).
- **Target Artifacts**:
  - `Open VS Code.app` (macOS application bundle).
  - `Open-VS-Code-darwin-arm64-0.1.0.tar.gz` (distribution archive).
- **macOS Specifics**:
  - `Contents/Info.plist` bundle metadata (`CFBundleName`, `CFBundleIdentifier`, `CFBundleExecutable`).
  - Ad-hoc codesign for local execution without gatekeeper blocking.
  - Native CLI launcher at `Contents/Resources/app/bin/open-vs-code`.

---

### B. Linux (x64 & arm64) — Future Milestone

- **Upstream Distribution Assets**:
  - `VSCodium-linux-x64-1.135.06055.tar.gz` / `VSCodium-linux-arm64-1.135.06055.tar.gz`
  - `.deb`, `.rpm`, or `.AppImage` packages.
- **Packaging Pipeline**:
  - Unpack tarball.
  - Inject `product.json` into `resources/app/product.json`.
  - Copy extension bundle into `resources/app/extensions/open-vs-code/`.
  - Provide desktop entry file (`open-vs-code.desktop`) and icon in `/usr/share/icons`.
  - Rename main executable `codium` to `open-vs-code`.
  - Repackage as `.tar.gz` or `.AppImage`.

---

### C. Windows (x64 & arm64) — Future Milestone

- **Upstream Distribution Assets**:
  - `VSCodium-win32-x64-1.135.06055.zip` / `VSCodium-win32-arm64-1.135.06055.zip`
- **Packaging Pipeline**:
  - Unpack zip.
  - Inject `product.json` into `resources/app/product.json`.
  - Copy extension bundle into `resources/app/extensions/open-vs-code/`.
  - Rename executable `codium.exe` to `open-vs-code.exe`.
  - (Optional) Build Inno Setup or WiX installer.
