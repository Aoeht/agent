// src/mcp/adapter.ts
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ToolRegistry } from "../core/registry";
import { ToolDefinition, ToolRuntime } from "../core/types";
import {
  Confirmer,
  McpAdapterOptions,
  SyncToolsOptions,
  ToolAnnotationsLite,
  McpAuditHandler,
  McpProgressHandler,
  ToolContentBlock,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMiddleware,
  ToolPolicy,
} from "./types";

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** OpenAI function name 只允许 [a-zA-Z0-9_-]，且最长 64 字符 */
const INVALID_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const DEFAULT_PROTECTED_PATH_NAMES = [".env", ".git", ".npmrc", ".ssh"];

/** annotations → 写进描述的短标记，让模型自己在选型时权衡副作用 */
const HINT_LABELS: Record<keyof Omit<ToolAnnotationsLite, "title">, string> = {
  readOnlyHint: "read-only",
  destructiveHint: "destructive",
  idempotentHint: "idempotent",
  openWorldHint: "open-world",
};

/** 常见承载路径的参数名；MCP 生态里命名并不统一，尽量覆盖 */
const PATH_LIKE_KEYS = [
  "path",
  "paths",
  "filepath",
  "file_path",
  "filePath",
  "targetPath",
  "destination",
  "filename",
  "file_name",
  "directory",
  "dir",
];

export class McpAdapter {
  private middlewares: ToolMiddleware[] = [];
  private allowedRoots: string[];
  /** MCP 工具注册的目标注册表；缺省内部新建，可注入实例与宿主 agent 共用工具集 */
  readonly registry: ToolRegistry;
  private requestTimeoutMs: number;
  private maxResultChars: number;
  private parseJsonText: boolean;
  private annotateDescription: boolean;
  private policy: ToolPolicy;
  private confirmer: Confirmer | undefined;
  private protectedPathNames: string[];
  private onProgress: McpProgressHandler | undefined;
  private onAudit: McpAuditHandler | undefined;

  /** serverId -> (注册名 -> 定义)，用于差量热更新与整台下线 */
  private byServer = new Map<string, Map<string, ToolDefinition>>();

  constructor(options: McpAdapterOptions = {}) {
    this.allowedRoots = (options.allowedRoots ?? []).map((root) => path.resolve(root));
    this.registry = options.registry ?? new ToolRegistry();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.maxResultChars = options.maxResultChars ?? 20_000;
    this.parseJsonText = options.parseJsonText ?? true;
    this.annotateDescription = options.annotateDescription ?? true;
    this.policy = options.toolPolicy ?? (() => "allow");
    this.confirmer = options.confirmer;
    this.protectedPathNames = options.protectedPathNames ?? DEFAULT_PROTECTED_PATH_NAMES;
    this.onProgress = options.onProgress;
    this.onAudit = options.onAudit;

    // 审计包住整条链，确保策略拒绝和守卫错误也能被记录。
    if (this.onAudit) this.use(this.createAuditMiddleware(this.onAudit));
    // 准入策略先跑（只看 annotations，开销低），路径守卫作为兜底
    this.use(this.createPolicyMiddleware());
    this.use(McpAdapter.createPathGuard(this.allowedRoots, this.protectedPathNames));
    for (const middleware of options.middlewares ?? []) this.use(middleware);

    if (this.allowedRoots.length === 0) {
      console.warn("[MCP] allowedRoots 为空，路径遍历守卫已关闭；挂载文件系统类 Server 前请显式配置白名单。");
    }
  }

  use(middleware: ToolMiddleware): void {
    this.middlewares.push(middleware);
  }

  /** 准入中间件：把 Server 声明的意图交给策略函数裁决 */
  private createPolicyMiddleware(): ToolMiddleware {
    return async (args, context, next) => {
      const action = await this.policy({
        serverId: context.serverId,
        toolName: context.toolName,
        registeredName: context.registeredName,
        annotations: McpAdapter.effectiveAnnotations(context.annotations),
        declared: context.annotations !== undefined,
        args,
      });

      if (action === "deny") {
        throw new Error(`Policy Denied [${context.registeredName}]: 该工具被准入策略拒绝执行`);
      }

      if (action === "ask") {
        if (!this.confirmer) {
          throw new Error(
            `Policy Denied [${context.registeredName}]: 策略要求人工确认，但未配置 confirmer`
          );
        }
        const decision = await this.confirmer({
          serverId: context.serverId,
          message: `是否允许调用工具 "${context.registeredName}"（来自 ${context.serverId}）？\n参数: ${JSON.stringify(
            McpAdapter.summarizeArgs(args)
          )}`,
        });
        if (decision.action !== "accept") {
          throw new Error(
            `Policy Denied [${context.registeredName}]: 人工${decision.action === "cancel" ? "取消" : "拒绝"}了该工具调用`
          );
        }
      }

      return next();
    };
  }

