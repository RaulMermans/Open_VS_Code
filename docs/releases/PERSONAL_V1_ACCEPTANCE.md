# Personal V1 acceptance

Status: `PERSONAL_V1_BLOCKED`

The installed application has not completed the seven GUI journeys. Privileged install was not authorized. This is not a release.

## Git

- Branch: `product/personal-v1-production-completion` (dirty working tree)
- Canonical `origin/main`: `08e32e175829106f98807f1c817d26351990e421`
- Release-candidate payload stamp: `gitCommit` `08e32e1758`, **`gitDirty`: true**. The bundled agent is this working tree, not a clean commit. No merge or push.

## 1. original-format-note (`qwen3-coder:30b`)

`OPEN_VS_CODE_MODEL_TRACE=1` showed tools advertised (`apply_patch`, `create_file`, `find_files`, `list_directory`, `read_file`, `run_verification`, `search_text`) with `tool_choice: auto`. Early turns had `finish_reason: stop` and Qwen `<function=…><parameter=…>` in content (`rawToolCallCount: 0`). Class: **content-tool parsing**, not missing tools. `run_verification` without `action` was rejected; auto-verify sent `{}`. Class: **invalid verify arguments**.

Correction: parse Qwen function-parameter calls; default omitted verify `action` to `TEST`; synthesized auto-verify uses `{ action: "TEST" }`. Single AgentRunner, approvals, path checks, truthful completion unchanged.

## 2. Independent 30B benchmark

Oracles in `scripts/personal-v1-local-benchmark.ts` import workspace source. `formatNote("", "body")` and `formatNote("title", "")` must throw. Agent-written tests are not trusted. Rejected writes must leave files unchanged.

Three runs before the last read-loop skip:

| Run | Unseen | Originals | False COMPLETED | Unauthorized writes | Mean ms |
|---|---|---|---|---|---|
| 1 | 9/10 | 1/2 | 0 | 0 | 5806 |
| 2 | 8/10 | 1/2 | 0 | 0 | 7658 |
| 3 | 9/10 | 2/2 | 0 | 0 | 6585 |

Unseen bar held. Follow-up after skipping non-progress only while a required edit is outstanding: originals **2/2**, reject-greet unchanged.

## 3. Evaluations

- `eval:runtime` 14/14 (`e2e.1` still `BEFORE_COMPLETION` `VERIFY`)
- `eval:workflow` 14/14 eligibility
- `eval:recovery` 58/58
- `eval:skills` 38/40 (same Halo-deferred misses)
- `eval:performance` 5/5
- `eval:coding` **30/30** (100%) after aligning four scripted cases with the actual fixture files

## 4. Local monorepo + CI

- `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`: pass. Four skipped agent-core tests are optional REA (not installed). Chromium suites ran on this host (`verifyEffectiveSandboxSupport` supported).
- CI for **this tree** is not on GitHub. Latest `main` run still targets `08e32e1758`: https://github.com/RaulMermans/Open_VS_Code/actions/runs/42289274193
- Workflow now provisions Linux Chromium and does not skip Linux CI Chromium suites. That is unproven until pushed.

## 5. Desktop RC (not installed)

- Deb: `apps/desktop/dist/open-vs-code_0.1.0-rc.1_amd64.deb` (170 MB), version **0.1.0-rc.1**
- Payload SHA-256: `179e964b20d627426613878e2f61df4e42687181a079fb80b5281b424df55711`
- `chrome-sandbox` mode `4755`; launcher does not pass `--no-sandbox`
- User data folder remains `.open-vs-code-desktop`
- Packaged-app smoke: 12 pass / 3 macOS skips; Linux smoke 6/6
- `desktop:accept` Linux Category C: see below

Install (needs explicit sudo from Raul; not run):

```bash
sudo dpkg -i "apps/desktop/dist/open-vs-code_0.1.0-rc.1_amd64.deb"
```

Rollback after install:

```bash
sudo dpkg -r open-vs-code
# if restoring the previous 0.1.0 package:
sudo dpkg -i "apps/desktop/dist/open-vs-code_0.1.0_amd64.deb"
```

User data in `~/.open-vs-code-desktop` is not deleted by `dpkg -r`.

## 6. Installed GUI

Not run. No sudo. No screenshots. Journeys 1–7 unverified on the installed app.

## Remaining blockers

1. Working tree is dirty and not pushed; CI is not green for these fixes.
2. RC stamp is `gitDirty: true` — not a clean final commit.
3. No authorized privileged install; seven GUI journeys have no inspectable evidence.
4. Chromium sandbox on GitHub runners is not yet demonstrated.

## Readiness

`PERSONAL_V1_BLOCKED`
