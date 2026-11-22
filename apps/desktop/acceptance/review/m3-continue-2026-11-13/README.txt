Milestone 3 live Continue evidence (2026-11-13)

Installed daily driver: 0.1.0-rc.16 (unchanged).
Source HEAD at start: 1cd3805ea1 (includes 0aec532fab Continue wiring).
Overlay: /tmp/ovsc-m3-ext  extension.js SHA-256 876dc2d4e0058cbe48e9ba71bcac1cd5c5f28953e94d02380a6c21ef3acb8f4a
Model: qwen3-coder:30b  digest sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a
Lab-only initial budget: OPEN_VS_CODE_ACCEPTANCE_LAB=1 OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS=2
Continue: +8 turns, cap 40. Native tool messages remain experimental.

same-session/  CODE-CONTINUE run 2026-11-13T12-28-02-725Z
  Task id: session-1794572914124
  Pause: genuine MAX_TURNS_EXCEEDED. Continue this run visible. Idle 5s: no writes.
  Continue click: new approval for patch src/format.ts. Applied formatName only.
  Independent tests: 1/3. Did not raise the cap.

restart/  CODE-CONTINUE-RESTART run 2026-11-13T12-44-34-931Z
  Same pause, close isolated app, relaunch same profile/workspace.
  Continue this run restored. Idle wait: no auto-resume.
  Continue: one new approval, format.ts only, tests 1/3.

stale/  CODE-CONTINUE-STALE run 2026-11-13T13-00-40-892Z
  External EXTERNAL_STALE_MARKER written to src/*.ts after pause.
  Marker survived Continue. No whole-file overwrite.
