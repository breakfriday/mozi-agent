import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { DeviceLinkHttpService } from "./http.service";
import { createOutgoingTextItem, normalizeWsPath } from "./protocol";
import {
  DEFAULT_DEVICE_LINK_CONFIG,
  type DeviceLinkClientInfo,
  type DeviceLinkConfig,
  type DeviceLinkHandlers,
  type DeviceLinkStatus,
  type DeviceLinkTextItem,
} from "./types";
import { DeviceLinkWsService } from "./ws.service";

export function listLanIpv4Addresses(): string[] {
  const nets = networkInterfaces();
  const addresses = new Set<string>();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        addresses.add(entry.address);
      }
    }
  }
  return Array.from(addresses);
}

function listenServer(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export class DeviceLinkService {
  private config: Required<DeviceLinkConfig>;
  private readonly wsService: DeviceLinkWsService;
  private readonly httpService: DeviceLinkHttpService;
  private server?: Server;
  private boundPort = 0;
  private starting?: Promise<DeviceLinkStatus>;
  private stopping?: Promise<void>;
  private history: DeviceLinkTextItem[] = [];
  private seenIds = new Set<string>();

  constructor(
    initialConfig: DeviceLinkConfig = {},
    private readonly handlers: DeviceLinkHandlers = {},
  ) {
    this.config = {
      ...DEFAULT_DEVICE_LINK_CONFIG,
      ...initialConfig,
      path: normalizeWsPath(initialConfig.path ?? DEFAULT_DEVICE_LINK_CONFIG.path),
    };

    this.wsService = new DeviceLinkWsService(
      {
        path: this.config.path,
        maxTextBytes: this.config.maxTextBytes,
        maxPayloadBytes: this.config.maxPayloadBytes,
        heartbeatMs: this.config.heartbeatMs,
      },
      {
        onTextFrame: (item, client) => this.acceptIncomingText(item, client),
        onBinaryFrame: (chunk, client) => this.handlers.onAudioFrame?.(chunk, client),
        onClientConnected: (client) => this.handlers.onClientConnected?.(client),
        onClientDisconnected: (client, code) => this.handlers.onClientDisconnected?.(client, code),
        onDiagnostic: (diag) => this.handlers.onDiagnostic?.(diag),
      },
    );

    this.httpService = new DeviceLinkHttpService(
      { maxTextBytes: this.config.maxTextBytes },
      {
        onShareText: (item) => this.acceptIncomingText(item),
      },
    );
  }

  async start(overrideConfig?: DeviceLinkConfig): Promise<DeviceLinkStatus> {
    if (this.stopping) {
      await this.stopping;
    }
    if (this.server?.listening && !overrideConfig) {
      return this.getStatus();
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.server?.listening && overrideConfig) {
      await this.stop();
    }

    if (overrideConfig) {
      this.config = {
        ...this.config,
        ...overrideConfig,
        path: normalizeWsPath(overrideConfig.path ?? this.config.path),
      };
      this.wsService.configure({
        path: this.config.path,
        maxTextBytes: this.config.maxTextBytes,
        heartbeatMs: this.config.heartbeatMs,
      });
      this.httpService.configure({ maxTextBytes: this.config.maxTextBytes });
    }

    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<DeviceLinkStatus> {
    const httpServer = createServer((req, res) => {
      this.httpService.handleRequest(req, res);
    });

    httpServer.on("upgrade", (req, socket, head) => {
      this.wsService.handleUpgrade(req, socket, head);
    });

    const port = await listenServer(httpServer, this.config.port, this.config.host);
    this.server = httpServer;
    this.boundPort = port;
    this.wsService.startHeartbeat();

    this.handlers.onDiagnostic?.({
      level: "info",
      name: "device_link.started",
      detail: { host: this.config.host, port, path: this.config.path },
    });

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    const activeServer = this.server;
    if (!activeServer) return;

    this.stopping = (async () => {
      this.server = undefined;
      this.boundPort = 0;
      this.wsService.closeAll();
      await closeHttpServer(activeServer);
      this.handlers.onDiagnostic?.({
        level: "info",
        name: "device_link.stopped",
      });
    })().finally(() => {
      this.stopping = undefined;
    });

    return this.stopping;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.clearHistory();
  }

  getStatus(): DeviceLinkStatus {
    const running = Boolean(this.server?.listening);
    const activePort = running ? this.boundPort : this.config.port;
    const lanAddresses = listLanIpv4Addresses();
    const endpointHosts =
      this.config.host === "0.0.0.0" || this.config.host === "::"
        ? lanAddresses.length > 0
          ? lanAddresses
          : ["127.0.0.1"]
        : [this.config.host];
    const wsEndpoints = running
      ? endpointHosts.map((ip) => `ws://${ip}:${activePort}${this.config.path}`)
      : [];

    return {
      running,
      host: this.config.host,
      port: activePort,
      path: this.config.path,
      lanAddresses,
      wsEndpoints,
      connectedClients: this.wsService.getClients(),
      historyCount: this.history.length,
    };
  }

  getHistory(): DeviceLinkTextItem[] {
    return this.history.slice();
  }

  clearHistory(): void {
    this.history = [];
    this.seenIds.clear();
  }

  sendText(rawText: string): { item: DeviceLinkTextItem; deliveredCount: number } {
    const item = createOutgoingTextItem(rawText, { maxBytes: this.config.maxTextBytes });
    this.recordItem(item);
    const deliveredCount = this.wsService.broadcastText(item);
    return { item, deliveredCount };
  }

  sendTextToClient(clientId: string, rawText: string): { item: DeviceLinkTextItem; delivered: boolean } {
    const item = createOutgoingTextItem(rawText, { maxBytes: this.config.maxTextBytes });
    const delivered = this.wsService.sendTextToClient(clientId, item);
    if (delivered) {
      this.recordItem(item);
    }
    return { item, delivered };
  }

  private acceptIncomingText(item: DeviceLinkTextItem, client?: DeviceLinkClientInfo): void {
    if (this.seenIds.has(item.id)) {
      return;
    }
    this.recordItem(item);
    this.handlers.onTextMessage?.(item, client);

    if (this.config.relayBetweenClients) {
      this.wsService.broadcastText(item, client?.clientId);
    }
  }

  private recordItem(item: DeviceLinkTextItem): void {
    this.seenIds.add(item.id);
    this.history.unshift(item);
    if (this.history.length > this.config.historyLimit) {
      const removed = this.history.splice(this.config.historyLimit);
      for (const old of removed) {
        this.seenIds.delete(old.id);
      }
    }
  }
}
