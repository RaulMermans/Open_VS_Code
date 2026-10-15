# Open VS Code V1.1 — Consolidated Deterministic Benchmark

Status (2026-10-15, Sprint 5D, branch `sprint-5d`): every deterministic V1.1 evaluation is green. **REAL-MODEL V1.1 BENCHMARK — DEFERRED_TO_HALO.**

This report aggregates evidence the evals produced. It does not merge heterogeneous metrics into an overall score, and it does not compare numbers whose fixtures differ. Every row carries one of these labels:

| Label | Meaning |
| --- | --- |
| **directly comparable** | Same fixtures, same simulated model, feature off vs on, measured in one run. |
| **not directly comparable** | The fixture set or the measured unit differs from the earlier report. |
| **simulated** | A deterministic scripted or simulated local model stood in for a real one. |
| **real-model** | A real open-weight model ran. There are none in V1.1. |
| **deferred** | Needs the HALO target host. |

## Layers

| Layer | Adds | Flag (default) | ADR |
| --- | --- | --- | --- |
| V1 Desktop Candidate | Agent core, safe mutations, verification, MCP, routing, IDE adapter, chat/diff/terminal review, autocomplete, security hardening, runtime evals, checkpoints, large-repo performance, VSCodium packaging | — | 001–028 |
| +5A | Portable Skills Runtime: `SKILL.md` contract, five built-ins, lazy loading, PermissionGate-checked capabilities | `skills.enabled` (off) | 029 |
| +5B | Structured Engineering Loop: PLAN → IMPLEMENT → TEST → fresh-context REVIEW → VERIFY | `workflow.enabled` (off) | 030 |
| +5C | Non-progress detection and one bounded recovery; progress epochs (5D closure) | `progressMonitor.enabled` (off) | 031 |
| +5D | Bounded learning: evidence-backed records, human-approved memory and learned skills | `learning.enabled` (off) | 032 |

All four V1.1 layers are off by default. With every flag off the product behaves as the V1 Desktop Candidate. The regression ladder below runs the V1 suites unchanged and confirms this.

## Baseline: V1 Desktop Candidate

These suites are re-run every sprint. Counts are the same in 5D:

| Suite | Result | Label |
| --- | --- | --- |
| `eval:coding` (30 cases) | task 100%, safety 100%, multi-file 100% | simulated |
| `eval:runtime` | 14/14 tests | simulated |
| `eval:recovery` | 50/50 tests | simulated |
| `eval:performance` | 5/5 tests | simulated |
| `desktop:smoke` | 13/13 | simulated (mock inference fixture) |
| `desktop:accept` | 3/3 (real packaged app, real extension host, archive codesign) | packaged app, no model |

## +5A Portable Skills Runtime (`eval:skills`)

| Dimension | Value | Label |
| --- | --- | --- |
| Skill selection accuracy | 38/40 (95.0%); 1 false positive, 1 false negative, 0 wrong skill | simulated (deterministic selector) |
| No-skill accuracy | 9/9 | simulated |
| Context: eager vs lazy | 2,530 → 332.1 average tokens per task (−86.9%; −81.8% including the 128-token index) | directly comparable (same 5 skills) |

## +5B Structured Engineering Loop (`eval:workflow`)

| Dimension | A direct | B workflow | Label |
| --- | --- | --- | --- |
| Workflow eligibility | 14/14 correct | — | simulated |
| Correct outcome | 4/5 | 5/5 | directly comparable, simulated |
| Verified | 5/5 | 5/5 | directly comparable, simulated |
| Review defect detection (seeded defects caught) | 1/2 | 2/2 | directly comparable, simulated |
| Model calls | 17 | 25 | directly comparable, simulated |
| Prompt tokens | 5,206 | 10,069 | directly comparable, simulated |
| Peak context | 470 | 642 | directly comparable, simulated |
| Repair cycles | 1 | 2 | directly comparable, simulated |

Reviewer pipeline (scripted reviewer): true-positive rate 100%, false-positive rate 33.3% (the inflated-severity probe "D-inflated", kept as measured), severity correctness 80%.

The workflow buys correctness and defect detection with about 2× the prompt tokens on these fixtures. Whether that trade holds for a real model is the HALO question.

## +5C Non-Progress Detection (`eval:progress`)

| Dimension | Value | Label |
| --- | --- | --- |
| Known loops detected | 6/6 | simulated |
| False stalls on progress fixtures | 0/4 | simulated |
| Failure classification | 6/6 | simulated |
| Recovery attempts → recovered | 5 → 2 (40%) | simulated; the simulated implementer is no smarter in recovery |
| Unnecessary recoveries | 0 | simulated |
| Model calls A → B | 73 → 60 (−13) | directly comparable within this run |
| Tool/check calls A → B | 64 → 51 (−13) | directly comparable within this run |
| Prompt tokens A → B | 26,312 → 23,496 (−2,816) | directly comparable within this run |

