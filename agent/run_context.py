"""
Run context shared between the backend and tools.

Uses contextvars so values propagate to ThreadPoolExecutor threads
(e.g. LangGraph ToolNode parallel execution).
"""

from contextvars import ContextVar
from typing import Callable

_run_id: ContextVar[str] = ContextVar("run_id", default="")
_project_dir: ContextVar[str] = ContextVar("project_dir", default="")
_app_base_url: ContextVar[str] = ContextVar("app_base_url", default="")
_progress_callback: ContextVar[Callable | None] = ContextVar("progress_callback", default=None)


def set_run_context(*, run_id: str, project_dir: str, app_base_url: str):
    _run_id.set(run_id)
    _project_dir.set(project_dir)
    _app_base_url.set(app_base_url.rstrip("/"))


def get_run_id() -> str:
    return _run_id.get()


def get_project_dir() -> str:
    return _project_dir.get()


def get_app_base_url() -> str:
    return _app_base_url.get()


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


def set_progress_callback(cb: Callable | None):
    _progress_callback.set(cb)


def get_progress_callback() -> Callable | None:
    return _progress_callback.get()


def report_progress(completed: int, total: int, detail: str = ""):
    """Report batch progress to the UI if a callback is registered."""
    cb = _progress_callback.get()
    if cb:
        cb(completed, total, detail)


def snapshot_context() -> dict:
    """Capture the current run context as a plain dict."""
    return {
        "run_id": get_run_id(),
        "project_dir": get_project_dir(),
        "app_base_url": get_app_base_url(),
        "_progress_callback": get_progress_callback(),
    }


def restore_context(ctx: dict):
    """Restore a snapshotted run context."""
    set_run_context(
        run_id=ctx.get("run_id", ""),
        project_dir=ctx.get("project_dir", ""),
        app_base_url=ctx.get("app_base_url", ""),
    )
    set_progress_callback(ctx.get("_progress_callback"))
