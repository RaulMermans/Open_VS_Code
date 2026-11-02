---
id: rea-investigation-routing
name: REA Investigation Routing
description: Classify software targets and select bounded reverse-engineering workflows across web apps, Electron bundles, native artifacts, and repositories.
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
context_budget: 850
risk_level: low
triggers:
  - reverse engineer target
  - rea routing
  - classify investigation target
  - investigate software target
  - reverse engineering intake
composes_with:
  - browser-behavior-investigation
  - javascript-electron-analysis
  - native-artifact-analysis
---

# Intent

Direct software investigation tasks to the correct specialized workflow based on target category, available tools, and provider prerequisites, preventing unguided exploration.

# When to Use

- A user requests reverse engineering or functional investigation of a software target.
- Determining whether an input is a running web app, an Electron/ASAR bundle, a native binary, or a source repository.
- Choosing between browser automation, REA MCP tools, or standard repository tools.

Do not use for routine source code refactoring or simple bug fixes in known repositories.

# Inputs

- Target locator: URL endpoint, file path, directory path, or package archive.
- Authorization scope: verified local-first or permitted origin bounds.
- REA server diagnostics: advertised tools and configured analysis providers.

# Workflow

1. Probe target type: inspect protocol for URLs (`http://`, `https://`), file extension for archives (`.asar`, `.dmg`, `.apk`), or directory structure.
2. Verify permissions and target scope: confirm web URLs belong to allowlisted local or test origins; verify file paths reside within permitted workspaces.
3. Check provider readiness: query REA provider diagnostics to verify if required engines (`native-macos`, `rea-artifact-graph`) are available.
4. Route to specialist:
   - Running web application -> `browser-behavior-investigation`.
   - JavaScript/Electron application -> `javascript-electron-analysis`.
   - Native or packaged executable -> `native-artifact-analysis`.
   - Source code repository -> standard repository tools.
5. Report missing providers: if an unconfigured decompiler (Ghidra, Hopper, IDA) is required, report exact remediation without failing closed.

# Verification

- Target is unambiguously classified into one of the four canonical categories.
- Selected workflow matches available tool capabilities.
- Security constraints and origin allowlists are fully satisfied.

# Failure Modes

- Unchecked URL: attempting to investigate external public URLs without authorization.
- Provider assumption: assuming heavyweight native decompilers are installed when unconfigured.
- Misrouting: treating an ASAR bundle as a generic binary rather than a JavaScript application.

# Exit Criteria

- Target category is determined with supporting evidence.
- Appropriate specialized skill is selected for the next stage.
- Missing dependencies or provider prerequisites are clearly communicated.
