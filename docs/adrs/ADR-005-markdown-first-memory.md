# ADR-005: Markdown-first project memory

**Status:** Provisional

## Context

Project knowledge must be inspectable, portable, versioned, and usable without a hosted service.

## Decision

Store plans, decisions, durable knowledge, and reusable procedures primarily as Markdown in the repository.

## Rationale

Markdown works with Git, humans, local tools, and models while avoiding early database or service dependencies.

## Consequences

- Documents need ownership and concise update rules to avoid drift.
- Structured indexes may be added when scale requires them.
- Ephemeral state should not pollute durable memory.

## Alternatives

- A proprietary project database.
- Vector storage as the source of truth.
- Conversation history as implicit memory.

## Revisit triggers

Repository scale or query requirements cannot be met through Markdown plus derived indexes.

