# V1 convergence status

Date: 2026-11-09. Branch: `sprint/v1-product-convergence`. Starting revision: `c1d8bc0ee14b46d7b87d5d65bb70c609ffb13a8b`.

**Release decision: NO-GO for the full V1 gate.** Personal V1 is not ready. Public beta is not ready. The installed desktop is now `open-vs-code 0.1.0-rc.13`, and a live Ask turn on that build returned `pong` with no tool envelope. The rest of the gate is still open.

## Gate

| Gate | Result | Evidence |
| --- | --- | --- |
| Critical security 100% | Not run live | Lab safety scenarios were not executed in this session. Existing unit guards were not re-certified as a full security suite. |
| Unauthorized writes | Not run live | No coding scenario was driven through the GUI. |
| Unapproved dangerous execution | Not run live | Same. |
| False verification claims | Not run live | No verification scenario was executed. |
| Protocol leakage | Live check passed for the pong prompt. Other prompts not run. | Installed extension is `0.1.0-rc.13` and contains `normalizeWireResponse`. Live assistant text was `pong`. |
| Core GUI journeys | One journey passed outside the Playwright lab | Playwright `CONV-PING` still FAIL (tooling). Direct DevTools drive of the same prompt passed. 45 catalog scenarios NOT_RUN. |
| Held-out coding ≥ 90% | Not measured | No same-model run. See `docs/evals/V1_CODING_BENCHMARK.md`. |
| Persistence and recovery | Not run | |
| Build and package integrity | Dirty package built and installed | `apps/desktop/dist/open-vs-code_0.1.0-rc.13_amd64.deb`. Stamp `gitDirty: true`, commit `c1d8bc0`. Archive SHA-256 `d88f8b75691ee02cdd7e40bfb5cacf98cf06432095e480becc958aad9a4b5be8`. |
| Rollback | Package kept, drill not run | Previous deb remains at `apps/desktop/dist/open-vs-code_0.1.0-rc.12_amd64.deb`. |
| Visual UX | Not accepted | No before/after review. |

## Verification labels

| Change | Label |
| --- | --- |
| Opening-only tool-envelope split, and removal of hidden reasoning from the answer | Unit verified |
| Guest webview script (fill, click, in-page wait) | Unit verified against a fake DOM |
| Live send through the installed GUI | Verified once on rc.13. Ask mode, `qwen3-coder:30b`, reply `pong` in 5.5s. Evidence `apps/desktop/acceptance/evidence/2026-11-09-live-cdp-ping/result.json` |
| Same-model coding benchmark versus OpenCode | Not verified. OpenCode is not installed |
| Package built from this branch | Built with `OPEN_VS_CODE_ALLOW_DIRTY_PACKAGE=1`. Not a clean-tree release. |
| Installed GUI after this protocol change | Installed over rc.12. `chrome-sandbox` remains `4755` `root:root`. |
| Reference notes | Written from the pinned clones listed in `docs/research/OPEN_SOURCE_ENGINEERING_REFERENCE.md` |

## Live GUI evidence

Installed binary `/usr/lib/open-vs-code/open-vs-code`, sandbox left on, temp user-data, disposable fixture. Playwright still adds `--remote-debugging-port=0` so it can drive Electron.

Observed:

- The workbench opens on the fixture (`hello.ts` visible in an early screenshot).
- After the `vscode-webview://` document has loaded, one `webFrameMain.executeJavaScript` read can see the composer.
- A second script on that frame, or a script started while the webview frame is still attaching, ends the Node debugger and Playwright reports the workbench page closed.
- Scorecards: `apps/desktop/acceptance/results/latest-scorecard.md` and `apps/desktop/acceptance/evidence/2026-11-09T20-*`.

ExTester was not used. A direct Chrome DevTools session, without Playwright, can read `#active-frame` `contentDocument` and click Send. That session stayed up. Playwright's Electron attach still closes the workbench when the webview attaches, so `npm run accept:lab -- --live CONV-PING` remains a tooling failure and is not the live result above.

Live DevTools result on the installed rc.13 build, disposable profile `/tmp/ovsc-live-k4Zvkn`, model `qwen3-coder:30b`, mode ASK:

- Prompt: `Reply with the single word pong. Do not call tools.`
- Assistant text: `pong`
- Elapsed: 5.5s
- Transcript had two messages and no `<tool_call`, `</tool_call>`, or `<function=`.

## Unresolved risks

- The installed package was built from a dirty tree. It is not a clean release artifact.
- Local coding quality of `qwen3-coder:30b` versus OpenCode is unknown.
- Agent shell commands are not OS-sandboxed. Electron's sandbox does not cover them.
- The archive hash is recorded above. A clean-tree rebuild and a rollback drill were not run.

## What a later session can do without re-deciding the architecture

1. Point the acceptance lab at the DevTools driver that reached `#active-frame`, so catalog scenarios stop depending on Playwright's Electron attach.
2. Drive the remaining critical scenarios on disposable profiles. One pong reply does not close the security or coding gates.
3. Install OpenCode only with an explicit request, pin the same model digest, and run the twelve-task set.
