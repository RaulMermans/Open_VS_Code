# Skills

Skills are short Markdown playbooks that guide the agent through one kind of task, such as debugging or a security review. The runtime shows the model at most one skill per task, chosen from compact metadata, and reads the full `SKILL.md` only after choosing it.

A skill is **guidance, not authority**. It cannot grant tools, permissions or network access, approve its own actions, skip verification, or change which model runs.

Design record: [ADR-029](../adrs/ADR-029-portable-skills-runtime.md).

## Turning skills on

The runtime is **off by default** until its effect on real local models has been measured on HALO.

| Surface | Setting |
| --- | --- |
| VS Code / desktop | `open-vs-code.skills.enabled: true` |
| CLI | `--skills`, or `OPEN_VS_CODE_SKILLS=1` |
| Library | `createAgentRuntime({ ..., skills: { enabled: true } })` |

When it is on, the chat output shows a one-line status such as `Skill: bug-triage`. Two commands help with inspection:

- **Open VS Code: List Available Skills** lists ids, versions, sources and descriptions. It reads metadata only, and any diagnostics go to the Open VS Code Agent output channel.
- **Open VS Code: Show Active Skill** shows which skill the last task used, its load status and its token cost.

## Where skills live

```text
packages/agent-core/skills/builtins/<id>/SKILL.md   built-in: curated, shipped with the product
<workspace>/.open-vs-code/skills/<id>/SKILL.md      workspace: yours, treated as untrusted
```

The directory name must equal the skill `id`. Workspace skills are only read when the workspace is trusted. If you want to commit your workspace skills, make sure your ignore rules keep `.open-vs-code/skills/`.

Built-in skills: `bug-triage`, `tdd`, `refactor-with-guards`, `security-review`, `verification`.

### Precedence

A workspace skill with the same id as a built-in replaces it **only if** it is valid **and** narrower:

- `capabilities`, `allowed_modes` and `required_tools` must be subsets of the built-in's;
- `risk_level` and `context_budget` must not be higher.

Otherwise the built-in stays active and a diagnostic explains why (`OVERRIDE_INVALID` or `OVERRIDE_EXPANDS_PERMISSIONS`). Workspace skills with new ids are added alongside the built-ins, up to 32.

## Writing a skill

```markdown
---
id: api-migration
name: API Migration
description: Migrate call sites from a deprecated internal API in small verified steps.
version: 1
category: refactoring
allowed_modes:
  - BUILD
capabilities:
  - read
  - search
  - write
  - verify
required_tools:
  - read_file
  - search_text
  - apply_patch
  - run_verification
context_budget: 900
risk_level: medium
triggers:
  - migrate
  - deprecated api
---

# Intent
# When to Use
# Inputs
# Workflow
# Verification
# Failure Modes
# Exit Criteria
```

All seven sections are required and must not be empty. Write each skill so it makes sense on its own, without references like "as described above".

### Frontmatter fields

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | lowercase kebab-case, at most 48 characters, equal to the directory name |
| `name` | yes | at most 60 characters |
| `description` | yes | at most 200 characters. This is the line the selector and the skills list show. |
| `version` | yes | integer ≥ 1 |
| `category` | yes | `debugging`, `testing`, `refactoring`, `security`, `verification`, `architecture`, `documentation` |
| `allowed_modes` | yes | non-empty subset of `ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW` |
| `capabilities` | yes | subset of `read`, `search`, `write`, `verify`, `terminal`. These declare needs; they never grant anything. |
| `required_tools` | yes | subset of `read_file`, `list_directory`, `find_files`, `search_text`, `apply_patch`, `create_file`, `run_verification` |
| `context_budget` | yes | 200–4000 tokens, the most the injected guidance may use |
| `risk_level` | yes | `low`, `medium`, `high` |
| `triggers` | no | up to 16 short lowercase phrases matched against the task |
| `composes_with` | no | ids of skills that may be loaded as a second skill alongside this one |

The frontmatter is a strict YAML subset: `key: value`, `key: []`, and `key:` followed by `  - item` lines. Unknown keys, duplicate keys, anchors, tags, flow collections (`{}`/`[...]`), block scalars, backticks and `$(...)` are all rejected. The machine-readable schema is [`config/schemas/skill.schema.json`](../../config/schemas/skill.schema.json).

### Content rules

A skill is rejected when it is loaded if its body:

- contains secret-like values (API keys, bearer tokens, private keys);
- contains executable markup (`<script>`, `<iframe>`, `javascript:`);
- tries to override the runtime, for example "ignore previous instructions", "disable verification", "auto-approve", "switch to a cloud model", "print the .env file", or "ignore the user's task". Negated guidance such as "never skip verification" is allowed.

Files may be at most 16 KB, with at most 4 KB of frontmatter.

## How a skill gets selected

1. **Compatibility.** The active mode must be in `allowed_modes`. Every `required_tools` entry must be registered for this run; untrusted workspaces have no mutation or verification tools. No declared capability may be denied by the PermissionGate in this mode. For example, a skill that declares `write` is never selected in `REVIEW`.
2. **Relevance.** Each matching trigger phrase scores 3, matched after light stemming, so `fail` also matches "failing" and "failed". Overlap with the name and description adds up to 3. The minimum score to be selected is 3.
3. **Outcome.** The highest score wins. An exact tie between unrelated skills selects **nothing**, as does any score below the threshold. You can force a compatible skill by writing `skill:<id>` in the task.

