// src/server/bridge.ts
import type { Confirmer, ElicitationRequest, ElicitationResult } from "../mcp/types";
import { runSessionStore } from "./run_context";
import type { ApprovalDecisionBody, RequestedSchemaField, ServerEvent } from "./protocol";

interface PendingRequest {
  sessionId: string;
  /** 原始事件：SSE 重连/刷新页面后重发，未决审批不能因为断线而消失 */
  event: ServerEvent;
  timer: ReturnType<typeof setTimeout>;
  resolveApproval?: (result: ElicitationResult) => void;
  resolveInput?: (value: string | null) => void;
}

/**
 * UI 人工交互桥：MCP Confirmer 与 ToolRuntime.requestHuman 的 Web 版实现
 * （cli_confirmer 的对位替换，Agent 与 adapter 对此无感知）。
 *
 * 会话路由（多会话并行后"当前会话"不再唯一）：
 * - run 内的调用（run_script 的 requestHuman、工具执行中的策略 ask）——
 *   跟随 AsyncLocalStorage 的运行上下文，天然按 run 隔离；
 * - MCP elicitation 回调跑在传输层事件循环里、ALS 丢失——按「serverId → 在飞调用
 *   所属会话」的映射兜底：恰好一个会话在该 server 上有在飞调用时路由给它，
 *   多个并存时无法可靠归因，宁可 decline（审批绝不模糊放行）。
 *
 * 语义要点：审批超时自动 **decline**；run 中止/会话取消时未决请求统一收口；
 * 页面刷新后通过 pendingEventsFor 重发未决请求。
 */
export class UiBridge {
  private pending = new Map<string, PendingRequest>();
  /** serverId → 在飞调用所属会话集合（elicitation 的路由兜底，见类注释） */
  private serverInFlight = new Map<string, Set<string>>();
  private seq = 0;

  constructor(
    private readonly emit: (sessionId: string, event: ServerEvent) => void,
    private readonly timeoutMs: number
  ) {}

  /** MCP 策略 ask 与 elicitation/create 共用的确认入口 */
  readonly confirmer: Confirmer = async (request) => {
    const sessionId = this.sessionFor(request.serverId);
    if (sessionId === null) return { action: "decline" };
    return await this.askApproval(sessionId, request);
  };

  /**
   * ToolRuntime.requestHuman 通道。当前唯一的调用方是 run_script 的执行确认
   * （CLI 里回 y/N 的那条提示）。UI 上把它渲染成正式的审批卡而不是让用户
   * 在输入框里敲 "y"：accept → "y"（run_script 的 approve() 接受），
   * decline / 超时 / 会话取消 / run 中止 → null（按取消处理，脚本不执行）。
   * 未来若出现真正的"要用户输入文本"的调用方，再为它恢复 human_input_request 通道。
   */
  readonly requestHuman = async (prompt: string, signal: AbortSignal): Promise<string | null> => {
    const sessionId = this.sessionFor();
    if (sessionId === null) return null;
    const decision = await this.askApproval(
      sessionId,
      { serverId: "run_script", message: prompt.trim() },
      signal
    );
    return decision.action === "accept" ? "y" : null;
  };

  /**
   * ToolRuntime.askUser 通道：模型发起的主动澄清（ask_user 工具），向用户征询
   * 一段自由文本回答。复用 human_input_request 事件链路（Web 端渲染输入模态框，
   * 应答 POST /inputs/:id → resolveInput）。与此相对的 requestHuman 是 y/N 审批语义。
   */
  readonly askUser = async (prompt: string, signal: AbortSignal): Promise<string | null> => {
    const sessionId = this.sessionFor();
    if (sessionId === null) return null;
    return this.askInput(sessionId, prompt.trim(), signal);
  };

  /**
   * ToolRuntime.requestBudgetExtension 通道：预算用尽时询问是否追加。
   * 走审批卡语义：accept → 追加并继续本轮，decline / 超时 / run 中止 → 不追加。
   */
  readonly requestBudgetExtension = async (prompt: string, signal: AbortSignal): Promise<boolean> => {
    const sessionId = this.sessionFor();
    if (sessionId === null) return false;
    const decision = await this.askApproval(
      sessionId,
      { serverId: "运行预算", message: prompt.trim() },
      signal
    );
    return decision.action === "accept";
  };

