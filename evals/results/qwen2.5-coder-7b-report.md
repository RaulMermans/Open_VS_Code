# Benchmark Report: qwen2.5-coder:7b

- **Runtime**: Ollama v0.32.15 (local Apple Silicon M3 Pro)
- **Hardware**: Apple M3 Pro (11 cores), 18GB RAM
- **Context window**: 8192
- **Timestamp**: 2026-08-26T08:03:35.730Z

## Overall Metrics (n = 24)

| Metric | Score | Sample Size (n) |
| --- | --- | --- |
| Task Success (All) | 75.0% | 18/24 |
| Dev Split Success | 70.0% | 14/20 |
| Held-Out Split Success | 100.0% | 4/4 |
| Tool Syntax Validity | 93.2% | 41/44 calls |
| Correct Tool Selection | 95.8% | 23/24 tasks |
| Argument Payload Validity | 93.2% | 41/44 calls |
| Grounded Answer Rate | 75.0% | 18/24 tasks |
| Non-Progress Failure Rate | 8.3% | 2/24 tasks |
| Average Turns per Task | 3.29 | 24 tasks |
| Average Latency per Task | 9359 ms | 24 tasks |

## Failure Root Cause Breakdown

| Root Cause | Count | Percentage |
| --- | --- | --- |
| NONE (Passed) | 18 | 75.0% |
| MODEL_REASONING | 1 | 4.2% |
| TOOL_SELECTION | 0 | 0.0% |
| TOOL_ARGUMENTS | 1 | 4.2% |
| CONTEXT_OVERFLOW | 0 | 0.0% |
| NON_PROGRESS | 2 | 8.3% |
| MAX_TURNS | 2 | 8.3% |
| BACKEND_PROTOCOL | 0 | 0.0% |
| BACKEND_RUNTIME | 0 | 0.0% |
| UNKNOWN | 0 | 0.0% |

## Detailed Case Results

| ID | Name | Category | Complexity | Split | Outcome | Turns | Latency | Root Cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVAL_01 | mini_express_app_purpose | repo_orientation | easy | dev | PASS | 2/4 | 4916ms | NONE |
| EVAL_02 | mini_express_structure | repo_orientation | medium | dev | PASS | 3/5 | 6560ms | NONE |
| EVAL_03 | find_source_files | file_discovery | easy | dev | PASS | 2/4 | 5736ms | NONE |
| EVAL_04 | rocket_cli_find_tests | file_discovery | medium | dev | PASS | 3/4 | 5945ms | NONE |
| EVAL_05 | find_authenticate_symbol | symbol_finding | easy | dev | FAIL | 4/4 | 19360ms | MAX_TURNS |
| EVAL_06 | find_require_auth | symbol_finding | medium | dev | PASS | 3/4 | 13062ms | NONE |
| EVAL_07 | discover_port_config | configuration_discovery | easy | dev | PASS | 4/4 | 10186ms | NONE |
| EVAL_08 | discover_cli_config_path | configuration_discovery | medium | dev | PASS | 3/4 | 4729ms | NONE |
| EVAL_09 | diagnose_failing_math_test | test_diagnosis | medium | dev | FAIL | 6/6 | 9515ms | MODEL_REASONING |
| EVAL_10 | diagnose_failing_auth_test | test_diagnosis | hard | dev | PASS | 5/6 | 21429ms | NONE |
| EVAL_11 | express_app_dependencies | dependency_understanding | easy | dev | PASS | 2/4 | 4613ms | NONE |
| EVAL_12 | rocket_cli_dependencies | dependency_understanding | easy | dev | PASS | 2/4 | 4173ms | NONE |
| EVAL_13 | auth_flow_control | control_flow_explanation | medium | dev | PASS | 2/5 | 4125ms | NONE |
| EVAL_14 | mini_express_auth_flow | control_flow_explanation | hard | dev | FAIL | 3/6 | 4439ms | NON_PROGRESS |
| EVAL_15 | mini_express_architecture | architecture_explanation | medium | dev | PASS | 3/5 | 12081ms | NONE |
| EVAL_16 | rocket_cli_commands | architecture_explanation | medium | dev | PASS | 2/5 | 5190ms | NONE |
| EVAL_17 | auth_cross_file_reasoning | cross_file_reasoning | hard | dev | FAIL | 3/5 | 4834ms | TOOL_ARGUMENTS |
| EVAL_18 | server_route_composition | cross_file_reasoning | hard | dev | PASS | 5/6 | 30876ms | NONE |
| EVAL_19 | markdown_testing_rule | markdown_project_rules | easy | dev | FAIL | 4/4 | 8468ms | MAX_TURNS |
| EVAL_20 | mini_express_agent_rules | markdown_project_rules | easy | dev | FAIL | 3/4 | 4015ms | NON_PROGRESS |
| EVAL_21 | tiny_repo_summary_held_out | repo_orientation | medium | held_out | PASS | 4/5 | 7502ms | NONE |
| EVAL_22 | user_payload_roles_held_out | symbol_finding | medium | held_out | PASS | 2/4 | 3877ms | NONE |
| EVAL_23 | build_target_check_held_out | test_diagnosis | hard | held_out | PASS | 5/6 | 21950ms | NONE |
| EVAL_24 | server_route_routes_held_out | cross_file_reasoning | hard | held_out | PASS | 4/6 | 7028ms | NONE |
