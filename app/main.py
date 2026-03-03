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

sys.path.insert(0, str(Path(__file__).parent.parent))

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
# Agent invocations
# ---------------------------------------------------------------------------
@app.post("/invocations")
async def invocations(request: dict):
    """Query the compliance agent. Compatible with MLflow ResponsesAgent schema."""
    from agent.agent import AGENT
    from mlflow.types.responses import ResponsesAgentRequest

    try:
        agent_request = ResponsesAgentRequest(**request)
        response = AGENT.predict(agent_request)
        return response.model_dump(exclude_none=True)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, str(e))


@app.post("/invocations/stream")
async def invocations_stream(request: dict):
    """Streaming agent invocation."""
    from agent.agent import AGENT
    from mlflow.types.responses import ResponsesAgentRequest
    from fastapi.responses import StreamingResponse
    import json as json_mod

    agent_request = ResponsesAgentRequest(**request)

    async def event_generator():
        for event in AGENT.predict_stream(agent_request):
            yield f"data: {json_mod.dumps(event.model_dump(exclude_none=True))}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).parent.parent / "frontend" / "dist"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    @app.get("/")
    async def root():
        return {
            "message": "GSK Controls Evidence Review Agent API",
            "docs": "/docs",
            "health": "/health",
        }
