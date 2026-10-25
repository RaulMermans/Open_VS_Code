import * as path from "node:path";
import * as os from "node:os";
import { AccountDatabase } from "../db/connection.js";
import { AdminService } from "./admin-service.js";
import { AccountServer } from "../server/http-server.js";
import type { UserRole, UserStatus } from "../types.js";

function getDefaultDbPath(): string {
  if (process.env.OPEN_VS_CODE_ACCOUNT_DB_PATH) {
    return process.env.OPEN_VS_CODE_ACCOUNT_DB_PATH;
  }
  const homeDir = os.homedir();
  return path.join(homeDir, ".open-vs-code", "accounts.db");
}

function parseArgs(args: string[]): { command?: string | undefined; options: Record<string, string> } {
  const options: Record<string, string> = {};
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    } else if (!command) {
      command = arg;
    }
  }

  return { command, options };
}

async function readPasswordSecurely(promptEnvVar: string): Promise<string> {
  if (process.env[promptEnvVar]) {
    return process.env[promptEnvVar]!.trim();
  }

  // If stdin has data (piped or redirected)
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => {
        resolve(data.trim());
      });
    });
  }

  // Interactive read
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("Enter password: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function runAdminCli(args: string[]): Promise<number> {
  const { command, options } = parseArgs(args);
  const dbPath = options.db || getDefaultDbPath();

  if (!command || command === "help" || options.help) {
    console.log(`
Open VS Code Private Account Administration CLI

Usage:
  open-vs-code-admin <command> [options]

Commands:
  bootstrap       Initialize the first administrator account (only valid when database is empty)
  create-user     Create a new account with specified role
  list-users      List all registered accounts
  set-status      Enable or disable an account
  reset-password  Reset an account's password and revoke active sessions
  audit-log       View administrative and authentication audit records
  serve           Start the account service HTTP/HTTPS daemon

Options:
  --db <path>     Path to SQLite database file (default: ~/.open-vs-code/accounts.db)
  --username <u>  Account username
  --role <r>      Account role: ADMIN or USER (default: USER)
  --status <s>    Account status: ACTIVE or DISABLED
  --port <p>      HTTP port for serve (default: 4040)
  --host <h>      Bind host for serve (default: 127.0.0.1)

Security Note:
  Passwords must NOT be passed via command-line arguments.
  Provide passwords via STDIN or environment variables:
    OPEN_VS_CODE_ADMIN_PASSWORD
    OPEN_VS_CODE_USER_PASSWORD
    OPEN_VS_CODE_NEW_PASSWORD
`);
    return 0;
  }

  const db = AccountDatabase.open(dbPath);
  const adminService = new AdminService(db);

  try {
    switch (command) {
      case "bootstrap": {
        const username = options.username || "admin";
        const password = await readPasswordSecurely("OPEN_VS_CODE_ADMIN_PASSWORD");
        if (!password) {
          console.error("Error: Password is required for administrator bootstrap.");
          return 1;
        }
        const user = await adminService.bootstrapFirstAdmin(username, password);
        console.log(`Successfully bootstrapped administrator account:`);
        console.log(`  ID:       ${user.id}`);
        console.log(`  Username: ${user.username}`);
        console.log(`  Role:     ${user.role}`);
        return 0;
      }

      case "create-user": {
        const username = options.username;
        if (!username) {
          console.error("Error: --username is required.");
          return 1;
        }
        const role = (options.role?.toUpperCase() === "ADMIN" ? "ADMIN" : "USER") as UserRole;
        const password = await readPasswordSecurely("OPEN_VS_CODE_USER_PASSWORD");
        if (!password) {
          console.error("Error: Password is required for user creation.");
          return 1;
        }
        const user = await adminService.createUser("ADMIN_CLI", { username, password, role });
        console.log(`User created successfully:`);
        console.log(`  ID:       ${user.id}`);
        console.log(`  Username: ${user.username}`);
        console.log(`  Role:     ${user.role}`);
        console.log(`  Status:   ${user.status}`);
        return 0;
      }

      case "list-users": {
        const users = await adminService.listUsers("ADMIN_CLI");
        if (users.length === 0) {
          console.log("No accounts found in database. Run 'bootstrap' to create the initial administrator.");
          return 0;
        }
        console.log(`Accounts (${users.length}):`);
        console.log("------------------------------------------------------------------");
        console.log("USERNAME".padEnd(20) + "ROLE".padEnd(10) + "STATUS".padEnd(12) + "CREATED");
        console.log("------------------------------------------------------------------");
        for (const u of users) {
          console.log(
            u.username.padEnd(20) +
            u.role.padEnd(10) +
            u.status.padEnd(12) +
            u.createdAt.slice(0, 19).replace("T", " ")
          );
        }
        return 0;
      }

      case "set-status": {
        const userTarget = options.user || options.username;
        const status = options.status?.toUpperCase() as UserStatus;
        if (!userTarget || (status !== "ACTIVE" && status !== "DISABLED")) {
          console.error("Error: --user and valid --status (ACTIVE or DISABLED) are required.");
          return 1;
        }
        let targetId = userTarget;
        const byUsername = db.users.findByUsername(userTarget);
        if (byUsername) {
          targetId = byUsername.id;
        }
        const updated = await adminService.setStatus("ADMIN_CLI", targetId, status);
        console.log(`Account status updated for ${updated.username}: ${updated.status}`);
        return 0;
      }

      case "reset-password": {
        const userTarget = options.user || options.username;
        if (!userTarget) {
          console.error("Error: --user or --username is required.");
          return 1;
        }
        let targetId = userTarget;
        const byUsername = db.users.findByUsername(userTarget);
        if (byUsername) {
          targetId = byUsername.id;
        }
        const newPassword = await readPasswordSecurely("OPEN_VS_CODE_NEW_PASSWORD");
        if (!newPassword) {
          console.error("Error: New password is required.");
          return 1;
        }
        await adminService.resetPassword("ADMIN_CLI", targetId, newPassword);
        console.log(`Password reset successfully for ${byUsername?.username || targetId}. All active sessions revoked.`);
        return 0;
      }

      case "audit-log": {
        const limit = parseInt(options.limit || "50", 10);
        const events = await adminService.getAuditLog("ADMIN_CLI", { limit });
        if (events.length === 0) {
          console.log("No audit records found.");
          return 0;
        }
        console.log(`Audit Events (latest ${events.length}):`);
        console.log("--------------------------------------------------------------------------------------");
        console.log("TIMESTAMP".padEnd(21) + "ACTION".padEnd(24) + "OUTCOME".padEnd(10) + "ACTOR");
        console.log("--------------------------------------------------------------------------------------");
        for (const ev of events) {
          console.log(
            ev.timestamp.slice(0, 19).replace("T", " ").padEnd(21) +
            ev.action.padEnd(24) +
            ev.outcome.padEnd(10) +
            ev.actor
          );
        }
        return 0;
      }

      case "serve": {
        const port = parseInt(options.port || process.env.OPEN_VS_CODE_PORT || "4040", 10);
        const host = options.host || process.env.OPEN_VS_CODE_HOST || "127.0.0.1";
        const server = new AccountServer(db, { port, host });
        const { url } = await server.start();
        console.log(`Open VS Code Account Service running at ${url}`);
        console.log(`Database: ${dbPath}`);
        console.log(`Press Ctrl+C to terminate.`);

        process.on("SIGINT", async () => {
          console.log("\nShutting down account service...");
          await server.stop();
          db.close();
          process.exit(0);
        });

        // Keep process running
        await new Promise(() => {});
        return 0;
      }

      default:
        console.error(`Unknown command: "${command}". Run with --help for usage.`);
        return 1;
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}
