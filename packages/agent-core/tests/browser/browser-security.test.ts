import { test, describe } from "node:test";
import * as assert from "node:assert";
import {
  isBrowserUrlPermitted,
  classifyBrowserToolAction,
  isSensitiveField,
  isDestructiveElement,
  createBrowserToolRegistrations,
  detectBrowserProvisioning,
  BrowserSessionManager,
  BrowserSessionError,
  type ElementRef,
} from "../../src/browser/index.ts";

describe("Sprint 9A — Browser Security & Policy Enforcement", () => {
  // Scenario 15: Network guard blocks private IP / SSRF / unallowed origins
  test("15. Network guard blocks SSRF and unauthorized origins", () => {
    const policy = {
      allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:8080"],
    };

    // Allowed origins
    assert.strictEqual(isBrowserUrlPermitted("http://localhost:3000/dashboard", policy).allowed, true);
    assert.strictEqual(isBrowserUrlPermitted("http://127.0.0.1:8080/app", policy).allowed, true);

    // Private network SSRF blocked
    assert.strictEqual(isBrowserUrlPermitted("http://192.168.1.50/admin", policy).allowed, false);
    assert.strictEqual(isBrowserUrlPermitted("http://10.0.0.1/secret", policy).allowed, false);
    assert.strictEqual(isBrowserUrlPermitted("http://172.16.0.5/api", policy).allowed, false);

    // External origins not in allowed list blocked
    assert.strictEqual(isBrowserUrlPermitted("https://malicious-site.example.com/", policy).allowed, false);
    assert.strictEqual(isBrowserUrlPermitted("http://localhost:4000/unauthorized-port", policy).allowed, false);
  });

  // Scenario 16: Reject file:// URLs
  test("16. Reject file:// URLs to prevent local filesystem exfiltration", () => {
    const policy = {
      allowedOrigins: ["http://localhost:3000"],
    };

    const res1 = isBrowserUrlPermitted("file:///etc/passwd", policy);
    assert.strictEqual(res1.allowed, false);
    assert.ok(res1.reason?.toLowerCase().includes("forbidden protocol"));

    const res2 = isBrowserUrlPermitted("file:///Users/alice/.ssh/id_rsa", policy);
    assert.strictEqual(res2.allowed, false);
    assert.ok(res2.reason?.toLowerCase().includes("forbidden protocol"));
  });

  // Scenario 17: Reject cloud metadata endpoints
  test("17. Reject cloud metadata endpoints (AWS, GCP, Azure)", () => {
    const policy = {
      allowedOrigins: ["http://localhost:3000"],
    };

    // AWS / Azure / OpenStack metadata
    const awsRes = isBrowserUrlPermitted("http://169.254.169.254/latest/meta-data/", policy);
    assert.strictEqual(awsRes.allowed, false);
    assert.ok(awsRes.reason?.toLowerCase().includes("cloud metadata"));

    // GCP metadata
    const gcpRes = isBrowserUrlPermitted("http://metadata.google.internal/computeMetadata/v1/", policy);
    assert.strictEqual(gcpRes.allowed, false);
    assert.ok(gcpRes.reason?.toLowerCase().includes("cloud metadata"));
  });

  // Scenario 18: Distinguish inspection from interaction
  test("18. Distinguish inspection from interaction deterministically", () => {
    // Inspection actions
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_open" }),
      "browser_inspection"
    );
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_snapshot" }),
      "browser_inspection"
    );
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_screenshot" }),
      "browser_inspection"
    );
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_close" }),
      "browser_inspection"
    );

    // Interaction actions
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_navigate" }),
      "browser_interaction"
    );
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_click" }),
      "browser_interaction"
    );
    assert.strictEqual(
      classifyBrowserToolAction({ toolName: "browser_fill", args: { value: "hello" } }),
      "browser_interaction"
    );
  });

  // Scenario 19: Require approval for form submission & sensitive interactions
  test("19. Require explicit approval for form interactions and capture review payload", async () => {
    const dummyManager = new BrowserSessionManager({
      workspaceRoot: "/tmp",
      sessionId: "test-sec-19",
    });

    const tools = createBrowserToolRegistrations(dummyManager);
    const clickTool = tools.find((t) => t.definition.name === "browser_click")!;
    const fillTool = tools.find((t) => t.definition.name === "browser_fill")!;

    assert.ok(clickTool.prepareForReview, "browser_click must have prepareForReview for permission gating");
    assert.ok(fillTool.prepareForReview, "browser_fill must have prepareForReview for permission gating");

    const reviewFill = await fillTool.prepareForReview!(
      { refId: "e1", value: "test-value" },
      { signal: new AbortController().signal } as any
    );
    assert.strictEqual(reviewFill.reviewPayload.tool, "browser_fill");
    assert.strictEqual(reviewFill.reviewPayload.refId, "e1");
    assert.strictEqual(reviewFill.reviewPayload.displayValue, "test-value");
  });

  // Scenario 20: Sensitive field masking and protection
  test("20. Identify sensitive fields and mask credentials in review payloads", async () => {
    // Detect password / secret fields
    assert.strictEqual(isSensitiveField({ name: "password", role: "textbox", tag: "input", selector: "#pass" }), true);
    assert.strictEqual(isSensitiveField({ name: "apiKey", role: "textbox", tag: "input", selector: "#key" }), true);
    assert.strictEqual(isSensitiveField({ name: "credit_card", role: "textbox", tag: "input", selector: "#cc" }), true);
    assert.strictEqual(isSensitiveField({ name: "username", role: "textbox", tag: "input", selector: "#user" }), false);

    const sensitiveTarget: ElementRef = {
      refId: "e_pass",
      role: "textbox",
      name: "Account Password",
      selector: "input[type='password']",
      snapshotId: "snap_1",
      tag: "input",
      sensitive: true,
      destructive: false,
    };

    assert.strictEqual(
      classifyBrowserToolAction({
        toolName: "browser_fill",
        args: { value: "supersecret123" },
        targetElement: sensitiveTarget,
      }),
      "browser_sensitive"
    );

    // Also classifies as sensitive if the value itself contains secret tokens
    assert.strictEqual(
      classifyBrowserToolAction({
        toolName: "browser_fill",
        args: { value: "my-secret-token-value" },
      }),
      "browser_sensitive"
    );
  });

  // Scenario 21: Destructive action classification
  test("21. Classify destructive actions with high risk and confirmation requirement", () => {
    // Detect destructive elements
    assert.strictEqual(isDestructiveElement({ name: "Delete Account", role: "button", tag: "button" }), true);
    assert.strictEqual(isDestructiveElement({ name: "Remove Workspace", role: "button", tag: "button" }), true);
    assert.strictEqual(isDestructiveElement({ name: "Destroy Database", role: "button", tag: "button" }), true);
    assert.strictEqual(isDestructiveElement({ name: "Save Changes", role: "button", tag: "button" }), false);

    const destructiveTarget: ElementRef = {
      refId: "e_del",
      role: "button",
      name: "Delete User Record",
      selector: "#btn-delete",
      snapshotId: "snap_1",
      tag: "button",
      sensitive: false,
      destructive: true,
    };

    assert.strictEqual(
      classifyBrowserToolAction({
        toolName: "browser_click",
        targetElement: destructiveTarget,
      }),
      "browser_destructive"
    );
  });

  // Scenario 28: Exclude high-risk capabilities
  test("28. Exclude high-risk capabilities from governed browser tool surface", () => {
    const dummyManager = new BrowserSessionManager({
      workspaceRoot: "/tmp",
      sessionId: "test-sec",
    });

    const tools = createBrowserToolRegistrations(dummyManager);
    const exposedToolNames = tools.map((t) => t.definition.name);

    // Permitted 7 governed tools
    const expected = [
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_screenshot",
      "browser_close",
    ];
    assert.deepStrictEqual(exposedToolNames.toSorted(), expected.toSorted());

    // Prohibited high-risk capabilities must NOT be present
    const prohibited = [
      "browser_eval",
      "browser_evaluate",
      "browser_cdp",
      "browser_export_cookies",
      "browser_session_storage",
      "browser_upload_file",
      "browser_arbitrary_download",
      "browser_install_extension",
    ];
    for (const p of prohibited) {
      assert.strictEqual(
        exposedToolNames.includes(p),
        false,
        `High-risk capability "${p}" must not be exposed`
      );
    }
  });

  // Scenario 29: Missing browser binary handling
  test("29. Missing browser binary returns NOT_CONFIGURED status without crashing", () => {
    const diag = detectBrowserProvisioning({
      overrideExecutablePath: "/nonexistent/path/to/custom-chromium-binary",
      skipPlaywrightCacheScan: true,
    });

    assert.strictEqual(diag.status, "NOT_CONFIGURED");
    assert.strictEqual(diag.executable, undefined);
    assert.ok(diag.details.some((d) => d.includes("No supported browser binary detected") || d.includes("Operator provisioning required")));
  });

  // Scenario 30: Process death and crash recovery
  test("30. Detect session closure and reject commands cleanly after disposal", async () => {
    const session = new BrowserSessionManager({
      workspaceRoot: "/tmp",
      sessionId: "test-crash-recovery",
    });

    assert.strictEqual(session.getStatus(), "UNINITIALIZED");
    await session.close();
    assert.strictEqual(session.getStatus(), "CLOSED");

    // Operations after close() throw clean NO_PAGE BrowserSessionError
    await assert.rejects(
      async () => {
        await session.snapshot();
      },
      (err: any) => err instanceof BrowserSessionError && err.code === "NO_PAGE"
    );

    await session.dispose();
    assert.strictEqual(session.getStatus(), "CLOSED");

    // Operations after terminal dispose() throw clean DISPOSED BrowserSessionError
    await assert.rejects(
      async () => {
        await session.snapshot();
      },
      (err: any) => err instanceof BrowserSessionError && err.code === "DISPOSED"
    );

    await assert.rejects(
      async () => {
        await session.click("e1");
      },
      (err: any) => err instanceof BrowserSessionError && err.code === "DISPOSED"
    );
  });
});
