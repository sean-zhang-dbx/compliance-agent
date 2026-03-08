"""
Volume-first artifact storage for the GSK Compliance Agent.

All run artifacts (reports, workbooks, step outputs, manifests) are stored
primarily in UC Volumes.  Local filesystem is used only as a write-through
cache for the current process lifetime (local dev convenience; lost on
Databricks App restarts).

Volume layout
=============
/Volumes/{catalog}/{schema}/{volume}/
└── projects/
    └── {project_dir}/
        ├── engagement.json
        ├── engagement_workbook.xlsx
        ├── evidence/  …
        └── runs/
            └── {run_id}/
                ├── run_manifest.json
                ├── report.md
                ├── {CTRL}_completed_{ts}.xlsx
                └── steps/
                    ├── 000_load_engagement.json
                    └── …
"""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("volume_store")

_ws_client = None


def _ws():
    """Return a cached WorkspaceClient singleton."""
    global _ws_client
    if _ws_client is None:
        from databricks.sdk import WorkspaceClient
        _ws_client = WorkspaceClient()
    return _ws_client


def _volume_base() -> str:
    from agent.config import PROJECTS_BASE_PATH
    return PROJECTS_BASE_PATH


# ── path helpers ────────────────────────────────────────────────────────
def run_path(project_dir: str, run_id: str) -> str:
    return f"{_volume_base()}/{project_dir}/runs/{run_id}"


def step_path(project_dir: str, run_id: str, filename: str) -> str:
    return f"{run_path(project_dir, run_id)}/steps/{filename}"


def artifact_path(project_dir: str, run_id: str, filename: str) -> str:
    return f"{run_path(project_dir, run_id)}/{filename}"


# ── write operations ────────────────────────────────────────────────────
def upload_text(vol_path: str, content: str) -> str:
    """Upload UTF-8 text to a volume path.  Returns the path on success."""
    _ws().files.upload(vol_path, io.BytesIO(content.encode("utf-8")), overwrite=True)
    log.info("Uploaded text → %s (%d bytes)", vol_path, len(content))
    return vol_path


def upload_bytes(vol_path: str, data: bytes) -> str:
    """Upload binary data to a volume path.  Returns the path on success."""
    _ws().files.upload(vol_path, io.BytesIO(data), overwrite=True)
    log.info("Uploaded binary → %s (%d bytes)", vol_path, len(data))
    return vol_path


def save_step_artifact(
    project_dir: str,
    run_id: str,
    step_index: int,
    tool_name: str,
    content: str,
    *,
    suffix: str = ".json",
) -> str:
    """Save a tool step's output into the steps/ subfolder.

    Returns the volume path on success, empty string on failure.
    """
    fname = f"{step_index:03d}_{tool_name}{suffix}"
    path = step_path(project_dir, run_id, fname)
    try:
        upload_text(path, content)
        return path
    except Exception as exc:
        log.warning("Failed to save step artifact %s: %s", path, exc)
        return ""


def save_run_artifact(
    project_dir: str,
    run_id: str,
    filename: str,
    content: str | bytes,
) -> str:
    """Save a top-level run artifact (report, manifest, workbook).

    Returns the volume path on success, empty string on failure.
    """
    path = artifact_path(project_dir, run_id, filename)
    try:
        if isinstance(content, bytes):
            upload_bytes(path, content)
        else:
            upload_text(path, content)
        return path
    except Exception as exc:
        log.warning("Failed to save run artifact %s: %s", path, exc)
        return ""


def save_manifest(project_dir: str, run_id: str, manifest: dict) -> str:
    return save_run_artifact(
        project_dir, run_id, "run_manifest.json", json.dumps(manifest, indent=2)
    )


# ── read operations ─────────────────────────────────────────────────────
def download_text(vol_path: str) -> str:
    resp = _ws().files.download(vol_path)
    return resp.contents.read().decode("utf-8")


def download_bytes(vol_path: str) -> bytes:
    resp = _ws().files.download(vol_path)
    return resp.contents.read()


def list_dir(vol_path: str) -> list[Any]:
    """List directory contents.  Returns an empty list on error."""
    try:
        return list(_ws().files.list_directory_contents(vol_path))
    except Exception:
        return []


def list_runs(project_dir: str) -> list[dict]:
    """List all runs for a project, newest first.

    Each run includes an ``artifacts`` list with downloadable file entries
    (filename, tool, location) so the frontend can render download links
    without a separate manifest fetch.
    """
    runs_base = f"{_volume_base()}/{project_dir}/runs"
    items = list_dir(runs_base)
    runs = []
    for item in sorted(items, key=lambda x: x.name or "", reverse=True):
        if not item.is_directory:
            continue
        run_id = (item.name or "").rstrip("/")
        run_info: dict[str, Any] = {"run_id": run_id, "source": "volume"}
        try:
            manifest_path = f"{runs_base}/{run_id}/run_manifest.json"
            m = json.loads(download_text(manifest_path))
            raw_artifacts = m.get("artifacts", [])
            downloadable = [
                {
                    "filename": a["filename"],
                    "tool": a.get("tool", ""),
                    "location": a.get("location", ""),
                }
                for a in raw_artifacts
                if a.get("filename")
                and not a["filename"].endswith("run_manifest.json")
            ]
            run_info.update({
                "status": m.get("status", "unknown"),
                "started_at": m.get("started_at", ""),
                "completed_at": m.get("completed_at", ""),
                "total_steps": m.get("total_steps", 0),
                "artifact_count": len(downloadable),
                "artifacts": downloadable,
            })
        except Exception:
            pass
        runs.append(run_info)
    return runs


def download_artifact(project_dir: str, run_id: str, filename: str) -> bytes | None:
    """Download a run artifact.  Returns None if not found.

    Tries top-level first, then steps/ subfolder.
    """
    for path in (
        artifact_path(project_dir, run_id, filename),
        step_path(project_dir, run_id, filename),
    ):
        try:
            return download_bytes(path)
        except Exception:
            continue
    return None
