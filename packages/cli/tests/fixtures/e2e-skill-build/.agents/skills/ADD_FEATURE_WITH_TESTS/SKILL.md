---
id: ADD_FEATURE_WITH_TESTS
title: Add Feature With Tests
summary: Safely add a new feature by locating the smallest surface and verifying with tests.
modes:
  - BUILD
tags:
  - feature
  - tests
  - development
tools:
  - read_file
  - search_text
  - find_files
---

# Intent
Safely introduce new functionality while preserving existing architecture and ensuring behavioral correctness through tests.

# When
Use when asked to implement a new feature, add missing functionality, or extend an API.

# Inputs
- Feature requirements
- Target components or modules

# Procedure
1. **Understand existing behavior:** Inspect the codebase to see how similar features are implemented.
2. **Locate smallest implementation surface:** Identify exactly where the new logic should live to minimize impact.
3. **Identify regression contract:** Determine what existing tests or behavior must NOT change.
4. **Implement bounded change:** Add the feature. Do not encourage broad rewrites.
5. **Add/update tests:** Create tests that prove the new feature works and edge cases are handled.
6. **Human-approved verification:** Wait for approval before mutation.
7. **Report evidence:** Report the results of the applied mutation and test verification.

# Expected Output
The requested feature implemented correctly with passing unit tests.

# Failure Modes
- Feature creep or unnecessary rewrites.
- Tests missing or inadequate.
- Existing tests broken by the new feature.

# Recovery Prompts
Feature creep: reject unrelated changes and strictly bound the scope.
Tests failing: review test logic and fix either the implementation or the test.
