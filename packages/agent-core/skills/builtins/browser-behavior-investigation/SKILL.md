---
id: browser-behavior-investigation
name: Browser Behavior Investigation
description: Investigate authorized running web applications through bounded Playwright exploration, recording state transitions, forms, and accessibility trees.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
  - REVIEW
  - BUILD
capabilities:
  - read
  - search
required_tools:
  - read_file
  - search_text
context_budget: 800
risk_level: low
triggers:
  - investigate web application
  - explore running website
  - black box web investigation
  - browser behavioral exploration
  - reverse engineer web app
composes_with:
  - rea-investigation-routing
  - feature-specification
  - evidence-reconciliation
---

# Intent

Conduct structured, bounded behavioral investigation of a running web application without access to its source code, recording inspectable evidence of routes, controls, and state transitions.

# When to Use

- Black-box reverse engineering of an authorized running website or web service.
- Discovering application routes, interactive controls, and navigation topology.
- Recording form validation behaviors, error recovery states, and visible data contracts.

Do not use for crawling arbitrary public websites or web scraping untrusted external domains.

# Inputs

- Authorized web URL (validated against origin allowlist).
- Governed browser tools (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`).
- Exploration budget: maximum pages, interaction steps, and time bounds.

# Workflow

1. Initialize session: navigate to target URL and record initial route, page title, and accessibility snapshot.
2. Inventory landmarks: identify navigation links, interactive buttons, inputs, and semantic regions.
3. Formulate hypotheses: deduce intended user flows (e.g., authentication, item creation, filtering).
4. Execute bounded interactions:
   - Click navigation links and observe route changes.
   - Fill form fields with valid and invalid values to uncover validation rules.
   - Observe resulting DOM changes and record state transitions.
5. Capture evidence: record structured transition records (`Initial State -> User Action -> Resulting State -> Visible Change -> Confidence`).
6. Identify unknowns: document unobservable server-side behaviors (backend APIs, database persistence).

# Verification

- Every recorded state transition cites a concrete accessibility ref or DOM snapshot.
- No arbitrary external domains or unauthorized ports were contacted.
- Sensitive values (passwords, tokens) are redacted from recorded evidence.

# Failure Modes

- Unbounded crawling: following links to external third-party origins.
- Side-effect escalation: submitting destructive forms without required user confirmation.
- Conflating inference with fact: claiming knowledge of backend SQL schema from a UI form.

# Exit Criteria

- Page inventory and navigation graph are recorded in the evidence ledger.
- Form inputs, validation messages, and error states are documented.
- All observed state transitions are ground in timestamped evidence records.
