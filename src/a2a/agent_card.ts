// src/a2a/agent_card.ts
/**
 * Agent Card 派生（A2A 进阶篇第 5 章）。
 *
 * 设计要点（评估文档 4.3）：**不手写卡片 JSON**。卡片的接口地址从服务端实际监听
 * 参数拼出，版本从 package.json 读——能力清单与实际配置不一致的整类 bug 从源头消失。
 *
 * 边界纪律：Card 描述**业务能力**（对外可承诺什么），不是内部工具目录——
 * 工具清单、提示词、DAG 一概不出现在卡片里（Opaque Execution）。
 * 也不声明 tenant：没有实现多租户就干脆不声明（声明了不实现是最糟的选择）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentCard, AgentSkill } from "./types";

/** 对外业务技能：声明的是"能承诺的交付"，路由与校验由 operations 层真实执行 */
const SKILLS: AgentSkill[] = [
  {
    id: "general-assistant",
    name: "通用助手",
    description:
      "接收一段任务描述，自主规划并执行（可检索网络、读写工作区文件、运行脚本），" +
      "返回一份完整回答或结构化结论。多轮任务可在同一 contextId 下续聊。",
    tags: ["assistant", "task", "multi-turn"],
    examples: ["帮我调研 X 并给出结论", "把这份材料整理成表格"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain", "application/json"],
  },
  {
    id: "evidence-research",
    name: "带出处的调研",
    description:
      "围绕一个问题做资料收集与分析，回答区分观察与推测，并给出实际查阅过的出处与未解决的问题。",
    tags: ["research", "evidence"],
    examples: ["对比 A 与 B 两个方案的取舍，给出依据"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  },
];

function readPackageVersion(): string {
  try {
    // 相对本文件向上找 package.json（src/a2a/ → 仓库根）；读不出来就退回开发版号
    const raw = readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: string }).version;
    return typeof version === "string" && version !== "" ? version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export interface AgentCardOptions {
  /** JSON-RPC 接口的绝对 URL（服务端实际监听的 host:port + /a2a） */
  interfaceUrl: string;
  name?: string;
  description?: string;
  version?: string;
}

export function buildAgentCard(options: AgentCardOptions): AgentCard {
  return {
    name: options.name ?? (process.env.AGENT_A2A_NAME?.trim() || "ai_agent"),
    description:
      options.description ??
      "一个自托管的多工具 AI Agent：自主规划、检索、读写工作区并运行脚本，交付带出处的结论。" +
        "本名片由服务端代码派生，能力以 /a2a 端点的实际行为为准。",
    version: options.version ?? readPackageVersion(),
    supportedInterfaces: [
      {
        url: options.interfaceUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      // 推送通知是唯一"服务端主动向外发请求"的能力（SSRF 面），本轮明确不实现：
      // 卡片如实声明 false，客户端不应请求 pushNotificationConfig
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: SKILLS,
  };
}
