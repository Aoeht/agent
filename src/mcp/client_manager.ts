// src/mcp/client_manager.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpAdapter } from "./adapter";
import {
  Confirmer,
  McpGetPromptResult,
  McpPromptInfo,
  McpPromptMessage,
  McpResourceContent,
  McpResourceInfo,
  McpResourceTemplateInfo,
  McpServerConfig,
  McpServerLogHandler,
  ServerStartReport,
  ServerStatus,
  SyncToolsOptions,
  ToolContentBlock,
} from "./types";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

interface ServerInstance {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  toolNames: string[];
  connected: boolean;
  supportsResources: boolean;
  supportsResourceSubscribe: boolean;
  supportsPrompts: boolean;
}

export class McpClientManager {
  private servers = new Map<string, ServerInstance>();
  private adapter: McpAdapter;
  private onServerLog: McpServerLogHandler | undefined;
  private confirmer: Confirmer | undefined;

  constructor(adapter?: McpAdapter, onServerLog?: McpServerLogHandler, confirmer?: Confirmer) {
    this.adapter = adapter ?? new McpAdapter();
    this.onServerLog = onServerLog;
    this.confirmer = confirmer;
  }

  /**
   * 按配置批量启动，单个 Server 失败不影响其余（例如未配置 GITHUB_TOKEN）。
   */
  async loadFromConfig(configs: McpServerConfig[]): Promise<ServerStartReport[]> {
    const reports: ServerStartReport[] = [];

    for (const config of configs) {
      if (config.enabled === false) {
        console.log(`[MCP] Skipped disabled server: ${config.id}`);
        continue;
      }
      try {
        const tools = await this.addServer(config);
        reports.push({ id: config.id, ok: true, tools });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MCP] Failed to start server "${config.id}": ${message}`);
        reports.push({ id: config.id, ok: false, error: message });
      }
    }

    return reports;
  }

  /** 启动并连接单个 MCP Server，返回注册成功的工具名 */
  async addServer(config: McpServerConfig): Promise<string[]> {
    if (this.servers.has(config.id)) {
      throw new Error(`MCP Server with id "${config.id}" already exists.`);
    }

    const transport = this.createTransport(config);
    const roots = (config.roots ?? []).map((root) => path.resolve(root));
    // 只声明自己真的实现了的能力，否则 Server 调用对应方法会得到 -32601
    const capabilities: { roots?: { listChanged: boolean }; elicitation?: { form: Record<string, never> } } = {};
    if (roots.length > 0) capabilities.roots = { listChanged: true };
    if (this.confirmer) capabilities.elicitation = { form: {} };
    const client = new Client({ name: "agent-host", version: "1.0.0" }, { capabilities });

    let toolNames: string[] = [];
    let supportsResources = false;
    let supportsResourceSubscribe = false;
    let supportsPrompts = false;
    try {
      // 必须在 connect 之前注册：Server 会在初始化完成后立刻拉取 roots
      if (roots.length > 0) {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: roots.map((root) => ({
            uri: pathToFileURL(root).href,
            name: path.basename(root),
          })),
        }));
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        this.onServerLog?.({
          serverId: config.id,
          level: notification.params.level,
          ...(notification.params.logger ? { logger: notification.params.logger } : {}),
          data: notification.params.data,
        });
      });

      // 必须在 connect 之前注册：声明了 elicitation 能力后 Server 可能随时发起 elicitation/create
      if (this.confirmer) {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          const params = request.params;
          if (params.mode === "url") {
            // 只声明了 form 能力，Server 理论上不会发 url 模式；稳妥起见直接拒绝
            return { action: "decline" };
          }
          const decision = await this.confirmer!({
            serverId: config.id,
            message: params.message,
            requestedSchema: params.requestedSchema,
          });
          return decision.content !== undefined
            ? { action: decision.action, content: decision.content }
            : { action: decision.action };
        });
      }

      await withTimeout(
        client.connect(transport),
        config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        `connect to MCP server "${config.id}"`
      );

      const serverCapabilities = client.getServerCapabilities() ?? {};

      if (config.loggingLevel && serverCapabilities.logging) {
        await client.setLoggingLevel(config.loggingLevel);
      }

      // 纯 prompts/resources 型 Server（比如本地预设模板服务）合法地不会声明 tools 能力，
      // 无条件 syncTools 会得到 -32601；能力是契约，先探测再挂载
      if (serverCapabilities.tools) {
        // 先挂通知处理器再首次 listTools，避免这中间的变更通知被丢掉
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          console.log(`[MCP] Tool list changed for server: ${config.id}, refreshing...`);
          return this.reloadServerTools(config.id).then(() => undefined);
        });
        toolNames = await this.adapter.syncTools(client, config.id, this.syncOptionsFor(config));
      } else {
        console.log(`[MCP] Server "${config.id}" 未声明 tools 能力，跳过工具同步`);
      }

      supportsResources = Boolean(serverCapabilities.resources);
      supportsResourceSubscribe = Boolean(serverCapabilities.resources?.subscribe);
      supportsPrompts = Boolean(serverCapabilities.prompts);

      // resources/prompts 列表变化只影响宿主自己挑选的可见性，不像 tools 需要同步进注册表，
      // 这里只打日志提示，实际读取时总是按需重新 list，避免缓存陈旧
      if (serverCapabilities.resources?.listChanged) {
        client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
          console.log(`[MCP] Resource list changed for server: ${config.id}（下次 listResources 会拿到最新结果）`);
        });
      }
      if (serverCapabilities.prompts?.listChanged) {
        client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
          console.log(`[MCP] Prompt list changed for server: ${config.id}（下次 listPrompts 会拿到最新结果）`);
        });
      }
    } catch (error) {
      // 失败时回收：子进程/长连接不能泄漏，半注册的工具也要清掉
      this.adapter.unregisterServer(config.id);
      await safeClose(transport);
      throw error;
    }

    const instance: ServerInstance = {
      config,
      client,
      transport,
      toolNames,
      connected: true,
      supportsResources,
      supportsResourceSubscribe,
      supportsPrompts,
    };
    this.servers.set(config.id, instance);

    // 子进程退出或 SSE 断开后，工具必须同步下线，否则 LLM 会调到死连接上
    client.onclose = () => {
      if (!instance.connected) return;
      instance.connected = false;
      instance.toolNames = [];
      this.adapter.unregisterServer(config.id);
      this.servers.delete(config.id);
      console.warn(`[MCP] Server disconnected: ${config.id}（工具已下线）`);
    };
    client.onerror = (error) => {
      console.error(`[MCP] Transport error on "${config.id}":`, error.message);
    };

    console.log(`[MCP] Server connected: ${config.id} (${config.transport}, ${toolNames.length} tools)`);
    return toolNames;
  }

  private createTransport(config: McpServerConfig): Transport {
    switch (config.transport) {
      case "stdio": {
        if (!config.command) throw new Error(`Missing 'command' for stdio server "${config.id}"`);
        const params: StdioServerParameters = {
          command: config.command,
          args: config.args ?? [],
          stderr: config.stderr ?? "inherit",
        };
        // SDK 会合并平台安全默认环境（Windows 下含 SYSTEMROOT/TEMP/APPDATA），
        // 这里只传增量，避免自定义白名单把子进程必需的变量筛掉
        if (config.cwd) params.cwd = config.cwd;
        if (config.env) params.env = config.env;
        return new StdioClientTransport(params);
      }
      case "sse": {
        if (!config.url) throw new Error(`Missing 'url' for sse server "${config.id}"`);
        return new SSEClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : {},
        });
      }
      case "streamableHttp": {
        if (!config.url) throw new Error(`Missing 'url' for streamableHttp server "${config.id}"`);
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : {},
        });
        // SDK 的 sessionId getter 返回 string | undefined，与 Transport 接口在
        // exactOptionalPropertyTypes 下不兼容，属于 SDK 类型声明问题
        return transport as unknown as Transport;
      }
      default: {
        const unsupported: never = config;
        throw new Error(`Unsupported transport config: ${JSON.stringify(unsupported)}`);
      }
    }
  }

  /** 把 server 级配置收敛成 adapter 的同步选项（exactOptionalPropertyTypes 下不能直接透传 undefined） */
  private syncOptionsFor(config: McpServerConfig): SyncToolsOptions {
    const options: SyncToolsOptions = {};
    if (config.allowedTools) options.allowedTools = config.allowedTools;
    if (config.requestTimeoutMs) options.requestTimeoutMs = config.requestTimeoutMs;
    return options;
  }

  /** 动态刷新单个服务的工具；失败时保留旧工具，不让整台 Server 失联 */
  async reloadServerTools(serverId: string): Promise<string[]> {
    const instance = this.servers.get(serverId);
    if (!instance) return [];

    try {
      instance.toolNames = await this.adapter.syncTools(
        instance.client,
        serverId,
        this.syncOptionsFor(instance.config)
      );
      console.log(`[MCP] Tools refreshed for "${serverId}": ${instance.toolNames.length}`);
    } catch (error) {
      console.error(
        `[MCP] Failed to refresh tools for "${serverId}":`,
        error instanceof Error ? error.message : String(error)
      );
    }
    return instance.toolNames;
  }

  /** 精确移除指定 Server 并回收资源 */
  async removeServer(id: string): Promise<void> {
    const instance = this.servers.get(id);
    if (!instance) return;

    // 先摘除登记，避免 close 触发的 onclose 回调重复清理
    this.servers.delete(id);
    instance.connected = false;
    this.adapter.unregisterServer(id);

    await safeClose(instance.transport);
    console.log(`[MCP] Server closed: ${id}`);
  }

  /** 优雅关停所有子进程与网络长链接 */
  async closeAll(): Promise<void> {
    const ids = [...this.servers.keys()];
    await Promise.allSettled(ids.map((id) => this.removeServer(id)));
  }

  /** 只取指定 Server 或全部在线 Server，并按 Server 声明的能力过滤 */
  private instancesFor(serverId: string | undefined, supports: (instance: ServerInstance) => boolean): ServerInstance[] {
    const all = [...this.servers.values()].filter((instance) => instance.connected && supports(instance));
    return serverId === undefined ? all : all.filter((instance) => instance.config.id === serverId);
  }

  /** `resources/list`：分页拉全，附带 serverId 归属 */
  async listResources(serverId?: string): Promise<McpResourceInfo[]> {
    const instances = this.instancesFor(serverId, (instance) => instance.supportsResources);
    if (serverId !== undefined && instances.length === 0) {
      throw new Error(`Server "${serverId}" 不存在或未声明 resources 能力`);
    }

    const resources: McpResourceInfo[] = [];
    for (const instance of instances) {
      let cursor: string | undefined;
      do {
        const page = await instance.client.listResources(cursor ? { cursor } : {});
        resources.push(...page.resources.map((resource) => ({ ...resource, serverId: instance.config.id })));
        cursor = page.nextCursor;
      } while (cursor);
    }
    return resources;
  }

  /** `resources/templates/list`：动态资源的 URI 模板 */
  async listResourceTemplates(serverId?: string): Promise<McpResourceTemplateInfo[]> {
    const instances = this.instancesFor(serverId, (instance) => instance.supportsResources);
    if (serverId !== undefined && instances.length === 0) {
      throw new Error(`Server "${serverId}" 不存在或未声明 resources 能力`);
    }

    const templates: McpResourceTemplateInfo[] = [];
    for (const instance of instances) {
      let cursor: string | undefined;
      do {
        const page = await instance.client.listResourceTemplates(cursor ? { cursor } : {});
        templates.push(
          ...page.resourceTemplates.map((template) => ({ ...template, serverId: instance.config.id }))
        );
        cursor = page.nextCursor;
      } while (cursor);
    }
    return templates;
  }

  /**
   * `resources/read`：读取前先过 adapter 的路径守卫。
   * resource 是纯数据不是动作，绕不过 toolPolicy，所以这层守卫是它唯一的调用侧防护。
   */
  async readResource(serverId: string, uri: string): Promise<McpResourceContent[]> {
    const instance = this.servers.get(serverId);
    if (!instance?.connected || !instance.supportsResources) {
      throw new Error(`Server "${serverId}" 不存在或未声明 resources 能力`);
    }

    this.adapter.checkResourceUri(uri);

    const result = await instance.client.readResource({ uri });
    return result.contents.map((content) => ({
      uri: content.uri,
      ...("mimeType" in content && content.mimeType ? { mimeType: content.mimeType } : {}),
      ...("text" in content ? { text: content.text } : { blob: content.blob }),
    }));
  }

  /** 订阅单个资源的后续变更通知（Server 需声明 `resources.subscribe`） */
  async subscribeResource(serverId: string, uri: string): Promise<void> {
    const instance = this.servers.get(serverId);
    if (!instance?.connected || !instance.supportsResourceSubscribe) {
      throw new Error(`Server "${serverId}" 不支持 resources.subscribe`);
    }
    await instance.client.subscribeResource({ uri });
  }

  /** `prompts/list` */
  async listPrompts(serverId?: string): Promise<McpPromptInfo[]> {
    const instances = this.instancesFor(serverId, (instance) => instance.supportsPrompts);
    if (serverId !== undefined && instances.length === 0) {
      throw new Error(`Server "${serverId}" 不存在或未声明 prompts 能力`);
    }

    const prompts: McpPromptInfo[] = [];
    for (const instance of instances) {
      let cursor: string | undefined;
      do {
        const page = await instance.client.listPrompts(cursor ? { cursor } : {});
        prompts.push(...page.prompts.map((prompt) => ({ ...prompt, serverId: instance.config.id })));
        cursor = page.nextCursor;
      } while (cursor);
    }
    return prompts;
  }

  /**
   * `prompts/get`：name 必须在该 Server 当前 `prompts/list` 结果里，
   * 不依赖这份清单去防止任意名注入，同时防止模型幻觉出个不存在的模板名浪费一次往返。
   * role 原样保留（system/user/assistant 都可能出现，见 McpPromptRole），由调用方决定怎么分层。
   */
  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>
  ): Promise<McpGetPromptResult> {
    const instance = this.servers.get(serverId);
    if (!instance?.connected || !instance.supportsPrompts) {
      throw new Error(`Server "${serverId}" 不存在或未声明 prompts 能力`);
    }

    const available = await this.listPrompts(serverId);
    if (!available.some((prompt) => prompt.name === name)) {
      throw new Error(`Prompt "${name}" 不在 Server "${serverId}" 的当前 prompts/list 结果中`);
    }

    const result = await instance.client.getPrompt({ name, ...(args ? { arguments: args } : {}) });
    return {
      ...("description" in result && result.description ? { description: result.description } : {}),
      messages: result.messages.map<McpPromptMessage>((message) => ({
        role: message.role,
        content: McpClientManager.toContentBlock(message.content),
      })),
    };
  }

  /** prompt 消息内容与工具返回值同构，统一转成 ToolContentBlock；不认识的类型压成可读文本 */
  private static toContentBlock(content: unknown): ToolContentBlock {
    const block = content as {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      uri?: string;
      resource?: unknown;
    };

    switch (block.type) {
      case "text":
        return { type: "text", text: block.text ?? "" };
      case "image":
        return { type: "image", data: block.data ?? "", mimeType: block.mimeType ?? "image/*" };
      case "resource":
        return { type: "resource", resource: block.resource };
      default:
        return { type: "text", text: `[${block.type} ${block.uri ?? block.mimeType ?? ""}]`.trim() };
    }
  }

  getStatus(): ServerStatus[] {
    return [...this.servers.values()].map((instance) => ({
      id: instance.config.id,
      transport: instance.config.transport,
      connected: instance.connected,
      tools: [...instance.toolNames],
    }));
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms while trying to ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeClose(transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    console.warn("[MCP] Failed to close transport:", error instanceof Error ? error.message : String(error));
  }
}