  /**
   * 标记某 server 连接上有某会话的在飞调用（由每会话注册表的包装中间件在
   * MCP 工具执行前后调用）。elicitation 从传输层回调进来时 ALS 已丢失，靠它归因。
   */
  noteServerUse(serverId: string, sessionId: string): void {
    let sessions = this.serverInFlight.get(serverId);
    if (!sessions) {
      sessions = new Set();
      this.serverInFlight.set(serverId, sessions);
    }
    sessions.add(sessionId);
  }

  releaseServerUse(serverId: string, sessionId: string): void {
    const sessions = this.serverInFlight.get(serverId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) this.serverInFlight.delete(serverId);
  }

  /** 前端应答审批；未知或已过期的 id 返回 false（HTTP 层映射 404） */
  resolveApproval(id: string, body: ApprovalDecisionBody): boolean {
    const pending = this.pending.get(id);
    if (!pending?.resolveApproval) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolveApproval(toElicitationResult(body));
    return true;
  }

  /** 前端应答人工输入 */
  resolveInput(id: string, text: string): boolean {
    const pending = this.pending.get(id);
    if (!pending?.resolveInput) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolveInput(text);
    return true;
  }

  /** SSE 订阅建立时重发该会话的未决请求 */
  pendingEventsFor(sessionId: string): ServerEvent[] {
    return [...this.pending.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => pending.event);
  }

  /** 会话取消/关停：未决请求统一按拒绝/取消收口，回合不能吊死在等待上 */
  disposeSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolveApproval?.({ action: "decline" });
      pending.resolveInput?.(null);
    }
  }

  /**
   * 这次交互属于哪个会话：优先 ALS 运行上下文（run 内一切调用）；
   * elicitation 无 ALS，按 serverId 的在飞映射兜底——唯一在飞会话才路由。
   */
  private sessionFor(serverId?: string): string | null {
    const fromRun = runSessionStore.getStore()?.sessionId;
    if (fromRun !== undefined) return fromRun;
    if (serverId !== undefined) {
      const sessions = this.serverInFlight.get(serverId);
      if (sessions !== undefined && sessions.size === 1) {
        return [...sessions][0]!;
      }
    }
    return null;
  }

  private askApproval(
    sessionId: string,
    request: ElicitationRequest,
    signal?: AbortSignal
  ): Promise<ElicitationResult> {
    const id = `approval-${Date.now().toString(36)}-${++this.seq}`;
    const requestedSchema = flattenRequestedSchema(request.requestedSchema);
    return new Promise<ElicitationResult>((resolve) => {
      const finish = (result: ElicitationResult): void => {
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(result);
      };
      const onAbort = (): void => finish({ action: "decline" });
      const timer = setTimeout(() => {
        // 审批的本质是"未确认不执行"：超时一律 decline，绝不默认放行
        finish({ action: "decline" });
      }, this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const event: ServerEvent = {
        type: "approval_request",
        id,
        source: request.serverId,
        message: request.message,
        ...(Object.keys(requestedSchema).length > 0 ? { requestedSchema } : {}),
      };
      this.pending.set(id, { sessionId, event, resolveApproval: finish, timer });
      this.emit(sessionId, event);
    });
  }

  /** 人工输入事件通道：由公开的 askUser（模型发起的澄清）使用，会话路由由调用方解析 */
  private askInput(sessionId: string, prompt: string, signal: AbortSignal): Promise<string | null> {
    const id = `input-${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<string | null>((resolve) => {
      const finish = (value: string | null): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), this.timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      const event: ServerEvent = { type: "human_input_request", id, prompt };
      this.pending.set(id, { sessionId, event, resolveInput: finish, timer });
      this.emit(sessionId, event);
    });
  }
}

function toElicitationResult(body: ApprovalDecisionBody): ElicitationResult {
  if (body.action !== "accept") return { action: "decline" };
  return body.content !== undefined ? { action: "accept", content: body.content } : { action: "accept" };
}

/** MCP form schema（{ properties: {...} }）→ 协议里的扁平字段表 */
function flattenRequestedSchema(schema: unknown): Record<string, RequestedSchemaField> {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties;
  if (typeof properties !== "object" || properties === null) return {};
  const fields: Record<string, RequestedSchemaField> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const raw = value as Record<string, unknown>;
    fields[key] = {
      ...(raw.type !== undefined ? { type: String(raw.type) } : {}),
      ...(raw.title !== undefined ? { title: String(raw.title) } : {}),
      ...(raw.description !== undefined ? { description: String(raw.description) } : {}),
      ...(typeof raw.default === "string" || typeof raw.default === "number" || typeof raw.default === "boolean"
        ? { default: raw.default }
        : {}),
    };
  }
  return fields;
}
