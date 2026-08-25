export interface EvalCase {
  readonly id: string
  readonly name: string
  readonly category:
    | "repo_orientation"
    | "file_discovery"
    | "symbol_finding"
    | "configuration_discovery"
    | "test_diagnosis"
    | "dependency_understanding"
    | "control_flow_explanation"
    | "architecture_explanation"
    | "cross_file_reasoning"
    | "markdown_project_rules"
  readonly complexity: "easy" | "medium" | "hard"
  readonly split: "dev" | "held_out"
  readonly fixtureRelPath: string
  readonly instruction: string
  readonly expectedFiles: readonly string[]
  readonly groundingKeywords: readonly string[]
  readonly maxTurns: number
}

export const EVAL_CASES: readonly EvalCase[] = [
  // 1. Repo orientation (easy)
  {
    id: "EVAL_01",
    name: "mini_express_app_purpose",
    category: "repo_orientation",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Read the README.md file in the repository and summarize the purpose of this application and what default port it uses.",
    expectedFiles: ["README.md"],
    groundingKeywords: ["3000", "REST", "JWT"],
    maxTurns: 4,
  },
  // 2. Repo orientation (medium)
  {
    id: "EVAL_02",
    name: "mini_express_structure",
    category: "repo_orientation",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "List the repository files and describe the main components in src/.",
    expectedFiles: ["src/server.ts", "src/config.ts"],
    groundingKeywords: ["server", "config", "auth", "routes"],
    maxTurns: 5,
  },
  // 3. File discovery (easy)
  {
    id: "EVAL_03",
    name: "find_source_files",
    category: "file_discovery",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Find all TypeScript files in the src/ directory and list their paths.",
    expectedFiles: ["src/config.ts", "src/server.ts"],
    groundingKeywords: ["config.ts", "server.ts", "jwt.ts", "middleware.ts"],
    maxTurns: 4,
  },
  // 4. File discovery (medium)
  {
    id: "EVAL_04",
    name: "rocket_cli_find_tests",
    category: "file_discovery",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/cli-tool-repo",
    instruction: "Find all test files in the repository and state what commands they test.",
    expectedFiles: ["tests/build.test.ts"],
    groundingKeywords: ["build.test.ts", "build"],
    maxTurns: 4,
  },
  // 5. Symbol finding (easy)
  {
    id: "EVAL_05",
    name: "find_authenticate_symbol",
    category: "symbol_finding",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/agent-scenarios/auth-flow",
    instruction: "Find the definition of the function `authenticate` and identify what token value it accepts.",
    expectedFiles: ["src/auth.ts"],
    groundingKeywords: ["local-token", "authenticate"],
    maxTurns: 4,
  },
  // 6. Symbol finding (medium)
  {
    id: "EVAL_06",
    name: "find_require_auth",
    category: "symbol_finding",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Find where `requireAuth` is defined and explain how it checks the authHeader.",
    expectedFiles: ["src/auth/middleware.ts"],
    groundingKeywords: ["Bearer", "requireAuth", "authenticated"],
    maxTurns: 4,
  },
  // 7. Configuration discovery (easy)
  {
    id: "EVAL_07",
    name: "discover_port_config",
    category: "configuration_discovery",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Find what environment variables and default values are used in config.ts.",
    expectedFiles: ["src/config.ts"],
    groundingKeywords: ["PORT", "JWT_SECRET", "3000"],
    maxTurns: 4,
  },
  // 8. Configuration discovery (medium)
  {
    id: "EVAL_08",
    name: "discover_cli_config_path",
    category: "configuration_discovery",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/cli-tool-repo",
    instruction: "Discover the default configuration filename returned by resolveConfigPath in src/utils/paths.ts.",
    expectedFiles: ["src/utils/paths.ts"],
    groundingKeywords: ["rocket.config.json", "resolveConfigPath"],
    maxTurns: 4,
  },
  // 9. Test diagnosis (medium)
  {
    id: "EVAL_09",
    name: "diagnose_failing_math_test",
    category: "test_diagnosis",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/agent-scenarios/failing-test",
    instruction: "Inspect the test file in tests/ and implementation in src/ to diagnose why the test fails.",
    expectedFiles: ["tests/math.case.ts", "src/math.ts"],
    groundingKeywords: ["sum(1, 2)", "3", "4", "assertion"],
    maxTurns: 5,
  },
  // 10. Test diagnosis (hard)
  {
    id: "EVAL_10",
    name: "diagnose_failing_auth_test",
    category: "test_diagnosis",
    complexity: "hard",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Inspect tests/auth.test.ts and src/auth/jwt.ts to explain why testAuthScenario throws an error.",
    expectedFiles: ["tests/auth.test.ts", "src/auth/jwt.ts", "src/auth/middleware.ts"],
    groundingKeywords: ["invalid-token", "authenticated", "false"],
    maxTurns: 6,
  },
  // 11. Dependency understanding (easy)
  {
    id: "EVAL_11",
    name: "express_app_dependencies",
    category: "dependency_understanding",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Read package.json and list all runtime dependencies of this package.",
    expectedFiles: ["package.json"],
    groundingKeywords: ["express", "jsonwebtoken", "zod"],
    maxTurns: 4,
  },
  // 12. Dependency understanding (easy)
  {
    id: "EVAL_12",
    name: "rocket_cli_dependencies",
    category: "dependency_understanding",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/cli-tool-repo",
    instruction: "Read package.json of rocket-cli and list the CLI dependencies used.",
    expectedFiles: ["package.json"],
    groundingKeywords: ["commander", "chalk"],
    maxTurns: 4,
  },
  // 13. Control flow explanation (medium)
  {
    id: "EVAL_13",
    name: "auth_flow_control",
    category: "control_flow_explanation",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/agent-scenarios/auth-flow",
    instruction: "Explain how authorize in src/middleware.ts processes an incoming header before calling authenticate.",
    expectedFiles: ["src/middleware.ts", "src/auth.ts"],
    groundingKeywords: ["Bearer", "replace", "authenticate"],
    maxTurns: 5,
  },
  // 14. Control flow explanation (hard)
  {
    id: "EVAL_14",
    name: "mini_express_auth_flow",
    category: "control_flow_explanation",
    complexity: "hard",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Trace the control flow from requireAuth down to verifyToken and explain which two token values succeed.",
    expectedFiles: ["src/auth/middleware.ts", "src/auth/jwt.ts"],
    groundingKeywords: ["valid-admin-token", "valid-user-token", "Bearer"],
    maxTurns: 6,
  },
  // 15. Architecture explanation (medium)
  {
    id: "EVAL_15",
    name: "mini_express_architecture",
    category: "architecture_explanation",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Read ARCHITECTURE.md and explain the 4 layers in mini-express-app.",
    expectedFiles: ["ARCHITECTURE.md"],
    groundingKeywords: ["Configuration", "Authentication", "Routing", "Server"],
    maxTurns: 4,
  },
  // 16. Architecture explanation (medium)
  {
    id: "EVAL_16",
    name: "rocket_cli_commands",
    category: "architecture_explanation",
    complexity: "medium",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/cli-tool-repo",
    instruction: "Inspect src/commands/ and explain what commands are provided and their responsibilities.",
    expectedFiles: ["src/commands/build.ts", "src/commands/clean.ts"],
    groundingKeywords: ["build", "clean", "target"],
    maxTurns: 5,
  },
  // 17. Cross-file reasoning (hard)
  {
    id: "EVAL_17",
    name: "auth_cross_file_reasoning",
    category: "cross_file_reasoning",
    complexity: "hard",
    split: "dev",
    fixtureRelPath: "tests/fixtures/agent-scenarios/auth-flow",
    instruction: "Determine what exact token string must be passed to authorize('Bearer ...') to get a true return value.",
    expectedFiles: ["src/middleware.ts", "src/auth.ts"],
    groundingKeywords: ["Bearer local-token", "local-token"],
    maxTurns: 5,
  },
  // 18. Cross-file reasoning (hard)
  {
    id: "EVAL_18",
    name: "server_route_composition",
    category: "cross_file_reasoning",
    complexity: "hard",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Inspect src/server.ts, src/routes/users.ts, and src/routes/health.ts to explain what endpoints are created and how users are listed.",
    expectedFiles: ["src/server.ts", "src/routes/users.ts", "src/routes/health.ts"],
    groundingKeywords: ["/health", "/api/users", "Alice", "Bob"],
    maxTurns: 6,
  },
  // 19. Markdown / project rules (easy)
  {
    id: "EVAL_19",
    name: "markdown_testing_rule",
    category: "markdown_project_rules",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/markdown-project",
    instruction: "Read AGENTS.md in markdown-project and state the Testing and Safety rules.",
    expectedFiles: ["AGENTS.md"],
    groundingKeywords: ["Run focused tests first", "Never expose secrets"],
    maxTurns: 4,
  },
  // 20. Markdown / project rules (easy)
  {
    id: "EVAL_20",
    name: "mini_express_agent_rules",
    category: "markdown_project_rules",
    complexity: "easy",
    split: "dev",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Read AGENTS.md in mini-express-app and state the rules regarding JWT secrets and route validation.",
    expectedFiles: ["AGENTS.md"],
    groundingKeywords: ["Never log raw JWT secrets", "verify route parameters"],
    maxTurns: 4,
  },
  // 21. Held-out: Repo orientation (medium)
  {
    id: "EVAL_21",
    name: "tiny_repo_summary_held_out",
    category: "repo_orientation",
    complexity: "medium",
    split: "held_out",
    fixtureRelPath: "tests/fixtures/agent-scenarios/tiny-repository",
    instruction: "Read README.md and src/index.ts to summarize the purpose and function export of tiny-repository.",
    expectedFiles: ["README.md", "src/index.ts"],
    groundingKeywords: ["Tiny Greeter", "greet"],
    maxTurns: 5,
  },
  // 22. Held-out: Symbol finding (medium)
  {
    id: "EVAL_22",
    name: "user_payload_roles_held_out",
    category: "symbol_finding",
    complexity: "medium",
    split: "held_out",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Find UserPayload interface in src/auth/jwt.ts and list the allowed role values.",
    expectedFiles: ["src/auth/jwt.ts"],
    groundingKeywords: ["admin", "user", "UserPayload"],
    maxTurns: 4,
  },
  // 23. Held-out: Test diagnosis (hard)
  {
    id: "EVAL_23",
    name: "build_target_check_held_out",
    category: "test_diagnosis",
    complexity: "hard",
    split: "held_out",
    fixtureRelPath: "tests/fixtures/eval-repos/cli-tool-repo",
    instruction: "Inspect src/commands/build.ts and tests/build.test.ts to explain what targets are supported and what error message is thrown for invalid targets.",
    expectedFiles: ["src/commands/build.ts", "tests/build.test.ts"],
    groundingKeywords: ["node", "browser", "Invalid build target"],
    maxTurns: 5,
  },
  // 24. Held-out: Cross-file reasoning (hard)
  {
    id: "EVAL_24",
    name: "server_route_routes_held_out",
    category: "cross_file_reasoning",
    complexity: "hard",
    split: "held_out",
    fixtureRelPath: "tests/fixtures/eval-repos/mini-express-app",
    instruction: "Inspect createServer in src/server.ts and describe the returned routes array.",
    expectedFiles: ["src/server.ts"],
    groundingKeywords: ["/health", "/api/users", "mini-express-app"],
    maxTurns: 4,
  },
]
