# ADR-002: Extension/product layer before deep Code-OSS changes

**Status:** Provisional

## Context

Maintaining a Code-OSS distribution is expensive and does not by itself validate the agent experience.

## Decision

Prove the AI and agent product layer through extension-level or similarly isolated integration before making deep editor changes.

## Rationale

This keeps early iteration focused on differentiated behavior and delays editor maintenance until requirements are demonstrated.

## Consequences

- Some UX may initially be constrained by extension APIs.
- Editor-specific changes require explicit justification.
- A later Code-OSS distribution remains possible.

## Alternatives

- Fork Code-OSS immediately.
- Build a new editor shell.

## Revisit triggers

Validated product requirements cannot be delivered through stable extension or adapter boundaries.

