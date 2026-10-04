# HALO Acceptance Runbook — Open VS Code V1 Release Gate

**Status**: Release Gate Runbook  
**Target Inference Host**: HALO (High-Assurance Local Orchestration / Inference Appliance)  
**Governing ADRs**: [ADR-020](../adrs/ADR-020-halo-capability-provider.md), [ADR-027](../adrs/ADR-027-real-local-models-and-adaptive-routing.md), [ADR-028](../adrs/ADR-028-desktop-shell-and-packaging-strategy.md)  

---

## 1. Overview & Separation of Concerns

Sprint 4F completes the Open VS Code Desktop Candidate application without requiring local model weights or inference execution on the development workstation.

Real open-weight model execution and benchmark validation belong exclusively to **HALO target-host acceptance**.

HALO serves as an external, private, high-performance OpenAI-compatible inference host accessible over local network (LAN) or local loopback. Open VS Code communicates with HALO using standard HTTP OpenAI-compatible protocol (`/v1/models`, `/v1/chat/completions`, `/v1/completions`).

**No HALO-specific transport or proprietary SDK is bundled inside the editor.**

---

## 2. Prerequisites

Before initiating HALO target-host acceptance, verify:

1. **Hardware Availability**:
   - Dedicated HALO host powered on with Apple Silicon (e.g. M-series Max/Ultra) or Linux NVIDIA GPU cluster.
2. **Inference Runtime Running**:
   - Supported OpenAI-compatible serving engine active: Ollama, vLLM, or llama.cpp server.
3. **Required Open-Weight Model Weights Installed by Operator**:
   - Primary coding model: `qwen2.5-coder:7b` (or designated quantized GGUF variant).
   - FIM / Autocomplete capability confirmed on the served model.
   - Weights installed via operator CLI (e.g., `ollama pull qwen2.5-coder:7b`); never downloaded by Open VS Code.
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
