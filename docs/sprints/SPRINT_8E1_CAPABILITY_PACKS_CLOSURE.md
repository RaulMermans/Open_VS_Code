# SPRINT 8E.1 REPORT
## Capability Packs Integrity, Isolation & Runtime Closure

- **Sprint**: 8E.1 (Integrity, Isolation & Runtime Closure)
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8E1_ACCEPTED`
- **Branch**: `sprint/8e1-capability-packs-closure`
- **Starting Canonical Main**: `23654caf67a44b256e4be9a94f63fb6061619a60` (PR #46)
- **ADR Reference**: `docs/adrs/ADR-038-capability-packs-architecture.md`

---

## 1. Executive Summary

Sprint 8E.1 resolves the verified integration, integrity, and isolation gaps identified in Sprint 8E prior to platform expansion into external browser, design, and reverse-engineering packs.

The sprint delivers complete runtime closure across four critical areas:

1. **Manifest Integrity & Canonical Serialization**:
   - Implemented canonical manifest serialization (`serializeCanonicalManifest`) using recursive lexicographical key sorting, preserved array ordering, deterministic JSON primitive encoding, and strict omission of the top-level `integrity` field.
   - Enforced SHA-256 digest verification during import, installation, update, rollback, and persisted-record loading.
   - Enforced strict fail-closed rejection: digest mismatches immediately reject the manifest with a descriptive error and are **never** downgraded to a warning.
   - Formally documented and surfaced in diagnostics that a cryptographic checksum guarantees data integrity against tampering, but does **not** establish publisher authenticity.
   - Added rigorous tampered-manifest test suites verifying rejection of schema-valid manifests with modified instructions, permissions, or dependencies.

2. **Account-Owned Mode Lifecycle & Ephemeral Profiles**:
   - Eliminated the implicit conversion of account capability pack modes into durable workspace profiles (`.open-vs-code/modes.json`).
   - Account packs create account-scoped, explicitly ephemeral in-memory execution profiles in `ModeService` (`registerAccountPackProfile`).
   - On account logout or switch:
     - Account-derived modes and packs are purged from memory immediately.
     - Active turn executions and pending user confirmations are cancelled immediately via `ChatController.onAccountStateChange`.
     - Active chat controller modes revert cleanly to base `ASK` mode.
     - Workspace-owned modes and packs are preserved intact.
   - Verified complete user isolation: user Alice logs in, installs account pack, logs out → user Bob logs in within the same workspace and sees zero account modes or packs, surviving application restarts.

3. **Cross-Device Restoration**:
   - Verified the complete multi-device lifecycle using two independent client storage environments sharing a single account backend:
     - **Device A**: Logs in, installs an account-scoped pack, enables it, and logs out. Verified that Device A's workspace `.open-vs-code/modes.json` contains no account mode.
     - **Device B**: Clean storage environment (zero files from Device A). Logs into the same account, synchronizes packs via `syncAccountPacks`, registers effective mode profiles in `ModeService`, activates the pack, and executes a permitted task through `AgentSessionBridge` → `AgentRuntime` → `PermissionGate` → `Tool` (`read_file`).
   - Verified explicit blocked states when local requirements (e.g. skills or MCP servers/credentials) are missing on Device B.

4. **Readiness Correctness & Storage Reliability**:
   - Replaced permissive version requirement handling with strict SemVer range parsing (`parseSemver`, `isVersionCompatible`), rejecting malformed version expressions instead of treating them as compatible.
   - Added model deployment and declared capability checks to `PackResolverInput` and pack readiness evaluation, ensuring unmet requirements block `READY` status.
   - Unified UI readiness reporting and execution-time readiness checking under the same authoritative snapshot (`IntegrationManagerController.getProductionCapabilitySnapshot`).
   - Implemented atomic writes for workspace pack configurations (`packs.json.tmp` -> `renameSync`) and automatic corruption recovery (`.corrupt.<timestamp>` backup) preventing crash loops.

---

## 2. Root Cause Analysis & Corrective Actions

| Defect / Risk | Root Cause in Sprint 8E | Corrective Action in Sprint 8E.1 |
|---|---|---|
| **Manifest Integrity** | Manifest digests were generated via non-canonical `JSON.stringify(draft)` which varied by key insertion order, and verification could be bypassed or downgraded. | Implemented `serializeCanonicalManifest(manifest)` (lexicographically sorted keys, deterministic primitives, top-level `integrity` excluded). Strict SHA-256 verification in `validateCapabilityPackManifest`, `importPack`, `installPack`, `updatePack`, and `rollbackPack`. |
| **Account Mode Leakage** | `CapabilityPackService.installPack` called `modeService.createWorkspaceMode()`, persisting account-owned modes into the local `.open-vs-code/modes.json` workspace file. | Removed durable workspace writes for account packs. Added `registerAccountPackProfile` and `registerWorkspacePackProfile` in `ModeService`. Account packs register in-memory ephemeral profiles only. |
| **Cross-Device Restoration Failure** | Device B could sync the pack manifest from the account backend, but lacked the mode profile because it was only saved in Device A's local `modes.json`. | `CapabilityPackService.syncAccountPacks` now registers the pack's `customMode` directly into `ModeService.registerAccountPackProfile`, restoring full execution capabilities on Device B with zero reliance on Device A's filesystem. |
| **Revoked External Authority** | On account logout, active chat turns or pending confirmations could retain permissions previously granted by an account pack. | Added active turn and pending confirmation cancellation in `ChatController.onAccountStateChange`, resetting active custom mode IDs to `undefined` and reverting to `ASK` base mode. |
| **Malformed Version Requirements** | `isVersionCompatible` treated unparseable version strings as compatible wildcards. | Added strict SemVer parser rejecting malformed versions, returning `false` and recording incompatibility diagnostics. |
| **Storage Corruption Risk** | Non-atomic writes to `.open-vs-code/packs.json` could result in truncated files if interrupted; corrupt files crashed service initialization. | Implemented atomic temporary-file writes (`packs.json.tmp` -> `renameSync`) and corruption backup (`packs.json.corrupt.<timestamp>`), falling back safely to built-in starter packs. |

---

## 3. Targeted Test Evidence

### A. Manifest Integrity & Canonical Serialization (`agent-core` & `account-service`)
- `packages/agent-core/tests/packs/pack-validation.test.ts`:
  - `12. verifies cryptographic digest integrity and detects tampering`
  - `13. canonical serialization produces byte-identical strings regardless of key order and excludes integrity`
  - `14. rejects valid-schema manifests with tampered instructions (digest mismatch)`
  - `15. rejects valid-schema manifests with tampered permissions (digest mismatch)`
  - `16. rejects valid-schema manifests with tampered dependencies (digest mismatch)`
- `packages/account-service/tests/integration/pack-management.test.ts`:
  - `7b. rejects installation of tampered manifest (digest mismatch)`

### B. Mode Lifecycle & Workspace Isolation (`vscode-integration`)
- `packages/vscode-integration/tests/capability-packs.test.ts`:
  - `17. rejects tampered manifests on import, install, update, rollback, and load`
  - `18. rejects valid-schema manifests with tampered instructions, permissions, or dependencies`
  - `19. atomic workspace pack writes and corruption recovery creates backup and preserves valid builtins`
  - `20. account pack installation creates ephemeral in-memory profile and does not persist to modes.json`
  - `21. corrupted rollback record is rejected safely`
- `packages/vscode-integration/tests/capability-packs-e2e.test.ts`:
  - `9. Account-owned mode lifecycle: Alice -> logout -> Bob within same workspace and across app restart`
    - Alice installs and activates account pack with account mode.
    - Verified `.open-vs-code/modes.json` does not contain Alice's mode.
    - Pending turn / confirmation cancelled on logout.
    - Alice's mode and pack removed from memory; workspace mode and pack preserved.
    - Bob logs into the same workspace and cannot see Alice's pack or mode.
    - Application restart simulated: neither Alice's nor Bob's modes leaked to disk.

### C. Cross-Device Restoration & Execution (`vscode-integration`)
- `packages/vscode-integration/tests/capability-packs-e2e.test.ts`:
  - `10. Cross-device restoration (Device A -> Device B) without reliance on modes.json and executes permitted task`:
    - Device A (isolated storage A): login Alice, install account pack, enable, logout.
    - Device B (independent storage B, clean directory): login Alice, sync pack, resolve dependencies and effective mode in `ModeService`, activate pack, and execute permitted `read_file` task via `AgentSessionBridge` → `AgentRuntime` → `PermissionGate` → `Tool`.
  - `11. Cross-device restoration fails closed when required local dependency or credential is missing`:
    - Missing local skill or MCP server triggers explicit blocked diagnostics and fails closed.

---

## 4. Verification Ladder Results

All verification suites completed with zero errors and zero warnings:

| Gate | Scope | Command | Result |
|---|---|---|---|
| **Monorepo Tests** | All packages & apps (235 tests across 35 suites) | `npm test` | **PASS** (0 failures, 235 passed) |
| **Typecheck** | All packages & apps | `npm run typecheck` | **PASS** (0 errors) |
| **Lint** | All packages & apps | `npm run lint` | **PASS** (0 warnings, 0 errors) |
| **Build** | All packages & apps | `npm run build` | **PASS** (All bundles compiled) |
| **Runtime Evals** | Runtime determinism & category invariants (111 scenarios) | `npm run eval:runtime` | **PASS** (14/14 passed) |
| **Skills Evals** | Skill selection accuracy & token efficiency | `npm run eval:skills` | **PASS** (38/40, 86.9% reduction) |
| **Workflow Evals** | Structured engineering loop | `npm run eval:workflow` | **PASS** (14/14 eligible, 5/5 verified) |
| **Desktop Smoke** | Packaged desktop app structure & branding | `npm run desktop:smoke` | **PASS** (14/14 passed) |
| **Desktop Accept** | Real VSCodium extension host & app restart | `npm run desktop:accept` | **PASS** (5/5 passed) |

---

## 5. Architectural Invariants Preserved

1. **Zero Secondary Agent Runtimes**: Capability Packs remain purely declarative metadata manifests. Tool execution and agent loops flow exclusively through the existing `AgentSessionBridge`, `AgentRuntime`, and `PermissionGate`.
2. **Authority Hierarchy**: `PermissionGate` remains the supreme authority. Packs cannot elevate base mode permissions or self-approve mutations.
3. **No Dynamic Execution Hooks**: Package installation, import, preview, enable, and activation remain strictly free of shell commands, binary execution, npm hooks, or container creation.
4. **Clean Scope Separation**: Workspace packs reside in `.open-vs-code/packs.json`. Account packs reside in `AccountService` and project ephemeral in-memory profiles in `ModeService`, preventing leakage across multi-tenant workspaces.
