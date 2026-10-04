# ADR-028: Desktop Shell and Packaging Strategy (Code-OSS vs VSCodium)

**Date**: 2026-10-02  
**Status**: Accepted  
**Sprint**: Sprint 4F — Code-OSS / VSCodium Desktop Packaging & V1 Candidate  

---

## Context

Open VS Code requires a branded, installable desktop application built on an open-source VS Code distribution, integrating our existing agent, chat, autocomplete, and local inference architecture without coupling core agent logic to editor internals.

Early architecture decisions established key principles:
- **ADR-001 (Reuse First)**: Reuse proven open-source infrastructure before building replacements.
- **ADR-002 (Extension-First)**: Prove product and agent layer through extension-level integration before deep editor changes.
- **ADR-003 (Editor-Independent Agent Core)**: Keep agent reasoning, routing, tools, memory, and recovery decoupled from any IDE.
- **ADR-017 (IDE Host Adapter Boundary)**: Bridge IDE state through bounded contracts (`IdeHost`).
- **ADR-027 (Real Local Models & Canonical Endpoints)**: Local-first inference via OpenAI-compatible endpoints with zero cloud fallback.

Sprint 4F requires deciding the desktop host foundation, establishing a reproducible packaging pipeline, and branding the desktop distribution as **Open VS Code**.

---

## Desktop Host Audit: Code-OSS vs VSCodium

We evaluated two open-source desktop shell candidates:

| Dimension | Upstream Code-OSS (`microsoft/vscode`) | Pinned VSCodium (`VSCodium/vscodium`) |
|---|---|---|
| **Build Reproducibility** | Fragile. Requires full Electron/native compilation toolchain (Python, node-gyp, C++ compiler, Xcode toolchains, yarn v1/patching), high build duration (40-60+ min), and platform variance. | High. VSCodium maintains automated CI pipelines producing clean, deterministic, multi-platform binaries from Code-OSS with verified SHA-256 checksums. |
| **Licensing** | Code-OSS source is MIT, but default build recipes inject Microsoft endpoints and proprietary branding configurations. | Pure MIT. All binaries and build recipes are strictly MIT-licensed with zero proprietary Microsoft binary blobs. |
| **Telemetry Defaults** | Upstream default includes active Microsoft telemetry channels requiring custom source-level patching to fully disable. | Telemetry disabled by default (`enableTelemetry: false`, telemetry endpoints completely stripped or redirected). |
| **Branding & Customization** | Requires heavy in-tree modifications across `product.json`, build scripts, and resource files. | Shallow and clean. Supports external `product.json` override, bundle identifier replacement, and icon injection without rebuilding editor core. |
| **Extension Bundling** | Supports built-in extensions in `resources/app/extensions/`. | Supports built-in extensions in `resources/app/extensions/` identically. |
| **Marketplace Behavior** | Microsoft Marketplace is legally restricted to official Microsoft VS Code builds. | Configured out-of-the-box for Open VSX (`open-vsx.org`), preventing ToS conflicts. Core Open VS Code features require zero marketplace access. |
| **Cross-Platform Portability** | Substantial platform-specific build scripts required for macOS, Linux, and Windows. | Deterministic releases available for macOS (arm64, x64), Linux (.deb, .rpm, .tar.gz, AppImage), and Windows (x64, arm64). |
| **Maintenance Burden** | High. Forking Code-OSS requires continuous rebasing against massive upstream churn. | Low. Open VS Code maintains only a shallow packaging workspace (`apps/desktop`) that applies branding and bundles our extension. |

---

## Decision

We adopt **VSCodium** as the pinned open-source desktop shell for Open VS Code V1.

### 1. Pinned Upstream Release

The upstream shell dependency is strictly pinned:
- **Distribution**: VSCodium
- **Upstream Release Tag**: `1.135.06055`
- **Base VS Code Version**: `1.135.0`
- **Upstream Commit**: `5a73682ca091082675b10c9dc3f348c1d824d94f`
- **Platform (V1 Development)**: macOS `darwin-arm64`
- **Artifact**: `VSCodium-darwin-arm64-1.135.06055.zip`
- **SHA-256**: `61ff9ebc3ac5563c63a0a9e1b479822647e7f2c3303b0629f15fefe9e291f7cc`
- **License**: MIT

