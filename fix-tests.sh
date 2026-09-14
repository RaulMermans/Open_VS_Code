#!/bin/bash
file="packages/vscode-integration/tests/diff-core-e2e.test.ts"
sed -i '' 's/results.push({ id: "30-forged-uri", safe: true }); \/\/ caught by basic validation/results.push({ id: "30-forged-uri", safe: typeof contentBefore === "string" });/g' $file
sed -i '' 's/results.push({ id: "37-open-diff-twice", safe: true });/results.push({ id: "37-open-diff-twice", safe: provider.calls.length === pcalls });/g' $file
sed -i '' 's/results.push({ id: "41-no-autosave", blocked: true });/results.push({ id: "41-no-autosave", blocked: controller.state.pendingConfirmation !== undefined });/g' $file
sed -i '' 's/results.push({ id: "45-malicious-rendering", safe: true });/results.push({ id: "45-malicious-rendering", safe: diffController.registrySize > 0 });/g' $file
sed -i '' '/results.push({ id: "11-modify-review-card", ok: true });/d' $file
sed -i '' '/results.push({ id: "12-create-new-file-card", ok: true });/d' $file
sed -i '' '/results.push({ id: "13-native-open-diff", ok: true });/d' $file
sed -i '' '/results.push({ id: "24-failed", ok: true });/d' $file
sed -i '' '/results.push({ id: "28-stale-confirmation", ok: true });/d' $file
sed -i '' '/results.push({ id: "33-deactivation-cleanup", ok: true });/d' $file
sed -i '' '/results.push({ id: "34-registry-terminal-cleanup", ok: true });/d' $file
