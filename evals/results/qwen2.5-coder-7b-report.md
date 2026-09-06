# Benchmark Report: qwen2.5-coder:7b

- **Runtime**: Ollama v0.32.15 (local Apple Silicon M3 Pro)
- **Hardware**: Apple M3 Pro (11 cores), 18GB RAM
- **Context window**: 8192
- **Timestamp**: 2026-09-06T09:08:04.651Z

## Overall Metrics (n = 24)

| Metric | Score | Sample Size (n) |
| --- | --- | --- |
| Task Success (All) | 0.0% | 0/24 |
| Dev Split Success | 0.0% | 0/20 |
| Held-Out Split Success | 0.0% | 0/4 |
| Tool Syntax Validity | 100.0% | 0/0 calls |
| Correct Tool Selection | 0.0% | 0/24 tasks |
| Argument Payload Validity | 100.0% | 0/0 calls |
| Grounded Answer Rate | 0.0% | 0/24 tasks |
| Non-Progress Failure Rate | 0.0% | 0/24 tasks |
| Average Turns per Task | 1.00 | 24 tasks |
| Average Latency per Task | 8 ms | 24 tasks |

## Failure Root Cause Breakdown

| Root Cause | Count | Percentage |
| --- | --- | --- |
| NONE (Passed) | 0 | 0.0% |
| MODEL_REASONING | 0 | 0.0% |
| TOOL_SELECTION | 0 | 0.0% |
| TOOL_ARGUMENTS | 0 | 0.0% |
| CONTEXT_OVERFLOW | 0 | 0.0% |
| NON_PROGRESS | 0 | 0.0% |
| MAX_TURNS | 0 | 0.0% |
| BACKEND_PROTOCOL | 0 | 0.0% |
| BACKEND_RUNTIME | 0 | 0.0% |
| UNKNOWN | 0 | 0.0% |

## Detailed Case Results

| ID | Name | Category | Complexity | Split | Outcome | Turns | Latency | Root Cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVAL_01 | mini_express_app_purpose | repo_orientation | easy | dev | FAIL | 1/4 | 115ms | PREMATURE_COMPLETION |
| EVAL_02 | mini_express_structure | repo_orientation | medium | dev | FAIL | 1/5 | 7ms | PREMATURE_COMPLETION |
| EVAL_03 | find_source_files | file_discovery | easy | dev | FAIL | 1/4 | 4ms | PREMATURE_COMPLETION |
| EVAL_04 | rocket_cli_find_tests | file_discovery | medium | dev | FAIL | 1/4 | 7ms | PREMATURE_COMPLETION |
| EVAL_05 | find_authenticate_symbol | symbol_finding | easy | dev | FAIL | 1/4 | 10ms | PREMATURE_COMPLETION |
| EVAL_06 | find_require_auth | symbol_finding | medium | dev | FAIL | 1/4 | 5ms | PREMATURE_COMPLETION |
| EVAL_07 | discover_port_config | configuration_discovery | easy | dev | FAIL | 1/4 | 4ms | PREMATURE_COMPLETION |
| EVAL_08 | discover_cli_config_path | configuration_discovery | medium | dev | FAIL | 1/4 | 3ms | PREMATURE_COMPLETION |
| EVAL_09 | diagnose_failing_math_test | test_diagnosis | medium | dev | FAIL | 1/6 | 2ms | PREMATURE_COMPLETION |
| EVAL_10 | diagnose_failing_auth_test | test_diagnosis | hard | dev | FAIL | 1/6 | 3ms | PREMATURE_COMPLETION |
| EVAL_11 | express_app_dependencies | dependency_understanding | easy | dev | FAIL | 1/4 | 3ms | PREMATURE_COMPLETION |
| EVAL_12 | rocket_cli_dependencies | dependency_understanding | easy | dev | FAIL | 1/4 | 2ms | PREMATURE_COMPLETION |
| EVAL_13 | auth_flow_control | control_flow_explanation | medium | dev | FAIL | 1/5 | 3ms | PREMATURE_COMPLETION |
| EVAL_14 | mini_express_auth_flow | control_flow_explanation | hard | dev | FAIL | 1/6 | 3ms | PREMATURE_COMPLETION |
| EVAL_15 | mini_express_architecture | architecture_explanation | medium | dev | FAIL | 1/5 | 5ms | PREMATURE_COMPLETION |
| EVAL_16 | rocket_cli_commands | architecture_explanation | medium | dev | FAIL | 1/5 | 4ms | PREMATURE_COMPLETION |
| EVAL_17 | auth_cross_file_reasoning | cross_file_reasoning | hard | dev | FAIL | 1/5 | 4ms | PREMATURE_COMPLETION |
| EVAL_18 | server_route_composition | cross_file_reasoning | hard | dev | FAIL | 1/6 | 3ms | PREMATURE_COMPLETION |
| EVAL_19 | markdown_testing_rule | markdown_project_rules | easy | dev | FAIL | 1/4 | 3ms | PREMATURE_COMPLETION |
| EVAL_20 | mini_express_agent_rules | markdown_project_rules | easy | dev | FAIL | 1/4 | 2ms | PREMATURE_COMPLETION |
| EVAL_21 | tiny_repo_summary_held_out | repo_orientation | medium | held_out | FAIL | 1/5 | 1ms | PREMATURE_COMPLETION |
| EVAL_22 | user_payload_roles_held_out | symbol_finding | medium | held_out | FAIL | 1/4 | 2ms | PREMATURE_COMPLETION |
| EVAL_23 | build_target_check_held_out | test_diagnosis | hard | held_out | FAIL | 1/6 | 5ms | PREMATURE_COMPLETION |
| EVAL_24 | server_route_routes_held_out | cross_file_reasoning | hard | held_out | FAIL | 1/6 | 3ms | PREMATURE_COMPLETION |
