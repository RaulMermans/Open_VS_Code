import type { AgentMode } from "../contracts/agent.ts"

export type TaskCategory =
  | "ORIENTATION"
  | "FILE_DISCOVERY"
  | "SYMBOL_SEARCH"
  | "CONFIG_DISCOVERY"
  | "DEPENDENCY_QUERY"
  | "TEST_DIAGNOSIS"
  | "CONTROL_FLOW"
  | "ARCHITECTURE"
  | "CROSS_FILE_REASONING"
  | "RULES_QUERY"

export type EvidenceRequirementKind =
  | "FILE_READ"
  | "SEARCH_PERFORMED"
  | "CROSS_FILE_EVIDENCE"
  | "TEST_AND_IMPLEMENTATION"
  | "DIRECTORY_LISTED"
  | "ANY_TOOL_OBSERVATION"

export interface EvidenceRequirement {
  readonly id: string
  readonly kind: EvidenceRequirementKind
  readonly minCount?: number
  readonly description: string
}

export interface TaskProfile {
  readonly category: TaskCategory
  readonly allowedTools: readonly string[]
  readonly recommendedInitialTools: readonly string[]
  readonly defaultTurnBudget: number
  readonly evidenceRequirements: readonly EvidenceRequirement[]
  readonly toolGuidance: string
  readonly explicitFilePaths: readonly string[]
  /** BUILD/DEBUG requests that ask for a code change. Ask, Plan, and Review stay false. */
  readonly requiresCodeChange: boolean
}

const FILE_PATH_REGEX = /\b(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:md|mjs|cjs|ts|js|json|yml|yaml|txt|tsx|jsx)\b/gi

