# Sprint 7D — IDE Responsiveness, Performance & UX Hardening

Status: **SPRINT_7D_PARTIALLY_VERIFIED**. Every change was measured before and after on the same machine with the same fixtures. Automated gates and the packaged desktop (smoke 13/13, accept 5/5) are green. A human has not yet walked the live GUI (themes, VoiceOver), and that remains an open acceptance item (§7). No HALO host and no real model were used. Inference is absent or faked in process, and no model latency, tokens/s or completion quality is claimed.

Baseline: GitHub `main` `42fefcaed52ff0d37eb3101af22458a2a8bdaf5a` (Sprint 7C, PR #38).
Branch: `sprint/7d-ide-performance`.

Architecture preserved. Only the presentation, the history store and the autocomplete adapter changed. The agent runtime, model router, context compiler, permission gate and persistence architecture did not:

```text
Editor events ─┐ (coalesced; identical context posts nothing)
Agent events ──┴─► ChatController ──chat.state (transcript omitted when unchanged)──► Webview page (per-section signatures)
                         │
                         └─ ConversationStore (one-pass byte cap; wider redaction)
Keystrokes ─► AutocompleteController (bounded window) ─► AutocompleteService (scoped cancellation)
```

No new dependency, execution path, permission path or performance subsystem.

---

## 1. Baseline and methodology

**Machine.** Apple M3 Pro, 11 cores, 18 GiB, macOS 26.5.2. Node 22.23.2 for the bench; the packaged app is VSCodium 1.135.0 (Electron 42.8.1, Node 24.18.1). The disk was 93–98 % full during the sprint (§6).

**Two instruments**, both added this sprint and both using only APIs that already existed on `main`, so the same code measures both sides:

| Instrument | What it drives | Label in results |
| :--- | :--- | :--- |
| `npm run eval:ide-performance` (`packages/vscode-integration/tests/perf/ide-performance.bench.ts`) | The real `ChatController`, the real generated webview page script, the real `ConversationStore` on disk and the real `AutocompleteController` | `mock-DOM` (page script against `tests/helpers/fake-webview.ts`), `node host`, `node + real fs`, `MockTextDocument` |
| `desktop:accept` test 5 | The live extension inside the packaged app, with the chat view open so posts reach the real Chromium webview | real extension host |

**Mock-DOM vs Chromium.** The fake DOM runs the real page script and counts DOM work: elements created, listeners added, scroll writes, layout reads. Its timings measure script and DOM-call work, **not** Chromium style, layout or paint. Element and listener counts are exact. Host posts go through `JSON.stringify` and `JSON.parse` before delivery, matching VS Code 1.135's `serializeWebviewMessage`. `MockTextDocument` follows VS Code's `ExtHostDocumentData` model (a line array, prefix-sum offsets, `getText(range)` joining line slices).

**Fixtures.**

- A long conversation: 100 messages × 1,950 characters (the 200k cap), with code fences, 20 activities, 20 ledger rows, 50 history summaries and a pending approval.
- CJK and escape-dense variants that exceed the 512 KiB record cap.
- Synthetic TypeScript documents of 100 KB, 1 MB and 5 MB.
- Rapid typing (300 keystrokes).
- A late-cancel ordering and an unreachable endpoint.
- Retention runs: 1,000 pushes and 1,000 events.

**Comparability.** Before and after were run *interleaved* in one time window: before 1, after 1, before 2, after 2. For each "before" run, only `packages/agent-core/src` and `packages/vscode-integration/src` were stashed. Each result file records its commit and the hash of the measured source diff (`sourceDiff: none` = `main`). The real-host probe ran against a packaged `main` build and then a packaged 7D build.

Results: `evals/results/sprint-7d/ide-performance-{before,after}-run{1,2}.json`, `exthost-probe-{before,after}.json`.

## 2. Bottlenecks found

| # | Path | Evidence at baseline | Kind |
| :--- | :--- | :--- | :--- |
| B1 | Editor activity → chat | Every cursor move, selection or diagnostics change ran `getSnapshot` and posted the **whole** chat state. 500 identical refreshes = 500 posts, **102 MB** serialized. Real host: 300 cursor moves = **300 webview posts, 960 ms extension-host CPU** | Responsiveness |
| B2 | Agent events → chat | Each event re-sent the transcript (≈ 204 KB): 80 events = 17.6 MB | Responsiveness |
| B3 | Webview page | An unchanged push still created 87 elements and 8 listeners and forced a scroll (8,163 listeners added over 1,000 pushes) | Responsiveness |
| B4 | Webview page | An unrelated push **destroyed the focused approval button** and **yanked a reader scrolled up back to the bottom**; the connection status (a live region) was rebuilt on every push | UX / a11y defect |
| B5 | Webview page | `updateChatMessage` did not update the visible status label ("Assistant · failed") of an existing message | Correctness |
| B6 | Activity timeline | A model response added a new row and left the request row pending, so pending rows grew per model call and escaped the 50-row bound (`slice(-0)`): **250 rows** after one long turn | Unbounded state |
| B7 | Autocomplete | Each keystroke copied the **whole document twice** before the debounce: 5 MB doc → 10 M characters, 5.5–10 ms median, 7.9–15 ms p95. Real host, 50 requests on 4.8 MB: **364 ms CPU** | Responsiveness |
| B8 | Autocomplete | The debounce-phase cancel listener stayed attached. A late cancel of an older token cancelled a **newer** pending request, and an in-flight cancel was counted twice | Cancellation defect |
| B9 | History store | Over 512 KiB, `writeRecord` re-serialised and re-hashed the record once per dropped message, synchronously. Escape-dense save **270–316 ms**; CJK 33–39 ms | Main-thread CPU |
| B10 | History store | The redactor missed quoted JSON keys, URL credentials, Hugging Face / npm / GitLab / Google / Stripe-restricted tokens, Slack webhooks, labelled lowercase access keys and cookies (19-case probe: 13 leaked) | Privacy |

Examined and **not** changed, because measurement did not justify it:

- **ASCII saves.** About 3 ms of CPU; the rest is the off-thread `fsync`.
- **Index rebuild.** Only after damage.
- **Terminal streaming.** Already incremental: 27 elements over 2,000 updates.
- **Initial render and conversation switch.** Under 1 ms mock-DOM.
- **History filtering.** Already signature-skipped in 7C.
- **Coalescing agent-event posts.** B2's fix made each post about 25× smaller instead; posts stay immediate.
- **A keyed activity list.** About 60 small elements per *changed* push.
- **Save coalescing.** 3 saves per turn; no burst was observed.

## 3. Changes

| Change | Files |
| :--- | :--- |
| `refreshContext` posts only when the implicit chips change; editor events are coalesced through `coalesceRefresh` (one snapshot in flight plus one trailing; the last state wins; errors do not wedge it) | `chat-controller.ts`, `extension.ts` |
| `chat.state` carries `transcript: "unchanged"` and omits `messages` when id, role, status, content, attachments and inherited are unchanged since the last post. A new view, `chat.ready` and every `conversation.reset` re-send it. The page keeps its rendered transcript | `chat-controller.ts`, `chat-protocol.ts`, `chat-view-provider.ts` |
| Per-section signatures for the activity timeline, both chip rows, the connection status and the approval card. An unchanged approval keeps its card, so focus and the click lock survive. The reset path goes through the render functions, so signatures stay coherent | `webview-render-helpers.ts`, `chat-view-provider.ts` |
| Scroll follows new transcript content only when the reader is at the bottom (tracked from `scroll` events, so pushes read no layout) or has just sent | `chat-view-provider.ts` |
| `updateChatMessage` refreshes the role/status label and keeps `is-inherited` | `webview-render-helpers.ts` |
| Model outcomes resolve the row that announced them (as tools already did); hard 50-row bound | `chat-controller.ts` |
| `editorTextAround`: prefix and suffix windows of ceiling + 16 through `offsetAt`/`positionAt`, with a full-prefix fallback when the window has fewer than 3 non-whitespace characters. The token subscription is disposed per request | `autocomplete-controller.ts` |
| Debounce-phase cancel listener scoped to its own pending request and removed when the debounce fires; an already-cancelled request never reaches the provider | `agent-core/src/autocomplete/service.ts` |
| One-pass byte-cap cut, verified by one serialisation; the old loop remains for the single-message clip | `conversation-store.ts` |
| Canonical redactor: 6 new patterns, all with bounded repetition (one first draft was quadratic, 2 s on 50k chars; it was caught and bounded) | `agent-core/src/runtime-evals/evidence.ts` |
| `ChatController.uiMetrics`: 13 numeric counters (posts, transcript posts, skipped refreshes, peak messages/activities, turns, turn ms, cancel latency, saves, save failures, save ms). In memory only; never persisted, logged or used to decide anything | `chat-controller.ts` |

## 4. Before/after

Bench (two interleaved runs each; the ms values are medians unless marked):

| Metric | before 1 | before 2 | after 1 | after 2 |
| :--- | ---: | ---: | ---: | ---: |
| H1 posts, 500 identical editor refreshes | 500 | 500 | **0** | **0** |
| H1 bytes serialized | 102,143,000 | 102,143,000 | **0** | **0** |
| H1 host + page ms | 321.9 | 625.8 | **0.8** | **0.8** |
| H2 bytes, 80 agent events (86 posts) | 17,602,971 | 17,602,971 | **658,119** | **658,119** |
| H2 host stringify ms | 26.9 | 43.0 | **1.2** | **1.3** |
| H2 page render ms (mock-DOM) | 25.8 | 50.2 | **2.5** | **2.5** |
| W2 elements / activity-only push | 87 | 87 | 60.7 | 60.7 |
| W2b elements / unchanged push | 87 | 87 | **0.3** | **0.3** |
| W2 listeners / push | 8 | 8 | **0** | **0** |
| W2 scroll writes / push; W2b layout reads / push | 1; 1 | 1; 1 | **0; 0** | **0; 0** |
| R1 listeners added in 1,000 pushes | 8,163 | 8,163 | **164** | **164** |
| R1 live listeners after 1,000 pushes | 163 | 163 | 164 | 164 |
| W3 approval focus kept / scroll position kept | no / no | no / no | **yes / yes** | **yes / yes** |
| R2 activity rows retained after 1,000 events | 250 | 250 | **50** | **50** |
| A1 5 MB: chars copied per keystroke | 10,000,024 | 10,000,024 | **12,032** | **12,032** |
| A1 5 MB ms (median / p95) | 5.52 / 7.86 | 9.95 / 15.00 | **0.19 / 0.20** | **0.18 / 0.27** |
| A1 1 MB ms | 0.86 | 1.03 | **0.19** | **0.19** |
| A1 100 KB ms | 0.21 | 0.25 | 0.19 | 0.23 |
| A2 provider calls / completions shown, 300 keystrokes | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| A3 newer request cancelled by older token; cancel count | yes; 2 | yes; 2 | **no; 1** | **no; 1** |
| S3b escape-dense save over cap | 270.0 | 316.2 | **20.0** | **31.6** |
| S2 CJK save over cap | 33.1 | 38.5 | **12.1** | **22.5** |
| Kept messages (S2 / S3b) | 87 / 58 | 87 / 58 | 87 / 58 | 87 / 58 |
| S1 ASCII save (disk-bound) | 8.9 | 10.8 | 10.9 | 16.8 |
| S6 read largest record | 3.2 | 3.4 | 5.6 | 7.7 |
| S5 rebuild index of 50 (after damage only) | 172.8 | 183.1 | 203.8 | 200.4 |
| S4 load 50 with index | 0.96 | 1.13 | 0.81 | 0.79 |
| W1 initial render / W4 switch (mock-DOM) | 0.67 / 0.40 | 0.69 / 0.39 | 0.70 / 0.40 | 0.65 / 0.34 |
| H3 open-conversation switch (host + disk) | 3.6 | 6.4 | 5.0 | 5.1 |

**Tradeoff (correctness at a cost).** S6 and S5 got slower because every save and load re-runs the sanitization boundary, which now has six more patterns. Redacting a full 195k-character conversation went from **0.84 ms to 2.31 ms** (measured directly, 30 iterations). That is about 1.5 ms of CPU per full save or read, and about 70 ms on the rare 50-record rebuild. It was accepted for the wider secret coverage. S1 and H3 move within disk noise.

Real extension host (packaged app, one run each, chat view open):

| Metric | `main` | 7D |
| :--- | ---: | ---: |
| 300 real cursor moves: webview posts | 300 | **0** |
| … extension-host CPU ms | 960 | **273** |
| … wall ms | 2,901 | 1,687 |
| 50 rapid completions on a 4.8 MB document: extension-host CPU ms | 364 | **69** |
| … CPU before the first await (synchronous) | 256 | **31** |
| … wall ms (includes the 100 ms debounce) | 416 | 133 |
| Chat send, median / p95 ms (turn fails fast: no model configured) | 3.6 / 9.2 | 2.1 / 3.8 |
| Switch between two 80-message conversations, median / p95 ms | 7.2 / 46.6 | 8.8 / 9.5 |
| Activation ms (single sample) | 77.9 | 41.7 |
| Heap used after the probe (MB; no forced GC) | 365 | 77 |

Activation and heap are single, unforced samples. They are reported, not claimed as improvements.

## 5. Regression results

Final branch, Node 22.23.2:

| Check | Result |
| :--- | :--- |
| `npm test` | vscode-integration **124/124** (91 + 33 new), cli 21/21, ide-adapter 7/7. agent-core (633 = 629 + 4 new): **0 failed** in every run. Runs on this disk also had **1–2 cancelled** subtests, filesystem-bound 4D tests exceeding their 300 s timeout (632 + 1 cancelled; 631 + 2 cancelled). Unmodified `main` run the same way had **3 cancelled**. The 4D performance suite alone passes **5/5 in 67 s** on 7D and 84 s on `main`. See §6 |
| `npm run typecheck` | exit 0, all workspaces |
| `npm run lint` | exit 0 (agent-core, cli). The new 7D test and helper files pass `oxlint --deny-warnings`. `ide-performance.bench.ts` has 8 style warnings (0 errors); it is kept byte-identical to the file that produced the committed results |
| `npm run build` | exit 0; `dist/extension.js` 951.8 kb (7C: 943.7 kb) |
| `npm run eval:performance` | 5/5 |
| `npm run eval:runtime` | 14/14 |
| `eval:skills`, `eval:learning`, `eval:progress`, `eval:workflow` (redactor consumers) | all exit 0; outcomes unchanged. `eval:progress`'s estimated prompt tokens vary by ±1–2 between runs on `main` too (−2814/−2815/−2814), so result files were restored |
| `npm run desktop:package` | exit 0, ad-hoc signed and strictly verified; archive SHA-256 `c97b7546b8adcb531b78cf761e808a014d19dfab0eea92fdecc7b997887f2ef8` |
| `npm run desktop:smoke` | **13/13**. Test 12's fake document had no `offsetAt` and returned the whole text for every range; it now follows the document model |
| `npm run desktop:accept` | **5/5** (new test 5: the responsiveness probe) |

**New and extended tests (38 new):**

- `vscode-integration/tests/sprint-7d-performance.test.ts` (33): host posting 1–6, activity and metrics 7–9, webview 10–17, autocomplete 18–26 including 21b, persistence 27–31, coalescing 32.
- `agent-core/tests/runtime-evals/redaction-formats.test.ts` (4).
- `desktop:accept` test 5.

Extended: the 7B focus test (now asserts the *same* button and no second `focus()`), the autocomplete e2e and smoke document mocks (range-faithful).

Stress scenarios covered:

| Scenario | Tests |
| :--- | :--- |
| Long conversations | 5, 6, H1–H3 |
| Repeated lifecycle (new view, reload, reset) | 4, 5 |
| Rapid autocomplete cancellation | 21–23 |
| Repeated history switching | 6 |
| Heavy terminal output | 16, W5 |
| Large workspaces / documents | 18, 20, A1 |
| Concurrent UI state changes | 11, 16 |
| Interrupted persistence | 29 |
| UI message flooding | 16, R1 |
| Failed inference connectivity | 25, A4 |

**Adversarial check.** Each 7D mechanism was removed in turn (26 mutants). **25 were killed.** The survivor removes the page-side transcript merge. It is equivalent for rendering, because an unchanged push skips `syncTranscript` entirely; the merge only keeps the page's own `currentState` coherent.

The first run showed that several of my test waits could hang instead of fail. They now use a deadline, and the suite runs with `--test-timeout`. One mutant (the cancel guard) first survived. The controller already disposes a finished request's token subscription, so through VS Code that path is closed twice. Test 21b now drives the service directly and kills it.

## 6. Resource usage and environment

- **Bounded memory and listeners.** Webview live nodes and listeners are constant over 1,000 pushes and 5,000 terminal updates (R1, test 16). The host keeps at most 100 messages / 200k characters and 50 activity rows (R2, test 8). Store heap growth over 200 save/read cycles stayed within ±0.1 MB in the bench (S7).
- **No orphaned processes.** Process-tree tests (security-eval, terminal-core-e2e, 7B) pass unchanged.
- **Disk.** The volume was 93–98 % full during the sprint. Two filesystem-wait stalls were observed:
  - one bench run took 679 s instead of about 13 s, with 8.5 s of CPU, in an untimed section, and no timed scenario was affected; it was re-run, and the stalled file is not committed;
  - agent-core's 4D performance suite took 11 min on its own (73 s user, 124 s system, 29 % CPU).

  - The full agent-core suite took 47 s at the start of the sprint and later 19 min on the 7D tree (17 % CPU) and **1 h 58 min on unmodified `main`** (4 % CPU; 626 passed, 3 cancelled). On both trees, user and system CPU stayed roughly the same; only the time spent waiting grew. So the stalls are environmental (filesystem waits on a near-full APFS volume), not a 7D regression.
- The 7D changes touch no filesystem path used by that suite. The redactor has no I/O, and the suite's redaction inputs stay linear (7D-R4).

## 7. UX and accessibility

Fixed and tested:

- An approval card keeps keyboard focus and its click lock across unrelated pushes (test 11).
- The connection status live region is no longer recreated on every push (test 12).
- A reader scrolled up keeps their place, and sending scrolls to the new message (test 13).
- Status labels update in place (test 14).
- The timeline no longer shows finished model calls as the current step (`aria-current="step"`) (test 7).
- Untrusted text stays text in both the skipped and the re-rendered paths (test 17).

**Not done, and not claimed:** a person has not run the packaged app to check light, dark and high-contrast pixels, the narrow sidebar, or VoiceOver announcements. No assistive-technology session was available to this run. Automated checks cover the accessibility *contracts* (roles, labels, focus targets, live-region stability), not what VoiceOver actually says. The 7A–7C checklist carries forward unchanged. Add to it:

1. With VoiceOver on, approve a change while agent activity streams in: focus stays on the card and the connection status is not re-announced.
2. Scroll up in a long conversation during a turn: the view does not jump; send a message: it scrolls to the new message.
3. In a narrow sidebar, the timeline shows one row per model call, and none stays "current" after it finished.

## 8. Security invariants

- **No new authority.** No new Webview → Host message. `uiMetrics` is read-only, numeric and in memory. Autocomplete still inserts only through native editor acceptance and has no AgentRunner, tool or mutation access. Model routing is unchanged.
- **Transcript omission is display-only.** The host remains the single source of the transcript. The page can only keep what it was sent. A new view, reload or reset always gets the full transcript.
- **CSP and escaping unchanged.** No `innerHTML` of untrusted content; signatures compare data, they do not inject it (test 17).
- **Persistence.**
  - Unchanged: atomic exclusive-temp + rename, checksums, schema and workspace checks, quarantine, the 512 KiB / 100-message / 200k-character / 50-conversation ceilings, no restored approvals and no replay.
  - The byte cut is provably the same minimal oldest-first cut (test 27).
  - An interrupted write never replaces a record (test 29).
- **Redaction is best effort.** It is broader now (B10), but still pattern-based, and an unrecognised secret format can still be saved. Records stay local (0600, outside the repository), and deleting a conversation removes its file. No guarantee that every secret is removed is claimed.

## 9. Remaining limitations

- Live GUI theme, narrow-layout and VoiceOver checks (§7).
- No real-model latency, tokens/s or completion quality (deferred to HALO).
- Mock-DOM timings are not Chromium layout or paint; the real-host probe covers extension-host CPU only, not webview frame time.
- Activation and heap-after-probe are single samples.
- A changed push still rebuilds the 20-row activity list (about 60 elements); not worth a keyed list at measured cost.
- On this near-full disk, filesystem-bound 4D tests intermittently exceed their 300 s timeout, on `main` as well as 7D (§6). A clean full agent-core run on a machine with free disk was not obtained in this session.
- `npm run lint` still does not cover `vscode-integration`, which has pre-existing findings.

## 10. Upstream references

No third-party code was copied.

| Repository | License | Version | Component investigated | Mechanism | Classification | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| https://github.com/microsoft/vscode | MIT | tag `1.135.0` (commit `08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`) | `src/vs/workbench/api/common/extHostDocumentData.ts` | `getText(range)` joins line slices; `offsetAt`/`positionAt` use prefix sums. A bounded range is cheap, a full `getText()` is not | **ADOPT** (public API use) | A1, test 20, real-host autocomplete CPU 364 → 69 ms |
| same | MIT | same | `extHostWebview.ts`, `extHostWebviewMessaging.ts` | Webview messages are `JSON.stringify`'d | **REFERENCE_ONLY** | The bench's JSON round trip; H1/H2 byte counts |
| same | MIT | same | `editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts` | The previous request's token is cancelled before the next request starts | **REFERENCE_ONLY** | Scopes B8's real-world effect (double count) |
| https://github.com/cline/cline | Apache-2.0 | `40c5d99031fe1128189c5b52e40638d2b7787754` | `apps/vscode/src/sdk/state-post-debouncer.ts` | One flush in flight plus one trailing flush | **REFERENCE_ONLY** (inspiration) | Same mechanism as `coalesceRefresh` (test 32). Cline debounces full-state posts; 7D instead omits the unchanged transcript, so posts stay immediate |
| https://github.com/VSCodium/vscodium | MIT | `1.135.06055` | Packaged host | — | **KEEP** | smoke 13/13, accept 5/5 |

Note: `microsoft/vscode` does not resolve commit `5a73682ca091082675b10c9dc3f348c1d824d94f`, which earlier records give for VS Code 1.135.0; the `1.135.0` tag points to `08d4889f…`. The pinned VSCodium artifact (SHA-256 verified) is unaffected.

## 11. Verdict

**SPRINT_7D_PARTIALLY_VERIFIED.**

- The major responsiveness paths were profiled. All ten confirmed bottlenecks were addressed (§2), and the rest were explicitly justified.
- Memory and listener retention are bounded. Autocomplete cancellation and stale handling work. Persistence safety holds.
- Agent runtime behaviour is unaffected. Performance claims come from measurements on the same hardware and fixtures.
- Open: the human GUI/VoiceOver checklist (§7). Also open: a clean full agent-core run without environmental timeouts (no failures in any run; the timeouts reproduce on `main`) (§6).
- Not merged; awaiting authorization.
