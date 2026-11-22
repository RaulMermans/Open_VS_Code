# Sprint 11A — Linux Daily Driver & Real Local Inference

Verdict: **`SPRINT_11A_PARTIALLY_VERIFIED`**

The installed application can open on this machine with the Electron sandbox enabled. A real local model answers through the existing model gateway. It can read a repository and explain the code it actually opened. It did not complete a correct code edit on the two editing tasks. The new Debian package is built and still needs a root install before the applications menu picks up this sprint's launcher.

HALO is not required.

## Machine

Observed on the development host, not assumed:

| Item | Observed |
|---|---|
| CPU | AMD Ryzen AI MAX+ 395, 32 threads |
| GPU | Radeon 8060S (`gfx1151`), ROCm module loaded |
| Memory | `free` reports about 61 GiB. ROCm reports a 64 GiB GPU heap. |
| OS | Linux x86-64 |
| Ollama | `0.40.15`, listening on `127.0.0.1:11434` |
| Model | `qwen2.5-coder:7b` (Q4_K_M, 4.7 GB on disk). Capabilities reported by Ollama: completion, tools, insert. |
| During tasks | Ollama `ps` showed 100% GPU, 6.6 GB, context 32768 |
| Other endpoint | `llama-server` on `127.0.0.1:8081` returned HTTP 401. It was not used. |

No model weights were downloaded for this sprint.

## Install and launch

From the repository:

```bash
npm ci
npm run desktop:prepare
npm run desktop:build
npm run desktop:package
```

Artifacts:

- Unpacked tree: `apps/desktop/dist/Open-VS-Code-linux-x64-0.1.0`
- Archive: `apps/desktop/dist/Open-VS-Code-linux-x64-0.1.0.tar.gz`
- Package: `apps/desktop/dist/open-vs-code_0.1.0_amd64.deb`
- Archive SHA-256: `bb7942a428c4a11197e94e62797164a6dcaf4f2eab7503a5328e9cfbaf2c5d8d`

Install the package as root:

```bash
sudo dpkg -i apps/desktop/dist/open-vs-code_0.1.0_amd64.deb
```

The package `postinst` sets `/usr/lib/open-vs-code/chrome-sandbox` to owner `root:root` and mode `4755`. That is the supported Electron sandbox configuration. The launcher does not pass `--no-sandbox`.

Launch:

```bash
open-vs-code /path/to/repo
```

Or use the applications-menu entry `Open VS Code` (`Exec=open-vs-code %F`).

The launcher exports `OPEN_VS_CODE_REAL_INFERENCE=1` before starting the GUI. That is the operator authorization for the workspace's configured local endpoint. It does not add a cloud provider. A parent VS Code or Cursor terminal's `ELECTRON_RUN_AS_NODE` is cleared before the GUI starts, then set only for the VS Code CLI handoff.

## Connect the local model

In the opened repository, create `.open-vs-code/models.json` from `config/examples/models.local.example.json`, or run **Open VS Code: Create Starter Model Configuration**.

For this machine the served model name is `qwen2.5-coder:7b` and the base URL is `http://127.0.0.1:11434`. Check the endpoint:

```bash
curl -sS http://127.0.0.1:11434/api/version
curl -sS http://127.0.0.1:11434/api/tags
```

The chat label comes from the deployment `ModelRouter` selects for the active mode. It is not the first object in `models`. After a turn, the label is the deployment that actually served the request, including the served model name.

A direct completion of "Reply with the single word pong." returned `Pong` in 1.74 seconds (36 prompt tokens, 3 completion tokens).

## Sandbox

| Launch | Result |
|---|---|
| Already installed `/usr/lib/open-vs-code/codium` (`chrome-sandbox` is `4755 root`) | Process stayed up. A `chrome-sandbox` child was present. The process tree did not contain `--no-sandbox`. |
| Unpacked payload, helper not owned by root | Process aborted with `The SUID sandbox helper binary was found, but is not configured correctly.` It did not continue unsandboxed. |

Playwright's Chromium on this host starts a setuid-sandbox zygote parent with `--no-zygote-sandbox` while the sandboxed zygote is the `chrome-sandbox` child. The browser runtime no longer treats that flag as `--no-sandbox`. `--no-sandbox` and `--disable-setuid-sandbox` are still rejected.

Root install of the new `.deb` was not performed in this session. Until that install, the applications menu still runs the previously installed 0.1.0 package.

## Coding tasks

