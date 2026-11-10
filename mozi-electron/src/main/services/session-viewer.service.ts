import { Buffer } from "node:buffer";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionViewerDependencies } from "../../agent/runtime/pi/sessions/session-viewer";

type RegisterSessionViewer = (pi: ExtensionAPI, dependencies?: SessionViewerDependencies) => void;

async function defaultLoadRegister(): Promise<RegisterSessionViewer> {
  const mod = await import("@hfrancisla/pi-session-viewer/dist/extension/index.js");
  return mod.registerExtension;
}

interface RunningViewer {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function forwardToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  getTargetSessionId: () => string | undefined,
): void {
  const pathname = (req.url ?? "/").split("?", 1)[0] || "/";
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  const proxyReq = httpRequest(
    {
      hostname: upstream.hostname,
      port: Number(upstream.port),
      path: req.url ?? "/",
      method: req.method ?? "GET",
      headers,
    },
    (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks);
        res.statusCode = proxyRes.statusCode ?? 200;
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value !== undefined && key.toLowerCase() !== "content-length" && key.toLowerCase() !== "transfer-encoding") {
            res.setHeader(key, value);
          }
        }
        const targetSessionId = getTargetSessionId();
        if (pathname === "/api/sessions" && res.statusCode === 200 && targetSessionId) {
          try {
            const payload = JSON.parse(raw.toString("utf8")) as {
              sessions?: Array<{ id?: unknown; token?: unknown; cwd?: unknown }>;
              initialSessionToken?: string;
              currentCwd?: string;
            };
            const matched = Array.isArray(payload.sessions)
              ? payload.sessions.find((item) => item && item.id === targetSessionId)
              : undefined;
            if (matched && typeof matched.token === "string") {
              payload.initialSessionToken = matched.token;
              if (typeof matched.cwd === "string" && matched.cwd) payload.currentCwd = matched.cwd;
            }
            const body = Buffer.from(JSON.stringify(payload), "utf8");
            res.setHeader("Content-Length", String(body.byteLength));
            res.end(body);
            return;
          } catch {
            // Fall through and return the original payload if JSON parsing fails.
          }
        }
        res.setHeader("Content-Length", String(raw.byteLength));
        res.end(raw);
      });
    },
  );
  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify({ error: error.message }));
  });
  req.pipe(proxyReq);
}

/** Manages the local read-only Pi Session Viewer server and targets the requested session. */
export class SessionViewerService {
  private targetSessionId?: string;
  private running?: RunningViewer;
  private starting?: Promise<RunningViewer>;

  constructor(
    private readonly sessionRoot: string,
    private readonly loadRegister: () => Promise<RegisterSessionViewer> = defaultLoadRegister,
  ) {}

  async urlForSession(sessionId?: string): Promise<string> {
    this.targetSessionId = sessionId?.trim() || undefined;
    const viewer = await this.ensureStarted();
    const query = this.targetSessionId ? `?${new URLSearchParams({ sessionId: this.targetSessionId }).toString()}` : "";
    const hash = new URLSearchParams({ token: viewer.token }).toString();
    return `http://${viewer.host}:${viewer.port}/${query}#${hash}`;
  }

  private async ensureStarted(): Promise<RunningViewer> {
    if (this.running) return this.running;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<RunningViewer> {
    mkdirSync(this.sessionRoot, { recursive: true });
    const registerExtension = await this.loadRegister();
    let commandHandler: ((args: string, ctx: { cwd?: string; ui: { notify(message: string, level: string): void } }) => Promise<void>) | undefined;
    let shutdownHandler: (() => Promise<void>) | undefined;
    let upstreamPanelUrl: string | undefined;

    const fakePi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (event === "session_shutdown") shutdownHandler = handler as () => Promise<void>;
      },
      registerCommand(name: string, definition: { handler: typeof commandHandler }) {
        if (name === "session-viewer") commandHandler = definition.handler;
      },
    } as unknown as ExtensionAPI;

    registerExtension(fakePi, {
      sessionRoot: this.sessionRoot,
      openBrowser: (url: string) => {
        upstreamPanelUrl = url;
      },
    });

    if (!commandHandler) throw new Error("Pi Session Viewer 扩展未能注册启动命令。");
    let notifyError: string | undefined;
    await commandHandler("on", {
      cwd: this.sessionRoot,
      ui: {
        notify(message: string, level: string) {
          if (level === "error") notifyError = message;
        },
      },
    });
    if (notifyError || !upstreamPanelUrl) {
      throw new Error(notifyError ?? "Pi Session Viewer 服务启动失败。");
    }

    const upstream = new URL(upstreamPanelUrl);
    const token = new URLSearchParams(upstream.hash.replace(/^#/, "")).get("token") ?? "";
    if (!token) {
      await shutdownHandler?.();
      throw new Error("Pi Session Viewer 缺少访问令牌。");
    }

    const host = "127.0.0.1";
    const proxyServer = createServer((req, res) => {
      forwardToUpstream(req, res, upstream, () => this.targetSessionId);
    });
    try {
      const port = await listen(proxyServer, host);
      const running: RunningViewer = {
        host,
        port,
        token,
        close: async () => {
          await Promise.allSettled([closeServer(proxyServer), shutdownHandler?.()]);
        },
      };
      this.running = running;
      return running;
    } catch (error) {
      await shutdownHandler?.();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const active = this.running ?? (await this.starting?.catch(() => undefined));
    this.running = undefined;
    if (active) await active.close();
  }
}
