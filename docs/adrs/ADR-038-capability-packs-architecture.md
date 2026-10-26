# ADR-038: Capability Packs — Declarative Packaging, Dependency Resolution & Governed Installation

- **Status**: Accepted (Amended in Sprint 8E.1)
- **Date**: 2026-10-26
- **Sprint**: 8E, 8E.1 (Capability Packs Integrity, Isolation & Runtime Closure)
- **Preceded by**: ADR-014 (Metadata-First Skills), ADR-015 (Bounded MCP Integration), ADR-018 (Chat UX Layer), ADR-023 (System Security Boundaries), ADR-029 (Portable Skills Runtime), ADR-034 (MCP Modern Transports & Governance), ADR-035 (Private Accounts & Integration Profiles), ADR-036 (Visual Integration Manager & MCP Lifecycle UX), ADR-037 (Custom Modes Engine & Execution Profiles)

---

## 1. Context

In Sprint 8D, Open VS Code established the Custom Modes Engine and Execution Profiles (ADR-037), enabling users to specialize agent behavior into constrained roles mapped deterministically onto canonical base modes (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`). However, configuring a complete agent capability across real-world workflows requires orchestrating multiple related elements:
1. Custom Mode profiles
2. Required and optional portable Skills (ADR-029)
3. Required and optional MCP tools and server registrations (ADR-034)
4. Preferred model capabilities and context constraints
5. Workflow requirements and eligibility rules
6. Runtime evaluation requirements and test assertions

Without declarative packaging, users are forced to manually configure each layer separately across scattered JSON files, workspace settings, and MCP registrations. Conversely, common packaging implementations in other ecosystems introduce severe supply-chain vulnerabilities and architectural anti-patterns:
- **Parallel Pack Runtimes**: Introducing independent execution loops or custom agent interpreters for each package, fracturing auditing and security invariants.
- **Side-Effecting Package Scripts**: Running arbitrary code during package installation (`npm install`, `npx`, postinstall hooks, shell scripts, container spin-ups).
- **Conflation of Lifecycle Operations**: Conflating import, installation, activation, and tool-execution authority into a single step, granting remote bundles immediate execution authority.
- **Permission Boundary Escalation**: Allowing imported packages to override canonical mode constraints, bypass `PermissionGate`, or self-approve file/command mutations.
- **State Pollution Across Scopes**: Overwriting local workspace configurations with account-level packages without clear precedence or logout cleanup.

---

## 2. Core Architectural Decision: Declarative Packaging Without a Secondary Agent Runtime

**A Capability Pack is a declarative bundle of references to existing capabilities, not a new execution engine or permission authority.**

Open VS Code maintains a single, authoritative agent execution pipeline. Capability Packs resolve directly into validated references consumed by existing subsystems:

```text
Capability Pack Manifest (.json)
       │
       ▼
Manifest Validation (Untrusted Input Scanning, SemVer, Checksums)
       │
       ▼
Deterministic Pack Resolver (Custom Modes, Skills, MCP, Models, Workspaces)
       │
       ▼
Permission & Trust Review (PermissionGate Bounds, Integrity, Publisher)
       │
       ▼
Installation Registry (Workspace: .open-vs-code/packs.json | Account: SQLite DB)
       │
       ▼
Custom Mode Activation (ModeService / ModeResolver)
       │
       ▼
AgentSessionBridge (Existing Session Orchestrator)
       │
       ▼
AgentRuntime (Existing Single Authoritative Agent Loop)
```

### Key Invariants
1. **Single Authoritative Runtime**: The `AgentRuntime` remains completely unaware of pack-installation or marketplace mechanics. It receives immutable capability snapshots prepared by the existing `AgentSessionBridge`.
2. **PermissionGate Authority**: `PermissionGate` remains the supreme authority. A Capability Pack cannot override canonical mode boundaries, self-approve mutation actions, or expand tool access beyond the intersection of the mode profile and user settings.
3. **No Execution Scripts**: Capability Packs are purely declarative JSON documents. No arbitrary shell commands, binary execution, npm scripts, or Docker containers are permitted during any stage of pack handling.

---

## 3. Governed Installation Lifecycle: Strict Separation of Concerns

To prevent ambient authority and supply-chain exploits, pack management enforces strict separation across 10 distinct lifecycle operations:

```text
[ Remote / File ] ──► (1) Import ──► (2) Validate ──► (3) Preview
                                                             │
                                                             ▼
                                                       (4) Install
                                                             │
                                                             ▼
                                                       (5) Enable
                                                             │
                                                             ▼
                                                       (6) Activate ──► [ Execution in AgentRuntime ]
                                                             │
                                                             ▼
                                                       (7) Disable
                                                             │
                                                             ├─► (8) Update
                                                             ├─► (9) Remove
                                                             └─► (10) Rollback
```

### The Three Separation Rules:
1. **Import != Install**: Importing reads and validates the pack manifest without persisting it to the workspace or account registry.
2. **Install != Enable**: Installing writes the record with `enabled: false`. No mode is registered as active, no skill is injected, and no MCP server is engaged.
3. **Enable != Execute**: Enabling makes the pack eligible for activation, but runtime execution occurs only when the user explicitly selects the mode in the chat interface. All tool invocations remain subject to `PermissionGate`.

---

## 4. Manifest Specification & Untrusted Input Defense

All manifests conform to `open-vs-code/capability-pack@v1`. Manifests must be treated as untrusted external inputs.

### Manifest Integrity Verification (Sprint 8E.1)
1. **Canonical Serialization**: Manifest digests are calculated using recursive lexicographical key sorting, preserving array ordering, deterministic JSON primitive encoding, and strictly excluding the top-level `integrity` field.
2. **Digest Verification**: The SHA-256 digest is strictly verified during import, installation, update, rollback, and persisted-record loading.
3. **Fail-Closed Mismatch Rejection**: Any digest mismatch rejects the manifest immediately with a terminal error; verification failures are **never** downgraded to a warning.
4. **Authenticity Notice**: A checksum provides integrity, not publisher authenticity. The system explicitly communicates this boundary in documentation and diagnostics.
5. **Tamper Defense**: Valid-schema manifests with altered custom instructions, expanded permissions, or injected dependencies are rejected due to digest mismatch.

### A. Manifest Structure (`CapabilityPackManifest`)
- **Metadata**: `id` (alphanumeric/kebab-case), `name`, `description`, `version` (strict SemVer), `publisher` (`id`, `displayName`, `verified`, `repositoryUrl`, `contactUrl`), `source` (`repositoryUrl`, `commit`, `release`, `tag`), `license` (SPDX identifier), `engines` (`openVsCode` compatible version range).
- **Referenced Capabilities**:
  - `customMode`: Embedded or referenced custom mode profile mapped to a canonical base mode (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`).
  - `skills`: Required and optional skill identifiers.
  - `mcp`: Required and optional server names and tool allowlists.
  - `models`: Preferred and fallback model families, minimum context window, recommended parameters.
  - `workflow`: Step requirements (e.g. structured engineering loop requirements).
  - `evaluations`: Evaluation suite identifiers and minimum passing thresholds.
  - `permissions`: Declarative permission requirements (strictly validated against base mode ceilings).
  - `integrity`: SHA-256 cryptographic digest of the manifest payload.

