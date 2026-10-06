# HALO Acceptance Runbook — Open VS Code V1 Release Gate

**Status**: Release Gate Runbook  
**Target Inference Host**: HALO (High-Assurance Local Orchestration / Inference Appliance)  
**Governing ADRs**: [ADR-020](../adrs/ADR-020-halo-capability-provider.md), [ADR-027](../adrs/ADR-027-real-local-models-and-adaptive-routing.md), [ADR-028](../adrs/ADR-028-desktop-shell-and-packaging-strategy.md)  

---

## 1. Authoritative Architecture & Topology Reconciliation

Sprint 4F completes the Open VS Code Desktop Candidate application without requiring local model weights or inference execution on the development workstation. Real open-weight model execution and benchmark validation belong exclusively to **HALO target-host acceptance**.

Open VS Code implements a reconciled, authoritative dual-path topology:

### A. HALO Control / Capability Path (Governed by ADR-020)
When configured with `open-vs-code.inferenceBackend = "halo"`:
```text
Open VS Code extension
  → HaloProvider
  → HALO Core capability API (POST /inference/capability/chat)
  → HALO runtime model routing (coding vs. reasoning)
```
- Authenticates using Bearer token from VS Code SecretStorage (`halo.appToken` or `HALO_APP_TOKEN_OPEN_VSCODE`).
- Deterministically maps agent modes to capabilities (`ASK`/`BUILD` → `coding`, `PLAN`/`DEBUG`/`REVIEW` → `reasoning`).
- Invariant: Failures on the HALO Core path never fall back to standalone-local inference.

### B. FIM / Autocomplete Path (Governed by ADR-027)
Editor-native inline completion (FIM) uses direct OpenAI-compatible routing:
```text
Open VS Code extension
  → AutocompleteController
  → AutocompleteService
  → Production Gateway
  → ModelRouter
  → LocalFimProvider
  → POST /v1/completions (hosted on HALO machine)
```
- Configured via `.open-vs-code/models.json`.
- Uses standard FIM prompt formatting (Qwen / DeepSeek / StarCoder strategies).

### C. Standalone Local Path (Governed by ADR-027)
When `open-vs-code.inferenceBackend = "standalone-local"`:
- Chat and reasoning query direct OpenAI-compatible `/v1/chat/completions` endpoints hosted on local or LAN inference servers.

---

## 2. Target Platform & Prerequisites

### Designated Target Hardware
- **Target**: AMD Halo host
- **Runtime**: Operator-selected supported local inference runtime (e.g. Ollama, llama.cpp server, or vLLM)
- **Served Model**: Determined during HALO provisioning (baseline: `qwen2.5-coder:7b`)

Before initiating HALO target-host acceptance, verify:

1. **Hardware Availability**:
   - Dedicated AMD Halo host powered on and accessible on the local network.
2. **Inference Runtime Running**:
   - Supported local inference engine active on the AMD Halo host exposing OpenAI-compatible endpoints and/or HALO Core capability daemon.
3. **Required Open-Weight Model Weights Installed by Operator**:
   - Primary coding model: `qwen2.5-coder:7b` (or designated quantized GGUF variant).
   - FIM / Autocomplete capability confirmed on the served model.
   - Weights installed via operator CLI; never downloaded by Open VS Code.
4. **Network Connectivity**:
   - HTTP reachability from the Open VS Code client machine to `http://HALO_HOST:PORT` verified (e.g. `curl -s http://HALO_HOST:PORT/v1/models`).
5. **Operator Inference Authorization**:
   - Explicit environment variable set on the benchmark runner:
     ```bash
     export OPEN_VS_CODE_REAL_INFERENCE=1
     ```

---

## 3. Pre-Flight Verification Sequence

Run the sequential verification checks:

### Step 3.1: Health Endpoint Check

```bash
curl -f -s http://HALO_HOST:PORT/v1/models | jq .
```
- **Expected**: HTTP 200 OK with JSON array of available models.

### Step 3.2: Served Model Discovery

- Confirm `qwen2.5-coder:7b` appears in `data[].id`.

