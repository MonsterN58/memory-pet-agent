import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComputerContextAction, SharedComputerContext } from "../../common/types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 32145;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_COMMAND_RESULT_BYTES = 4 * 1024;
const MAX_FIND_TEXT_LENGTH = 200;
const MAX_RESULT_MESSAGE_LENGTH = 500;
const DEFAULT_COMMAND_TTL_MS = 45_000;
const DEFAULT_MAX_PENDING_COMMANDS = 8;
const MAX_LONG_POLL_MS = 20_000;
const MAX_POLL_WAITERS = 2;
const ACTIONS = new Set<ComputerContextAction>(["explain", "summarize", "chat", "remember"]);
const BROWSER_COMMAND_ACTIONS = new Set<BrowserCommandAction>([
  "reload",
  "go-back",
  "go-forward",
  "scroll-up",
  "scroll-down",
  "scroll-top",
  "scroll-bottom",
  "find-text",
]);

export type BrowserCommandAction =
  | "reload"
  | "go-back"
  | "go-forward"
  | "scroll-up"
  | "scroll-down"
  | "scroll-top"
  | "scroll-bottom"
  | "find-text";

export interface BrowserCommandRequest {
  action: BrowserCommandAction;
  text?: string;
}

export interface BrowserCommandResult {
  id: string;
  action: BrowserCommandAction;
  ok: boolean;
  message: string;
  completedAt: string;
}

interface BrowserCommandEnvelope extends BrowserCommandRequest {
  id: string;
  expiresAt: number;
}

