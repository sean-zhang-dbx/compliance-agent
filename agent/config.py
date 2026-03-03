"""
Configuration for the GSK Controls Evidence Review Agent.

Override via environment variables or Databricks secrets.
"""

import os

# -- LLM endpoints (Databricks Foundation Model APIs) --
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "databricks-claude-3-7-sonnet")
VISION_LLM_ENDPOINT = os.getenv("VISION_LLM_ENDPOINT", "databricks-claude-3-7-sonnet")

# -- Unity Catalog --
UC_CATALOG = os.getenv("UC_CATALOG", "catalog_sandbox_e1b2kq")
UC_SCHEMA = os.getenv("UC_SCHEMA", "gsk_compliance")
UC_VOLUME = os.getenv("UC_VOLUME", "evidence_files")
VOLUME_PATH = f"/Volumes/{UC_CATALOG}/{UC_SCHEMA}/{UC_VOLUME}"

# -- Projects --
PROJECTS_BASE_PATH = os.getenv(
    "PROJECTS_BASE_PATH",
    f"/Volumes/{UC_CATALOG}/{UC_SCHEMA}/{UC_VOLUME}/projects",
)
PROJECTS_LOCAL_PATH = os.getenv(
    "PROJECTS_LOCAL_PATH",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "sample_data", "projects"),
)

# -- Microsoft Graph API (email sending) --
GRAPH_TENANT_ID = os.getenv("GRAPH_TENANT_ID", "")
GRAPH_CLIENT_ID = os.getenv("GRAPH_CLIENT_ID", "")
GRAPH_CLIENT_SECRET = os.getenv("GRAPH_CLIENT_SECRET", "")
GRAPH_SENDER_EMAIL = os.getenv("GRAPH_SENDER_EMAIL", "sean.zhang@databricks.com")

# -- Agent identity --
AGENT_NAME = "GSK Controls Evidence Review Agent"
AGENT_VERSION = "3.1.0"
