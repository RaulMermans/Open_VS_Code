import type { McpToolMetadata } from "./mcp-catalog.ts";
import type { AgentMode } from "../contracts/agent.ts";

export interface McpSelectorOptions {
  task: string;
  mode: AgentMode;
  maxTools?: number;
  schemaBudget?: number;
}

export interface McpSelectorResult {
  selected: McpToolMetadata[];
  eligibleCount: number;
}

export function selectMcpTools(tools: McpToolMetadata[], options: McpSelectorOptions): McpSelectorResult {
  const maxTools = options.maxTools ?? 3;
  const schemaBudget = options.schemaBudget ?? 1500;

  const taskTokens = options.task.toLowerCase().split(/[\s_\-.,]+/);

  const scored = tools.map(tool => {
    let score = 0;
    const nameTokens = tool.toolName.toLowerCase().split(/[\s_\-.,]+/);
    const descTokens = tool.description.toLowerCase().split(/[\s_\-.,]+/);
    
    for (const t of taskTokens) {
      if (t.length < 3) continue;
      if (nameTokens.includes(t)) score += 3;
      if (descTokens.includes(t)) score += 1;
    }
    
    if (options.task.toLowerCase().includes(tool.serverId.toLowerCase())) score += 5;
    if (options.task.toLowerCase().includes(tool.toolName.toLowerCase())) score += 5;
    
    return { tool, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.canonicalName.localeCompare(b.tool.canonicalName);
  });

  const relevant = scored.filter(s => s.score > 0).map(s => s.tool);

  const selected: McpToolMetadata[] = [];
  let currentTokens = 0;

  for (const tool of relevant) {
    if (selected.length >= maxTools) break;
    
    if (currentTokens + tool.estimatedSchemaTokens > schemaBudget) {
      continue;
    }

    selected.push(tool);
    currentTokens += tool.estimatedSchemaTokens;
  }

  return { selected, eligibleCount: relevant.length };
}