At most one skill is loaded by default. A second one is loaded only when `maxSkills: 2` is set **and** the first skill lists it in `composes_with`. The hard cap is 2.

## Token budgeting

Skill guidance is optional context. It ranks after system and security instructions, the task, memory facts and acceptance criteria, and active code. It ranks ahead of retrieved code, tool observations and background. It never displaces anything ranked above it; if the budget is short, the skill is the item that gets dropped.

A selected skill may use the smallest of:

- its `context_budget`;
- 15% of the available context;
- the room left after required context.

If the full body does not fit, whole sections are dropped in this order: Inputs, Failure Modes, When to Use. If Intent, Workflow, Verification and Exit Criteria still do not fit, the skill is not injected (`FAILED_BUDGET`). Frontmatter is never injected, and sections are never cut part-way.

Run `npm run eval:skills` to measure index and body token costs and selection accuracy. Results are written to `evals/results/sprint-5a-skills-eval.md`.

## Debugging an invalid skill

Invalid skills are left out, and the agent keeps running. Each diagnostic has a code, a source and a skill name. You can see diagnostics in three places:

- the **List Available Skills** output channel;
- `skillEvidence.diagnostics` in `--json` CLI output;
- `SkillRegistry.discover(...).diagnostics` when using the library.

| Code | Meaning |
| --- | --- |
| `MALFORMED_FRONTMATTER` | Missing or unterminated `---` block, or unsupported YAML syntax |
| `UNKNOWN_FIELD` / `DUPLICATE_FIELD` | A key that is not in the schema, or a key declared twice |
| `MISSING_FIELD` / `INVALID_FIELD` | A required field is absent, or a value is out of range or not in its enum |
| `ID_DIRECTORY_MISMATCH` | `id` differs from the directory name |
| `EMPTY_BODY` / `MISSING_SECTION` / `DUPLICATE_SECTION` | Problems with the body structure |
| `TOO_LARGE` | Over 16 KB, or over 4 KB of frontmatter |
| `SECRET_DETECTED` / `EXECUTABLE_CONTENT` / `UNSAFE_DIRECTIVE` | The content-safety rules above |
| `UNSAFE_PATH` | The file resolves outside the workspace (for example through a symlink) |
| `OVERRIDE_INVALID` / `OVERRIDE_EXPANDS_PERMISSIONS` | A workspace override was ignored and the built-in kept |
| `WORKSPACE_UNTRUSTED` / `WORKSPACE_LIMIT` | Workspace skills were skipped (untrusted workspace), or there are more than 32 |
| `CHANGED_SINCE_INDEX` | The file changed between indexing and loading |

Body-level problems such as missing sections and unsafe content are found when the skill is first selected, because bodies are not read before then. In that case the evidence shows `skillLoadStatus: FAILED_INVALID`.

## Evidence

Every task with skills enabled records `skillEvidence`. It contains:

- candidate ids;
- the selected id, version and source, and the reason it was selected;
- the load status;
- the tokens used and the sections loaded;
- rejection reasons and diagnostic codes;
- whether the skill actually reached the model: `injectionStatus`, `injectedSkills`, `injectedSkillTokens` and `omittedSkills`.

"Loaded" is not "applied". Skill guidance is optional context, so the final context compiler can drop it when the budget is tight. That case is reported as `OMITTED_BY_FINAL_BUDGET`. A skill is shown as active (CLI `Skill:` line, the IDE output, **Show active skill**) only when its guidance was in a request the model received.

It never contains task text, prompts, source code or skill bodies.

## Learned skills (Sprint 5D, ADR-032)

With learning enabled, a reusable pattern that held in 3 or more independent verified tasks becomes a *skill candidate*. After you approve it (`open-vscode-agent learning approve <id>` or *Open VS Code: Review Learning Candidates*), it is written to `.open-vs-code/skills/<id>/SKILL.md` in exactly the format above. From then on it is an ordinary workspace skill: trusted workspaces only, lazily loaded, at most one per task, capabilities checked by the PermissionGate.

- A learned skill may declare only `read`, `search`, `write` and `verify`, and only known tools. It never shadows a built-in and never overwrites a skill you wrote.
- The generated file is validated with this schema before it is written. A candidate that fails validation is rejected; nothing is written.
- Provenance (supporting tasks, evidence, approval time, version history) lives in `.open-vs-code/learning/learning.json`, not in the frontmatter, because the schema rejects unknown fields.
- An update needs a new approval. It increments `version` and archives the previous file under `.open-vs-code/learning/history/<id>/`.

Details: `docs/learning/LEARNING_SYSTEM.md`.

## Legacy `.agents/skills`

The ADR-014 skills under `.agents/skills/` are still used **only while the portable runtime is off**, which keeps V1 behaviour unchanged. Turning skills on replaces them, and the two systems are never active together. To migrate a legacy skill, rewrite it to the contract above under `.open-vs-code/skills/<id>/`.
