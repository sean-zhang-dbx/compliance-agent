"""
LangGraph state machine for the GSK Controls Evidence Review Agent.

All 18 tools are registered as Unity Catalog Python functions and loaded
via UCFunctionToolkit.  Tools that need runtime context (run_id,
project_dir, app_base_url) are wrapped to auto-inject values from
contextvars so the LLM never has to pass them.
"""

from __future__ import annotations

import time
import threading
from typing import Annotated, Any, Sequence, TypedDict

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import StructuredTool
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt.tool_node import ToolNode
from pydantic import create_model

from agent.config import LLM_ENDPOINT, UC_CATALOG, UC_SCHEMA
from agent.prompts import SYSTEM_PROMPT
from agent.run_context import get_run_id, get_project_dir, get_app_base_url

# -- Load all tools from Unity Catalog ----------------------------------------

from databricks_langchain import UCFunctionToolkit

_TOOL_NAMES = [
    "list_projects",
    "load_engagement",
    "announce_plan",
    "parse_workbook",
    "extract_workbook_images",
    "review_document",
    "review_screenshot",
    "analyze_email",
    "generate_test_plan",
    "execute_test",
    "aggregate_test_results",
    "compile_results",
    "fill_workbook",
    "save_report",
    "send_email",
    "ask_user",
    "batch_review_evidence",
    "batch_execute_tests",
]

_UC_FUNCTION_NAMES = [f"{UC_CATALOG}.{UC_SCHEMA}.{name}" for name in _TOOL_NAMES]

_toolkit = UCFunctionToolkit(function_names=_UC_FUNCTION_NAMES)

# -- Context injection wrapper -------------------------------------------------
# UC functions that need runtime context declare run_id / project_dir /
# app_base_url as parameters.  We strip these from the LLM-facing schema
# and inject them from contextvars at call time.

_CONTEXT_PARAMS = {"run_id", "project_dir", "app_base_url"}


def _wrap_tools(uc_tools: list) -> list:
    """Wrap UC tools to auto-inject context parameters the LLM should not see."""
    wrapped = []
    for tool in uc_tools:
        schema = tool.args_schema
        ctx_keys = set(schema.model_fields.keys()) & _CONTEXT_PARAMS

        if not ctx_keys:
            wrapped.append(tool)
            continue

        # Build a new Pydantic model excluding context fields
        business_fields: dict = {}
        for field_name, field_info in schema.model_fields.items():
            if field_name not in ctx_keys:
                business_fields[field_name] = (field_info.annotation, field_info)

        NewSchema = create_model(f"{tool.name}_business", **business_fields)

        def _make_fn(_tool, _ctx_keys):
            def fn(**kwargs):
                if "run_id" in _ctx_keys:
                    kwargs["run_id"] = get_run_id()
                if "project_dir" in _ctx_keys:
                    kwargs["project_dir"] = get_project_dir()
                if "app_base_url" in _ctx_keys:
                    kwargs["app_base_url"] = get_app_base_url()
                return _tool.invoke(kwargs)
            return fn

        wrapped.append(StructuredTool(
            name=tool.name,
            description=tool.description,
            func=_make_fn(tool, ctx_keys),
            args_schema=NewSchema,
        ))
    return wrapped


ALL_TOOLS = _wrap_tools(_toolkit.tools)

# -- Cancellation support ------------------------------------------------------

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
