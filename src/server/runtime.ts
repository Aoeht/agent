// src/server/runtime.ts
import type { ToolRegistry } from "../core/registry";
import type { McpClientManager } from "../mcp/client_manager";
import type { AgentRunConfig } from "../config";
import type { SkillManifest } from "../skills/loader";
import type { ScriptSandboxResolution } from "../tools/sandbox_docker";
import { createAgentStack } from "../bootstrap";
import type { UiBridge } from "./bridge";

export interface ServerRuntime {
  config: AgentRunConfig;
  /**
   * 共享工具注册表：MCP 工具定义的**来源**（adapter 挂载目标）。
   * 各会话的 Agent 不直接用它——ensureAgent 会建每会话注册表，
   * 用 registerSessionTools 组装无状态内置工具（计划仓私有），
   * 再用 copyMcpTools 把这里的 MCP 定义拷过去。
   */
  registry: ToolRegistry;
  mcp: McpClientManager;
  skills: SkillManifest[];
  sandbox: ScriptSandboxResolution;
  /** 当前沙箱根（绝对路径）。UI 切换后整栈重建并更新此字段 */
  sandboxRoot: string;
  /**
   * 远程收紧：全栈不注册 run_script（共享栈与每会话注册表同一份清单）。
   * 由 main.ts 依 AGENT_UI_REMOTE_HARDENING 设定；切换沙箱根重建时原样带上，
   * 否则重建会把任意代码执行又塞回工具清单。
   */
  disableRunScript: boolean;
  /** MCP 资源注入的不可信上下文（随栈重建刷新；空串表示无资源） */
  untrustedContext?: string | undefined;
  /** 收口整栈（配置 watcher + 全部 MCP 连接）；关停与切沙箱回收旧栈用 */
  dispose: () => Promise<void>;
}

export async function createServerRuntime(options: {
  bridge: UiBridge;
  disableRunScript?: boolean;
}): Promise<ServerRuntime> {
  const stack = await createAgentStack({
    confirmer: options.bridge.confirmer,
    logPrefix: "[UI] ",
    disableRunScript: options.disableRunScript === true,
  });

  return {
    config: stack.config,
    registry: stack.registry,
    mcp: stack.mcp,
    skills: stack.skills,
    sandbox: stack.sandbox,
    sandboxRoot: stack.sandboxRoot,
    disableRunScript: options.disableRunScript === true,
    ...(stack.untrustedContext !== "" ? { untrustedContext: stack.untrustedContext } : {}),
    dispose: stack.dispose,
  };
}

/**
 * 切换沙箱根目录：用同一条 bootstrap 流水线重建整栈（MCP 重新挂载到新根），
 * 成功后原位替换字段、回收旧连接；失败抛错、原栈原封不动。
 * 调用方（main.ts）负责先确认没有在飞回合，并在成功后丢弃全部会话 Agent
 * （下个回合用新根重建；对话历史在磁盘上，不受影响）。
 */
export async function rebuildRuntimeWithSandboxRoot(
  runtime: ServerRuntime,
  bridge: UiBridge,
  sandboxRoot: string
): Promise<void> {
  const next = await createAgentStack({
    confirmer: bridge.confirmer,
    logPrefix: "[UI] ",
    sandboxRoot,
    disableRunScript: runtime.disableRunScript,
  });
  const previousDispose = runtime.dispose;
  runtime.registry = next.registry;
  runtime.mcp = next.mcp;
  runtime.sandbox = next.sandbox;
  runtime.sandboxRoot = next.sandboxRoot;
  runtime.untrustedContext = next.untrustedContext !== "" ? next.untrustedContext : undefined;
  runtime.dispose = next.dispose;
  await previousDispose();
}
