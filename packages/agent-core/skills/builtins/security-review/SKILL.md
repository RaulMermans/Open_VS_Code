---
id: security-review
name: Security Review
description: Review a change or module for common security regressions and report concrete findings.
version: 1
category: security
allowed_modes:
  - REVIEW
  - ASK
capabilities:
  - read
  - search
required_tools:
  - read_file
  - search_text
context_budget: 900
risk_level: low
triggers:
  - security
  - vulnerability
  - vulnerable
  - injection
  - xss
  - csrf
  - path traversal
  - secret leak
  - credential
  - auth
  - authentication
  - authorization
  - exploit
  - sanitize
composes_with:
  - verification
---

# Intent

Find concrete security regressions in a bounded change or module and report each with evidence.

# When to Use

- The task asks for a security review, or a review of authentication, permissions, input handling, or credential code.

Do not turn this into a general audit of the whole repository.

# Inputs

- The files or diff under review.
- The trust boundary: which inputs come from users, files, the network, or a model.

# Workflow

1. Scope: list the files under review with `find_files` or from the task. Stay inside that scope.
2. Trace untrusted input from where it enters to where it is used, with `search_text` and `read_file`.
3. Check, where relevant:
   - injection: input concatenated into shell commands, SQL, HTML, or regular expressions;
   - unsafe command execution: shell interpreters, unvalidated arguments, inherited environment;
   - path traversal: user paths joined without containment or symlink checks;
   - secret leakage: credentials in code, logs, error messages, or telemetry;
   - credential handling: literal keys in config instead of environment or secret storage;
   - permission and auth boundaries: checks that can be skipped, reordered, or bypassed;
   - network boundary: new outbound calls or fallbacks to remote services.
4. For each finding, confirm it by reading the exact code path. Discard anything you cannot point to.

# Verification

- Every finding cites a file, a line or symbol, and the input that reaches it.
- Suspected issues that could not be confirmed are listed separately as open questions.

# Failure Modes

- Generic advice with no code reference.
- Reviewing unrelated files outside the stated scope.
- Reporting a theoretical issue as confirmed.

# Exit Criteria

- A findings list ordered by severity, each with location, impact, and a suggested fix, or an explicit statement that no issues were found in scope.
