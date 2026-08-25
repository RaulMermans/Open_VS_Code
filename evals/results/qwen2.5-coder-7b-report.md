# Benchmark Report: qwen2.5-coder:7b

- **Runtime**: Ollama v0.32.15 (local Apple Silicon M3 Pro)
- **Hardware**: Apple M3 Pro (11 cores), 18GB RAM
- **Context window**: 8192
- **Timestamp**: 2026-08-25T18:46:18.258Z

## Overall Metrics (n = 24)

| Metric | Score | Sample Size (n) |
| --- | --- | --- |
| Task Success (All) | 37.5% | 9/24 |
| Dev Split Success | 35.0% | 7/20 |
| Held-Out Split Success | 50.0% | 2/4 |
| Tool Syntax Validity | 90.9% | 40/44 calls |
| Correct Tool Selection | 79.2% | 19/24 tasks |
| Argument Payload Validity | 90.9% | 40/44 calls |
| Grounded Answer Rate | 37.5% | 9/24 tasks |
| Non-Progress Failure Rate | 4.2% | 1/24 tasks |
| Average Turns per Task | 2.63 | 24 tasks |
| Average Latency per Task | 6101 ms | 24 tasks |

## Failure Root Cause Breakdown

| Root Cause | Count | Percentage |
| --- | --- | --- |
| NONE (Passed) | 9 | 37.5% |
| MODEL_REASONING | 6 | 25.0% |
| TOOL_SELECTION | 4 | 16.7% |
| TOOL_ARGUMENTS | 0 | 0.0% |
| CONTEXT_OVERFLOW | 0 | 0.0% |
| NON_PROGRESS | 1 | 4.2% |
| MAX_TURNS | 4 | 16.7% |
| BACKEND_PROTOCOL | 0 | 0.0% |
| BACKEND_RUNTIME | 0 | 0.0% |
| UNKNOWN | 0 | 0.0% |

## Detailed Case Results

| ID | Name | Category | Complexity | Split | Outcome | Turns | Latency | Root Cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVAL_01 | mini_express_app_purpose | repo_orientation | easy | dev | PASS | 2/4 | 3351ms | NONE |
| EVAL_02 | mini_express_structure | repo_orientation | medium | dev | PASS | 3/5 | 13283ms | NONE |
| EVAL_03 | find_source_files | file_discovery | easy | dev | PASS | 4/4 | 9796ms | NONE |
| EVAL_04 | rocket_cli_find_tests | file_discovery | medium | dev | FAIL | 4/4 | 5399ms | MAX_TURNS |
| EVAL_05 | find_authenticate_symbol | symbol_finding | easy | dev | FAIL | 1/4 | 1871ms | TOOL_SELECTION |
| EVAL_06 | find_require_auth | symbol_finding | medium | dev | FAIL | 2/4 | 2406ms | MODEL_REASONING |
| EVAL_07 | discover_port_config | configuration_discovery | easy | dev | FAIL | 1/4 | 2598ms | TOOL_SELECTION |
| EVAL_08 | discover_cli_config_path | configuration_discovery | medium | dev | FAIL | 4/4 | 5806ms | MAX_TURNS |
| EVAL_09 | diagnose_failing_math_test | test_diagnosis | medium | dev | FAIL | 3/5 | 2952ms | NON_PROGRESS |
| EVAL_10 | diagnose_failing_auth_test | test_diagnosis | hard | dev | PASS | 3/6 | 16220ms | NONE |
| EVAL_11 | express_app_dependencies | dependency_understanding | easy | dev | PASS | 2/4 | 3616ms | NONE |
| EVAL_12 | rocket_cli_dependencies | dependency_understanding | easy | dev | FAIL | 3/4 | 4221ms | MODEL_REASONING |
| EVAL_13 | auth_flow_control | control_flow_explanation | medium | dev | FAIL | 1/5 | 5683ms | TOOL_SELECTION |
| EVAL_14 | mini_express_auth_flow | control_flow_explanation | hard | dev | FAIL | 2/6 | 2764ms | MODEL_REASONING |
| EVAL_15 | mini_express_architecture | architecture_explanation | medium | dev | PASS | 2/4 | 12541ms | NONE |
| EVAL_16 | rocket_cli_commands | architecture_explanation | medium | dev | PASS | 3/5 | 14406ms | NONE |
| EVAL_17 | auth_cross_file_reasoning | cross_file_reasoning | hard | dev | FAIL | 2/5 | 2421ms | MODEL_REASONING |
| EVAL_18 | server_route_composition | cross_file_reasoning | hard | dev | FAIL | 1/6 | 3719ms | TOOL_SELECTION |
| EVAL_19 | markdown_testing_rule | markdown_project_rules | easy | dev | FAIL | 2/4 | 1569ms | MODEL_REASONING |
| EVAL_20 | mini_express_agent_rules | markdown_project_rules | easy | dev | FAIL | 2/4 | 2536ms | MODEL_REASONING |
| EVAL_21 | tiny_repo_summary_held_out | repo_orientation | medium | held_out | FAIL | 5/5 | 9950ms | MAX_TURNS |
| EVAL_22 | user_payload_roles_held_out | symbol_finding | medium | held_out | FAIL | 4/4 | 5974ms | MAX_TURNS |
| EVAL_23 | build_target_check_held_out | test_diagnosis | hard | held_out | PASS | 3/5 | 6708ms | NONE |
| EVAL_24 | server_route_routes_held_out | cross_file_reasoning | hard | held_out | PASS | 4/4 | 6644ms | NONE |
