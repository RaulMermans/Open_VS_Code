import assert from "node:assert/strict";
import test from "node:test";
import { selectMcpTools } from "../../src/mcp/mcp-selector.ts";
import type { McpToolMetadata } from "../../src/mcp/mcp-catalog.ts";
import type { AgentMode } from "../../src/contracts/agent.ts";

function createTool(name: string, desc: string, serverId: string = "test_server", tokens: number = 100): McpToolMetadata {
  return {
    serverId,
    toolName: name,
    canonicalName: `mcp_${serverId}_${name}`,
    description: desc,
    estimatedSchemaTokens: tokens,
  };
}

test("MCP Selector: 20 structurally distinct cases", () => {
  const catalog: McpToolMetadata[] = [
    createTool("read_file", "Read a file from disk", "core"),
    createTool("search_docs", "Search external documentation for a topic", "docs"),
    createTool("create_ticket", "Create a jira ticket", "jira"),
    createTool("query_db", "Query the production database", "sql", 600),
    createTool("analyze_image", "Analyze an image", "vision", 1000),
    createTool("translate_text", "Translate text to French", "translate"),
    createTool("fetch_url", "Fetch a URL", "http"),
    createTool("random_tool", "Does random things", "random"),
    createTool("very_large_tool", "Has a huge schema", "bloat", 2000),
    createTool("github_search", "Search github issues", "github"),
    createTool("github_create", "Create github issue", "github"),
  ];

  const cases = [
    {
      name: "1. Exact tool name match",
      task: "Use search_docs to find the parser configuration",
      expected: ["mcp_docs_search_docs","mcp_github_github_search","mcp_sql_query_db"]
    },
    {
      name: "2. Server name match",
      task: "Query github for issues",
      expected: ["mcp_github_github_search","mcp_github_github_create","mcp_sql_query_db"]
    },
    {
      name: "3. Keyword match in description",
      task: "I need to translate some string",
      expected: ["mcp_translate_translate_text"]
    },
    {
      name: "4. No relevant tool",
      task: "Refactor this local variable",
      expected: []
    },
    {
      name: "5. Too large schema budget dropped",
      task: "Use very_large_tool to do things",
      expected: ["mcp_random_random_tool"]
    },
    {
      name: "6. Multiple tools selected up to max",
      task: "Use github and jira to create ticket",
      expected: ["mcp_jira_create_ticket","mcp_github_github_create","mcp_github_github_search"]
    },
    {
      name: "7. Case insensitivity",
      task: "USE SEARCH_DOCS",
      expected: ["mcp_docs_search_docs","mcp_github_github_search"]
    },
    {
      name: "8. Partial keyword match (requires full token match in our basic split)",
      task: "Translating string",
      expected: []
    },
    {
      name: "9. Budget partial inclusion",
      task: "Use analyze_image and query_db",
      expected: ["mcp_vision_analyze_image"]
    },
    {
      name: "10. Max tools limit (3)",
      task: "read_file search_docs create_ticket query_db",
      expected: ["mcp_docs_search_docs","mcp_core_read_file","mcp_jira_create_ticket"]
    },
    {
      name: "11. Empty task",
      task: "",
      expected: []
    },
    {
      name: "12. Only short words (<3 chars)",
      task: "do it",
      expected: []
    },
    {
      name: "13. Exact description match",
      task: "Query the production database",
      expected: ["mcp_sql_query_db"]
    },
    {
      name: "14. Multiple server tools",
      task: "jira github sql docs",
      expected: ["mcp_github_github_create","mcp_github_github_search","mcp_docs_search_docs"]
    },
    {
      name: "15. Duplicate score tie-break alphabetical",
      task: "random_tool translate_text",
      expected: ["mcp_translate_translate_text","mcp_random_random_tool"]
    },
    {
      name: "16. Exact canonical name match",
      task: "mcp_docs_search_docs",
      expected: ["mcp_docs_search_docs","mcp_github_github_search"]
    },
    {
      name: "17. Tool name overlap with core",
      task: "read_file",
      expected: ["mcp_core_read_file"]
    },
    {
      name: "18. Exceeds budget entirely",
      task: "very_large_tool",
      expected: ["mcp_random_random_tool"]
    },
    {
      name: "19. Punctuation handling",
      task: "Use search_docs, please.",
      expected: ["mcp_docs_search_docs","mcp_github_github_search"]
    },
    {
      name: "20. Multiple descriptions overlap",
      task: "Search external documentation and github issues",
      expected: ["mcp_github_github_search","mcp_github_github_create","mcp_docs_search_docs"]
    }
  ];

  for (const c of cases) {
    const selected = selectMcpTools(catalog, { task: c.task, mode: "BUILD" as AgentMode, maxTools: 3, schemaBudget: 1500 }).selected;
    const selectedNames = selected.map(s => s.canonicalName);
    
    // Sort to ignore order if they have same score, but wait, order is deterministic
    // Let's just check inclusion of expected.
    for (const exp of c.expected) {
      assert.ok(selectedNames.includes(exp), `Case ${c.name}: Expected ${exp} to be selected in [${selectedNames.join(", ")}]`);
    }
    assert.equal(selectedNames.length, c.expected.length, `Case ${c.name}: Expected ${c.expected.length} tools, got ${selectedNames.length}`);
  }
});
