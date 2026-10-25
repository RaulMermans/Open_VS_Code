import { test, describe } from "node:test";
import assert from "node:assert";
import * as http from "node:http";
import {
  AccountClient,
  validateAccountServerUrl,
  UntrustedEndpointError,
  UntrustedRedirectError,
  UnsupportedDatabaseRuntimeError,
  SqliteCliConnection,
} from "../../src/index.js";

describe("AccountClient Transport Security & Validation (Sprint 8C P0)", () => {
  test("1. accepts verified loopback IPv4, IPv6 and localhost endpoints", () => {
    const urls = [
      "http://127.0.0.1:4040",
      "http://127.0.0.2:8080",
      "http://localhost:3000",
      "http://[::1]:4040",
      "https://account.internal.net",
    ];

    for (const u of urls) {
      const parsed = validateAccountServerUrl(u);
      assert.ok(parsed);
      const client = new AccountClient({ baseUrl: u });
      assert.ok(client.getBaseUrl());
    }
  });

  test("2. rejects remote plaintext HTTP endpoints", () => {
    const forbiddenUrls = [
      "http://remote.example.com",
      "http://api.company.internal:4040",
      "http://192.168.1.100:4040",
      "http://10.0.0.1:4040",
      "http://172.16.0.1:4040",
    ];

    for (const u of forbiddenUrls) {
      assert.throws(
        () => validateAccountServerUrl(u),
        (err: any) => {
          assert.ok(err instanceof UntrustedEndpointError);
          assert.match(err.message, /Remote plaintext HTTP is forbidden/i);
          return true;
        }
      );
    }
  });

  test("3. rejects URLs containing embedded credentials", () => {
    const credentialUrls = [
      "http://admin:secret@127.0.0.1:4040",
      "https://user:password@secure.example.com",
      "http://token:@localhost:4040",
    ];

    for (const u of credentialUrls) {
      assert.throws(
        () => validateAccountServerUrl(u),
        (err: any) => {
          assert.ok(err instanceof UntrustedEndpointError);
          assert.match(err.message, /embedded user credentials/i);
          return true;
        }
      );
    }
  });

  test("4. rejects non-HTTP protocols", () => {
    const invalidProtocols = [
      "ftp://127.0.0.1:4040",
      "file:///etc/passwd",
      "ws://127.0.0.1:4040",
    ];

    for (const u of invalidProtocols) {
      assert.throws(
        () => validateAccountServerUrl(u),
        (err: any) => {
          assert.ok(err instanceof UntrustedEndpointError);
          assert.match(err.message, /Unsupported protocol/i);
          return true;
        }
      );
    }
  });

  test("5. clearing token when switching backend server URL", () => {
    const client = new AccountClient({
      baseUrl: "http://127.0.0.1:4040",
      token: "ovsc_sess_secret_token_1234567890",
    });

    assert.strictEqual(client.getToken(), "ovsc_sess_secret_token_1234567890");

    // Switching to another URL clears the token
    client.setBaseUrl("http://127.0.0.1:5050");
    assert.strictEqual(client.getToken(), undefined);

    // Setting a new token works
    client.setToken("ovsc_sess_new_token_abcdef");
    assert.strictEqual(client.getToken(), "ovsc_sess_new_token_abcdef");

    // Setting same base URL preserves token
    client.setBaseUrl("http://127.0.0.1:5050/");
    assert.strictEqual(client.getToken(), "ovsc_sess_new_token_abcdef");
  });

  test("6. rejects cross-origin redirect when authenticated", async () => {
    const evilServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ leaked: true }));
    });

    let evilPort = 0;
    const mainServer = http.createServer((_req, res) => {
      const target = `http://localhost:${evilPort}/stolen`;
      res.writeHead(302, { Location: target });
      res.end();
    });

    await new Promise<void>((resolve) => mainServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => {
      evilServer.listen(0, "127.0.0.1", () => {
        evilPort = (evilServer.address() as any).port;
        resolve();
      });
    });

    const mainPort = (mainServer.address() as any).port;

    try {
      const client = new AccountClient({
        baseUrl: `http://127.0.0.1:${mainPort}`,
        token: "ovsc_sess_secret_token_to_protect",
      });

      await assert.rejects(
        async () => {
          await client.getProfile();
        },
        (err: any) => {
          assert.ok(err instanceof UntrustedRedirectError);
          assert.match(err.message, /Cross-origin redirect/i);
          return true;
        }
      );
    } finally {
      mainServer.close();
      evilServer.close();
    }
  });

  test("7. rejects redirect to remote plaintext HTTP", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: "http://untrusted-remote.com/api" });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const client = new AccountClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "ovsc_sess_token",
      });

      await assert.rejects(
        async () => {
          await client.getProfile();
        },
        (err: any) => {
          assert.ok(err instanceof UntrustedRedirectError);
          assert.match(err.message, /remote plaintext HTTP/i);
          return true;
        }
      );
    } finally {
      server.close();
    }
  });

  test("8. rejects redirect containing embedded credentials", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: "http://user:pass@127.0.0.1:4040/api" });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const client = new AccountClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "ovsc_sess_token",
      });

      await assert.rejects(
        async () => {
          await client.getProfile();
        },
        (err: any) => {
          assert.ok(err instanceof UntrustedRedirectError);
          assert.match(err.message, /embedded credentials/i);
          return true;
        }
      );
    } finally {
      server.close();
    }
  });

  test("9. 401 Unauthorized clears client token to prevent stale authenticated state", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Session expired" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    try {
      const client = new AccountClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "ovsc_sess_stale_token",
      });

      assert.strictEqual(client.getToken(), "ovsc_sess_stale_token");

      await assert.rejects(
        async () => {
          await client.getProfile();
        },
        (err: any) => {
          assert.strictEqual(err.code, "UNAUTHORIZED");
          return true;
        }
      );

      // Token has been cleared
      assert.strictEqual(client.getToken(), undefined);
    } finally {
      server.close();
    }
  });

  test("10. SqliteCliConnection fails closed when instantiated", () => {
    assert.throws(
      () => new SqliteCliConnection(":memory:"),
      (err: any) => {
        assert.ok(err instanceof UnsupportedDatabaseRuntimeError);
        assert.match(err.message, /Node\.js >= 22\.0\.0/i);
        return true;
      }
    );
  });
});