### B. Validation Guardrails
The validation layer (`validatePackManifest`) enforces:
1. **Schema Integrity**: Strict typing, non-empty IDs, valid SemVer (`semver.valid`), and matching schema version (`open-vs-code/capability-pack@v1`).
2. **Prototype Pollution Protection**: Deep scanning rejecting objects with `__proto__`, `constructor`, or `prototype` keys.
3. **Executable Directive Scanning**: Rejecting manifests containing execution triggers (`runCommand`, `postinstall`, `shell`, `exec`, `script`, `command`, `spawn`).
4. **Embedded Credential Scanning**: Detecting API keys, bearer tokens, AWS credentials (`AKIA...`), and PEM private keys in any string field.
5. **Path Traversal Scanning**: Rejecting `../`, `..\\`, or absolute root paths in identifiers and relative path fields.
6. **Permission Ceiling Invariant**: Rejecting permission declarations that exceed the canonical base mode (e.g. attempting to grant `canExecuteCommands: true` or `mutationAuthority: true` under `REVIEW` or `ASK`).
7. **Tamper Detection**: Verifying SHA-256 integrity digest when provided.

---

## 5. Deterministic Dependency Resolution & Readiness States

The `PackResolver` deterministically inspects the host environment and dependencies without side effects:
- Referenced Custom Mode validity
- Required and optional Skill availability in `SkillRegistry`
- Required MCP server registration in `McpService` and live connection state
- Tool availability in `McpCatalog`
- Model availability and satisfyability
- Workspace trust status