  private createAuditMiddleware(onAudit: McpAuditHandler): ToolMiddleware {
    return async (args, context, next) => {
      const startedAt = Date.now();
      const base = {
        serverId: context.serverId,
        toolName: context.toolName,
        registeredName: context.registeredName,
        args: McpAdapter.summarizeArgs(args),
      };
      onAudit({ phase: "started", ...base });

      try {
        const result = await next();
        onAudit({
          phase: "completed",
          ...base,
          durationMs: Date.now() - startedAt,
          resultChars: McpAdapter.resultCharCount(result),
        });
        return result;
      } catch (error) {
        onAudit({
          phase: error instanceof Error && error.message.startsWith("Policy Denied") ? "denied" : "failed",
          ...base,
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    };
  }

  private static effectiveAnnotations(annotations?: ToolAnnotationsLite): ToolAnnotationsLite {
    const effective: ToolAnnotationsLite = {
      readOnlyHint: annotations?.readOnlyHint ?? false,
      destructiveHint: annotations?.destructiveHint ?? true,
      idempotentHint: annotations?.idempotentHint ?? false,
      openWorldHint: annotations?.openWorldHint ?? true,
    };
    if (annotations?.title) effective.title = annotations.title;
    return effective;
  }

  private static summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, McpAdapter.summarizeValue(key, value)])
    );
  }

  private static summarizeValue(key: string, value: unknown, depth = 0): unknown {
    if (/(token|secret|password|authorization|credential|api[_-]?key)/i.test(key)) return "[redacted]";
    if (typeof value === "string") return `[string ${value.length} chars]`;
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) return `[array ${value.length} items]`;
    if (typeof value !== "object" || value === null || depth >= 1) return `[${typeof value}]`;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        McpAdapter.summarizeValue(childKey, childValue, depth + 1),
      ])
    );
  }

  private static resultCharCount(result: ToolExecutionResult): number {
    if (result.structured !== undefined) return JSON.stringify(result.structured)?.length ?? 0;
    return result.content.reduce((total, block) => {
      if (block.type === "text") return total + block.text.length;
      if (block.type === "image") return total + block.data.length;
      return total + (JSON.stringify(block.resource)?.length ?? 0);
    }, 0);
  }

  /** annotations 摘要，用于拼进工具描述 */
  private static hintTags(annotations?: ToolAnnotationsLite): string[] {
    if (!annotations) return [];
    const tags: string[] = [];
    for (const key of Object.keys(HINT_LABELS) as (keyof typeof HINT_LABELS)[]) {
      if (annotations[key] === true) tags.push(HINT_LABELS[key]);
    }
    return tags;
  }

  /** 仅明确标注只读、且未标破坏性的工具才允许并发执行 */
  private static isParallelSafe(annotations?: ToolAnnotationsLite): boolean {
    return annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
  }

  /**
   * 路径守卫：把参数里的路径解析成绝对路径后校验是否落在白名单内。
   * 相对路径按第一个白名单根目录解析（与 filesystem server 的行为一致），
   * 这样 Windows 的 "C:\..." 与 POSIX 的 "/..." 都能被正确拦截。
   */
  private static createPathGuard(allowedRoots: string[], protectedPathNames: string[]): ToolMiddleware {
    return async (args, _context, next) => {
      if (allowedRoots.length === 0) return next();

      for (const key of PATH_LIKE_KEYS) {
        const values = Array.isArray(args[key]) ? args[key] : [args[key]];
        for (const value of values) {
          if (typeof value !== "string" || value.length === 0) continue;
          // 形如 URL 的字段（http://host/path）不是文件系统路径，跳过以免误杀
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;

          const resolved = path.isAbsolute(value)
            ? path.resolve(value)
            : path.resolve(allowedRoots[0]!, value);

          McpAdapter.assertResolvedPathAllowed(resolved, value, allowedRoots, protectedPathNames);
        }
      }
      return next();
    };
  }

  /** 守卫核心：受保护路径黑名单 + 白名单包含性检查，两处调用共享同一份判断 */
  private static assertResolvedPathAllowed(
    resolved: string,
    displayValue: string,
    allowedRoots: string[],
    protectedPathNames: string[]
  ): void {
    if (McpAdapter.isProtectedPath(resolved, protectedPathNames)) {
      throw new Error(`Security Exception: 路径 "${displayValue}" 指向受保护文件或目录`);
    }

    const inside = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!inside) {
      throw new Error(
        `Security Exception: 路径 "${displayValue}" 超出允许的工作区范围（${allowedRoots.join(", ")}）`
      );
    }
  }

  /**
   * resources/read 的路径守卫：与工具调用的参数守卫共用同一套白名单/黑名单，
   * 只是入口是 URI 而不是散落的参数。非 file:// 的 URI（http(s)/自定义 scheme）
   * 不属于本地文件系统范畴，无法用路径守卫拦截，交由上层按 open-world 风险自行判断。
   */
  checkResourceUri(uri: string): void {
    if (this.allowedRoots.length === 0) return;

    let filePath: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:") return;
      // fileURLToPath 才能正确处理 Windows 盘符（"/A:/..." 手剥前导斜杠会得到无效路径）
      filePath = fileURLToPath(parsed);
    } catch {
      // 不是合法 URI（有些 Server 直接给相对路径），按第一个白名单根解析
      filePath = path.resolve(this.allowedRoots[0]!, uri);
    }

    const resolved = path.resolve(filePath);
    McpAdapter.assertResolvedPathAllowed(resolved, uri, this.allowedRoots, this.protectedPathNames);
  }

  private static isProtectedPath(resolved: string, protectedPathNames: string[]): boolean {
    const segments = resolved.split(/[\\/]+/).filter(Boolean);
    return segments.some((segment) =>
      protectedPathNames.some((name) => segment === name || (name === ".env" && segment.startsWith(".env.")))
    );
  }

  /** 命名空间隔离 + 合法化：github__create_issue / filesystem__read_file */
  private namespacedName(serverId: string, toolName: string): string {
    const full = `${serverId}__${toolName}`.replace(INVALID_NAME_CHARS, "_");
    if (full.length <= MAX_TOOL_NAME_LENGTH) return full;

    const digest = createHash("sha1").update(`${serverId}/${toolName}`).digest("hex").slice(0, 8);
    return `${full.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${digest}`;
  }

  /** listTools 是分页接口，不翻页会漏注册工具 */
  private async listAllTools(client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    return tools;
  }

  /**
   * 拉取 Server 的工具列表并与本地注册表做差量同步：
   * 新增的注册、消失的卸载、同名的覆盖。
   * 相比"先全量卸载再注册"，中途失败不会让整台 Server 的工具集体消失。
   */
  async syncTools(client: Client, serverId: string, options: SyncToolsOptions = {}): Promise<string[]> {
    const listed = await this.listAllTools(client);
    const current = this.byServer.get(serverId) ?? new Map<string, ToolDefinition>();

    const desired = new Map<string, McpTool>();
    for (const tool of listed) {
      if (options.allowedTools && !options.allowedTools.includes(tool.name)) continue;
      desired.set(this.namespacedName(serverId, tool.name), tool);
    }

    for (const name of [...current.keys()]) {
      if (desired.has(name)) continue;
      this.registry.unregister(name);
      current.delete(name);
      console.log(`[MCP] Tool unregistered: ${name}`);
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? this.requestTimeoutMs;
    for (const [name, tool] of desired) {
      const isUpdate = current.has(name);
      const definition = this.buildDefinition(client, serverId, tool, name, requestTimeoutMs);
      this.registry.register(definition, { replace: true });
      current.set(name, definition);
      console.log(`[MCP] Tool ${isUpdate ? "updated" : "registered"}: ${name}`);
    }

    this.byServer.set(serverId, current);
    return [...desired.keys()];
  }

  /** 整台 Server 下线时清理其全部工具 */
  unregisterServer(serverId: string): void {
    const current = this.byServer.get(serverId);
    if (!current) return;
    for (const name of current.keys()) this.registry.unregister(name);
    this.byServer.delete(serverId);
  }

  private buildDefinition(
    client: Client,
    serverId: string,
    tool: McpTool,
    name: string,
    requestTimeoutMs: number
  ): ToolDefinition {
    const annotations = this.normalizeAnnotations(tool.annotations);
    const tags = McpAdapter.hintTags(annotations);
    const readable = `${tool.description?.trim() || tool.name}${
      this.annotateDescription && tags.length > 0 ? ` (${tags.join(", ")})` : ""
    }`;

    return {
      name,
      description: `[MCP ${serverId}] ${readable}`.slice(0, MAX_DESCRIPTION_LENGTH),
      parameters: tool.inputSchema as Record<string, unknown>,
      parallelSafe: McpAdapter.isParallelSafe(annotations),

      execute: async (args: unknown, runtime?: ToolRuntime) => {
        const rawArgs = (args ?? {}) as Record<string, unknown>;
        const context: ToolExecutionContext = {
          serverId,
          toolName: tool.name,
          registeredName: name,
          ...(annotations ? { annotations } : {}),
          ...(runtime?.signal ? { signal: runtime.signal } : {}),
        };

        const result = await this.runMiddlewares(context, rawArgs, async () => {
          const requestOptions: RequestOptions = {
            timeout: requestTimeoutMs,
            // 长任务只要还在上报进度就续期，但总时长仍受 timeout 约束
            resetTimeoutOnProgress: true,
          };
          if (context.signal) requestOptions.signal = context.signal;
          if (this.onProgress) {
            requestOptions.onprogress = (progress) => {
              this.onProgress?.({
                serverId,
                toolName: tool.name,
                registeredName: name,
                progress: progress.progress,
                ...(progress.total !== undefined ? { total: progress.total } : {}),
                ...(progress.message !== undefined ? { message: progress.message } : {}),
              });
            };
          }

          const response = await client.callTool(
            { name: tool.name, arguments: rawArgs },
            undefined, // 使用 SDK 默认的 CallToolResultSchema
            requestOptions
          );

          const content = this.parseContentBlocks(response.content);
          if (response.isError) {
            throw new Error(`MCP Tool Error [${name}]: ${this.textOf(content) || "server returned an error"}`);
          }

          const structured = (response as { structuredContent?: unknown }).structuredContent;
          const isStructured = typeof structured === "object" && structured !== null;

          return {
            isError: false,
            content,
            ...(isStructured ? { structured } : {}),
            raw: response,
          };
        });

        return this.formatForLlm(result);
      },
    };
  }

  /**
   * Server 的 annotations 是可选且松散的（老服务可能整体缺失或只给一两个字段），
   * 逐字段归一化比直接断言更稳。
   */
  private normalizeAnnotations(raw: unknown): ToolAnnotationsLite | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const source = raw as Record<string, unknown>;
    const normalized: ToolAnnotationsLite = {};

    if (typeof source.title === "string") normalized.title = source.title;
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      if (typeof source[key] === "boolean") normalized[key] = source[key];
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  /** 快照中间件链，避免执行过程中 use() 造成的行为漂移 */
  private async runMiddlewares(
    context: ToolExecutionContext,
    args: Record<string, unknown>,
    invoke: () => Promise<ToolExecutionResult>
  ): Promise<ToolExecutionResult> {
    const chain = [...this.middlewares].reduceRight<() => Promise<ToolExecutionResult>>(
      (next, middleware) => () => middleware(args, context, next),
      invoke
    );
    return chain();
  }

  private parseContentBlocks(content: unknown): ToolContentBlock[] {
    if (!Array.isArray(content)) return [];

    const blocks: ToolContentBlock[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;

      if (item.type === "text" && typeof item.text === "string") {
        blocks.push({ type: "text", text: item.text });
      } else if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
      } else if (item.type === "resource" && "resource" in item) {
        blocks.push({ type: "resource", resource: item.resource });
      }
    }
    return blocks;
  }

  /**
   * tool 角色的消息只能是字符串，多模态块直接塞进去会把 base64 灌进上下文，
   * 所以这里统一压平成文本：图片/二进制资源只保留元信息。
   * structuredContent 是 Server 显式声明过的类型化结果，优先于文本猜测。
   */
  private formatForLlm(result: ToolExecutionResult): unknown {
    if (result.structured !== undefined) return this.formatStructured(result.structured);

    const blocks = result.content;
    if (blocks.length === 0) return "";

    const texts = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text");

    if (texts.length === blocks.length) {
      const joined = texts.map((b) => b.text).join("\n");
      if (this.parseJsonText) {
        const trimmed = joined.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            return JSON.parse(trimmed);
          } catch {
            // 不是合法 JSON，按纯文本返回
          }
        }
      }
      return this.truncate(joined);
    }

    const flattened = blocks
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "image":
            return `[image ${block.mimeType}, base64 已省略, ${block.data.length} chars]`;
          case "resource":
            return this.describeResource(block.resource);
        }
      })
      .join("\n");

    return this.truncate(flattened);
  }

  private describeResource(resource: unknown): string {
    if (typeof resource !== "object" || resource === null) return "[resource]";
    const { uri, mimeType, text } = resource as { uri?: string; mimeType?: string; text?: string };
    if (typeof text === "string") return text;
    const suffix = mimeType ? ` (${mimeType})` : "";
    return `[resource ${uri ?? "unknown"}${suffix}]`;
  }

  /** 结构化结果原样交给上层序列化；只有超长时才退化成截断文本 */
  private formatStructured(value: unknown): unknown {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    return text.length <= this.maxResultChars ? value : this.truncate(text);
  }

  private truncate(text: string): string {
    if (text.length <= this.maxResultChars) return text;
    return `${text.slice(0, this.maxResultChars)}\n...[truncated ${text.length - this.maxResultChars} chars]`;
  }

  private textOf(blocks: ToolContentBlock[]): string {
    return blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
}
