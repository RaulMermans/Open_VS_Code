# Model Card: Qwen 2.5 Coder 7B (Instruct) for Local Agent Core

## 1. Specification

- **Model**: `Qwen/Qwen2.5-Coder-7B-Instruct` (served locally as `qwen2.5-coder:7b`)
- **Architecture**: Dense Transformer, 7B parameters, 28 layers, GQA
- **Quantization**: 4-bit (`Q4_K_M`, ~4.7 GB memory footprint)
- **License**: Apache 2.0 (commercial & research friendly, fully open weight)
- **Inference Runtime**: Ollama v0.32.15 via local REST OpenAI-compatible `/v1/chat/completions` endpoint
- **Host Hardware**: Apple M3 Pro (11 CPU cores, 14 GPU cores), 18 GB Unified Memory, macOS
- **Context Configuration**: Tested across 2,048 (Small), 8,192 (Medium), and 32,768 (Large) token bounds; native model supports up to 128k context.

---

## 2. Evaluation Summary (Our Agent Benchmark)

Evaluated across a fixed 24-task read-only evaluation corpus spanning repository orientation, file discovery, symbol finding, configuration discovery, test diagnosis, dependency understanding, control-flow explanation, architecture explanation, cross-file reasoning, and markdown/project-rule adherence.

- **Tasks Attempted**: 24
- **Tool-Call Validity**: High (~95-100% syntax compliance across single and multi-turn runs)
- **Correct Tool Selection**: High (~90-95% appropriate tool selection)
- **Argument Validity**: High (~95% conforming to JSON schema without hallucinated parameters)
- **Non-Progress Rate**: Low (< 5% with deterministic 3-turn non-progress guard and observation context formatting)
- **Average Latency**: ~3,000–5,000 ms per task (~1,200 ms per model turn on Apple M3 Pro GPU)

---

## 3. Strengths

1. **Tool Schema Adherence**: Accurately formats tool invocations (`read_file`, `search_text`, `find_files`, `list_directory`) with exact parameter names.
2. **Context Synthesis**: Successfully recognizes repository observations in recompiled context and stops calling tools when sufficient evidence is present.
3. **Targeted Reads**: Prefers targeted file reading and precise symbol searches rather than dumping large directories.
4. **Local Performance**: Generates at > 45 tokens/second locally with low memory footprint (~4.7 GB RAM), leaving > 12 GB RAM free on consumer hardware.
5. **Grounded Explanations**: Cites actual observed filenames, functions, line contents, and assertions in final answers without hallucinating implementation details.

---

## 4. Weaknesses & Failure Patterns

1. **Repetitive Tool Calls without Guidance**: When not provided with a concise guideline stating that observations provide answers, the model can sometimes repeat tool invocations for the same file.
2. **Occasional Prose Wrapping of Tool Calls**: In certain prompt contexts, outputs JSON tool calls inside markdown code fences (` ```json `) instead of pure wire function calls. *Mitigation*: Our protocol normalizer automatically decodes both wire `tool_calls` and content-embedded JSON tool calls.
3. **Broad Glob Patterns**: Occasionally uses broad search patterns (`"*.ts"` across root) instead of narrowing down to specific subdirectories when exploring unfamiliar codebases.

---

## 5. Recommended Agent Modes

| Mode | Recommendation | Rationale |
| --- | --- | --- |
| **ASK** | **Strongly Recommended** | Fast, accurate repository orientation, symbol discovery, and architectural explanation. |
| **DEBUG / DIAGNOSE** | **Recommended** | Accurately reads test cases and implementation files to pinpoint failing assertions. |
| **PLAN** | **Recommended** | Read-only analysis and structured plan generation before code changes. |
| **MUTATE / WRITE** | **Experimental** | Requires strictly bounded patches and validation loops (Sprint 1F). |

---

## 6. Not Recommended For

- Entire whole-repository blindly loaded into prompt without search filtering.
- Autonomous unconstrained terminal or shell execution without human-in-the-loop review.
- Multi-step architectural refactors without intermediate deterministic checkpoint verification.
