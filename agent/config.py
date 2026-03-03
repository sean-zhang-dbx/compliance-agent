"""
Configuration for the GSK Controls Evidence Review Agent.

Override via environment variables or Databricks secrets.
"""

import base64
import os

# -- LLM endpoints (Databricks Foundation Model APIs) --
# Sonnet 4.6 for reasoning-heavy tasks (orchestration, test execution, report generation, vision)
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "databricks-claude-sonnet-4-6")
VISION_LLM_ENDPOINT = os.getenv("VISION_LLM_ENDPOINT", "databricks-claude-sonnet-4-6")
# Haiku 4.5 for fast extraction tasks (document review, email parsing)
FAST_LLM_ENDPOINT = os.getenv("FAST_LLM_ENDPOINT", "databricks-claude-haiku-4-5")

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

# -- Email (Gmail SMTP with App Password) --
SMTP_EMAIL = os.getenv("SMTP_EMAIL", "seanxzhang94@gmail.com")
SMTP_DISPLAY_NAME = os.getenv("SMTP_DISPLAY_NAME", "GSK Compliance Agent")

_smtp_password_cache: str | None = None

def get_smtp_password() -> str:
    """Lazy-fetch SMTP password: env var first, then Databricks secrets."""
    global _smtp_password_cache
    if _smtp_password_cache is not None:
        return _smtp_password_cache

    pw = os.getenv("SMTP_APP_PASSWORD", "")
    if pw:
        _smtp_password_cache = pw
        return pw

    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()
        resp = w.secrets.get_secret(scope="gsk-compliance", key="smtp-app-password")
        if resp.value:
            decoded = base64.b64decode(resp.value).decode("utf-8")
            _smtp_password_cache = decoded
            print(f"[config] SMTP password loaded from Databricks secrets ({len(decoded)} chars)")
            return decoded
    except Exception as exc:
        print(f"[config] Failed to load SMTP password from secrets: {exc}")

    _smtp_password_cache = ""
    return ""

# Keep for backward compat but use the lazy getter in send_email
SMTP_APP_PASSWORD = ""

# -- App URL (so tools can build clickable links to artifacts) --
APP_BASE_URL = os.getenv("APP_BASE_URL", "")

# -- Parallelism --
MAX_PARALLEL_EVIDENCE = int(os.getenv("MAX_PARALLEL_EVIDENCE", "4"))
MAX_PARALLEL_TESTS = int(os.getenv("MAX_PARALLEL_TESTS", "3"))

# -- Agent identity --
AGENT_NAME = "GSK Controls Evidence Review Agent"
AGENT_VERSION = "7.0.0"
