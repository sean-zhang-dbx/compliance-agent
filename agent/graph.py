"""
LangGraph state machine for the GSK Controls Evidence Review Agent.

Implements the FRMC control testing workflow with:
- Retry + exponential backoff for 429 rate limit errors
- Cancellation support via thread-local flag
- Hybrid tool loading: UC functions for pure-logic tools, @tool for file I/O
"""

from __future__ import annotations

import time
import threading
from typing import Annotated, Any, Sequence, TypedDict

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt.tool_node import ToolNode

from agent.config import LLM_ENDPOINT, UC_CATALOG, UC_SCHEMA
from agent.prompts import SYSTEM_PROMPT

# -- Hybrid tool loading -------------------------------------------------------
# Pure-logic tools from Unity Catalog (no file I/O or authenticated API calls)
from databricks_langchain import UCFunctionToolkit

_UC_FUNCTION_NAMES = [
    f"{UC_CATALOG}.{UC_SCHEMA}.generate_test_plan",
    f"{UC_CATALOG}.{UC_SCHEMA}.ask_user",
]

_toolkit = UCFunctionToolkit(function_names=_UC_FUNCTION_NAMES)
_uc_tools = _toolkit.tools

# File I/O and LLM-powered tools from local @tool implementations
# (UC sandbox doesn't have filesystem access or Databricks auth)
from agent.tools import (
    list_projects,
    load_engagement,
    parse_workbook,
    extract_workbook_images,
    review_document,
    review_screenshot,
    analyze_email,
    execute_test,
    aggregate_test_results,
    compile_results,
    fill_workbook,
    save_report,
    send_email,
    announce_plan,
    batch_review_evidence,
    batch_execute_tests,
)

ALL_TOOLS = _uc_tools + [
    list_projects,
    load_engagement,
    parse_workbook,
    extract_workbook_images,
    review_document,
    review_screenshot,
    analyze_email,
    execute_test,
    aggregate_test_results,
    compile_results,
    fill_workbook,
    save_report,
    send_email,
    announce_plan,
    batch_review_evidence,
    batch_execute_tests,
]

_cancel_flags = threading.local()


def request_cancel():
    """Set the cancel flag for the current thread."""
    _cancel_flags.cancelled = True


def clear_cancel():
    """Clear the cancel flag for the current thread."""
    _cancel_flags.cancelled = False


def is_cancelled() -> bool:
    return getattr(_cancel_flags, "cancelled", False)


class CancelledError(Exception):
    pass


class AgentState(TypedDict):
    messages: Annotated[Sequence, add_messages]


MAX_RETRIES = 6
BACKOFF_BASE = 5


def _should_continue(state: AgentState) -> str:
    if is_cancelled():
        return "end"
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tools"
    return "end"


def _call_model(state: AgentState) -> dict:
    if is_cancelled():
        raise CancelledError("Run cancelled by user")

    from databricks_langchain import ChatDatabricks

    llm = ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0)
    llm_with_tools = llm.bind_tools(ALL_TOOLS)

    messages = [SystemMessage(content=SYSTEM_PROMPT)] + list(state["messages"])

    for attempt in range(MAX_RETRIES + 1):
        if is_cancelled():
            raise CancelledError("Run cancelled by user")
        try:
            response = llm_with_tools.invoke(messages)
            return {"messages": [response]}
        except Exception as e:
            err_str = str(e)
            is_rate_limit = "429" in err_str or "REQUEST_LIMIT_EXCEEDED" in err_str or "rate limit" in err_str.lower()
            if is_rate_limit and attempt < MAX_RETRIES:
                wait = BACKOFF_BASE * (2 ** attempt)
                print(f"[rate-limit] 429 on attempt {attempt+1}, retrying in {wait}s...")
                for _ in range(int(wait * 2)):
                    if is_cancelled():
                        raise CancelledError("Run cancelled by user during rate-limit wait")
                    time.sleep(0.5)
                continue
            raise


def build_graph() -> Any:
    """Build and compile the LangGraph state machine."""
    graph = StateGraph(AgentState)

    graph.add_node("agent", RunnableLambda(_call_model))
    graph.add_node("tools", ToolNode(ALL_TOOLS))

    graph.set_entry_point("agent")

    graph.add_conditional_edges(
        "agent",
        _should_continue,
        {"tools": "tools", "end": END},
    )
    graph.add_edge("tools", "agent")

    return graph.compile()
