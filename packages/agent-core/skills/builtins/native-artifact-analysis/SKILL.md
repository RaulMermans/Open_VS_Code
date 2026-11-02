---
id: native-artifact-analysis
name: Native Artifact Analysis
description: Inspect compiled native binaries and archives with REA, verifying provider capabilities without unsandboxed execution or unconfigured engine assumptions.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
  - REVIEW
capabilities:
  - read
  - search
required_tools:
  - read_file
  - list_directory
  - search_text
context_budget: 750
risk_level: low
triggers:
  - analyze native binary
  - inspect macho binary
  - inspect elf binary
  - rea native analysis
  - reverse engineer binary artifact
composes_with:
  - rea-investigation-routing
  - evidence-reconciliation
---

# Intent

Safely inspect native executables and package archives, verifying provider capabilities, extracting symbols and layout headers, and strictly prohibiting unsandboxed target execution.

# When to Use

- Inspecting Mach-O, ELF, PE, DMG, APK, or IPA packages.
- Extracting binary layout, headers, dependencies, and exported symbols.
- Checking decompiler prerequisites (Ghidra, Hopper, IDA) and reporting missing configurations.

Do not use for running untrusted binaries or executing live debugger sessions in non-isolated environments.

# Inputs

- Local path to a native binary or packaged archive.
- REA server diagnostics reporting available and missing providers.
- Bounded observation parameters.

# Workflow

1. Probe binary format: read header magic bytes to identify Mach-O, ELF, PE, or archive container.
2. Check provider availability: evaluate whether configured providers (e.g. `native-macos`, `rea-artifact-graph`) support the format.
3. Handle missing providers: if a decompiler is missing, report the required environment variable (`GHIDRA_INSTALL_DIR`, `IDADIR`) and stop.
4. Execute safe inspection: invoke `inspect_artifact` or `inspect_macho` to extract sections, libraries, and symbols.
5. Record observations: register findings as `OBSERVED` facts with provider provenance.
6. Document limitations: clearly record unanalyzed code sections as `UNKNOWN`.

# Verification

- Native analysis operates strictly within read-only boundaries.
- No binary is executed directly on the host operating system.
- Missing external engines are accurately reported with actionable remediation.

# Failure Modes

- Running untrusted code: launching target executables with `exec` or `spawn`.
- Decompiler assumption: claiming Ghidra decompilation when Ghidra is not installed.
- Corrupted archive: failing to validate package archive checksums before analysis.

# Exit Criteria

- Binary format, architecture, and headers are documented.
- Exported symbols and imported libraries are recorded in the evidence ledger.
- All provider limitations and residual unknowns are explicit.
