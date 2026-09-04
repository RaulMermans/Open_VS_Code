---
id: LOCAL_RELEASE_RUNBOOK
title: Local Release Runbook
summary: Prepare and verify a local-first distribution release.
modes:
  - PLAN
tags:
  - release
  - local
  - distribution
tools:
  - read_file
---

# Intent
Establish the procedure for verifying and releasing a local desktop application. This project is not being deployed on Railway. Focus on eventual local-first distribution. Do NOT implement packaging/distribution during this sprint. This is only the reusable procedure primitive. No Railway instructions.

# When
Use when asked to plan a release, prepare distribution, or document deployment steps.

# Inputs
- Current project version
- Build artifacts

# Procedure
Cover procedurally:
1. **Pre-release verification:** Ensure tests and linters pass.
2. **Versioning:** Determine the next version number.
3. **Build artifacts:** Identify what needs to be compiled or bundled.
4. **Local installation:** How the user will install the tool locally.
5. **Configuration:** What local config files are needed.
6. **Target inference endpoint configuration:** How to point the tool to a local model.
7. **Upgrade:** How users update from a previous version.
8. **Migration if needed:** Steps to migrate data or config.
9. **Backup/checkpoints:** Ensuring state is safe before upgrade.
10. **Rollback:** How to revert if the release fails.
11. **Cross-platform considerations:** OS-specific notes (macOS, Linux, Windows).
12. **Release verification:** How to prove the installed app works.

# Expected Output
A release plan or runbook document.

# Failure Modes
- Recommending cloud deployment (e.g., Railway, AWS).
- Executing release steps instead of documenting the runbook.

# Recovery Prompts
Cloud deployment suggested: remove cloud steps and focus on local desktop distribution.
Executing steps: stop executing and write the plan.
