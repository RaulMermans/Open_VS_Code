# ADR-016: Deterministic Model / Provider Routing Architecture

## Context
In Sprint 2D, we needed to establish the control-plane layer for routing coding tasks to appropriate model deployments, specifically focusing on local and open-weight models. The routing mechanism needed to be token-efficient, deterministic, and capable of operating without running real model weights on the development machine. It also needed to handle fallback gracefully without resorting to silent cloud fallback or open-ended cycling.

## Decision
We implemented a deterministic Model / Provider Routing Architecture with the following core principles:

1. **Clear Concept Separation**: We distinctly separate:
   - **Provider**: The protocol/transport implementation (e.g., `openai_compatible_local`, `scripted`).
   - **Model**: The logical model identity and capability metadata (`toolUse`, `coding` specialization, `contextWindow`).
   - **Deployment**: A configured runnable instance mapping a provider, a model, and an endpoint.

2. **Deterministic Router**: The `ModelRouter` is purely deterministic. It evaluates candidates against explicit hard capabilities (context window size, tool use, structured output), filters by health state, and scores them based on specialization preference and configured priority. Tie-breaking relies on a stable ID sort. **No LLM is used to choose an LLM.**

3. **Explicit Local Fallback**: Fallback chains are explicitly configured. If a primary deployment is unavailable (e.g., unhealthy), the router gracefully fails over to the next compatible healthy candidate in the chain. We strictly enforced a **no silent cloud fallback** policy. If no local fallback is available or permitted, the router explicitly fails.

4. **ScriptedModelProvider on Dev Machine**: To maintain a model-weight-free development environment, we use `ScriptedModelProvider` as a first-class deployment for testing and E2E verification, deferring real open-weight benchmarking to the target inference machine.

5. **Route Provenance & Token Accounting**: Every model invocation retains compact provenance (provider ID, model ID, deployment ID, and fallback level) without bloating the context or tracking complex billing engines.

6. **Boundary Preservation**: The router does not own repair loops, tool execution, or permissions. It simply returns a compatible deployment.

## Status
Accepted.

## Consequences
- **Positive**: We have a reliable, offline-compatible routing engine that seamlessly handles local models and explicitly defines fallback boundaries. The architecture remains extremely token-efficient.
- **Positive**: We maintain the strict invariant of not downloading or running real model weights on the development machine, ensuring reproducible and fast tests.
- **Negative**: The router's health states are kept minimal ("unknown", "ready", "unavailable"), requiring future expansion if degraded/latency-aware routing is needed on target machines.
