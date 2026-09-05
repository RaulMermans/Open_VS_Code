# ADR 015: Bounded MCP Integration

## Context
As the agent ecosystem grows, there is a need to support external capabilities dynamically via the Model Context Protocol (MCP) without compromising the strictly bounded, deterministic, and metadata-first architecture of the Open VS Code agent. Unconstrained MCP introduces severe risks: prompt bloat from massive tool schemas, injection of unreviewed side-effects, hidden dependencies requiring `npm install` on the fly, and infinite blocking on unresponsive servers.

## Decision
We integrate MCP as a bounded infrastructure layer, rather than an untethered dynamic capability:
1. **No Automatic Installation:** We implement a lightweight JSON-RPC 2.0 `StdioMcpTransport` natively over `node:child_process` and `node:readline`. We explicitly enforce `shell: false` and only connect to pre-installed executables declared in `.open-vs-code/mcp.json`.
2. **Deterministic Discovery and Selection:** We employ an `McpCatalog` to discover tools and an `McpSelector` to deterministically select a strict subset (max 3 tools, capped by a 1500-token schema budget) based on keyword matching with the current task, just like we do for agent skills.
3. **Explicit Permission Boundaries:** We map `mcp_external_read` to `ALLOW` and both `mcp_external_side_effect` and `mcp_external_unknown` to `CONFIRM`. All side-effects trigger human review via the same `AgentRunner` PAUSE mechanism used for filesystem writes. Server-provided metadata cannot escalate a tool's permission to bypass human review.
4. **Bounded Results:** Results from MCP tool executions are hard-truncated at 50KB. Timeouts are strictly enforced via `AbortSignal`.

## Consequences
- **Security:** The system remains structurally secure. Malicious or overly broad MCP tools cannot act without explicit `CONFIRM` loops.
- **Reliability:** Enforced token budgets and timeouts prevent context window explosion and agent freezing.
- **Portability:** The native `StdioMcpTransport` maintains our no-heavy-dependencies philosophy.
- **Complexity:** This introduces an additional discovery phase at startup and requires maintainers to curate the `.open-vs-code/mcp.json` file.
