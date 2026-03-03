"""
Thread-local run context shared between the backend and tools.

The backend sets run_id, project_dir, and app_base_url before invoking the
agent. Tools read these values to construct accessible URLs for artifacts.
"""

import threading

_ctx = threading.local()


def set_run_context(*, run_id: str, project_dir: str, app_base_url: str):
    _ctx.run_id = run_id
    _ctx.project_dir = project_dir
    _ctx.app_base_url = app_base_url.rstrip("/")


def get_run_id() -> str:
    return getattr(_ctx, "run_id", "")


def get_project_dir() -> str:
    return getattr(_ctx, "project_dir", "")


def get_app_base_url() -> str:
    return getattr(_ctx, "app_base_url", "")


def get_artifact_url(filename: str) -> str:
    """Build the full app URL for a run artifact, or empty string if unavailable."""
    base = get_app_base_url()
    proj = get_project_dir()
    rid = get_run_id()
    if base and proj and rid:
        return f"{base}/api/artifacts/{proj}/{rid}/{filename}"
    return ""


def get_report_url() -> str:
    return get_artifact_url("report.md")


def snapshot_context() -> dict:
    """Capture the current thread's run context as a plain dict."""
    return {
        "run_id": get_run_id(),
        "project_dir": get_project_dir(),
        "app_base_url": get_app_base_url(),
    }


def restore_context(ctx: dict):
    """Restore a snapshotted run context onto the current thread."""
    set_run_context(
        run_id=ctx.get("run_id", ""),
        project_dir=ctx.get("project_dir", ""),
        app_base_url=ctx.get("app_base_url", ""),
    )
