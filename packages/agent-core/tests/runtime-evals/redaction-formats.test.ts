// Sprint 7D — secret formats the canonical redactor missed, false positives it
// must not introduce, and linear time on adversarial input. Pattern-based
// redaction is best effort: these tests pin known formats, not every secret.
import { test } from "node:test"
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { redactRuntimeEvalSecrets as redact } from "../../src/runtime-evals/evidence.ts"

const SECRET_FORMATS: Record<string, [string, string]> = {
  "quoted JSON password": ['{"password": "hunter2-correct-horse"}', "hunter2-correct-horse"],
  "camelCase JSON apiKey": ['{"apiKey":"abc123def456ghi789"}', "abc123def456ghi789"],
  "JSON client_secret": ['"client_secret": "s3cr3t-value-123"', "s3cr3t-value-123"],
  "database URL credentials": ["DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app", "hunter2pass"],
  "https userinfo": ["curl https://user:pa55word@example.com/api", "pa55word"],
  "Hugging Face token": ["HF token hf_abcdefghijklmnopqrstuvwxyzABCDEFGH", "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH"],
  "bare npm token": ["use npm_abcdefghijklmnopqrstuvwxyz0123456789 here", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
  "GitLab token": ["glpat-abcdefghij1234567890", "glpat-abcdefghij1234567890"],
  "Google API key": ["key AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
  "Stripe restricted key": ["rk_live_abcdefghijklmnopqrstuvwx", "rk_live_abcdefghijklmnopqrstuvwx"],
  "Slack webhook": ["https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXXXXXX"],
  "lowercase AWS secret access key": ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  "cookie header": ["Cookie: session=abcdef1234567890abcdef", "abcdef1234567890abcdef"],
}

test("7D-R1. formats missed before Sprint 7D are redacted", () => {
  for (const [name, [input, secret]] of Object.entries(SECRET_FORMATS)) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `${name}: ${out}`)
    assert.match(out, /REDACTED/, name)
  }
})

test("7D-R2. formats covered before Sprint 7D still are", () => {
  for (const input of ["password: hunter2", "DATABASE_PASSWORD=hunter2", "Bearer abc.def.ghi", "sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123"]) {
    assert.match(redact(input), /REDACTED/, input)
  }
})

test("7D-R3. ordinary prose, configuration and URLs are left alone", () => {
  for (const input of [
    "max tokens: 4096 is the limit",
    '"max_tokens": 256',
    '"author": "Jane"',
    '"tokens": "many"',
    "see https://example.com:443/path@v2",
    "https://github.com/x/y",
    "the access key rotation doc",
    "the Cookie header is set by the server",
  ]) {
    assert.equal(redact(input), input)
  }
})

test("7D-R4. redaction stays linear on adversarial input", () => {
  for (const input of ["a.".repeat(100000), "a-".repeat(100000), "x://u:" + "p".repeat(200000), '"apikey'.repeat(28000), "ab://c:d".repeat(25000)]) {
    const t = performance.now()
    redact(input)
    const ms = performance.now() - t
    assert.ok(ms < 500, `${input.slice(0, 12)}… took ${ms.toFixed(1)} ms`)
  }
})
