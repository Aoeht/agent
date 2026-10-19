// src/tools/telemetry.ts
import { ToolCallMiddleware } from "../core/registry";

/** 结果是 {"error": ...} 形状时视为失败（工具异常与策略拒绝都被 runTool 序列化成这种形状） */
function extractError(result: string): string | null {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // 非 JSON 结果按成功处理
  }
  return null;
}

/**
 * 统一工具遥测：每个工具调用（内置 + MCP）输出一行摘要。
 * MCP 工具另有 adapter 级的详细审计日志，这里保证内置工具也有同等的可观测性。
 */
export function createToolTelemetry(
  log: (line: string) => void = (line) => console.log(line)
): ToolCallMiddleware {
  return async (context, next) => {
    const startedAt = Date.now();
    const result = await next();
    const ms = Date.now() - startedAt;
    const error = extractError(result);
    if (error) {
      log(`[Tool] ${context.name} ❌ ${ms}ms: ${error}`);
    } else {
      log(`[Tool] ${context.name} ✅ ${ms}ms ${result.length}chars`);
    }
    return result;
  };
}
