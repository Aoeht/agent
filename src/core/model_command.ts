// src/core/model_command.ts
// REPL 的 /model 命令：只负责解析与提示，真正的切换动作由 host 回调注入。
// 这样本模块不依赖 Agent/SessionStore（能直接单测），落盘策略也留给调用方决定。
//
// 设计要点：
// - 只认领 /model 前缀：/models、/modelx 之类未知斜杠命令原样交回主循环；
// - 不带参数 = 查看当前模型与用法，不产生任何副作用；
// - 切到同一个模型不写记录（否则会话文件里全是重复的元记录行）。

export interface ModelCommandHost {
  /** 当前生效的模型名 */
  currentModel: () => string;
  /** 切换模型；由调用方决定是否写进会话文件（REPL 会写，便于续聊恢复） */
  switchModel: (model: string) => Promise<void>;
}

export type ModelCommandResult = { kind: "handled" } | { kind: "not-a-command" };

const MODEL_CMD = "/model";

export async function handleModelCommand(
  line: string,
  host: ModelCommandHost,
  out: (s: string) => void = (s) => console.log(s)
): Promise<ModelCommandResult> {
  const input = line.trim();
  if (input !== MODEL_CMD && !input.startsWith(`${MODEL_CMD} `)) return { kind: "not-a-command" };

  const rest = input.slice(MODEL_CMD.length).trim();
  const current = host.currentModel();

  if (rest === "") {
    out(`当前模型: ${current}`);
    out(`用法: ${MODEL_CMD} <模型名>   切换后写入本会话，下一轮生效，续聊时自动恢复`);
    return { kind: "handled" };
  }
  if (/\s/.test(rest)) {
    out(`❌ 模型名不能含空格，收到: "${rest}"`);
    return { kind: "handled" };
  }
  if (rest === current) {
    out(`当前已经是 ${current}，未做改动。`);
    return { kind: "handled" };
  }

  try {
    await host.switchModel(rest);
    out(`✅ 已切换模型: ${current} → ${rest}（写入本会话，下一轮生效；续聊时自动恢复）`);
  } catch (error) {
    out(`❌ 切换模型失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { kind: "handled" };
}
