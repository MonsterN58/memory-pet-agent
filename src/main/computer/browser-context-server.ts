import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComputerContextAction, SharedComputerContext } from "../../common/types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 32145;
const MAX_REQUEST_BYTES = 64 * 1024;
const ACTIONS = new Set<ComputerContextAction>(["explain", "summarize", "chat", "remember"]);

export interface BrowserContextServerStatus {
  running: boolean;
  endpoint: string;
  message: string;
}

export interface BrowserContextServerOptions {
  host?: string;
  port?: number;
  getPairingToken(): string;
  onContext(context: SharedComputerContext): Promise<void> | void;
  onError?(error: unknown): void;
}

export class BrowserContextServer {
  private server?: Server;
  private statusValue: BrowserContextServerStatus = {
    running: false,
    endpoint: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    message: "浏览器桥接未启动",
  };

  constructor(private readonly options: BrowserContextServerOptions) {}

  status(): BrowserContextServerStatus {
    return { ...this.statusValue };
  }

  async start(): Promise<BrowserContextServerStatus> {
    if (this.server?.listening) return this.status();
    const host = this.options.host ?? DEFAULT_HOST;
    const port = this.options.port ?? DEFAULT_PORT;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      this.statusValue = {
        running: true,
        endpoint: `http://${host}:${address.port}`,
        message: "浏览器桥接仅监听本机回环地址",
      };
      server.on("error", (error) => {
        this.statusValue = {
          ...this.statusValue,
          running: false,
          message: `浏览器桥接运行错误：${error.message}`,
        };
        this.options.onError?.(error);
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      this.statusValue = {
        running: false,
        endpoint: `http://${host}:${port}`,
        message: `浏览器桥接启动失败：${error instanceof Error ? error.message : "未知错误"}`,
      };
      this.options.onError?.(error);
    }
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.statusValue = {
      ...this.statusValue,
      running: false,
      message: "浏览器桥接未启动",
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (!allowedOrigin(origin)) {
      json(response, 403, { error: "来源未被允许" });
      return;
    }
    addCorsHeaders(response, origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!secureTokenEqual(request.headers["x-memory-pet-token"], this.options.getPairingToken())) {
      json(response, 401, { error: "配对令牌无效" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, service: "memory-pet-agent", version: 1 });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/context") {
      json(response, 404, { error: "未知接口" });
      return;
    }
    try {
      const raw = await readJsonBody(request);
      const context = sanitizeBrowserContext(raw);
      json(response, 202, { accepted: true, action: context.action });
      void Promise.resolve(this.options.onContext(context)).catch((error) => this.options.onError?.(error));
    } catch (error) {
      const status = error instanceof RequestTooLargeError ? 413 : 400;
      json(response, status, { error: error instanceof Error ? error.message : "请求格式无效" });
    }
  }
}

export function sanitizeBrowserContext(value: unknown): SharedComputerContext {
  if (!value || typeof value !== "object") throw new Error("上下文请求格式无效");
  const input = value as Record<string, unknown>;
  if (typeof input.action !== "string" || !ACTIONS.has(input.action as ComputerContextAction)) {
    throw new Error("未知的上下文操作");
  }
  if (typeof input.text !== "string") throw new Error("共享内容必须是文本");
  const text = input.text.replace(/\u0000/g, "").trim().slice(0, 12_000);
  if (!text) throw new Error("共享内容为空");
  const title = typeof input.title === "string" ? input.title.replace(/\u0000/g, "").trim().slice(0, 300) : "";
  const url = sanitizePageUrl(input.url);
  return {
    action: input.action as ComputerContextAction,
    source: "browser",
    text,
    title: title || undefined,
    url,
    capturedAt: new Date().toISOString(),
  };
}

function sanitizePageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim().slice(0, 2048));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function addCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Memory-Pet-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
}

function secureTokenEqual(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || !header || !expected) return false;
  const actualBytes = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求 JSON 格式无效");
  }
}

function json(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

class RequestTooLargeError extends Error {
  constructor() {
    super("共享内容超过大小限制");
  }
}
