"""
LangGraph state machine for the GSK Controls Evidence Review Agent.

Implements the FRMC control testing workflow:

  ParseWorkbook -> ValidatePopulation -> PrepareSampling 
    -> ExecuteTests (loop A-F) -> GenerateReport

The coordinator LLM decides which tools to call at each step.
"""

from __future__ import annotations

from typing import Annotated, Any, Sequence, TypedDict

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt.tool_node import ToolNode

from agent.config import LLM_ENDPOINT
from agent.prompts import SYSTEM_PROMPT
from agent.tools import ALL_TOOLS


class AgentState(TypedDict):
    messages: Annotated[Sequence, add_messages]


def _should_continue(state: AgentState) -> str:
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tools"
    return "end"


def _call_model(state: AgentState) -> dict:
    from databricks_langchain import ChatDatabricks

    llm = ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0)
    llm_with_tools = llm.bind_tools(ALL_TOOLS)

    messages = [SystemMessage(content=SYSTEM_PROMPT)] + list(state["messages"])
    response = llm_with_tools.invoke(messages)
    return {"messages": [response]}


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
