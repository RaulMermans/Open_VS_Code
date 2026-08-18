# ADR-004: Provider-agnostic model gateway

**Status:** Accepted

## Context

Local inference backends and model capabilities vary. Binding the agent to one model or transport would make the architecture brittle.

## Decision

Agent code targets a generic model interface. Backend-specific configuration, streaming, tool-call normalization, and capability detection live in provider adapters.

## Rationale

The gateway permits Ollama, llama.cpp, vLLM, LM Studio, and local OpenAI-compatible endpoints to evolve independently of agent behavior.

## Consequences

- The common interface must expose capability differences rather than assuming parity.
- Provider conformance tests will be needed.
- Model-specific optimizations remain possible behind adapters.

## Alternatives

- Standardize on one local model and runtime.
- Spread provider conditionals through the agent loop.

## Revisit triggers

A stable external protocol fully covers required semantics, or lowest-common-denominator abstraction blocks critical local-model behavior.
