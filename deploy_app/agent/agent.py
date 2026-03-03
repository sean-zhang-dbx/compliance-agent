"""
GSK Controls Evidence Review Agent — MLflow ResponsesAgent wrapper.

This module wraps the LangGraph compliance agent in MLflow's ResponsesAgent
interface, making it deployable to:
  - Databricks Model Serving
  - Databricks Apps (via AgentServer)
  - Any MLflow-compatible endpoint

Usage:
    # Local testing
    from agent.agent import AGENT
    from mlflow.types.responses import ResponsesAgentRequest
    
    request = ResponsesAgentRequest(
        input=[{"role": "user", "content": "Review the engagement workbook at /path/to/workbook.xlsx"}]
    )
    response = AGENT.predict(request)
"""

import os
import mlflow
from mlflow.pyfunc import ResponsesAgent
from mlflow.types.responses import (
    ResponsesAgentRequest,
    ResponsesAgentResponse,
    ResponsesAgentStreamEvent,
    output_to_responses_items_stream,
    to_chat_completions_input,
)
from typing import Generator

mlflow.langchain.autolog()

_experiment_name = os.getenv(
    "MLFLOW_EXPERIMENT_NAME",
    "/Users/sean.zhang@databricks.com/gsk-compliance-agent-traces",
)
try:
    mlflow.set_experiment(_experiment_name)
except Exception:
    pass


class ComplianceReviewAgent(ResponsesAgent):
    """FRMC Controls Evidence Review Agent.
    
    Orchestrates the full control testing workflow via LangGraph,
    exposing it through the standard ResponsesAgent interface.
    """

    def __init__(self):
        self._graph = None

    @property
    def graph(self):
        if self._graph is None:
            from agent.graph import build_graph
            self._graph = build_graph()
        return self._graph

    def predict(self, request: ResponsesAgentRequest) -> ResponsesAgentResponse:
        outputs = [
            event.item
            for event in self.predict_stream(request)
            if event.type == "response.output_item.done"
        ]
        return ResponsesAgentResponse(output=outputs)

    def predict_stream(
        self, request: ResponsesAgentRequest
    ) -> Generator[ResponsesAgentStreamEvent, None, None]:
        messages = to_chat_completions_input(
            [m.model_dump() for m in request.input]
        )

        for event in self.graph.stream(
            {"messages": messages}, stream_mode=["updates"]
        ):
            if event[0] == "updates":
                for node_data in event[1].values():
                    if node_data.get("messages"):
                        yield from output_to_responses_items_stream(
                            node_data["messages"]
                        )


AGENT = ComplianceReviewAgent()
mlflow.models.set_model(AGENT)
