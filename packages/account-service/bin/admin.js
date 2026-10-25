#!/usr/bin/env node
import { runAdminCli } from "../src/admin/admin-cli.js";

runAdminCli(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