### Structured Readiness Results
| Status | Meaning | Can Activate? |
| :--- | :--- | :--- |
| `READY` | All required Custom Modes, Skills, MCP servers, and models are available, connected, and permitted. | Yes |
| `INSTALLED_INACTIVE` | Pack is installed but disabled by the user or admin policy. | No |
| `MISSING_DEPENDENCIES` | Required skills, MCP servers, or tools are not present or registered. | No |
| `INCOMPATIBLE` | Incompatible Open VS Code version, schema version, or base mode restrictions. | No |
| `BLOCKED_BY_POLICY` | Enterprise or account security policy blocks one or more pack capabilities. | No |
| `UNTRUSTED` | Workspace is untrusted and pack requires elevated workspace trust. | No |
| `INVALID` | Manifest fails validation, corrupt state, or checksum mismatch. | No |

**Fail-Closed Rule**: A pack is never marked `READY` if a required MCP server is disconnected or unreachable. Missing optional dependencies are reported as informational diagnostics without blocking activation.

---

## 6. Scope & Identity Integration: Account Packs vs Workspace Packs

Capability Packs support dual-scope persistence:

### A. Account Packs (Server-Side Persistence & Ephemeral Client Profiles)
- Persisted in the authenticated user's account database via `AccountService` (SQLite `capability_packs` table with user isolation and audit logging).
- Seamlessly synchronize across developer machines upon account login.
- **Sprint 8E.1 Correction**: Account pack modes are registered strictly as ephemeral, account-scoped in-memory execution profiles in `ModeService`. They are **never** converted into or persisted as durable workspace profiles (`.open-vs-code/modes.json`).
- Pack configuration is strictly separated from machine-specific credentials and local binaries.
- On account logout or account switch:
  - Account-derived modes and packs are immediately flushed from memory.
  - Active turn executions and pending user confirmations are cancelled immediately.
  - Chat controller active modes revert to base `ASK` mode.
  - Subsequent users (e.g., Alice → logout → Bob) within the same workspace and across application restarts have zero leakage of account modes or packs.

### B. Workspace Packs (Local Git-Committed Configuration)
- Persisted in `.open-vs-code/packs.json` inside the repository using atomic temporary-file writes (`packs.json.tmp` -> `renameSync`).
- Corrupt records are backed up safely to `.open-vs-code/packs.json.corrupt.<timestamp>` to prevent crash loops and enable recovery.
- Version-controlled alongside repository code for reproducible team workflows.
- Subject to workspace trust boundaries.

### C. Precedence, Conflict Handling & Cross-Device Restoration
- If a pack ID exists in both scopes: **Workspace configuration takes precedence** over Account configuration for execution settings, preserving project-specific requirements.
- On account logout or switch: Account-derived packs are immediately removed from the active runtime and mode registry. Workspace packs remain untouched.
- Active sessions dependent on account packs are safely transitioned or terminated.
- **Cross-Device Restoration (Device A → Device B)**:
  - Proven across independent client storage environments sharing the same account backend.
  - Device B synchronizes packs from the account backend, registers effective modes in-memory, and executes permitted tasks through `AgentRuntime` with zero reliance on Device A's `.open-vs-code/modes.json`.
  - Missing local executables, unconfigured tools, or missing credentials produce explicit blocked states (`isReady: false` with diagnostics) and fail closed.

---

## 7. Reference Implementations

Sprint 8E provides two production-grade starter packs:

1. **Repository Architecture Review Pack (`repo-architecture-review`)**:
   - **Base Mode**: `REVIEW` (read-only ceiling).
   - **Tools**: Read, glob, grep, search. Mutating tools (`writeFile`, `executeCommand`) are strictly denied.
   - **Skills**: Architectural inspection and evidence-backed reporting.
   - **Execution**: Runs directly inside existing `AgentRuntime` with zero destructive actions permitted.

2. **MCP-Enabled Research Demonstration Pack (`mcp-research-demo`)**:
   - **Base Mode**: `PLAN`.
   - **Dependencies**: Declares required local MCP server (`fixture_server` / tool `mcp_fixture_server_echo`).
   - **Readiness Verification**: Resolves to `MISSING_DEPENDENCIES` when server is disconnected, transitions cleanly to `READY` when connected.

---

## 8. Consequences

### Positive
- Declarative, portable sharing of custom workflows, skills, and tools across teams and accounts.
- Zero proliferation of secondary agent runtimes; 100% reuse of existing `AgentSessionBridge`, `AgentRuntime`, and `PermissionGate`.
- Complete immunity against package-install execution exploits (`npm`, `npx`, shell hooks).
- Clear lifecycle semantics with rollbacks, updates, and audit logging.
- Consistent user interface inside the Visual Integration Manager.

### Neutral / Trade-offs
- Users cannot package arbitrary shell scripts or automated tool installers into packs; external tools must be installed out-of-band and registered via standard MCP/Skill mechanisms.
- Requires deterministic network-isolated verification of manifests.
