import { selectMcpTools } from "./packages/agent-core/src/mcp/mcp-selector.ts";
function createTool(name: string, desc: string, serverId: string = "test_server", tokens: number = 100): any {
  return { serverId, toolName: name, canonicalName: `mcp_${serverId}_${name}`, description: desc, estimatedSchemaTokens: tokens };
}
const catalog = [
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
console.log(selectMcpTools(catalog, { task: "Use search_docs to find the parser configuration", mode: "BUILD" as any, maxTools: 3 }).selected.map((t: any) => t.canonicalName));
