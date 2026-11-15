// src/a2a/fence.ts
/**
 * 远端 Agent 输出的不可信围栏（A2A 进阶篇 8.2 攻击路径①）。
 *
 * 为什么不复用 wrapUntrustedData 的调用方原样传 source：A2A 的出处比 MCP 丰富——
 * 哪个 Agent、哪个 skill、哪个 taskId/contextId。这些字段是审计与追责的凭据，
 * 必须写进围栏标签；出了问题能回答"这段话是谁在什么任务里说的"。
 *
 * 纪律（评估文档 5.1）：远端 Agent 的一切输出都是不可信数据——它有自己的主人与
 * 目标函数，可能被它读到的网页注入后"洗白"成自己的建议。围栏在客户端工具层强制
 * 落地（a2a_delegate / a2a_client），不靠提示词祈祷。
 */
import { wrapUntrustedData } from "../core/untrusted";

export interface RemoteOrigin {
  agentName: string;
  skillId?: string;
  taskId?: string;
  contextId?: string;
}

export function wrapRemoteAgentOutput(origin: RemoteOrigin, body: string): string {
  const source = [
    `远端 Agent「${origin.agentName}」`,
    ...(origin.skillId !== undefined ? [`skill=${origin.skillId}`] : []),
    ...(origin.taskId !== undefined ? [`taskId=${origin.taskId}`] : []),
    ...(origin.contextId !== undefined ? [`contextId=${origin.contextId}`] : []),
  ].join(" · ");
  return wrapUntrustedData(source, body);
}
