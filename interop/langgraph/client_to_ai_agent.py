# interop/langgraph/client_to_ai_agent.py
"""a2a-sdk 客户端 → ai_agent 的 A2A 服务端（互操作方向②：Python 生态调进来）。

前提：ai_agent 以 AGENT_A2A_SERVER=1 启动（bun run src/server/main.ts）。
本脚本拉取它的名片，用 a2a-sdk 的 ClientFactory 发一条流式消息，
逐事件打印任务生命周期，验证 TS 服务端说 v1.0 线格式没有跑偏。

用法：
    uv run client_to_ai_agent.py [baseUrl] [--message "文本"]
    # baseUrl 缺省 http://127.0.0.1:8787
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

from a2a.client import ClientConfig, ClientFactory
from a2a.client.card_resolver import A2ACardResolver
from a2a.helpers.proto_helpers import get_stream_response_text, new_text_message
from a2a.types.a2a_pb2 import Role, SendMessageRequest, TaskState

# 仓库根的 .env：AGENT_UI_TOKEN 存在时走 Bearer 通道（ai_agent 门禁的脚本调用方式）
load_dotenv(dotenv_path=Path(__file__).resolve().parents[2] / ".env")

TERMINAL_STATES = {
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
}


def args() -> tuple[str, str]:
    argv = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    base_url = argv[0] if argv else "http://127.0.0.1:8787"
    message = "用一句话介绍你自己能做到什么，然后说明你当前的工作区路径。"
    if "--message" in sys.argv:
        index = sys.argv.index("--message")
        message = sys.argv[index + 1]
    return base_url, message


async def main() -> None:
    base_url, message_text = args()
    print(f"📡 a2a-sdk 客户端 → {base_url}")
    timeout = httpx.Timeout(300.0, connect=10.0)
    import os

    token = os.environ.get("AGENT_UI_TOKEN", "").strip()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as httpx_client:
        resolver = A2ACardResolver(httpx_client=httpx_client, base_url=base_url)
        card = await resolver.get_agent_card()
        interfaces = ", ".join(
            f"{interface.protocol_binding}@{interface.protocol_version} {interface.url}"
            for interface in card.supported_interfaces
        )
        print(f"🪪 名片: {card.name} v{card.version} · 流式={card.capabilities.streaming}")
        print(f"🔌 接口: {interfaces}")
        print(f"🧩 skills: {', '.join(skill.id for skill in card.skills)}")

        factory = ClientFactory(ClientConfig(streaming=True, httpx_client=httpx_client))
        client = factory.create(card)
        request = SendMessageRequest(
            message=new_text_message(message_text, role=Role.ROLE_USER),
        )
        final_state = ""
        answer = ""
        async for event in client.send_message(request):
            if event.HasField("task"):
                print(f"  [task] {event.task.id} (context={event.task.context_id})")
            elif event.HasField("status_update"):
                status = event.status_update.status
                final_state = TaskState.Name(status.state)
                note = get_stream_response_text(event).strip()
                print(f"  [status] {final_state}" + (f" · {note[:120]}" if note else ""))
                if status.state in TERMINAL_STATES:
                    if status.message and status.message.parts:
                        answer = "\n".join(part.text for part in status.message.parts if part.text)
            elif event.HasField("artifact_update"):
                text = "\n".join(part.text for part in event.artifact_update.artifact.parts if part.text)
                answer = text or answer
                print(f"  [artifact] {event.artifact_update.artifact.name or '(未命名)'} · {text[:120]}")
            elif event.HasField("message"):
                answer = "\n".join(part.text for part in event.message.parts if part.text)
                print(f"  [message] {answer[:120]}")
        print(f"🏁 流结束，终态: {final_state}")
        print(f"📄 回答: {answer[:600]}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