interface PendingBrowserCommand {
  command: BrowserCommandEnvelope;
  state: "queued" | "delivered";
  resolve(result: BrowserCommandResult): void;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface CommandPollWaiter {
  resolve(command: BrowserCommandEnvelope | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserContextServerStatus {
  running: boolean;
  endpoint: string;
  message: string;
}

export interface BrowserContextServerOptions {
  host?: string;
  port?: number;
  commandTtlMs?: number;
  maxPendingCommands?: number;
  getPairingToken(): string;
  onContext(context: SharedComputerContext): Promise<void> | void;
  onError?(error: unknown): void;
}

export class BrowserContextServer {
  private server?: Server;
  private startTask?: Promise<BrowserContextServerStatus>;
  private stopTask?: Promise<void>;
  private readonly pendingCommands = new Map<string, PendingBrowserCommand>();
  private readonly commandQueue: string[] = [];
  private readonly pollWaiters = new Set<CommandPollWaiter>();
  private statusValue: BrowserContextServerStatus = {
    running: false,
    endpoint: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    message: "浏览器桥接未启动",
  };

  constructor(private readonly options: BrowserContextServerOptions) {}

  status(): BrowserContextServerStatus {
    return { ...this.statusValue };
  }

  enqueueCommand(value: BrowserCommandRequest): Promise<BrowserCommandResult> {
    const request = sanitizeBrowserCommand(value);
    const id = randomUUID();
    if (!this.server?.listening) {
      return Promise.resolve(this.commandResult(id, request.action, false, "浏览器桥接未运行"));
    }
    this.expireStaleCommands();
    const maxPending = clampInteger(this.options.maxPendingCommands, 1, 32, DEFAULT_MAX_PENDING_COMMANDS);
    if (this.pendingCommands.size >= maxPending) {
      return Promise.resolve(this.commandResult(id, request.action, false, "待执行的浏览器操作过多，请稍后再试"));
    }
    const ttlMs = clampInteger(this.options.commandTtlMs, 100, 120_000, DEFAULT_COMMAND_TTL_MS);
    const command: BrowserCommandEnvelope = {
      id,
      action: request.action,
      ...(request.text ? { text: request.text } : {}),
      expiresAt: Date.now() + ttlMs,
    };
    return new Promise<BrowserCommandResult>((resolve) => {
      const expiryTimer = setTimeout(() => {
        this.finishCommand(id, false, "浏览器扩展未及时领取或完成操作");
      }, ttlMs);
      this.pendingCommands.set(id, { command, state: "queued", resolve, expiryTimer });
      this.commandQueue.push(id);
      this.dispatchQueuedCommand();
    });
  }

  async start(): Promise<BrowserContextServerStatus> {
    if (this.stopTask) await this.stopTask;
    if (this.server?.listening) return this.status();
    if (this.startTask) return this.startTask;
    const task = this.startOnce();
    this.startTask = task;
    try {
      return await task;
    } finally {
      if (this.startTask === task) this.startTask = undefined;
    }
  }

  private async startOnce(): Promise<BrowserContextServerStatus> {
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
        this.finishAllCommands("浏览器桥接运行中断");
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
    if (this.stopTask) return this.stopTask;
    const task = this.stopOnce();
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = undefined;
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.startTask) await this.startTask;
    const server = this.server;
    this.server = undefined;
    this.releasePollWaiters();
    this.finishAllCommands("浏览器桥接已停止");
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
    const requestUrl = parseRequestUrl(request.url);
    if (!requestUrl) {
      json(response, 400, { error: "请求地址无效" });
      return;
    }
    const origin = request.headers.origin;
    const isCommandRoute = requestUrl.pathname.startsWith("/v1/commands/");
    if ((isCommandRoute && !allowedExtensionOrigin(origin)) || (!isCommandRoute && !allowedOrigin(origin))) {
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
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      json(response, 200, { ok: true, service: "memory-pet-agent", version: 2 });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/commands/poll") {
      try {
        const waitMs = parsePollWaitMs(requestUrl.searchParams.get("waitMs"));
        const command = await this.pollForCommand(waitMs, response);
        if (!command) {
          if (response.destroyed) return;
          response.writeHead(204);
          response.end();
          return;
        }
        if (response.destroyed) {
          this.requeueCommand(command.id);
          return;
        }
        response.once("close", () => {
          if (!response.writableFinished) this.requeueCommand(command.id);
        });
        try {
          json(response, 200, { command });
        } catch (error) {
          this.requeueCommand(command.id);
          throw error;
        }
      } catch (error) {
        const status = error instanceof TooManyPollersError ? 429 : 400;
        json(response, status, { error: error instanceof Error ? error.message : "轮询请求无效" });
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/commands/result") {
      try {
        const raw = await readJsonBody(request, MAX_COMMAND_RESULT_BYTES);
        const result = sanitizeBrowserCommandResult(raw);
        if (!this.acceptCommandResult(result)) {
          json(response, 409, { error: "操作不存在、尚未领取或结果已提交" });
          return;
        }
        json(response, 202, { accepted: true, id: result.id });
      } catch (error) {
        const status = error instanceof RequestTooLargeError ? 413 : 400;
        json(response, status, { error: error instanceof Error ? error.message : "操作结果格式无效" });
      }
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/v1/context") {
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

  private pollForCommand(
    waitMs: number,
    response: ServerResponse,
  ): Promise<BrowserCommandEnvelope | undefined> {
    const immediate = this.takeQueuedCommand();
    if (immediate || waitMs === 0) return Promise.resolve(immediate);
    if (this.pollWaiters.size >= MAX_POLL_WAITERS) throw new TooManyPollersError();
    return new Promise<BrowserCommandEnvelope | undefined>((resolve) => {
      let settled = false;
      let waiter: CommandPollWaiter;
      const finish = (command: BrowserCommandEnvelope | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.pollWaiters.delete(waiter);
        response.removeListener("close", onClose);
        resolve(command);
      };
      const onClose = (): void => {
        if (!response.writableFinished) finish(undefined);
      };
      waiter = { resolve: finish, timer: setTimeout(() => finish(undefined), waitMs) };
      response.once("close", onClose);
      this.pollWaiters.add(waiter);
    });
  }

  private dispatchQueuedCommand(): void {
    const waiter = this.pollWaiters.values().next().value as CommandPollWaiter | undefined;
    if (!waiter) return;
    const command = this.takeQueuedCommand();
    if (!command) return;
    waiter.resolve(command);
  }

  private takeQueuedCommand(): BrowserCommandEnvelope | undefined {
    this.expireStaleCommands();
    while (this.commandQueue.length > 0) {
      const id = this.commandQueue.shift();
      if (!id) continue;
      const pending = this.pendingCommands.get(id);
      if (!pending || pending.state !== "queued") continue;
      pending.state = "delivered";
      return { ...pending.command };
    }
    return undefined;
  }

  private acceptCommandResult(result: { id: string; ok: boolean; message: string }): boolean {
    const pending = this.pendingCommands.get(result.id);
    if (!pending || pending.state !== "delivered") return false;
    this.finishCommand(result.id, result.ok, result.message);
    return true;
  }

  private requeueCommand(id: string): void {
    const pending = this.pendingCommands.get(id);
    if (!pending || pending.state !== "delivered") return;
    pending.state = "queued";
    this.commandQueue.unshift(id);
    this.dispatchQueuedCommand();
  }

  private finishCommand(id: string, ok: boolean, message: string): void {
    const pending = this.pendingCommands.get(id);
    if (!pending) return;
    this.pendingCommands.delete(id);
    clearTimeout(pending.expiryTimer);
    pending.resolve(this.commandResult(id, pending.command.action, ok, message));
  }

  private commandResult(
    id: string,
    action: BrowserCommandAction,
    ok: boolean,
    message: string,
  ): BrowserCommandResult {
    return {
      id,
      action,
      ok,
      message: message.slice(0, MAX_RESULT_MESSAGE_LENGTH),
      completedAt: new Date().toISOString(),
    };
  }

  private expireStaleCommands(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingCommands) {
      if (pending.command.expiresAt <= now) this.finishCommand(id, false, "浏览器操作已过期");
    }
  }

  private finishAllCommands(message: string): void {
    for (const id of [...this.pendingCommands.keys()]) this.finishCommand(id, false, message);
    this.commandQueue.splice(0);
  }

  private releasePollWaiters(): void {
    for (const waiter of [...this.pollWaiters]) waiter.resolve(undefined);
  }
}

export function sanitizeBrowserCommand(value: unknown): BrowserCommandRequest {
  if (!value || typeof value !== "object") throw new Error("浏览器操作格式无效");
  const input = value as Record<string, unknown>;
  if (typeof input.action !== "string" || !BROWSER_COMMAND_ACTIONS.has(input.action as BrowserCommandAction)) {
    throw new Error("未知的浏览器操作");
  }
  const action = input.action as BrowserCommandAction;
  if (action !== "find-text") return { action };
  if (typeof input.text !== "string") throw new Error("查找内容必须是文本");
  const text = input.text.replace(/\u0000/g, "").trim();
  if (!text) throw new Error("查找内容为空");
  if (text.length > MAX_FIND_TEXT_LENGTH) throw new Error("查找内容超过长度限制");
  return { action, text };
}

function sanitizeBrowserCommandResult(value: unknown): { id: string; ok: boolean; message: string } {
  if (!value || typeof value !== "object") throw new Error("操作结果格式无效");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !isUuid(input.id)) throw new Error("操作编号无效");
  if (typeof input.ok !== "boolean") throw new Error("操作状态无效");
  if (input.message !== undefined && typeof input.message !== "string") throw new Error("操作结果说明无效");
  const message = typeof input.message === "string" ? input.message.replace(/\u0000/g, "").trim() : "";
  if (message.length > MAX_RESULT_MESSAGE_LENGTH) throw new Error("操作结果说明超过长度限制");
  return {
    id: input.id,
    ok: input.ok,
    message: message || (input.ok ? "浏览器操作已完成" : "浏览器操作执行失败"),
  };
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
  return allowedExtensionOrigin(origin);
}

function allowedExtensionOrigin(origin: string | undefined): origin is string {
  return typeof origin === "string" && /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
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

function parseRequestUrl(value: string | undefined): URL | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    return new URL(value, `http://${DEFAULT_HOST}`);
  } catch {
    return undefined;
  }
}

function parsePollWaitMs(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d{1,5}$/.test(value)) throw new Error("轮询等待时间无效");
  const waitMs = Number(value);
  if (waitMs > MAX_LONG_POLL_MS) throw new Error("轮询等待时间超过限制");
  return waitMs;
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value as number)) : fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readJsonBody(request: IncomingMessage, maximumBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > maximumBytes) throw new RequestTooLargeError(maximumBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) throw new RequestTooLargeError(maximumBytes);
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
  constructor(maximumBytes: number) {
    super(`请求内容超过 ${maximumBytes} 字节限制`);
  }
}

class TooManyPollersError extends Error {
  constructor() {
    super("已有浏览器扩展正在等待操作");
  }
}
