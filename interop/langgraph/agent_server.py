# interop/langgraph/agent_server.py
"""LangGraph 测试 Agent 暴露为 A2A 服务端（a2a-sdk v1.3.0，JSON-RPC 绑定）。

这是互操作实验的「对端」：一个 create_react_agent（带玩具天气工具），
包成 A2A AgentExecutor，对外提供名片发现 + SendMessage/SendStreamingMessage。
ai_agent 侧的 a2a_probe.ts / a2a_call 工具据此验证 TS→Python 方向的互通。

用法：
    uv run agent_server.py            # 真模型（DashScope compatible-mode，读 ../../.env）
    LANGGRAPH_FAKE=1 uv run agent_server.py   # 无 LLM 确定性图（配额失败时的兜底）
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from starlette.applications import Starlette

# 仓库根的 .env（DASHSCOPE_API_KEY / AGENT_MODEL 等），与 ai_agent 主项目共用一份凭据
load_dotenv(dotenv_path=Path(__file__).resolve().parents[2] / ".env")

from a2a.helpers.proto_helpers import new_task as new_task_proto  # noqa: E402
from a2a.helpers.proto_helpers import new_text_part  # noqa: E402
from a2a.server.agent_execution import AgentExecutor, RequestContext  # noqa: E402
from a2a.server.request_handlers import DefaultRequestHandler  # noqa: E402
from a2a.server.routes.agent_card_routes import create_agent_card_routes  # noqa: E402
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes  # noqa: E402
from a2a.server.events import EventQueue  # noqa: E402
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater  # noqa: E402
from a2a.types.a2a_pb2 import (  # noqa: E402
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Part,
    Role,
    TaskState,
)
from a2a.utils.constants import AGENT_CARD_WELL_KNOWN_PATH  # noqa: E402

HOST = os.environ.get("LANGGRAPH_HOST", "127.0.0.1")
PORT = int(os.environ.get("LANGGRAPH_PORT", "41241"))
DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"


# ---------- LangGraph 图 ----------

def build_react_graph():
    """真模型：create_react_agent + 一个玩具工具（DashScope compatible-mode）。"""
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent

    model_name = os.environ.get("LANGGRAPH_MODEL") or os.environ.get("AGENT_MODEL") or "qwen3.8-flash"
    llm = ChatOpenAI(
        model=model_name,
        api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
        base_url=DASHSCOPE_BASE,
        temperature=0.1,
    )

    def get_weather(city: str) -> str:
        """查询一个城市的今日天气（测试用固定数据）。"""
        return f"{city} 今日多云转晴，12~19°C，西北风 3 级，空气质量优。"

    return create_react_agent(llm, tools=[get_weather])


def build_fake_graph():
    """无 LLM 兜底：单节点确定性图（与真图同样吃 messages 状态，A2A 执行器无差别调用）。"""
    from langgraph.graph import END, START, MessagesState, StateGraph

    def answer_node(state: MessagesState) -> dict:
        question = state["messages"][-1].content
        return {
            "messages": [{
                "role": "assistant",
                "content": f"（FAKE 模式）针对「{question}」的确定性回答：上海今日多云转晴，12~19°C。",
            }]
        }

    graph = StateGraph(MessagesState)
    graph.add_node("answer", answer_node)
    graph.add_edge(START, "answer")
    graph.add_edge("answer", END)
    return graph.compile()


# ---------- A2A AgentExecutor ----------

class LangGraphExecutor(AgentExecutor):
    """把 LangGraph 图的执行映射进 A2A 任务生命周期：SUBMITTED→WORKING→COMPLETED。

    进度事件只放「节点名 / 工具名」级别的摘要（与 ai_agent 侧投影层同一纪律：
    模型内部文本与工具返回原文不进公共流）。
    """

    def __init__(self, graph) -> None:
        self._graph = graph

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)  # type: ignore[attr-defined]
        query = context.get_user_input()
        try:
            # a2a-sdk 1.x 要求**先入队完整 Task 事件**，之后才允许状态/产物更新事件
            initial_task = new_task_proto(context.task_id, context.context_id, TaskState.TASK_STATE_SUBMITTED)  # type: ignore[attr-defined]
            if getattr(context, "message", None) is not None:
                initial_task.history.append(context.message)
            await event_queue.enqueue_event(initial_task)
            await updater.start_work()

            final_text = ""
            async for chunk in self._graph.astream({"messages": [("user", query)]}, stream_mode="updates"):
                for node, update in chunk.items():
                    messages = (update or {}).get("messages", [])
                    for message in messages:
                        # 消息可能是 AIMessage（真图）也可能是 dict（自定义节点）
                        tool_calls = getattr(message, "tool_calls", None) or (
                            message.get("tool_calls") if isinstance(message, dict) else None
                        )
                        content = (
                            message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
                        )
                        if tool_calls:
                            names = ", ".join(
                                (call.get("name", "?") if isinstance(call, dict) else str(call)) for call in tool_calls
                            )
                            await updater.update_status(
                                TaskState.TASK_STATE_WORKING,
                                updater.new_agent_message([new_text_part(f"节点 {node} · 调用工具 {names}")]),
                            )
                        elif content:
                            final_text = content if isinstance(content, str) else str(content)

            await updater.add_artifact([Part(text=final_text)], name="最终回答", last_chunk=True)
            await updater.complete()
        except Exception as error:  # noqa: BLE001 —— 任何异常都转成 FAILED 终态，不让协议层挂死
            await updater.failed(updater.new_agent_message([new_text_part(f"执行出错: {error}")]))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)  # type: ignore[attr-defined]
        await updater.cancel()


def build_agent_card() -> AgentCard:
    return AgentCard(
        name="langgraph-weather-agent",
        description="LangGraph ReAct 测试 Agent：可调用玩具天气工具回答城市天气问题。互操作实验用。",
        version="0.1.0",
        supported_interfaces=[
            AgentInterface(url=f"http://{HOST}:{PORT}/", protocol_binding="JSONRPC", protocol_version="1.0"),
        ],
        capabilities=AgentCapabilities(streaming=True, push_notifications=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain", "application/json"],
        skills=[
            AgentSkill(
                id="weather-query",
                name="城市天气问答",
                description="根据城市名返回今日天气（玩具工具，固定数据）。",
                tags=["weather", "demo"],
                examples=["上海今天天气怎么样？"],
            ),
        ],
    )


async def main() -> None:
    fake = os.environ.get("LANGGRAPH_FAKE", "").strip() in {"1", "true", "yes"}
    graph = build_fake_graph() if fake else build_react_graph()
    print(f"🧠 LangGraph 图: {'FAKE（确定性）' if fake else 'create_react_agent（DashScope）'}")

    card = build_agent_card()
    handler = DefaultRequestHandler(
        agent_executor=LangGraphExecutor(graph),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    app = Starlette(
        routes=create_agent_card_routes(card, card_url=AGENT_CARD_WELL_KNOWN_PATH, cache_control="public, max-age=300")
        + create_jsonrpc_routes(handler, rpc_url="/"),
    )
    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="warning")
    print(f"🤖 A2A 服务端: {card.supported_interfaces[0].url}")
    print(f"🪪 名片: http://{HOST}:{PORT}{AGENT_CARD_WELL_KNOWN_PATH}")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
