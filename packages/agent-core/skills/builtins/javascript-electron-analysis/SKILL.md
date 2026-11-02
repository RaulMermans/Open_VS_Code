---
id: javascript-electron-analysis
name: JavaScript & Electron Analysis
description: Statically reconstruct JavaScript and Electron applications using REA, analyzing ASAR archives, bundle layouts, routes, and semantic relations.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
  - REVIEW
  - BUILD
capabilities:
  - read
  - search
required_tools:
  - read_file
  - list_directory
  - search_text
context_budget: 800
risk_level: low
triggers:
  - analyze asar
  - electron reverse engineering
  - analyze javascript application
  - rea asar inspection
  - reconstruct electron bundle
composes_with:
  - rea-investigation-routing
  - feature-specification
  - evidence-reconciliation
---

# Intent

Extract, inspect, and statically reconstruct local JavaScript and Electron application bundles without executing untrusted target code, using REA's application graph engine.

# When to Use

- Reverse engineering packaged Electron applications, ASAR files, or bundled Webpack/Vite distributions.
- Discovering entry points (`main.js`, preload scripts, renderer bundles).
- Mapping static routes, IPC communication channels, and semantic function relations.

Do not use for executing target binaries or debugging live unverified Electron main processes.

# Inputs

- Absolute path to an ASAR archive or unpacked application directory.
- REA MCP server providing `analyze_javascript_application` and `inspect_artifact`.
- Memory and timeout constraints for worker processes.

# Workflow

1. Validate input bundle: confirm archive integrity and locate package manifest (`package.json`).
2. Invoke REA static analysis: call `analyze_javascript_application` with `input_path` and bounded heap.
3. Inventory artifact structure: inspect recovered file list, dependencies, and entry scripts.
4. Extract routes and IPC: query static routes, handler mappings, and preload context bridges.
5. Trace feature seeds: identify key UI components and data flow models from semantic graphs.
6. Record evidence: store recovered application graph in the evidence ledger with `OBSERVED` status.

# Verification

- Application graph reflects authentic source files without execution.
- File digests and entry points match the physical bundle.
- Integrity contradictions or parse errors are flagged as limitations.

# Failure Modes

- Execution leakage: attempting to run `electron .` directly instead of static inspection.
- Unbounded analysis: analyzing multi-gigabyte bundles without setting source path bounds.
- Missing worker: failing to handle worker process timeouts gracefully.

# Exit Criteria

- ASAR archive layout and manifest are cataloged.
- Main, preload, and renderer modules are mapped.
- Static application graph is recorded in the evidence ledger.
