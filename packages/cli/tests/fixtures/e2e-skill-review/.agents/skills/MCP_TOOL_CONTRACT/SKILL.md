---
id: MCP_TOOL_CONTRACT
title: MCP Tool Contract
summary: Define how a future Model Context Protocol (MCP) tool should be specified.
modes:
  - PLAN
tags:
  - mcp
  - tools
  - specification
tools:
  - read_file
---

# Intent
Provide documentation and procedural guidance for specifying an MCP tool. Actual MCP runtime implementation is deferred to Sprint 2C. This is for specification only.

# When
Use when asked to design, define, or plan a new MCP tool.

# Inputs
- Tool purpose
- Target system or API

# Procedure
Define the following for the tool:
1. **Intent:** What the tool does and why it exists.
2. **Tool name:** A clear, unique identifier.
3. **Inputs:** Required and optional parameters with types.
4. **Outputs:** The structure of the returned data.
5. **Side effects:** Any state changes the tool causes.
6. **Permissions:** What authorization is needed to run it.
7. **Timeouts:** Maximum expected execution time.
8. **Cancellation:** How the tool handles being aborted.
9. **Idempotency:** Whether it is safe to call multiple times with the same inputs.
10. **Error taxonomy:** Specific error codes and meanings.
11. **Security boundary:** Risks and mitigations.
12. **Examples:** Sample invocations and responses.
13. **Tests:** How to verify the tool works.
14. **Failure modes:** Common ways it breaks.

# Expected Output
A comprehensive MCP tool specification document.

# Failure Modes
- Attempting to implement the tool code instead of specifying it.
- Missing security or idempotency details.

# Recovery Prompts
Implementing code: stop writing implementation and focus on the specification contract.
