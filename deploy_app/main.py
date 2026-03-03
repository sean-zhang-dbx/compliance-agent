"""
Databricks Apps entry point — FastAPI server wrapping the compliance agent.

Uses MLflow AgentServer for the /invocations endpoint, plus custom routes
for file upload, health checks, project listing, and the static React frontend.
"""

import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

sys.path.insert(0, str(Path(__file__).parent))

app = FastAPI(
    title="GSK Controls Evidence Review Agent",
    version="3.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health & metadata
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    from agent.config import AGENT_NAME, AGENT_VERSION
    return {"status": "healthy", "agent": AGENT_NAME, "version": AGENT_VERSION}


@app.get("/api/config")
async def get_config():
    from agent.config import AGENT_NAME, AGENT_VERSION, UC_CATALOG, UC_SCHEMA, UC_VOLUME
    return {
        "agent_name": AGENT_NAME,
        "agent_version": AGENT_VERSION,
        "catalog": UC_CATALOG,
        "schema": UC_SCHEMA,
        "volume": UC_VOLUME,
    }


# ---------------------------------------------------------------------------
# Project listing
# ---------------------------------------------------------------------------
@app.get("/api/projects")
async def get_projects():
    """List all available control testing projects."""
    from agent.config import PROJECTS_LOCAL_PATH, PROJECTS_BASE_PATH
    projects = []

    local_base = Path(PROJECTS_LOCAL_PATH)
    if local_base.exists():
        for d in sorted(local_base.iterdir()):
            if d.is_dir():
                eng_file = d / "engagement.json"
                info = {"project_dir": d.name, "source": "local"}
                if eng_file.exists():
                    try:
                        eng = json.loads(eng_file.read_text())
                        co = eng.get("control_objective", {})
                        info.update({
                            "engagement_number": eng.get("number", ""),
                            "engagement_name": eng.get("name", ""),
                            "control_id": co.get("control_id", ""),
                            "control_name": co.get("control_name", ""),
                            "domain": co.get("domain", ""),
                        })
                    except Exception:
                        pass
                projects.append(info)

    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()
        items = w.files.list_directory_contents(PROJECTS_BASE_PATH)
        for item in items:
            if item.is_directory:
                name = item.path.rstrip("/").split("/")[-1]
                if not any(p["project_dir"] == name for p in projects):
                    projects.append({"project_dir": name, "source": "uc_volume"})
    except Exception:
        pass

    return {"projects": projects, "count": len(projects)}


# ---------------------------------------------------------------------------
# File upload
# ---------------------------------------------------------------------------
UPLOAD_DIR = Path("/tmp/compliance_uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload an engagement workbook, population data, or supporting document."""
    if not file.filename:
        raise HTTPException(400, "No filename")

    allowed_extensions = {".xlsx", ".xlsm", ".xlsb", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".msg", ".eml"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_extensions:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    dest = UPLOAD_DIR / file.filename
    content = await file.read()
    dest.write_bytes(content)

    volume_path = None
    try:
        from agent.config import VOLUME_PATH
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()
        volume_path = f"{VOLUME_PATH}/{file.filename}"
        w.files.upload(volume_path, content, overwrite=True)
    except Exception:
        volume_path = None

    return JSONResponse({
        "filename": file.filename,
        "size_bytes": len(content),
        "local_path": str(dest),
        "volume_path": volume_path,
        "status": "uploaded",
    })


@app.get("/api/files")
async def list_files():
    """List uploaded files."""
    files = []
    for f in UPLOAD_DIR.iterdir():
        if f.is_file():
            files.append({
                "filename": f.name,
                "size_bytes": f.stat().st_size,
                "local_path": str(f),
            })
    return {"files": files}


# ---------------------------------------------------------------------------
# Agent invocations — async poll pattern (avoids proxy timeout)
# ---------------------------------------------------------------------------
import threading
import uuid as _uuid
import time as _time

_tasks: dict[str, dict] = {}
_TASK_TTL = 600


def _cleanup_tasks():
    now = _time.time()
    stale = [k for k, v in _tasks.items() if now - v.get("created", 0) > _TASK_TTL]
    for k in stale:
        _tasks.pop(k, None)


@app.post("/invocations")
async def invocations(request: dict):
    """Start an agent task and return a task_id for polling.

    The agent runs in a background thread.  The frontend polls
    GET /api/tasks/{task_id} every few seconds to retrieve the result.
    This avoids Databricks Apps reverse-proxy hard timeout (~120 s).
    """
    messages = request.get("input") or []
    if not messages or not any(m.get("content") for m in messages):
        raise HTTPException(400, "Please provide at least one message with content.")

    _cleanup_tasks()

    task_id = _uuid.uuid4().hex[:12]
    _tasks[task_id] = {"status": "running", "created": _time.time()}

    def _run():
        try:
            from agent.agent import AGENT
            from mlflow.types.responses import ResponsesAgentRequest
            agent_request = ResponsesAgentRequest(**request)
            response = AGENT.predict(agent_request)
            _tasks[task_id]["result"] = response.model_dump(exclude_none=True)
            _tasks[task_id]["status"] = "complete"
        except Exception as e:
            import traceback
            traceback.print_exc()
            _tasks[task_id]["error"] = str(e)
            _tasks[task_id]["status"] = "error"

    threading.Thread(target=_run, daemon=True).start()
    return {"task_id": task_id, "status": "running"}


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str):
    """Poll for the result of a background agent task."""
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found or expired")

    if task["status"] == "running":
        elapsed = _time.time() - task.get("created", _time.time())
        return {"task_id": task_id, "status": "running", "elapsed_seconds": round(elapsed, 1)}

    if task["status"] == "error":
        return {"task_id": task_id, "status": "error", "detail": task.get("error", "Unknown error")}

    result = task.get("result", {})
    _tasks.pop(task_id, None)
    return {"task_id": task_id, "status": "complete", **result}


# ---------------------------------------------------------------------------
# Static frontend + SPA catch-all
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).parent / "frontend" / "dist"
if FRONTEND_DIR.exists():
    _index_html = FRONTEND_DIR / "index.html"

    @app.get("/{full_path:path}")
    async def spa_catch_all(full_path: str):
        """Serve static assets if they exist, otherwise fall back to index.html for SPA routing."""
        file = FRONTEND_DIR / full_path
        if full_path and file.exists() and file.is_file():
            return FileResponse(file)
        return FileResponse(_index_html)
else:
    @app.get("/")
    async def root():
        return {
            "message": "GSK Controls Evidence Review Agent API",
            "docs": "/docs",
            "health": "/health",
        }
