---
id: SECURITY_HARDENING_PASS
title: Security Hardening Pass
summary: Review and harden code against common vulnerabilities like path traversal and secret leakage.
modes:
  - REVIEW
tags:
  - security
  - review
  - audit
tools:
  - read_file
  - search_text
---

# Intent
Identify and mitigate security boundaries, input validation flaws, and unsafe side effects. Do not claim a full security audit or formal verification. Do not add destructive security scanning tools.

# When
Use when asked to review security, harden an implementation, or verify trust boundaries.

# Inputs
- Module or application entry points
- Security concerns (e.g., path traversal, secrets)

# Procedure
1. **Trust boundaries:** Identify where untrusted input enters the system.
2. **Input validation:** Check if inputs are sanitized or typed correctly.
3. **Path containment:** Verify that file paths cannot escape the workspace.
4. **Secret handling:** Ensure passwords, tokens, and keys are not logged or stored in plaintext.
5. **Permission bypass:** Check if authorization checks can be skipped.
6. **Side-effect authorization:** Review if destructive actions require human confirmation.
7. **Process execution:** Ensure shell commands are bounded and safely parameterized.
8. **Dependency/config risks:** Check for unsafe defaults.
9. **Tests for identified boundary:** Recommend or write tests for the identified security boundary.

# Expected Output
A set of findings with severity, evidence, and the smallest recommended correction.

# Failure Modes
- Overstating the comprehensiveness of the audit.
- Running destructive scanners.
- Recommending large rewrites instead of targeted hardening.

# Recovery Prompts
Destructive tools suggested: remove them and rely on static inspection.
Overstated claims: clarify that this is a localized hardening pass, not formal verification.
