import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { AccountDatabase } from "../db/connection.js";
import { AuthService } from "../auth/auth-service.js";
import { AdminService } from "../admin/admin-service.js";
import { IntegrationService } from "../integration/integration-service.js";
import { ModeService } from "../mode/mode-service.js";
import {
  AccountServiceError,
  ForbiddenError,
  InvalidInputError,
  PayloadTooLargeError,
  PublicSignupDisabledError,
  SecurityViolationError,
  UnauthorizedError,
} from "../errors.js";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB

export interface ServerTlsConfig {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
}

export interface HttpServerOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly tls?: ServerTlsConfig | undefined;
}

export class AccountServer {
  public readonly authService: AuthService;
  public readonly adminService: AdminService;
  public readonly integrationService: IntegrationService;
  public readonly modeService: ModeService;
  private server?: http.Server | https.Server | undefined;
  private readonly port: number;
  private readonly host: string;
  private readonly tls?: ServerTlsConfig | undefined;

  constructor(
    public readonly db: AccountDatabase,
    options: HttpServerOptions = {}
  ) {
    this.port = options.port ?? 4040;
    this.host = options.host ?? "127.0.0.1";
    this.tls = options.tls;

    this.authService = new AuthService(db);
    this.adminService = new AdminService(db);
    this.integrationService = new IntegrationService(db);
    this.modeService = new ModeService(db);
  }