The Sprint 5C report recorded 5/5 loops, 1/4 recoveries, and 68 → 55 calls (−3,327 tokens). Those figures are **not directly comparable** with the table above. Sprint 5D added fixture J, the progress-epoch case: a real stall, then recovery, then new evidence, then the old action reused. J must complete, and before epochs it was falsely BLOCKED. A +1 prompt token shift in fixture A, present in both arms, comes from the runtime and not from detection.

## +5D Bounded Learning (`eval:learning`)

| Dimension | Value | Label |
| --- | --- | --- |
| Contract fixtures A–J | 10/10 | deterministic (no model) |
| Learning classification (project vs reusable) | 16/18 (88.9%) | deterministic |
| Dedupe pair decisions | 45/45 | deterministic |
| Candidate precision | 2/2 (100%) | deterministic |
| False promotions | 0/3 | deterministic |
| Promotion safety: malicious repository text trusted | 0/6 | deterministic |
| Promotion safety: escalation candidates rejected | 9/9 | deterministic |
| Stale memory excluded | yes | deterministic |
| Stored tokens, 12 tasks: transcript (estimated lower bound) vs records | ≥ 20,374 vs 2,615 (−87.2%) | estimated vs measured; transcript memory does not exist and was not built |
| Learned memory per prompt | 143 average (budget 650 = 10% of 6,500) | deterministic |

## Security invariants (all layers)

These hold on every layer. The 4A security suite (97 scenarios) is part of `npm test`. Each later sprint added its own negative tests:

- skill injection and escalation (5A);
- review grounding and sanitized persistence (5B);
- non-progress grants nothing (5C);
- learning cannot grant authority or leak secrets (5D: L-13, L-15, L-16, L-17–19, L-34/35).

| Invariant | Evidence |
| --- | --- |
| PermissionGate is the only authority | 5A capability checks, 5C NP-D-06, 5D L-15 |
| No cloud fallback, no model download | V1 routing tests; 5D L-34/35 (static scan of the learning layer) |
| No secrets or hidden reasoning persisted | 5B C-0A, 5D L-17/18/19 |
| Nothing learned affects a run until approved | 5D L-10, L-10b (real compiled prompt) |

## Regression ladder (Sprint 5D)

`npm ci`, typecheck, lint and build all pass. `npm test` passes 654/654: agent-core 603, cli 21, ide-adapter 7, vscode-integration 23.

| Eval | Result |
| --- | --- |
| `eval:skills` | 38/40 |
| `eval:workflow` | 14/14 eligibility; A/B unchanged |
| `eval:progress` | 6/6 loops, 0/4 false stalls |
| `eval:learning` | 10/10 |
| `eval:coding` | 30/30 |
| `eval:runtime` | 14/14 |
| `eval:recovery` | 50/50 |
| `eval:performance` | 5/5 |

Desktop: `desktop:package` OK, `desktop:smoke` 13/13, `desktop:accept` 3/3.

## Real-model status

**REAL-MODEL V1.1 BENCHMARK — DEFERRED_TO_HALO.** The HALO target host is not provisioned. No model weights are installed on the development Mac, and none will be.

## HALO V1.1 benchmark contract (to run on HALO)

Five arms, each a configuration of the same build:

| Arm | Configuration |
| --- | --- |
| A | V1 baseline: all V1.1 flags off |
| B | + skills (`skills.enabled`) |
| C | + workflow (B + `workflow.enabled`) |
| D | + progress monitor (C + `progressMonitor.enabled`) |
| E | + approved learning (D + `learning.enabled`, with a learning store frozen **before** the run; see below) |

**Held constant across arms:**

- model, quantisation, context size, temperature (0) and seed where supported;
- inference runtime and version, hardware;
- task fixtures: the union of the `eval:coding`, `eval:workflow` and `eval:progress` fixtures;
- tool permissions (auto-approve policy identical in every arm);
- turn limits.

Each arm runs every fixture at least 3 times. Report the median and range.

**Arm E store.** Arm E uses a learning store produced by running arm D over a disjoint *training* fixture split. A human reviews it with `learning list`, `show` and `approve`, and the store is then frozen and checked in alongside the results. No learning occurs during the measured run: `learnAfter` output is discarded. Otherwise arm E would measure on its own training data.

**Measure per arm:**

- task success and verification success (VERIFY READY or verified direct completion);
- tool correctness (valid calls / total calls; schema and permission rejections);
- review defect detection and review false positives (seeded-defect fixtures);
- repair cycles;
- stall rate, BLOCKED rate and recovery success;
- prompt and completion tokens (provider-reported, not estimated);
- latency per model call and wall time per task.

**Report:** one table per metric with arms side by side and the fixture-level rows. No combined score. Results go to `evals/results/v1.1-halo-benchmark.{json,md}`. Command: `OPEN_VS_CODE_REAL_INFERENCE=1 npm run eval:models` with per-arm flags, following `docs/deployment/HALO_ACCEPTANCE.md`.

**Release decision inputs:**

- A flag moves to default-on only if its arm improves task or verification success without a statistically meaningful regression in safety, stall rate or tokens per successful task.
- Learning (arm E) stays off by default unless E ≥ D on success at equal or lower tokens.
