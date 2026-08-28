# Evaluation Audit

## SWE-bench
- **repo:** swe-bench
- **pattern:** Docker containerized isolated workspaces, Git checkpoints for setup.
- **used/not used:** USED for fixture workspaces, NOT USED for Docker currently (we rely on node/npm and controlled paths).
- **reason:** Using a controlled fixture template copy is faster for local dev than heavy Docker containers per test, given our bounded JS context.

## SWE-bench Metrics (pass@1, pass@k)
- **repo:** swe-bench
- **pattern:** Measuring multi-attempt (pass@3, pass@k) rather than only one-shot execution.
- **used/not used:** USED.
- **reason:** Aligns with our bounded repair loops. We will measure one-attempt success rate and recovery success rate.

## SWE-rebench / Scaffolding Variability
- **repo:** swe-rebench
- **pattern:** Standardizing the harness/scaffolding around the model so performance measures the *model* or *system* not just prompt hacking.
- **used/not used:** USED.
- **reason:** The `ScriptedModelProvider` separates reasoning from our evaluation harness. We evaluate the scaffolding/orchestration system itself for determinism without tuning logic to specific eval cases.

## Success Definition (Test-based vs PatchDiff)
- **repo:** swe-bench / PatchDiff
- **pattern:** Using repository unit/e2e tests to verify correctness rather than patch exact-match.
- **used/not used:** USED.
- **reason:** We will define a `successCriteria` based on verification state (tests passing, diagnostics absent) rather than "patch looks exactly like this."

## Metric Logging
- **repo:** swe-bench / open coding agents
- **pattern:** Logging `total changed lines`, `tool calls`, `efficiency/turns`.
- **used/not used:** USED.
- **reason:** These directly match T-251 and T-255 requirements for tracking patch-quality metrics and tool/turn costs.
