# ADR-046: Sandbox agent-initiated commands with bubblewrap

Status: Accepted (Sprint 22, 2026-11-16)

## Context

The Electron/Chromium sandbox protects renderers, not processes the agent starts after approval (tests, lint, typecheck, build). Those ran on the host with the user's full permissions: network, `$HOME` (SSH keys, cloud credentials, other repositories) and every writable path. Personal V1 relied on approval alone.

Every agent-initiated command goes through one choke point, `VerificationEngine.execute` (MCP stdio servers are separate, user-configured integrations). Docker requires root-equivalent group membership on this host; unprivileged bubblewrap works (Sprint 21 investigation).

## Decision

`VerificationEngine` wraps the already-validated command (`command-sandbox.ts`) after its existing containment checks:

- `--unshare-all` (no network, private PID/IPC/UTS), `--die-with-parent`, `--new-session`, `--clearenv` with a minimal environment.
- Read-only `/usr`, `/etc`, `/opt`, `/bin`, `/lib*`; private tmpfs `/tmp` and `/run`.
- `$HOME` is an empty tmpfs. Toolchains on `PATH` under `$HOME` (nvm, `~/.local`) and `~/.local/lib` are re-bound read-only. `$HOME` itself is never bound.
- The workspace is the only writable host path.

Modes, setting `open-vs-code.agent.commandSandbox`:

- `auto` (default in the runtime and desktop): sandbox when bubblewrap works; otherwise run on the host and say so.
- `required`: never run unsandboxed; verification reports the reason instead.
- `off`: previous behavior.

The approval card shows the predicted sandbox, and every verification observation states whether it ran sandboxed. The library default for a bare `VerificationEngine` stays `off`, so existing embedders keep explicit control.

## Consequences

- An approved test command can no longer read SSH keys or other projects, reach the network or write outside the workspace.
- Verification that needs network (dependency install during `npm test`) fails inside the sandbox; switch the setting to `off` for such projects.
- Python packages installed with `pip --user` remain visible (`~/.local/lib` read-only); virtualenvs inside the workspace work.
- Not covered: MCP servers, and non-Linux hosts (they report `bubblewrap is Linux-only`).
