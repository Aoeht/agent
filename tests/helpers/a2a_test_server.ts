// tests/helpers/a2a_test_server.ts
/**
 * A2A 测试双端：一张合规范的名片 + 一个回声 JSON-RPC 端点，供 client / a2a_delegate
 * 的单测在不开真模型的情况下跑通完整 HTTP 链路。行为可用 options 微调。
 */
import type { AgentCard } from "../../src/a2a/types";

export interface A2aTestServerOptions {
  /** 任务答案文本（进 artifacts 与终态消息） */
  answer?: string;
  /** 对端是否声明流式能力（默认 true） */
  streaming?: boolean;
}

export interface CapturedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface A2aTestServer {
  url: string;
  requests: CapturedRequest[];
  close: () => void;
}

export function startA2aTestServer(options: A2aTestServerOptions = {}): A2aTestServer {
  const answer = options.answer ?? "测试答案：一切正常";
  const requests: CapturedRequest[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const headerRecord: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headerRecord[key] = value;
      });
      requests.push({ path: url.pathname, method: req.method, headers: headerRecord, body: undefined });

      if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        const card: AgentCard = {
          name: "test-agent",
          description: "测试双端 Agent",
          version: "0.1.0-test",
          supportedInterfaces: [
            { url: `http://127.0.0.1:${server.port}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          ],
          capabilities: { streaming: options.streaming ?? true, pushNotifications: false },
          defaultInputModes: ["text/plain"],
          defaultOutputModes: ["text/plain"],
          skills: [{ id: "echo", name: "回声", description: "原样返回", tags: ["test"] }],
        };
        return Response.json(card);
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        const envelope = (await req.json()) as { id: string | number; method: string; params?: { message?: { parts?: Array<{ text?: string }> } } };
        const taskId = `task-${envelope.id}`;
        const contextId = `ctx-${envelope.id}`;

        if (envelope.method === "SendMessage") {
          return Response.json({
            jsonrpc: "2.0",
            id: envelope.id,
            result: {
              task: {
                id: taskId,
                contextId,
                status: {
                  state: "TASK_STATE_COMPLETED",
                  timestamp: new Date().toISOString(),
                },
                artifacts: [{ artifactId: "a1", name: "最终回答", parts: [{ text: answer }] }],
              },
            },
          });
        }

        if (envelope.method === "SendStreamingMessage") {
          const userText = envelope.params?.message?.parts?.map((part) => part.text ?? "").join("") ?? "";
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (payload: unknown): void => {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
              };
              send({ jsonrpc: "2.0", id: envelope.id, result: { task: { id: taskId, contextId, status: { state: "TASK_STATE_SUBMITTED" } } } });
              send({
                jsonrpc: "2.0",
                id: envelope.id,
                result: { statusUpdate: { taskId, contextId, status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() } } },
              });
              send({
                jsonrpc: "2.0",
                id: envelope.id,
                result: { artifactUpdate: { taskId, contextId, artifact: { artifactId: "a1", parts: [{ text: `回声：${userText}` }] }, lastChunk: true } },
              });
              send({
                jsonrpc: "2.0",
                id: envelope.id,
                result: { statusUpdate: { taskId, contextId, status: { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() } } },
              });
              // 终态后关流：v1.0 的流结束信号就是 EOF
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }

        return Response.json({ jsonrpc: "2.0", id: envelope.id, error: { code: -32601, message: "未知方法" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: () => server.stop(true),
  };
}