export function extractExplicitFilePaths(instruction: string): string[] {
  const matches = instruction.match(FILE_PATH_REGEX) ?? []
  const unique = new Set<string>()
  for (const match of matches) {
    if (match.includes("/") || match.endsWith(".md") || match.endsWith(".ts") || match.endsWith(".js") || match.endsWith(".json")) {
      unique.add(match.replace(/^\.\//, ""))
    }
  }
  return Array.from(unique)
}

export function requestsCodeEdit(instruction: string): boolean {
  if (/\b(?:fix|modify|update|implement|refactor|repair|rewrite|patch|change|edit|rename|replace)\b/i.test(instruction)) return true
  if (/\b(?:make|ensure)\b/i.test(instruction) && /\b(?:test|tests|function|file|return|keep|export)\b/i.test(instruction)) return true
  return /\b(?:add|reject|remove|delete|create|write)\b/i.test(instruction)
    && /\b(?:file|test|tests|function|implementation|code|method|body|title|export)\b/i.test(instruction)
}

export function classifyTaskProfile(instruction: string, mode: AgentMode = "ASK"): TaskProfile {
  const text = instruction.toLowerCase()
  const explicitFiles = extractExplicitFilePaths(instruction)
  const requiresCodeChange = (mode === "BUILD" || mode === "DEBUG") && requestsCodeEdit(instruction)

  // 1. Rules Query (AGENTS.md, guidelines, rules)
  if (/\b(?:agents\.md|guidelines?|rules?|policy|conventions?)\b/i.test(text)) {
    return {
      category: "RULES_QUERY",
      allowedTools: ["read_file", "search_text", "find_files"],
      recommendedInitialTools: ["read_file", "search_text"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "read-rules",
          kind: "FILE_READ",
          minCount: 1,
          description: "Read AGENTS.md or the relevant project rule file directly with read_file",
        },
      ],
      toolGuidance: "Read the project rules or AGENTS.md directly using read_file.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 2. File Discovery (check before test diagnosis so 'find all test files' matches here)
  if (/\b(?:find|list|discover)\s+(?:all\s+)?(?:source\s+|test\s+|typescript\s+|[a-zA-Z0-9_-]+\s+)?files\b/i.test(text) || /\bwhat\s+(?:source\s+|test\s+)?files\b/i.test(text)) {
    return {
      category: "FILE_DISCOVERY",
      allowedTools: ["find_files", "read_file", "list_directory"],
      recommendedInitialTools: ["find_files", "list_directory"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "discover-files",
          kind: "SEARCH_PERFORMED",
          minCount: 1,
          description: "Discover files using find_files (with glob pattern like **/*.ts) or list_directory",
        },
      ],
      toolGuidance: "Use find_files with a glob pattern (e.g. **/*.ts or *.ts) to find matching files across the repository.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 3. Test Diagnosis
  if (/\b(?:failing|diagnose|assertion|error message|why.*failing)\b/i.test(text) || (/\b(?:test|tests)\b/i.test(text) && !/\b(?:find|list)\b/i.test(text))) {
    return {
      category: "TEST_DIAGNOSIS",
      allowedTools: ["search_text", "read_file", "find_files"],
      recommendedInitialTools: ["search_text", "read_file", "find_files"],
      defaultTurnBudget: 6,
      evidenceRequirements: [
        {
          id: "inspect-test-and-code",
          kind: "CROSS_FILE_EVIDENCE",
          minCount: explicitFiles.length >= 2 ? explicitFiles.length : 2,
          description: "Inspect both the test file and the implementation file under test using read_file",
        },
      ],
      toolGuidance: "Search for the test or error string with search_text, then read both the test file and the code being tested.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 3. Dependencies
  if (/\b(?:dependenc(?:y|ies)|package\.json|npm packages?)\b/i.test(text)) {
    return {
      category: "DEPENDENCY_QUERY",
      allowedTools: ["read_file", "find_files", "search_text"],
      recommendedInitialTools: ["read_file"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "read-manifest",
          kind: "FILE_READ",
          minCount: 1,
          description: "Read package.json using read_file to inspect dependencies",
        },
      ],
      toolGuidance: "Read package.json directly using read_file to inspect exact dependencies.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles.length > 0 ? explicitFiles : ["package.json"],
    }
  }

  // 4. Symbol Search
  if (
    /\b(?:function|interface|class|symbol|method|enum|constant|defined|definition|signature|export|token value|allowed role|roles? array)\b/i.test(text) ||
    /`[a-zA-Z0-9_]+`/.test(instruction)
  ) {
    return {
      category: "SYMBOL_SEARCH",
      allowedTools: ["search_text", "read_file", "find_files"],
      recommendedInitialTools: ["search_text", "read_file"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "locate-symbol",
          kind: "SEARCH_PERFORMED",
          minCount: 1,
          description: "Locate symbol definition using search_text or read_file",
        },
      ],
      toolGuidance: "Use search_text with the symbol name to find its definition immediately.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 5. Config Discovery
  if (/\b(?:port|config|configuration|settings?|environment|default format)\b/i.test(text)) {
    return {
      category: "CONFIG_DISCOVERY",
      allowedTools: ["read_file", "search_text", "find_files"],
      recommendedInitialTools: ["read_file", "search_text"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "read-config-evidence",
          kind: "SEARCH_PERFORMED",
          minCount: 1,
          description: "Search for configuration settings or inspect config files using search_text or read_file",
        },
      ],
      toolGuidance: "Use search_text or read_file (e.g. config.ts, README.md) to inspect configuration settings.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 6. Cross File Reasoning / Control Flow
  if (
    explicitFiles.length >= 2 ||
    /\b(?:cross[- ]file|across files|compare|endpoints are created|routes array|trace.*from.*to|how.*interact)\b/i.test(text)
  ) {
    return {
      category: "CROSS_FILE_REASONING",
      allowedTools: ["read_file", "search_text", "find_files", "list_directory"],
      recommendedInitialTools: ["read_file", "search_text"],
      defaultTurnBudget: 6,
      evidenceRequirements: [
        {
          id: "cross-file-reads",
          kind: "CROSS_FILE_EVIDENCE",
          minCount: Math.max(2, explicitFiles.length),
          description: `Read all relevant files (${explicitFiles.length > 0 ? explicitFiles.join(", ") : "at least 2 files"}) using read_file`,
        },
      ],
      toolGuidance: "Read each of the mentioned files using read_file to observe how they interact.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 7. Control Flow
  if (/\b(?:control[- ]flow|flow|trace|lifecycle|execution flow)\b/i.test(text)) {
    return {
      category: "CONTROL_FLOW",
      allowedTools: ["read_file", "search_text", "find_files", "list_directory"],
      recommendedInitialTools: ["read_file", "search_text"],
      defaultTurnBudget: 6,
      evidenceRequirements: [
        {
          id: "trace-flow-files",
          kind: "CROSS_FILE_EVIDENCE",
          minCount: 2,
          description: "Inspect entry point and handler/middleware files using read_file",
        },
      ],
      toolGuidance: "Read entry points and middleware/handlers using read_file to trace execution flow.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 8. File Discovery
  if (/\b(?:find all|list all.*files|find.*files|what.*files|all.*typescript)\b/i.test(text)) {
    return {
      category: "FILE_DISCOVERY",
      allowedTools: ["find_files", "read_file", "list_directory"],
      recommendedInitialTools: ["find_files", "list_directory"],
      defaultTurnBudget: 4,
      evidenceRequirements: [
        {
          id: "discover-files",
          kind: "SEARCH_PERFORMED",
          minCount: 1,
          description: "Discover files using find_files (with glob pattern like **/*.ts) or list_directory",
        },
      ],
      toolGuidance: "Use find_files with a glob pattern (e.g. **/*.ts) to find matching files across the repository.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 9. Architecture
  if (/\b(?:architecture|high-level|structure|components in src|commands are structured)\b/i.test(text)) {
    return {
      category: "ARCHITECTURE",
      allowedTools: ["read_file", "list_directory", "search_text", "find_files"],
      recommendedInitialTools: ["read_file", "list_directory"],
      defaultTurnBudget: 5,
      evidenceRequirements: [
        {
          id: "architecture-evidence",
          kind: "ANY_TOOL_OBSERVATION",
          minCount: 2,
          description: "Inspect architecture documentation or directory structure and key source files",
        },
      ],
      toolGuidance: "Read ARCHITECTURE.md/README.md or list directory structure, then read key entry files.",
      requiresCodeChange,
      explicitFilePaths: explicitFiles,
    }
  }

  // 10. Orientation (default)
  return {
    category: "ORIENTATION",
    allowedTools: ["read_file", "list_directory", "find_files", "search_text"],
    recommendedInitialTools: explicitFiles.length > 0 ? ["read_file"] : ["list_directory", "read_file"],
    defaultTurnBudget: 4,
    evidenceRequirements: explicitFiles.length > 0
      ? [
          {
            id: "orientation-explicit-files",
            kind: "FILE_READ",
            minCount: explicitFiles.length,
            description: `Read ${explicitFiles.join(", ")} using read_file`,
          },
        ]
      : [],
    toolGuidance: explicitFiles.length > 0
      ? `Read ${explicitFiles.join(", ")} directly using read_file.`
      : "Read README.md or use list_directory to inspect repository files.",
    requiresCodeChange,
    explicitFilePaths: explicitFiles,
  }
}
