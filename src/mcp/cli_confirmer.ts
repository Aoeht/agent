// src/mcp/cli_confirmer.ts
import readline from "node:readline/promises";
import { Confirmer } from "./types";

/**
 * 终端版人工确认器：form 模式按 requestedSchema 逐字段询问，
 * 本地策略触发的 ask（无 schema）退化为单个 y/N 确认。
 * 未来接 UI 时只需实现同样的 Confirmer 签名替换掉这个实现。
 */
export function createCliConfirmer(): Confirmer {
  return async (request) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n⚠️  需要人工确认 [server: ${request.serverId}]\n${request.message}`);

      const properties = request.requestedSchema?.properties ?? {};
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const [key, def] of Object.entries(properties)) {
        const label = (def as { title?: string; description?: string }).title ?? key;
        const hint = (def as { description?: string }).description;
        const answer = await rl.question(`  ${label}${hint ? ` (${hint})` : ""}: `);
        content[key] = answer;
      }

      const answer = (await rl.question("  允许执行吗？[y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        return { action: "decline" };
      }
      return Object.keys(content).length > 0 ? { action: "accept", content } : { action: "accept" };
    } finally {
      rl.close();
    }
  };
}
