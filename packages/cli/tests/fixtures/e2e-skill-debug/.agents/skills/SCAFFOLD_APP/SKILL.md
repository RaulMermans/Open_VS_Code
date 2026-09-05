---
id: SCAFFOLD_APP
title: Scaffold App
summary: Scaffold a new application or module safely without overwriting existing structure.
modes:
  - BUILD
  - PLAN
tags:
  - scaffold
  - init
  - bootstrap
  - architecture
tools:
  - search_text
  - read_file
  - write_file
version: 1.0.0
---

## Intent

Safely scaffold a new application, module, or component hierarchy without blindly overwriting existing structures or ignoring project constraints.

## When

Use this skill when initializing a new project, adding a major structural module, or laying out a multi-file foundation from scratch.

## Inputs

- The requested application or module structure.
- Any specific frameworks or patterns requested by the user.

## Procedure

1. **Inspect repository first:** Before creating files, verify what already exists to avoid collisions.
2. **Read relevant Markdown first:** Check `PROJECT.md`, `ARCHITECTURE.md`, and other documentation for existing architectural decisions.
3. **Determine stack from Project Memory:** Use the defined stack rather than assuming defaults.
4. **Do not overwrite existing app structure blindly:** If a target directory is not empty, prompt the user or integrate carefully.
5. **Smallest viable scaffold:** Generate the minimal set of files needed to start, rather than a massive boilerplate.
6. **File map before broad generation:** Propose the file structure before generating numerous files.
7. **No automatic package installation:** Do not install npm packages automatically. Add them to `package.json` for the user to install, or prompt the user.
8. **Controlled verification:** Verify the generated structure using read tools or non-mutating checks.
9. **Token-efficient inspection:** Use targeted searches rather than reading every existing file.

## Expected Output

- A minimal, correct file structure matching the requested scaffold and project constraints.
- A summary of the created files and any manual steps the user needs to take (e.g., `npm install`).

## Failure Modes

- Overwriting existing critical files.
- Generating a massive scaffold that exceeds token limits or repair budgets.
- Using the wrong framework or stack.

## Recovery Prompts

- "The target directory is not empty. Please review existing files before proceeding."
- "The scaffold failed validation. Check the test output and correct the structure."