  private isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase().trim();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") {
      return true;
    }
    const ipType = net.isIP(h);
    if (ipType === 4 && h.startsWith("127.")) {
      return true;
    }
    return false;
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let totalBytes = 0;
      let rejected = false;
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        if (rejected) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          rejected = true;
          req.resume(); // Drain stream to allow 413 response to be received
          reject(new PayloadTooLargeError());
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (rejected) return;
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        const str = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(str);
          resolve(parsed);
        } catch {
          reject(new InvalidInputError("Malformed JSON request body."));
        }
      });

      req.on("error", (err) => {
        if (!rejected) reject(err);
      });
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json, "utf8"),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(json);
  }

  private sendError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof AccountServiceError) {
      this.sendJson(res, err.statusCode, err.toJSON());
      return;
    }
    this.sendJson(res, 500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred.",
      },
    });
  }

  private getBearerToken(req: http.IncomingMessage): string | undefined {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return undefined;
    }
    return authHeader.slice("Bearer ".length).trim();
  }

  private getClientIp(req: http.IncomingMessage): string {
    const remote = req.socket.remoteAddress;
    return remote || "127.0.0.1";
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Basic CORS & Preflight handling
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();
    const clientIp = this.getClientIp(req);

    try {
      // 1. Public Health Check
      if (method === "GET" && pathname === "/api/v1/health") {
        this.sendJson(res, 200, { status: "ok", version: "0.1.0" });
        return;
      }

      // 2. Public Registration is strictly disallowed
      if (pathname === "/api/v1/auth/signup" || pathname === "/api/v1/auth/register") {
        throw new PublicSignupDisabledError();
      }

      // 3. Login
      if (method === "POST" && pathname === "/api/v1/auth/login") {
        const body = await this.parseJsonBody(req);
        if (!body.username || !body.password) {
          throw new InvalidInputError("Username and password are required.");
        }
        const result = await this.authService.login(body.username, body.password, clientIp);
        const user = this.authService.toProfile(
          this.db.users.findById(result.session.userId)!
        );
        this.sendJson(res, 200, {
          user,
          session: {
            id: result.session.id,
            expiresAt: result.session.expiresAt,
            createdAt: result.session.createdAt,
          },
          token: result.token,
        });
        return;
      }

      // 4. Logout
      if (method === "POST" && pathname === "/api/v1/auth/logout") {
        const token = this.getBearerToken(req);
        if (token) {
          await this.authService.logout(token, clientIp);
        }
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // Authenticated Routes: Validate session token
      const token = this.getBearerToken(req);
      if (!token) {
        throw new UnauthorizedError();
      }

      const { user, session } = await this.authService.validateSession(token);
      const userProfile = this.authService.toProfile(user);

      // 5. Current Profile
      if (method === "GET" && pathname === "/api/v1/auth/me") {
        this.sendJson(res, 200, {
          user: userProfile,
          session: {
            id: session.id,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
          },
        });
        return;
      }

      // 6. Admin Endpoints
      if (pathname.startsWith("/api/v1/admin/")) {
        if (user.role !== "ADMIN") {
          throw new ForbiddenError("Administrative privileges required.");
        }

        // POST /api/v1/admin/users
        if (method === "POST" && pathname === "/api/v1/admin/users") {
          const body = await this.parseJsonBody(req);
          const newUser = await this.adminService.createUser(user.id, body);
          this.sendJson(res, 201, { user: newUser });
          return;
        }

        // GET /api/v1/admin/users
        if (method === "GET" && pathname === "/api/v1/admin/users") {
          const users = await this.adminService.listUsers(user.id);
          this.sendJson(res, 200, { users });
          return;
        }

        // PATCH /api/v1/admin/users/:id/status
        const statusMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/status$/);
        if (method === "PATCH" && statusMatch && statusMatch[1]) {
          const targetUserId = statusMatch[1];
          const body = await this.parseJsonBody(req);
          if (body.status !== "ACTIVE" && body.status !== "DISABLED") {
            throw new InvalidInputError("status must be 'ACTIVE' or 'DISABLED'.");
          }
          const updated = await this.adminService.setStatus(user.id, targetUserId, body.status);
          this.sendJson(res, 200, { user: updated });
          return;
        }

        // POST /api/v1/admin/users/:id/reset-password
        const resetMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/reset-password$/);
        if (method === "POST" && resetMatch && resetMatch[1]) {
          const targetUserId = resetMatch[1];
          const body = await this.parseJsonBody(req);
          if (!body.newPassword) {
            throw new InvalidInputError("newPassword is required.");
          }
          await this.adminService.resetPassword(user.id, targetUserId, body.newPassword);
          this.sendJson(res, 200, { ok: true });
          return;
        }

        // GET /api/v1/admin/audit
        if (method === "GET" && pathname === "/api/v1/admin/audit") {
          const actor = parsedUrl.searchParams.get("actor") || undefined;
          const action = parsedUrl.searchParams.get("action") || undefined;
          const target = parsedUrl.searchParams.get("target") || undefined;
          const since = parsedUrl.searchParams.get("since") || undefined;
          const limit = parseInt(parsedUrl.searchParams.get("limit") || "100", 10);

          const filterOptions: { actor?: string; action?: string; target?: string; since?: string; limit?: number } = { limit };
          if (actor) filterOptions.actor = actor;
          if (action) filterOptions.action = action;
          if (target) filterOptions.target = target;
          if (since) filterOptions.since = since;

          const events = await this.adminService.getAuditLog(user.id, filterOptions);
          this.sendJson(res, 200, { events });
          return;
        }
      }

      // 7. Integration Management Endpoints
      // GET /api/v1/integrations
      if (method === "GET" && pathname === "/api/v1/integrations") {
        const integrations = await this.integrationService.list(user.id);
        this.sendJson(res, 200, { integrations });
        return;
      }

      // POST /api/v1/integrations
      if (method === "POST" && pathname === "/api/v1/integrations") {
        const body = await this.parseJsonBody(req);
        const integration = await this.integrationService.register(user.id, body);
        this.sendJson(res, 201, { integration });
        return;
      }

      // GET /api/v1/integrations/workspace/:workspaceId
      const wsMatch = pathname.match(/^\/api\/v1\/integrations\/workspace\/([^/]+)$/);
      if (method === "GET" && wsMatch && wsMatch[1]) {
        const workspaceId = decodeURIComponent(wsMatch[1]);
        const integrations = await this.integrationService.getEffectiveIntegrations(user.id, workspaceId);
        this.sendJson(res, 200, { integrations });
        return;
      }

      // Single Integration Routes: /api/v1/integrations/:id
      const idMatch = pathname.match(/^\/api\/v1\/integrations\/([^/]+)$/);
      if (idMatch && idMatch[1]) {
        const integrationId = idMatch[1];

        // GET /api/v1/integrations/:id
        if (method === "GET") {
          const integration = await this.integrationService.get(user.id, integrationId);
          this.sendJson(res, 200, { integration });
          return;
        }

        // PUT /api/v1/integrations/:id
        if (method === "PUT") {
          const body = await this.parseJsonBody(req);
          const updated = await this.integrationService.update(user.id, integrationId, body);
          this.sendJson(res, 200, { integration: updated });
          return;
        }

        // DELETE /api/v1/integrations/:id
        if (method === "DELETE") {
          await this.integrationService.delete(user.id, integrationId);
          this.sendJson(res, 200, { ok: true });
          return;
        }
      }

      // PUT /api/v1/integrations/:id/workspace/:workspaceId
      const policyMatch = pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/workspace\/([^/]+)$/);
      if (method === "PUT" && policyMatch && policyMatch[1] && policyMatch[2]) {
        const integrationId = policyMatch[1];
        const workspaceId = decodeURIComponent(policyMatch[2]);
        const body = await this.parseJsonBody(req);
        const policy = await this.integrationService.setWorkspacePolicy(
          user.id,
          integrationId,
          workspaceId,
          body.enabledState !== false,
          body.applicablePermissionRestrictions ?? null
        );
        this.sendJson(res, 200, { policy });
        return;
      }

      // 8. Custom Mode Profiles Endpoints (Sprint 8D)
      // GET /api/v1/modes
      if (method === "GET" && pathname === "/api/v1/modes") {
        const modes = await this.modeService.list(user.id);
        this.sendJson(res, 200, { modes });
        return;
      }

      // POST /api/v1/modes
      if (method === "POST" && pathname === "/api/v1/modes") {
        const body = await this.parseJsonBody(req);
        const mode = await this.modeService.register(user.id, body);
        this.sendJson(res, 201, { mode });
        return;
      }

      // Single Mode Routes: /api/v1/modes/:id
      const modeIdMatch = pathname.match(/^\/api\/v1\/modes\/([^/]+)$/);
      if (modeIdMatch && modeIdMatch[1]) {
        const profileId = modeIdMatch[1];

        // GET /api/v1/modes/:id
        if (method === "GET") {
          const mode = await this.modeService.get(user.id, profileId);
          this.sendJson(res, 200, { mode });
          return;
        }

        // PUT /api/v1/modes/:id
        if (method === "PUT") {
          const body = await this.parseJsonBody(req);
          const updated = await this.modeService.update(user.id, profileId, body);
          this.sendJson(res, 200, { mode: updated });
          return;
        }

        // DELETE /api/v1/modes/:id
        if (method === "DELETE") {
          await this.modeService.delete(user.id, profileId);
          this.sendJson(res, 200, { ok: true });
          return;
        }
      }

      // 404 Route Not Found
      this.sendJson(res, 404, {
        error: {
          code: "NOT_FOUND",
          message: `Endpoint ${method} ${pathname} was not found.`,
        },
      });
    } catch (err: any) {
      this.sendError(res, err);
    }
  }

  async start(): Promise<{ port: number; host: string; url: string }> {
    // Remote deployment security rule:
    // If not using TLS, strictly mandate loopback binding!
    if (!this.tls && !this.isLoopbackHost(this.host)) {
      throw new SecurityViolationError(
        `Plain HTTP is only permitted on loopback interface (127.0.0.1 / localhost). Remote deployment on host "${this.host}" requires TLS certificates.`
      );
    }

    return new Promise((resolve, reject) => {
      const requestListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
        void this.handleRequest(req, res);
      };

      if (this.tls) {
        this.server = https.createServer(
          {
            cert: this.tls.cert,
            key: this.tls.key,
          },
          requestListener
        );
      } else {
        this.server = http.createServer(requestListener);
      }

      this.server.on("error", (err) => reject(err));

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        let actualPort = this.port;
        if (addr && typeof addr === "object") {
          actualPort = addr.port;
        }
        const protocol = this.tls ? "https" : "http";
        const url = `${protocol}://${this.host}:${actualPort}`;
        resolve({ port: actualPort, host: this.host, url });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = undefined;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
