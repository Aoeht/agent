// scripts/a2a_probe.ts
/**
 * A2A 出站探针：对指定的远端 Agent 做一次「名片发现 → 发消息 → 收结果」的完整体检。
 * 用途：联调第一跳——确认对端名片可读、JSON-RPC 可达、流式事件符合 v1.0 线格式。
 *
 * 用法：bun run scripts/a2a_probe.ts [baseUrl] [--message "文本"] [--stream]
 *   baseUrl 缺省 http://127.0.0.1:41241（interop/langgraph 的测试 agent）
 */
import {
  fetchAgentCard,
  sendStreamingMessage,
  sendMessage,
  taskText,
  textMessage,
} from "../src/a2a/client";

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:41241";
const message = argOf("--message") ?? "上海今天天气怎么样？请给一句可执行的穿衣建议。";
const forceStream = process.argv.includes("--stream");

async function main(): Promise<void> {
  console.log(`📡 A2A 探针 → ${baseUrl}`);
  const { card, interface: iface } = await fetchAgentCard({ baseUrl });
  console.log(`🪪 名片: ${card.name} v${card.version} · 流式=${card.capabilities.streaming} · ${card.skills.map((s) => s.id).join(", ")}`);
  console.log(`🔌 接口: ${iface.protocolBinding} ${iface.protocolVersion} @ ${iface.url}`);

  const messageObj = textMessage(message);
  if (forceStream || card.capabilities.streaming) {
    console.log("🌊 流式事件：");
    let finalState = "";
    for await (const event of sendStreamingMessage({ baseUrl }, messageObj)) {
      if ("task" in event) {
        console.log(`  [task] ${event.task.id} (context=${event.task.contextId})`);
      } else if ("statusUpdate" in event) {
        finalState = event.statusUpdate.status.state;
        const note = event.statusUpdate.status.message?.parts.map((part) => ("text" in part ? part.text : "")).join(" ");
        console.log(`  [status] ${finalState}${note ? ` · ${note}` : ""}`);
      } else if ("artifactUpdate" in event) {
        console.log(`  [artifact] ${event.artifactUpdate.artifact.name ?? "(未命名)"} · ${event.artifactUpdate.artifact.parts.map((part) => ("text" in part ? part.text : "")).join(" ").slice(0, 120)}${""}`);
      } else if ("message" in event) {
        console.log(`  [message] ${event.message.parts.map((part) => ("text" in part ? part.text : "")).join(" ")}`);
      }
    }
    console.log(`🏁 流结束，终态: ${finalState}`);
  } else {
    console.log("⏳ 阻塞发送（对端未声明流式）…");
    const result = await sendMessage({ baseUrl }, messageObj);
    if ("task" in result) {
      console.log(`🏁 终态: ${result.task.status.state}`);
      console.log(`📄 回答: ${taskText(result.task).slice(0, 500)}`);
    } else {
      console.log(`📄 直返 Message: ${result.message.parts.map((part) => ("text" in part ? part.text : "")).join(" ").slice(0, 500)}`);
    }
  }
}

main().catch((error) => {
  console.error("❌ 探针失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
