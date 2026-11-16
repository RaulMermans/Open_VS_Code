# Sprint 22 — Agent command sandbox (bubblewrap)

Date: 2026-11-16. Candidate `0.1.0-rc.21` from `81abd18b26`, `.deb` SHA-256 `3cc6f2100c30f0bae02c5afc6052fb2f54eaf9a60522586ed026c9017a6e6047`, bundled `extension.js` `8554b19f5b321639e954a7a6d88bfd2ddc715757e6d87e0bfd0e557bd9052e27`. Decision: ADR-046.

## What changed

Every command the agent runs after approval goes through `VerificationEngine.execute`. That single choke point now wraps the command in bubblewrap (`packages/agent-core/src/tools/command-sandbox.ts`):

- no network, private PID/IPC/UTS namespaces, new session, dies with the parent;
- empty private `$HOME`; nvm/`~/.local` toolchains on `PATH` re-bound read-only;
- read-only system directories, private `/tmp` and `/run`;
- the workspace is the only writable host path; environment cleared.

Setting `open-vs-code.agent.commandSandbox`: `auto` (default), `required`, `off`. The approval card shows the predicted sandbox; each verification result states whether it was sandboxed.

## Evidence

| Check | Result |
| --- | --- |
| Real bubblewrap tests (`tests/tools/command-sandbox.test.ts`) | 5/5: workspace write allowed; outside write, `~/.ssh` visibility, inherited secret env and network all blocked; `node --test`, `npm run test`, Python `unittest` pass inside; cancel kills the sandboxed tree |
| CI gates | typecheck, lint, build, deterministic tests: PASS |
| Inside the real Electron extension host | Diagnostic copy of the rc.21 extension with the default forced to `required` (fail closed): GUI CODE-BUG (npm) and CODE-HELD-PY (unittest) PASS with "Tests passed", so verification ran inside bubblewrap |
| Live coding eval with sandboxed verification (RC21) | 26/30, held-out 20/22, 0 false completions, 0 timeouts, 0 out-of-scope writes (rc.20 unsandboxed: 27/30, 21/22 — within run variance; the one held-out difference, h09, is a genuine failing test reported from inside the sandbox) |

## Limitations

- Projects whose test command needs network (installing dependencies during `npm test`) fail in the sandbox; set the setting to `off` for them.
- Linux only. Other platforms report `bubblewrap is Linux-only` and run unsandboxed in `auto`.
- MCP stdio servers are not wrapped (user-configured integrations).
