import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export class SmokeEndpointFixture {
  private server: Server | null = null;
  public recordedRequests: RecordedRequest[] = [];
  public modelId: string = 'qwen2.5-coder:7b';
  public chatResponseText: string = 'Deterministic Open VS Code mock response.';
  public fimResponseText: string = 'function smokeTest() { return true; }';

  async start(port: number = 0): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr !== null) {
          const actualPort = addr.port;
          const url = `http://127.0.0.1:${actualPort}`;
          resolve({ port: actualPort, url });
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody: any = null;
      try {
        if (rawBody.trim()) parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }

      this.recordedRequests.push({
        method: req.method || 'UNKNOWN',
        url: req.url || '/',
        headers: req.headers,
        body: parsedBody,
      });

      const url = req.url || '/';

      // 1. Models endpoint
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: this.modelId,
                object: 'model',
                created: 1700000000,
                owned_by: 'local',
              },
            ],
          })
        );
        return;
      }

      // 2. Chat completions endpoint
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-smoke-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: this.modelId,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: this.chatResponseText,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 25,
              completion_tokens: 10,
              total_tokens: 35,
            },
          })
        );
        return;
      }

      // 3. Completions endpoint (for FIM)
      if (req.method === 'POST' && (url === '/v1/completions' || url === '/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-smoke-test',
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: this.modelId,
            choices: [
              {
                text: this.fimResponseText,
                index: 0,
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 8,
              total_tokens: 23,
            },
          })
        );
        return;
      }

      // Fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Route not found: ${req.method} ${url}`, code: 404 } }));
    });
  }
}