### Step 3.3: Warmup Inference Probe

```bash
curl -s http://HALO_HOST:PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder:7b",
    "messages": [{"role": "user", "content": "Respond with OK."}],
    "max_tokens": 10
  }' | jq .choices[0].message.content
```
- **Expected**: Non-empty model completion without error.

---

## 4. Open VS Code Configuration

Configure the Open VS Code workspace `.open-vs-code/models.json` pointing to HALO:

```json
{
  "$schema": "https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/models.schema.json",
  "providers": [
    {
      "id": "halo-remote",
      "kind": "openai_compatible_local",
      "baseUrl": "http://HALO_HOST:PORT"
    }
  ],
  "models": [
    {
      "id": "qwen2.5-coder-7b",
      "displayName": "Qwen 2.5 Coder 7B (HALO)",
      "family": "qwen",
      "contextWindow": 32768,
      "capabilities": ["toolUse", "coding", "autocomplete", "fim"],
      "specialization": "coding",
      "fimStrategy": "qwen",
      "provenance": "Qwen2.5-Coder-7B-Instruct on HALO"
    }
  ],
  "deployments": [
    {
      "id": "halo-chat",
      "providerId": "halo-remote",
      "modelId": "qwen2.5-coder-7b",
      "modelName": "qwen2.5-coder:7b",
      "enabled": true,
      "priority": 10
    },
    {
      "id": "halo-fim",
      "providerId": "halo-remote",
      "modelId": "qwen2.5-coder-7b",
      "modelName": "qwen2.5-coder:7b",
      "enabled": true,
      "priority": 10,
      "fimStrategy": "qwen"
    }
  ],
  "routes": {
    "coding": ["halo-chat"],
    "autocomplete": ["halo-fim"],
    "default": ["halo-chat"]
  }
}
```

*Note: Replace `http://HALO_HOST:PORT` with the actual HALO network address (e.g. `http://halo.local:11434` or `http://192.168.1.100:8000`). Never hardcode secrets.*

---

## 5. Required Benchmark Command

Execute the repository's canonical real-model evaluation flow:

```bash
export OPEN_VS_CODE_REAL_INFERENCE=1
npm run eval:models
```

**Do NOT duplicate benchmark logic or create separate test harnesses.**

`npm run eval:models` runs:
1. `InferenceGate` preflight check.
2. 10 real Agent coding benchmark tasks through production `AgentRuntime` + `RoutedModelGateway`.
3. 8 real FIM autocomplete tasks through production `AutocompleteGateway` + `LocalFimProvider`.
4. Adaptive routing evidence ledger updates.
5. Structural syntax and latency verification.

---

## 6. Acceptance Artifact Requirements

For V1 final release acceptance, the run must produce a verifiable acceptance record:

1. **Repository Provenance**:
   - Clean Git worktree (`git status --porcelain` is empty).
   - Exact commit SHA recorded.
2. **HALO Provenance**:
   - Host architecture and OS (e.g., Apple M3 Max 128GB, macOS / Linux Ubuntu 24.04).
   - Serving runtime name and version (e.g., Ollama v0.5.x or vLLM v0.6.x).
   - Exact served model identifier and quantization (e.g., `qwen2.5-coder:7b-instruct-q8_0`).
3. **Execution Evidence**:
   - Benchmark Status: `EXECUTED` (not `BLOCKED_WITH_EVIDENCE`).
   - `measuredTasksExecuted: true`.
   - Agent tasks: 10/10 executed and evaluated with structural correctness.
   - FIM tasks: 8/8 executed with latency and token metrics captured.
   - Zero proprietary cloud fallbacks.
4. **Desktop App Validation**:
   - Open VS Code Desktop application launched and confirmed operational against HALO endpoint.
   - Chat turn executes and displays in Chat webview.
   - Autocomplete triggers inline completions.

---

## 7. Verdict Declaration

Upon successful execution of all criteria:

```text
OPEN VS CODE V1 ✅ RELEASE ACCEPTED ON HALO
```

If model performance or latency is below desired thresholds, document measured evidence and tune serving configurations without invalidating desktop packaging architecture.
