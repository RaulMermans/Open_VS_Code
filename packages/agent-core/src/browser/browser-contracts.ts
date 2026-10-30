export type BrowserSessionStatus =
  | "UNINITIALIZED"
  | "READY"
  | "NAVIGATING"
  | "ACTION_PENDING"
  | "CLOSING"
  | "CLOSED"
  | "ERROR";

export type BrowserProvisioningStatus = "READY" | "NOT_CONFIGURED" | "UNSUPPORTED";

export interface BrowserExecutableProvenance {
  readonly path: string;
  readonly source: "env" | "playwright_cache" | "system" | "custom";
  readonly version?: string | undefined;
  readonly detectedAt: string;
}

export interface BrowserProvisioningDiagnostic {
  readonly status: BrowserProvisioningStatus;
  readonly executable?: BrowserExecutableProvenance | undefined;
  readonly supportedVersions: readonly string[];
  readonly details: readonly string[];
}

export interface BrowserNetworkPolicyConfig {
  readonly allowedOrigins: readonly string[];
  readonly blockPrivateSubnets?: boolean | undefined;
  readonly blockCloudMetadata?: boolean | undefined;
  readonly blockFileProtocol?: boolean | undefined;
  readonly blockServiceWorkers?: boolean | undefined;
  readonly blockWebSockets?: boolean | undefined;
  readonly maxRedirects?: number | undefined;
  readonly customResolver?: ((hostname: string) => Promise<string[]>) | undefined;
}

export interface BrowserSessionConfig {
  readonly workspaceRoot: string;
  readonly sessionId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly storageDir?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly executablePath?: string | undefined;
  readonly networkPolicy?: BrowserNetworkPolicyConfig | undefined;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxSnapshotBytes?: number | undefined;
  readonly maxConsoleMessages?: number | undefined;
  readonly maxNetworkEvents?: number | undefined;
}

export interface EffectiveSandboxVerification {
  readonly supported: boolean;
  readonly capabilitySupported: boolean;
  readonly runtimeVerified: boolean;
  readonly platform: NodeJS.Platform;
  readonly osRelease: string;
  readonly browserVersion?: string | undefined;
  readonly executablePath?: string | undefined;
  readonly executableSource?: "env" | "playwright_cache" | "system" | "custom" | undefined;
  readonly browserPid?: number | undefined;
  readonly helperPids?: readonly number[] | undefined;
  readonly verificationMethod?: string | undefined;
  readonly details: string;
  readonly processFlags: {
    readonly noSandboxIntroduced: boolean;
    readonly chromiumSandboxOption: boolean;
    readonly seatbeltClientActive?: boolean | undefined;
    readonly seccompActive?: boolean | undefined;
  };
}

export interface ElementRef {
  readonly refId: string;
  readonly role: string;
  readonly name: string;
  readonly selector: string;
  readonly snapshotId: string;
  readonly tag: string;
  readonly value?: string | undefined;
  readonly sensitive?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly sideEffect?: boolean | undefined;
  readonly targetFingerprint?: string | undefined;
  readonly inputType?: string | undefined;
  readonly href?: string | undefined;
  readonly formAction?: string | undefined;
  readonly parentSignature?: string | undefined;
}

export interface AccessibilitySnapshot {
  readonly snapshotId: string;
  readonly url: string;
  readonly title: string;
  readonly tree: string;
  readonly elements: readonly ElementRef[];
  readonly elementCount: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

export type BrowserEventType =
  | "session_started"
  | "session_closed"
  | "navigation_attempted"
  | "navigation_completed"
  | "navigation_failed"
  | "tool_invoked"
  | "action_approved"
  | "action_denied"
  | "snapshot_taken"
  | "screenshot_taken"
  | "console_message"
  | "network_failure"
  | "network_policy_denied"
  | "destination_resolution_failed"
  | "timeout"
  | "cancellation"
  | "process_cleanup"
  | "sandbox_verified"
  | "target_validated"
  | "approval_revalidated"
  | "session_invalidated";

export interface BrowserEvent {
  readonly type: BrowserEventType;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface BrowserConsoleEntry {
  readonly type: "log" | "info" | "warn" | "error";
  readonly text: string;
  readonly timestamp: number;
}

export interface BrowserNetworkFailure {
  readonly url: string;
  readonly method: string;
  readonly error: string;
  readonly timestamp: number;
}
