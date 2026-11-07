# Personal V1 acceptance

Status: `PERSONAL_V1_BLOCKED`

The installed application launches, talks to local Ollama, applies an approved repair, and leaves a rejected edit unwritten. It is not an accepted release because GitHub CI for this branch has not run, and CI on `main` is not green.

## Git and package

- Branch: `release/personal-v1-installed-acceptance`
- Source commit: `02d21325efafb710428a080bcba668f1931d779b`
- `gitDirty`: false
- Product: `0.1.0-rc.4`
- Debian: `apps/desktop/dist/open-vs-code_0.1.0-rc.4_amd64.deb`
- Package SHA-256: `95b7beb95665bacd44280d2dccbf7eb1ba6c318d634a2f8ad12c7f5e1a4fdb75`
- Archive SHA-256: `c24224bff08c3384f6e73c8f54c77fb05630bee101a4c3476f427b2e283998b7`
- Bundled extension: `open-vs-code.vscode-integration` `0.1.0-rc.4`
- Model gateway package: `@open-vs-code/agent-core` `0.1.0`
- Upstream shell: VSCodium `1.135.06055`
- Packaged at: `2026-11-07T09:21:49.852Z`
- Installed with `dpkg` over `0.1.0-rc.3`. `chrome-sandbox` is `4755 root:root`. The launcher does not pass `--no-sandbox`. The process runs as the desktop user.

User data is `~/.config/Open VS Code`. `~/.open-vs-code-desktop` also exists and was copied before the first candidate install. Backup:

`~/open-vs-code-backups/pre-0.1.0-rc.2-2026-11-07`

`dpkg` does not delete that data. Rollback to the previous package without removing user data:

```bash
sudo dpkg -i "apps/desktop/dist/open-vs-code_0.1.0_amd64.deb"
```

That package SHA-256 is `4de0da453a51095526e4f9efc31c3774916fa5bc16a65eb21ae1b68e3dbf8c55`.

## Installed GUI

Evidence is under `~/open-vs-code-acceptance/evidence/`. Model: `qwen3-coder:30b` at `http://127.0.0.1:11434`. Autocomplete stayed on `qwen2.5-coder:7b`. A custom `research` route was left unchanged by the model picker.

| Journey | Build | Result |
|---|---|---|
| Launch and open a repository | rc.3, same shell as rc.4 | Pass. Explorer, TypeScript highlighting, workspace trust, integrated terminal (`ovsc-terminal-ok`), Source Control, and the Extensions view worked. |
| Explain the repository | rc.3 | Pass. Ollama `/api/ps` showed `qwen3-coder:30b`. Tools included `search_text`, `list_directory`, and `read_file`. The answer matched `return name`. |
| Select the model in the GUI | rc.3, still shown on rc.4 | Pass. Status became `Standalone local · qwen3-coder:30b`. Before the first turn the status can read `Unavailable` because the endpoint has not been probed yet. |
| Implement a greeting | rc.3 | Pass. An approved edit changed `greet` to `` return `Hello, ${name}!` `` and the panel reported `Completed`. |
| Debug a failing test | rc.4 | Pass. `npm test` failed before the turn (`NaN !== 6`). The agent read both files, the GUI approved a `+1 −1` patch on `src/sum.mjs` only, and `npm run test` in that directory exited 0. The panel said `Changed: src/sum.mjs. Approval was granted for the applied edit. Tests passed. The requested edit was applied.` An independent `npm test` then passed. The test file was not modified. |
| Reject a change | rc.4 | Pass. The proposed `+1 −3` patch was rejected. The panel reported the rejection and that no edit was applied. `src/sum.mjs` was byte-identical afterward. |
| Restart and offline | rc.3, then real inference again on rc.4 | Pass for persistence and the dead endpoint. After quit and relaunch, the conversation and `qwen3-coder:30b` were still there, and no approval was replayed. Pointing the workspace endpoint at `127.0.0.1:9` produced `Cannot list local models at http://127.0.0.1:9. fetch failed` while the editor stayed readable. The endpoint was restored, and later rc.4 turns ran on `qwen3-coder:30b`. |

An rc.4 debug attempt that said "read the test and fix only the implementation" first failed on rc.3's completion rule: the test path was treated as a required edit after the implementation fix and the tests had already passed. `02d21325ef` keeps a path named with "fix only" as the required edit and leaves the other named file as context. The installed rc.4 rerun is the passing row above.

## Local checks

On the rc.3 tree, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` passed: account/ide 84, agent-core 1020 with 4 skipped, cli 21, a 7-test package, vscode-integration 280. Failures: 0. The four skips are the optional REA host check. They are not counted as passes.

After the rc.4 completion change, `npm --workspace=@open-vs-code/agent-core test` was 1021 pass / 4 skipped / 0 fail. `desktop:smoke` was 21 pass / 0 fail and `desktop:accept` was 2 pass / 0 fail.

`eval:runtime`, `eval:workflow`, `eval:recovery`, `eval:skills`, `eval:performance`, and `eval:coding` exited 0. The coding scorecard was 30/30, including three safe rejections. These evals use the deterministic local model, not Ollama.

## Coding benchmark

`scripts/personal-v1-local-benchmark.ts` with `OPEN_VS_CODE_REAL_INFERENCE=1` and `qwen3-coder:30b`, three runs, against the source that became rc.3. The rc.4 completion change does not alter those task prompts. Log: `~/open-vs-code-acceptance/evidence/benchmark-rc3.jsonl`.

| Run | Unseen | Originals | False COMPLETED | Unauthorized writes |
|---|---|---|---|---|
| 1 | 9/10 | 2/2 | 0 | 0 |
| 2 | 8/10 | 2/2 | 0 | 0 |
| 3 | 9/10 | 2/2 | 0 | 0 |

Each reject case stayed `REJECTED` with the file unchanged. The misses were multi-file tasks that stopped at `MAX_TURNS_EXCEEDED` and were not reported as `COMPLETED`. Run 2's `multi-prefix` task met the independent oracle and was still reported incomplete because the test file was not part of the edit.

## GitHub CI

`main` at `6db9ec3467` (PR #66), run `42348936718`: Ubuntu Node 22 and 24 failed because AppArmor blocks unprivileged user namespaces (`SANDBOX_UNAVAILABLE`). macOS Node 22 and 24 failed one motion test (`Expected >10 frames, got 7`) because the sample clock included the wait for the first frame. Windows Node 22 and 24 were still in progress when this note was written.

This branch enables user namespaces in Linux CI and starts motion sampling at the first animation frame. It does not pass `--no-sandbox`. Push was rejected:

`refusing to allow an OAuth App to create or update workflow .github/workflows/ci.yml without workflow scope`

The branch is local until a credential with the `workflow` scope pushes it. CI for `02d21325ef` has not run.

## Verdict

`PERSONAL_V1_BLOCKED`

The remaining blocker is GitHub CI. The workflow fix is in this branch and has not been executed on GitHub. Ubuntu and macOS on `main` are still red, and the Windows jobs had no conclusion.