Provider for every task: `ollama-local` deployment `qwen-chat`, model `qwen2.5-coder:7b`. The label recorded by the gateway was `Qwen 2.5 Coder 7B · qwen2.5-coder:7b`. Tasks ran through `AgentSessionBridge` and `createAgentRuntime`, which is the path the chat uses, with `OPEN_VS_CODE_REAL_INFERENCE=1`. They were not typed into the GUI webview. Approvals in the harness were granted when the runtime asked.

### Task 1 — Understand existing code — pass

Workspace: disposable notes project. Prompt: read `src/format-note.ts` and `package.json`, explain `formatNote`, and name the npm test command.

- Tools: `read_file` on the source, then `read_file` on `package.json`. Both completed.
- Model calls: 3. Elapsed: 3.5 s. Process RSS after the run: about 112 MiB.
- Answer: `formatNote` formats a title and body as Markdown, and the tests run with `npm test` (`test/format-note.test.ts`, Node strip-types). That matches the files.
- No file changes. No cloud fallback.

### Task 2 — Modify existing code — fail

Prompt: reject empty title or body in `formatNote`, update the unit test, and run the tests.

- The model listed the directory, read both files, then called `create_file` on `test/format-note.test.ts`.
- The mutation engine rejected it: `Cannot create file that already exists`.
- It then requested test verification. The harness approved both verification prompts.
- Status came back `COMPLETED` with an empty answer. `src/format-note.ts` and the test file were unchanged. The requested validation was not added.
- Elapsed: 8.8 s.

### Task 3 — Debug a failing test — fail

`src/add.ts` returns `left - right`. `test/add.test.ts` expects `add(2, 3) === 5` and fails with `actual: -1` before the agent runs. The fixture was not edited to make the test pass.

- The model searched, read a file, and called `modify_file`. That name is not a registered tool (`UNKNOWN_TOOL`).
- Later reads used `tmp/ovsc-sprint11a/...` without the leading slash. The repository tools rejected those paths.
- Status: `AGENT_TURN_BUDGET_EXCEEDED` after 13.0 s.
- `src/add.ts` still subtracts. The test still fails.

## When inference is down

The editor does not depend on the model process. A missing `.open-vs-code/models.json` or a refused connection is reported from the chat turn (`missing-config`, `disconnected`, `model-unavailable`). There is no cloud fallback in the router. This sprint did not add a second health monitor.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `SUID sandbox helper binary was found, but is not configured correctly` | `chrome-sandbox` is not `root:root` mode `4755`. Install the `.deb` as root. Do not add `--no-sandbox`. |
| Chat says real inference is disabled | The process was not started by the `open-vs-code` launcher, so `OPEN_VS_CODE_REAL_INFERENCE` is unset. |
| Chat says the endpoint is unreachable | Ollama is not listening on `127.0.0.1:11434`. |
| Chat says the model is unavailable | `modelName` in `models.json` does not match `ollama list`. |
| Label looks like the wrong model | The label follows the route for the active mode. A disabled or unrouted entry is not shown just because it is first in `models`. |

## Regression

| Gate | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | Two pre-existing failures remain. `FINAL_REPORT.txt` does not cite Node `v22.23.4`. The REA governance test cannot find the Reverse Engineer Anything entry script on this machine. The rest of the suite passed, including the new route-identity and concatenated tool-call tests. vscode-integration: 277/277. |
| `eval:runtime` | 14/14 |
| `eval:workflow` | 14/14 eligibility, scripted arms recorded |
| `eval:skills` | 38/40 selection (95%), unchanged misses S03 and S34 |
| `eval:recovery` | 58/58 |
| `desktop:smoke` | Linux payload checks passed. macOS bundle checks skipped on this host. |
| `desktop:accept` | Darwin suite skipped. Linux sandbox tests passed: unpacked tree fails closed, installed `4755 root` helper launches without `--no-sandbox`. |

## Remaining limits

- The new package is not installed system-wide yet.
- Chat inside the GUI webview was not driven keystroke by keystroke. Launch and sandbox were.
- `qwen2.5-coder:7b` can read files and explain them. On these two edit tasks it did not produce an approved patch that changed the code.
- A turn can be marked completed after a rejected create and a test run even when the requested edit did not land.
- Model switching in the UI is Sprint 11B.
- Conversation files already persist in the workspace. That path was not re-tested from the GUI in this sprint.

## Sprint 11B

11B should start from a root-installed build of this package and a model that can emit the existing patch tool. A model picker does not fix the edit failures above.
