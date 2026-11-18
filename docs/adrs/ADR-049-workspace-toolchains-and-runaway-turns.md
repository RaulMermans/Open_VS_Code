# ADR-049: Workspace toolchains in the command sandbox; bounded reasoning turns

Status: Accepted (Sprint 25, 2026-11-18). Approved by the project owner: trusted workspace-local Python
virtualenvs and existing project package managers, inside the command sandbox only.

## Context

Sprint 25 evaluation (ADR-048) found verification was the most common reason a correct change ended
unverified: Python verification used `python3` from PATH and refused a workspace interpreter (ADR-046), so
pytest in a project `.venv` was never usable; pnpm through Corepack tried to download inside the no-network
sandbox; and models added a `test` script to `package.json` to get something to run. Separately, 2 of 1,661
Qwen3.6 requests ran to the 180 s limit (runaway reasoning; normal turns 1-5 s), ending their tasks.

## Decision

1. **Project virtualenv.** `.venv` (or `venv`) is used when it is a real directory inside the workspace with
   its `pyvenv.cfg`, and `bin/python` resolves to an executable named `python3`/`python3.x` in the `home` that
   `pyvenv.cfg` names, outside the workspace. Copied binaries, other programs, symlinked venv directories and
   home mismatches are refused. pytest presence is read from `site-packages`; no workspace binary runs during
   discovery. The engine re-checks the interpreter at execution.
2. **Sandbox required.** A workspace interpreter runs only in sandbox mode `required`: never with the sandbox
   off, never on fallback when bubblewrap is unavailable. The approval card says so. Network stays unshared,
   HOME stays an empty tmpfs; the interpreter's own installation (each symlink hop's prefix under HOME) is
   exposed read-only.
3. **Package manager.** The `packageManager` version (pnpm/yarn) runs from the Corepack cache, exposed
   read-only, with `COREPACK_ENABLE_NETWORK=0`, auto-pin and download prompts off. The engine accepts only these
   fixed values and binds that resolve inside `COREPACK_HOME/v1`; any other variable (e.g. tokens) is refused.
4. **`ENVIRONMENT_SETUP_REQUIRED`.** Missing pytest, an uncached package manager the script calls, or declared
   dependencies without `node_modules` are reported before any approval, with the setup command named, and
   the task ends `ENVIRONMENT_SETUP_REQUIRED` when that is all that remains. Nothing is installed: discovery and
   verification never install. An approved, network-enabled setup step is not built (it would need a
   registry-only network path; bubblewrap offers all-or-nothing networking).
5. **No manifest workarounds.** A missing `test` script falls back to `test:unit`. An edit that adds a script
   to `package.json` is refused unless the request is about package.json, scripts or dependencies; editing an
   existing script remains possible.
6. **Bounded reasoning turns.** Agent turns (with tools) send `max_tokens: 6144`. A turn cut off with no tool
   call and no text, or a timed-out turn, is retried once with `reasoning_effort: "none"` (honoured by Ollama;
   `think: false` is ignored on `/v1`). The request timeout is unchanged; cancellation is never retried.

## Not done

- Approved dependency installation with restricted network access.
- Streaming with an inactivity timeout (would distinguish slow progress from a stall more precisely).