The download URL and SHA-256 checksum are stored in `apps/desktop/upstream.json`. Downloads are validated against this checksum prior to packaging.

### 2. Extension-First Architecture Preserved

The desktop product maintains strict layered decoupling:

```text
Open VS Code Desktop Distribution (apps/desktop)
        │
        ├── Bundled Open VS Code Extension
        │       │
        │       ├── @open-vs-code/vscode-integration (extension host, UI, commands)
        │       ├── @open-vs-code/ide-adapter (IdeHost contracts, bridge)
        │       └── @open-vs-code/agent-core (agent loop, model router, tools, memory, recovery)
        │
        └── Editor Shell (VSCodium / Code-OSS runtime)
```

The desktop shell is responsible solely for:
- Application windowing and OS integration
- Application branding and product metadata
- Default configuration and collision-free user-data directories
- Bundling and auto-activating the Open VS Code extension

The desktop shell is **not** responsible for and contains **no**:
- Model routing or provider logic
- Prompt templates or LLM abstractions
- Safety policies, mutations, or tool execution
- HALO inference logic or proprietary cloud fallbacks

### 3. Shallow Packaging Workspace (`apps/desktop`)

Packaging is implemented in `apps/desktop` with four canonical phases:
1. `npm run desktop:prepare` (`apps/desktop/scripts/prepare.ts`): Downloads the pinned upstream archive (if not cached), validates the SHA-256 checksum, and unpacks the shell into a staging directory.
2. `npm run desktop:build`: Bundles `@open-vs-code/vscode-integration` into production CommonJS bundle (`dist/extension.js`).
3. `npm run desktop:package` (`apps/desktop/scripts/package.ts`):
   - Copies the shell to `Open VS Code.app`.
   - Modifies `Contents/Info.plist` (CFBundleName: `Open VS Code`, CFBundleIdentifier: `com.openvscode.desktop`).
   - Replaces `Contents/Resources/app/product.json` with Open VS Code metadata (nameShort: `Open VS Code`, dataFolderName: `.open-vs-code-desktop`, telemetry: `false`).
   - Copies the Open VS Code icon.
   - Bundles the compiled extension into `Contents/Resources/app/extensions/open-vs-code/`.
   - Replaces/renames the executable binary to `Open VS Code`.
   - Produces clean local distribution artifacts (`Open VS Code.app` and archive).
4. `npm run desktop:smoke` (`apps/desktop/smoke/desktop-smoke.test.ts`): Runs automated end-to-end smoke verification against a deterministic mock OpenAI-compatible endpoint.

### 4. What Is Intentionally NOT Forked

To maintain long-term sustainability:
- We do NOT fork the VS Code monorepo source tree.
- We do NOT fork the Electron binary build scripts.
- We do NOT move agent or routing logic into the editor source code.
- We do NOT fork the Monaco editor, LSP client, or debug engine.

### 5. Telemetry & Privacy Guarantees

- `enableTelemetry` is explicitly `false` in `product.json`.
- All telemetry endpoints (`telemetryOptOutUrl`, crash reporter URLs) are cleared or omitted.
- Open VS Code adds zero analytics, zero phone-home pings, and zero tracking code.
- No model weights are bundled or downloaded by the application.
- No cloud LLM fallback is permitted.

---

## Upgrade Strategy

When updating the upstream shell in future milestones:
1. Identify the new stable VSCodium release tag.
2. Record the exact tag, commit SHA, and artifact SHA-256 in `apps/desktop/upstream.json`.
3. Run `npm run desktop:prepare && npm run desktop:package && npm run desktop:smoke`.
4. Run full monorepo regressions (`npm test`, `npm run eval:coding`, etc.).
5. Record the version bump and any configuration changes in a lightweight ADR update.

---

## Consequences

- Open VS Code ships as a real, standalone macOS desktop application without user extension installation steps.
- Clean separation between editor shell and agent core is maintained.
- Upstream maintenance overhead is minimized to a lightweight configuration and bundling script.
- Cross-platform packaging (Windows/Linux) follows the identical strategy using VSCodium's corresponding archive targets.
