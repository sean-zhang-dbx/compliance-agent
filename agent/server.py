"""
Shared FastAPI server logic for the GSK Controls Evidence Review Agent.

Both app/main.py (local dev) and deploy_app/main.py (Databricks Apps)
import create_app() from here, eliminating code duplication. All route
handlers, task management, artifact storage, and summarisation live in
this single module.
"""

import io
import json
import re
import threading
import time as _time
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.responses import Response


# ---------------------------------------------------------------------------
# Artifact helpers  (volume-first; local is a write-through cache)
# ---------------------------------------------------------------------------

def _save_to_volume(project_dir: str, run_id: str, filename: str,
                    content: str | bytes, *, is_step: bool = False) -> str:
    """Write an artifact to the UC Volume (primary store).

    Returns the volume path on success, empty string on failure.
    """
    from agent import volume_store as vs
    try:
        if is_step:
            path = vs.step_path(project_dir, run_id, filename)
        else:
            path = vs.artifact_path(project_dir, run_id, filename)
        if isinstance(content, bytes):
            vs.upload_bytes(path, content)
        else:
            vs.upload_text(path, content)
        return path
    except Exception as exc:
        print(f"[volume] Upload failed for {filename}: {exc}")
        return ""


def _cache_local(project_dir: str, run_id: str, filename: str,
                 content: str | bytes, *, is_step: bool = False):
    """Write-through cache to local filesystem (optional, best-effort)."""
    try:
        from agent.config import PROJECTS_LOCAL_PATH
        sub = "steps" if is_step else ""
        run_dir = Path(PROJECTS_LOCAL_PATH) / project_dir / "runs" / run_id
        if sub:
            run_dir = run_dir / sub
        run_dir.mkdir(parents=True, exist_ok=True)
        p = run_dir / filename
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content)
    except Exception:
        pass


def _step_filename(tool_name: str, step_index: int, args: dict) -> str:
    """Generate a descriptive filename for a step artifact in steps/."""
    short = _short_tool_name(tool_name)
    tag = ""
    if short in ("review_document", "review_screenshot", "analyze_email"):
        fname = (args.get("file_path", "") or "").split("/")[-1]
        tag = f"_{Path(fname).stem}" if fname else ""
    elif short == "execute_test":
        tag = f"_{args.get('test_ref', 'X')}"
    return f"{step_index:03d}_{short}{tag}.json"


# ---------------------------------------------------------------------------
# Task management
# ---------------------------------------------------------------------------
_tasks: dict[str, dict] = {}
_TASK_TTL = 600

def _uc_name(short: str) -> str:
    """Build the fully qualified UC function name used by UCFunctionToolkit."""
    from agent.config import UC_CATALOG, UC_SCHEMA
    return f"{UC_CATALOG}__{UC_SCHEMA}__{short}"

_SHORT_NAMES = [
    "list_projects", "load_engagement", "announce_plan", "parse_workbook",
    "extract_workbook_images", "batch_review_evidence", "batch_execute_tests",
    "review_document", "review_screenshot", "analyze_email",
    "generate_test_plan", "execute_test", "aggregate_test_results",
    "compile_results", "fill_workbook", "save_report", "send_email", "ask_user",
]
# All tools are now loaded from UC — tool names use catalog__schema__name format

_LABEL_MAP = {
    "list_projects": "Discovering projects",
    "load_engagement": "Loading engagement instructions",
    "announce_plan": "Announcing assessment plan",
    "parse_workbook": "Parsing workbook (data, rules, sample)",
    "extract_workbook_images": "Extracting embedded images",
    "batch_review_evidence": "Reviewing all evidence (parallel)",
    "batch_execute_tests": "Executing all tests (parallel)",
    "review_document": "Reviewing PDF document",
    "review_screenshot": "Analyzing screenshot / image",
    "analyze_email": "Analyzing email evidence",
    "generate_test_plan": "Computing test matrix",
    "execute_test": "Testing attribute",
    "aggregate_test_results": "Aggregating results (deterministic)",
    "compile_results": "Compiling results into report",
    "fill_workbook": "Filling out engagement workbook",
    "save_report": "Saving report to project",
    "send_email": "Sending notification email",
    "ask_user": "Waiting for user input",
}

# Mapping from plan step IDs to the tools that belong to that phase.
# Used to auto-advance plan checklist items as tools start/complete.
PLAN_TOOL_MAP: dict[str, list[str]] = {
    "load": ["load_engagement", "parse_workbook", "extract_workbook_images"],
    "images": ["extract_workbook_images"],
    "evidence": ["batch_review_evidence", "review_document", "review_screenshot", "analyze_email"],
    "test": ["generate_test_plan", "batch_execute_tests", "execute_test"],
    "aggregate": ["aggregate_test_results"],
    "compile": ["compile_results"],
    "deliver": ["fill_workbook", "save_report", "send_email"],
}

def _advance_plan(task: dict, tool_short: str, event: str):
    """Update plan step statuses based on tool start/completion events.
    event is 'start' or 'complete'."""
    plan = task.get("plan")
    if not plan:
        return
    for ps in plan["steps"]:
        pid = ps["id"]
        mapped_tools = PLAN_TOOL_MAP.get(pid, [])
        if tool_short not in mapped_tools:
            continue
        if event == "start" and ps["status"] == "pending":
            ps["status"] = "in_progress"
        elif event == "complete" and ps["status"] in ("pending", "in_progress"):
            started_tools = {
                _short_tool_name(s["tool"])
                for s in task.get("steps", [])
                if _short_tool_name(s["tool"]) in mapped_tools
            }
            completed_tools = {
                _short_tool_name(s["tool"])
                for s in task.get("steps", [])
                if s.get("status") == "complete" and _short_tool_name(s["tool"]) in mapped_tools
            }
            still_running = started_tools - completed_tools
            if not still_running:
                ps["status"] = "complete"
            elif ps["status"] == "pending":
                ps["status"] = "in_progress"

TOOL_LABELS: dict[str, str] = {}
for _sn in _SHORT_NAMES:
    TOOL_LABELS[_sn] = _LABEL_MAP[_sn]
    TOOL_LABELS[_uc_name(_sn)] = _LABEL_MAP[_sn]

_ARTIFACT_SHORT = {
    "load_engagement", "parse_workbook", "extract_workbook_images",
    "batch_review_evidence", "batch_execute_tests",
    "review_document", "review_screenshot", "analyze_email",
    "generate_test_plan", "execute_test", "aggregate_test_results",
    "compile_results", "fill_workbook", "save_report", "send_email",
}
ARTIFACT_TOOLS = set(_ARTIFACT_SHORT)
for _sn in _ARTIFACT_SHORT:
    ARTIFACT_TOOLS.add(_uc_name(_sn))


def _cleanup_tasks():
    now = _time.time()
    stale = [k for k, v in _tasks.items() if now - v.get("created", 0) > _TASK_TTL]
    for k in stale:
        _tasks.pop(k, None)


def _short_tool_name(name: str) -> str:
    """Extract the short tool name from a UC-qualified name like 'catalog__schema__tool'."""
    if "__" in name:
        return name.rsplit("__", 1)[-1]
    return name


def _summarize_args(name: str, args: dict) -> str:
    name = _short_tool_name(name)
    if name == "load_engagement":
        return args.get("project_path", "")
    if name == "parse_workbook":
        return args.get("file_path", "")
    if name in ("review_document", "review_screenshot", "analyze_email"):
        return args.get("file_path", "").split("/")[-1] if args.get("file_path") else ""
    if name == "execute_test":
        ref = args.get("test_ref", "")
        attr = args.get("attribute", "")[:80]
        sample_json = args.get("sample_item_json", "")
        sample_label = ""
        try:
            import json as _j
            si = _j.loads(sample_json) if sample_json else {}
            for k in ("Invoice_Number", "PO_Number", "Transaction_ID", "Vendor_ID", "id", "name", "_type"):
                if si.get(k):
                    sample_label = str(si[k])[:30]
                    break
        except Exception:
            pass
        parts = [f"[{ref}]" if ref else "", attr]
        if sample_label:
            parts.append(f"→ {sample_label}")
        return " ".join(p for p in parts if p)
    if name == "batch_review_evidence":
        try:
            import json as _j
            files = _j.loads(args.get("evidence_files_json", "[]"))
            return f"{len(files)} evidence files"
        except Exception:
            return args.get("project_path", "")
    if name == "batch_execute_tests":
        try:
            import json as _j
            plan = _j.loads(args.get("test_plan_json", "[]"))
            return f"{len(plan)} tests"
        except Exception:
            return ""
    if name == "compile_results":
        return args.get("control_id", "")
    if name == "save_report":
        return args.get("report_format", "both")
    if name == "send_email":
        return args.get("to", "")[:40]
    return ""


def _summarize_result(name: str, result_str: str) -> str:
    name = _short_tool_name(name)
    import json as _json
    try:
        d = _json.loads(result_str)
        # Unwrap UC function result envelope: {"format": "SCALAR", "value": "...", "truncated": ...}
        if isinstance(d, dict) and "format" in d and "value" in d:
            inner = d["value"]
            if isinstance(inner, str):
                try:
                    d = _json.loads(inner)
                except Exception:
                    return inner[:500]
            else:
                d = inner
        if isinstance(d, list) and name == "aggregate_test_results":
            refs = []
            exc_total = 0
            for entry in d:
                ref = entry.get("ref", "?")
                res = entry.get("result", "?")
                excs = len(entry.get("exceptions", []))
                exc_total += excs
                exc_str = f" ({excs} exc)" if excs else ""
                refs.append(f"{ref}:{res}{exc_str}")
            return " | ".join(refs)
        if isinstance(d, dict):
            if name == "load_engagement":
                co = d.get("control_objective", {})
                return f"{co.get('control_id', '')} — {co.get('control_name', '')} ({len(d.get('testing_attributes',[]))} attrs, {len(d.get('evidence_files',[]))} evidence files)"
            if name == "parse_workbook":
                return f"Tabs: {d.get('tab_names','?')}, Sample: {len(d.get('selected_sample',[]))} items, Images: {d.get('has_embedded_images', False)}"
            if name == "generate_test_plan":
                return f"{d.get('total_tests', '?')} tests planned ({d.get('attributes_count', '?')} attrs × {d.get('sample_size', '?')} samples)"
            if name in ("review_document", "review_screenshot", "analyze_email"):
                return (d.get("analysis", "") or d.get("summary", ""))[:500]
            if name == "batch_review_evidence":
                count = d.get("files_reviewed", 0)
                errs = len(d.get("errors", []))
                elapsed = d.get("elapsed_seconds", 0)
                workers = d.get("parallel_workers", "?")
                s = f"{count} files reviewed in {elapsed}s ({workers} parallel)"
                if errs:
                    s += f", {errs} errors"
                return s
            if name == "batch_execute_tests":
                total = d.get("total_tests", 0)
                passed = d.get("passed", 0)
                failed = d.get("failed", 0)
                elapsed = d.get("elapsed_seconds", 0)
                workers = d.get("parallel_workers", "?")
                conf = d.get("confidence_counts", {})
                low_refs = d.get("low_confidence_refs", [])
                s = f"{total} tests in {elapsed}s ({workers} parallel) — {passed} passed, {failed} failed"
                if conf:
                    s += f" | Confidence: {conf.get('High',0)}H {conf.get('Medium',0)}M {conf.get('Low',0)}L"
                if low_refs:
                    s += f" | Low-confidence: {', '.join(low_refs)}"
                return s
            if name == "execute_test":
                analysis = d.get("llm_analysis", "")
                if isinstance(analysis, str):
                    try:
                        inner = _json.loads(analysis.strip().strip("`").lstrip("json\n"))
                        if isinstance(inner, dict):
                            conf = inner.get("confidence", "")
                            conf_tag = f" [{conf}]" if conf else ""
                            return f"{inner.get('result','?')}{conf_tag} — {(inner.get('narrative',''))[:400]}"
                    except Exception:
                        pass
                return f"{d.get('result', d.get('test_ref', '?'))} — {(analysis or '')[:400]}"
            if name == "aggregate_test_results":
                if isinstance(d, list):
                    refs = []
                    for entry in d:
                        ref = entry.get("ref", "?")
                        res = entry.get("result", "?")
                        excs = len(entry.get("exceptions", []))
                        exc_str = f" ({excs} exc)" if excs else ""
                        refs.append(f"{ref}:{res}{exc_str}")
                    return " | ".join(refs)
                return result_str[:500]
            if name == "compile_results":
                return result_str[:500]
            if name == "fill_workbook":
                fname = d.get("filename", "")
                attrs = d.get("attrs_filled", 0)
                exc = d.get("exceptions_logged", 0)
                wurl = d.get("workbook_url", "")
                summary = f"{fname} — {attrs} attrs filled, {exc} exceptions"
                if wurl:
                    summary += f" — {wurl}"
                return summary
            if name == "save_report":
                fname = d.get("filename", "")
                rurl = d.get("report_url", "")
                vurl = d.get("volume_url", "")
                if rurl:
                    return f"{fname} — {rurl}"
                return f"{fname} — saved to {vurl}" if vurl else f"Saved {fname}"
            if name == "send_email":
                return d.get("status", "done")
    except Exception:
        pass
    return result_str[:500] if len(result_str) > 500 else result_str


def _extract_image_previews(result_str: str) -> list[dict]:
    """Pull preview_data_uri values from tool result JSON."""
    import json as _json
    previews: list[dict] = []
    try:
        d = _json.loads(result_str)
        if isinstance(d, dict):
            if d.get("preview_data_uri"):
                previews.append({
                    "data_uri": d["preview_data_uri"],
                    "label": Path(d.get("file_path", "image")).name,
                })
            for entry in d.get("analyses", []):
                if isinstance(entry, dict) and entry.get("preview_data_uri"):
                    previews.append({
                        "data_uri": entry["preview_data_uri"],
                        "label": f"{entry.get('sheet', 'image')} ({entry.get('anchor', '')})",
                    })
    except Exception:
        pass
    return previews


_THINKING_TEMPLATES: dict[str, str] = {
    "list_projects": "Let me discover what projects are available for review.",
    "load_engagement": "Loading the engagement data for {arg} to understand control requirements, testing attributes, and evidence files.",
    "announce_plan": "Planning the assessment workflow and outlining the steps I'll follow.",
    "parse_workbook": "Parsing the engagement workbook to extract testing data, sample items, and control parameters.",
    "extract_workbook_images": "Extracting embedded images from the workbook for visual evidence analysis.",
    "batch_review_evidence": "Reviewing {arg} in parallel to build a comprehensive understanding of the control documentation.",
    "batch_execute_tests": "Executing {arg} in parallel against the evidence gathered.",
    "review_document": "Analyzing document: {arg} — extracting key data points relevant to the control testing.",
    "review_screenshot": "Examining screenshot: {arg} — looking for visual evidence of control compliance.",
    "analyze_email": "Reviewing email: {arg} — checking communication trails for control documentation.",
    "generate_test_plan": "Computing the test matrix — mapping testing attributes to sample items from the workbook.",
    "execute_test": "Testing attribute {arg} — evaluating evidence against the control requirements.",
    "aggregate_test_results": "Aggregating all test results using deterministic rules to calculate pass/fail outcomes.",
    "compile_results": "Compiling all findings into a structured audit report with narrative, exceptions, and recommendations.",
    "fill_workbook": "Writing test results, narratives, and exceptions back into the engagement workbook.",
    "save_report": "Saving the completed audit report to the project.",
    "send_email": "Sending notification email with the assessment results to {arg}.",
}


def _generate_thinking(short_name: str, args: dict) -> str:
    template = _THINKING_TEMPLATES.get(short_name, "")
    if not template:
        return ""
    arg = _summarize_args(short_name, args)
    return template.format(arg=arg) if "{arg}" in template else template


def _detect_project(messages: list) -> str:
    """Try to detect the project_dir from the user's message."""
    for m in reversed(messages):
        content = m.get("content", "") if isinstance(m, dict) else ""
        for pattern in [r'"([\w_]+)"', r'project\s+"?([\w_]+)"?', r'(fin_\d+|env_\d+|hr_\d+|itg_\d+|p2p_\d+|rev_\d+)']:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                return match.group(1)
    return ""


def _serialize_steps_for_audit(steps: list[dict]) -> list[dict]:
    """Prepare the step list for inclusion in run_manifest.json (audit trail)."""
    _exclude = {"_call_id", "_step_idx"}
    audit_steps = []
    for s in steps:
        entry = {k: v for k, v in s.items() if k not in _exclude}
        if "started_at" in entry and isinstance(entry["started_at"], (int, float)):
            entry["started_at"] = datetime.fromtimestamp(entry["started_at"], tz=timezone.utc).isoformat()
        if "duration" in entry and "started_at" in s:
            entry["completed_at"] = datetime.fromtimestamp(
                s["started_at"] + (entry.get("duration") or 0), tz=timezone.utc
            ).isoformat()
        audit_steps.append(entry)
    return audit_steps


def _get_fill_workbook_xlsx(tool_name: str, result_str: str) -> str | None:
    """Extract the .xlsx filename from a fill_workbook tool result."""
    if _short_tool_name(tool_name) != "fill_workbook":
        return None
    try:
        d = json.loads(result_str)
        fname = d.get("filename", "")
        if fname and fname.endswith(".xlsx"):
            return fname
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Execution log generator
# ---------------------------------------------------------------------------

def _generate_execution_log(steps: list[dict], manifest: dict) -> str:
    """Format the step list into a human-readable markdown execution log."""
    proj = manifest.get("project_dir", "unknown")
    run_id = manifest.get("run_id", "unknown")
    started = manifest.get("started_at", "")
    completed = manifest.get("completed_at", "")
    status = manifest.get("status", "unknown")

    total_duration = 0.0
    for s in steps:
        total_duration += s.get("duration", 0)

    mins = int(total_duration // 60)
    secs = int(total_duration % 60)
    dur_str = f"{mins}m {secs}s" if mins else f"{secs}s"

    lines = [
        f"# Execution Log — {proj}",
        f"**Run ID**: {run_id}",
        f"**Project**: {proj}",
        f"**Started**: {started}",
        f"**Completed**: {completed}",
        f"**Duration**: {dur_str}",
        f"**Status**: {status.title()}",
        "",
        "---",
        "",
    ]

    total_tests = 0
    tests_passed = 0
    tests_failed = 0
    exceptions_logged = 0
    evidence_reviewed = 0
    report_saved = False
    email_sent = False

    for i, step in enumerate(steps, 1):
        tool = step.get("tool", "unknown")
        label = step.get("label", tool)
        duration = step.get("duration", 0)
        args_summary = step.get("args_summary", "")
        result_summary = step.get("result_summary", "")

        lines.append(f"## Step {i} — {label} ({duration}s)")
        lines.append(f"**Tool**: `{tool}`")
        if args_summary:
            lines.append(f"**Input**: {args_summary}")
        if result_summary:
            truncated = result_summary[:600]
            if len(result_summary) > 600:
                truncated += "..."
            lines.append(f"**Result**: {truncated}")
        lines.append("")

        if tool == "batch_review_evidence":
            try:
                import json as _j
                # Parse the count from the summary
                if "files reviewed" in result_summary:
                    evidence_reviewed = int(result_summary.split(" files")[0])
            except Exception:
                pass
        elif tool in ("review_document", "review_screenshot", "analyze_email"):
            evidence_reviewed += 1
        elif tool == "batch_execute_tests":
            try:
                if "passed" in result_summary and "failed" in result_summary:
                    parts = result_summary.split("—")[-1].strip()
                    for token in parts.split(","):
                        token = token.strip()
                        if "passed" in token:
                            tests_passed = int(token.split()[0])
                        elif "failed" in token:
                            tests_failed = int(token.split()[0])
                    total_tests = tests_passed + tests_failed
            except Exception:
                pass
        elif tool == "fill_workbook" and "exceptions" in result_summary:
            try:
                for part in result_summary.split(","):
                    if "exception" in part:
                        exceptions_logged = int(part.strip().split()[0])
            except Exception:
                pass
        elif tool == "save_report":
            report_saved = True
        elif tool == "send_email" and "sent" in result_summary.lower():
            email_sent = True

    lines.extend([
        "---",
        "",
        "## Summary",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total steps | {len(steps)} |",
        f"| Total duration | {dur_str} |",
        f"| Evidence files reviewed | {evidence_reviewed} |",
        f"| Tests executed | {total_tests} |",
        f"| Tests passed | {tests_passed} |",
        f"| Tests failed | {tests_failed} |",
        f"| Exceptions logged | {exceptions_logged} |",
        f"| Report saved | {'Yes' if report_saved else 'No'} |",
        f"| Email sent | {'Yes' if email_sent else 'No'} |",
        "",
    ])

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
def create_app(*, frontend_dirs: list[Path] | None = None) -> FastAPI:
    """
    Build and return the FastAPI application with all routes.

    Parameters
    ----------
    frontend_dirs : list of Path, optional
        Directories to try for serving the SPA frontend, in priority order.
        The first one that exists wins.
    """
    app = FastAPI(title="GSK Controls Evidence Review Agent", version="5.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # -- Health & metadata ---------------------------------------------------
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

    # -- Project listing -----------------------------------------------------
    @app.get("/api/projects")
    async def get_projects():
        from agent.config import PROJECTS_LOCAL_PATH, PROJECTS_BASE_PATH
        projects = []
        seen_dirs: set[str] = set()

        # UC Volume is the primary data source
        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            items = w.files.list_directory_contents(PROJECTS_BASE_PATH)
            for item in items:
                if item.is_directory:
                    name = item.path.rstrip("/").split("/")[-1]
                    info: dict = {"project_dir": name, "source": "uc_volume"}
                    try:
                        eng_path = f"{PROJECTS_BASE_PATH}/{name}/engagement.json"
                        resp = w.files.download(eng_path)
                        eng = json.loads(resp.contents.read().decode("utf-8"))
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
                    seen_dirs.add(name)
        except Exception as exc:
            print(f"[api/projects] UC Volume listing failed: {exc}")

        # Local filesystem is a fallback only (dev convenience)
        local_base = Path(PROJECTS_LOCAL_PATH)
        if local_base.exists():
            for d in sorted(local_base.iterdir()):
                if d.is_dir() and d.name not in seen_dirs:
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

        return {"projects": projects, "count": len(projects)}

    @app.get("/api/projects/{project_dir}/engagement")
    async def get_engagement(project_dir: str):
        """Return full engagement.json for a project (UC Volume first)."""
        from agent.config import PROJECTS_LOCAL_PATH, PROJECTS_BASE_PATH

        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            vol_path = f"{PROJECTS_BASE_PATH}/{project_dir}/engagement.json"
            resp = w.files.download(vol_path)
            return JSONResponse(json.loads(resp.contents.read().decode("utf-8")))
        except Exception:
            pass

        local_file = Path(PROJECTS_LOCAL_PATH) / project_dir / "engagement.json"
        if local_file.exists():
            return JSONResponse(json.loads(local_file.read_text()))

        raise HTTPException(404, f"Engagement not found for {project_dir}")

    @app.get("/api/projects/{project_dir}/evidence/{filepath:path}")
    async def get_evidence_file(project_dir: str, filepath: str):
        """Serve an evidence file (PDF, image, .eml) from a project folder."""
        from agent.config import PROJECTS_LOCAL_PATH, PROJECTS_BASE_PATH

        ext = Path(filepath).suffix.lower()
        MEDIA_TYPES = {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".eml": "message/rfc822",
            ".txt": "text/plain",
            ".msg": "application/vnd.ms-outlook",
        }
        media_type = MEDIA_TYPES.get(ext, "application/octet-stream")

        local_file = Path(PROJECTS_LOCAL_PATH) / project_dir / filepath
        if local_file.exists():
            data = local_file.read_bytes()
            return Response(content=data, media_type=media_type, headers={
                "Content-Disposition": f'inline; filename="{local_file.name}"',
            })

        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            vol_path = f"{PROJECTS_BASE_PATH}/{project_dir}/{filepath}"
            resp = w.files.download(vol_path)
            data = resp.contents.read()
            return Response(content=data, media_type=media_type, headers={
                "Content-Disposition": f'inline; filename="{Path(filepath).name}"',
            })
        except Exception:
            raise HTTPException(404, f"Evidence file not found: {project_dir}/{filepath}")

    # -- File upload ---------------------------------------------------------
    upload_dir = Path("/tmp/compliance_uploads")
    upload_dir.mkdir(exist_ok=True)

    @app.post("/api/upload")
    async def upload_file(file: UploadFile = File(...)):
        if not file.filename:
            raise HTTPException(400, "No filename")

        allowed_extensions = {".xlsx", ".xlsm", ".xlsb", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".msg", ".eml"}
        ext = Path(file.filename).suffix.lower()
        if ext not in allowed_extensions:
            raise HTTPException(400, f"Unsupported file type: {ext}")

        dest = upload_dir / file.filename
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

    # -- Agent invocation (async poll pattern) -------------------------------
    @app.post("/invocations")
    async def invocations(request: dict):
        messages = request.get("input") or []
        if not messages or not any(m.get("content") for m in messages):
            raise HTTPException(400, "Please provide at least one message with content.")

        _cleanup_tasks()
        task_id = _uuid.uuid4().hex[:12]
        run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        project_dir = _detect_project(messages)

        _tasks[task_id] = {
            "status": "running",
            "created": _time.time(),
            "steps": [],
            "current_step": None,
            "run_id": run_id,
            "project_dir": project_dir,
            "thinking": [],
            "plan": None,
        }

        def _make_progress_callback(tid: str):
            """Create a callback that updates sub_progress on the last running batch step."""
            def _cb(completed: int, total: int, detail: str = ""):
                steps = _tasks.get(tid, {}).get("steps", [])
                for s in reversed(steps):
                    if s.get("status") == "running":
                        s["sub_progress"] = {"completed": completed, "total": total, "detail": detail}
                        break
            return _cb

        def _run():
            from agent.config import APP_BASE_URL
            from agent.run_context import set_run_context, set_progress_callback
            from agent.graph import clear_cancel, is_cancelled, CancelledError
            try:
                from agent.agent import AGENT
                from mlflow.types.responses import (
                    ResponsesAgentRequest,
                    ResponsesAgentResponse,
                    to_chat_completions_input,
                    output_to_responses_items_stream,
                )
                from langchain_core.messages import AIMessage, ToolMessage

                clear_cancel()
                set_run_context(
                    run_id=run_id,
                    project_dir=project_dir,
                    app_base_url=APP_BASE_URL,
                )
                set_progress_callback(_make_progress_callback(task_id))

                agent_request = ResponsesAgentRequest(**request)
                lc_messages = to_chat_completions_input(
                    [m.model_dump() for m in agent_request.input]
                )

                outputs = []
                step_counter = [0]
                pending_args: dict[str, dict] = {}

                detected_project = _tasks[task_id].get("project_dir", "")

                manifest = {
                    "run_id": run_id,
                    "project_dir": detected_project,
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "status": "running",
                    "artifacts": [],
                }

                for event in AGENT.graph.stream(
                    {"messages": lc_messages}, stream_mode=["updates"]
                ):
                    if is_cancelled() or _tasks[task_id].get("cancel_requested"):
                        break

                    if event[0] != "updates":
                        continue
                    for node_data in event[1].values():
                        msgs = node_data.get("messages")
                        if not msgs:
                            continue

                        for msg in msgs:
                            if isinstance(msg, AIMessage):
                                narration = ""
                                if isinstance(msg.content, str) and msg.content.strip():
                                    narration = msg.content.strip()
                                elif isinstance(msg.content, list):
                                    parts = []
                                    for b in msg.content:
                                        if isinstance(b, dict):
                                            if b.get("type") == "text" and b.get("text", "").strip():
                                                parts.append(b["text"].strip())
                                            elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                                                parts.append(b["thinking"].strip())
                                    narration = " ".join(parts).strip()
                                if narration:
                                    _tasks[task_id]["thinking"].append({
                                        "content": narration,
                                        "timestamp": _time.time(),
                                    })

                                if msg.tool_calls:
                                    for tc in msg.tool_calls:
                                        tool_name = tc["name"]
                                        tool_args = tc.get("args", {})
                                        call_id = tc.get("id", "")
                                        short = _short_tool_name(tool_name)

                                        thinking_text = _generate_thinking(short, tool_args)
                                        if thinking_text:
                                            _tasks[task_id]["thinking"].append({
                                                "content": thinking_text,
                                                "timestamp": _time.time(),
                                            })

                                        _tasks[task_id]["current_step"] = tool_name
                                        _tasks[task_id]["steps"].append({
                                            "tool": tool_name,
                                            "label": TOOL_LABELS.get(tool_name, tool_name),
                                            "args_summary": _summarize_args(tool_name, tool_args),
                                            "status": "running",
                                            "started_at": _time.time(),
                                            "_call_id": call_id,
                                            "_step_idx": step_counter[0],
                                        })
                                        pending_args[call_id] = {"name": tool_name, "args": tool_args, "idx": step_counter[0]}
                                        step_counter[0] += 1

                                        _advance_plan(_tasks[task_id], short, "start")

                                        if short == "load_engagement":
                                            p = tool_args.get("project_path", "")
                                            if p and not detected_project:
                                                detected_project = p
                                                _tasks[task_id]["project_dir"] = p
                                                manifest["project_dir"] = p
                                                set_run_context(
                                                    run_id=run_id,
                                                    project_dir=p,
                                                    app_base_url=APP_BASE_URL,
                                                )

                            elif isinstance(msg, ToolMessage):
                                call_id = msg.tool_call_id
                                result_str = msg.content if isinstance(msg.content, str) else str(msg.content)
                                steps = _tasks[task_id]["steps"]
                                matched_step = None
                                for s in reversed(steps):
                                    if s.get("_call_id") == call_id and s["status"] == "running":
                                        matched_step = s
                                        break
                                if not matched_step and steps and steps[-1]["status"] == "running":
                                    matched_step = steps[-1]

                                if matched_step:
                                    matched_step["status"] = "complete"
                                    matched_step["result_summary"] = _summarize_result(matched_step["tool"], result_str)
                                    matched_step["duration"] = round(
                                        _time.time() - matched_step.get("started_at", _time.time()), 1
                                    )
                                    image_previews = _extract_image_previews(result_str)
                                    matched_step["image_previews"] = image_previews

                                    if image_previews:
                                        img_lines = [f"**Extracted {len(image_previews)} image(s):**\n"]
                                        for ip in image_previews:
                                            img_lines.append(f"![{ip['label']}]({ip['data_uri']})")
                                        _tasks[task_id]["thinking"].append({
                                            "content": "\n".join(img_lines),
                                            "timestamp": _time.time(),
                                        })

                                    tool_info = pending_args.get(call_id, {})
                                    tool_name = tool_info.get("name", matched_step["tool"])
                                    tool_args = tool_info.get("args", {})
                                    step_idx = tool_info.get("idx", 0)

                                    short_name = _short_tool_name(tool_name)

                                    # Parse announce_plan result into structured plan
                                    if short_name == "announce_plan":
                                        try:
                                            plan_data = json.loads(result_str)
                                            plan_steps = plan_data.get("steps", [])
                                            _tasks[task_id]["plan"] = {
                                                "steps": [
                                                    {"id": s["id"], "label": s["label"],
                                                     "detail": s.get("detail", ""), "status": "pending"}
                                                    for s in plan_steps
                                                ]
                                            }
                                            # Retroactively mark plan steps for tools that already completed
                                            for prev_step in _tasks[task_id].get("steps", []):
                                                if prev_step.get("status") == "complete":
                                                    prev_short = _short_tool_name(prev_step["tool"])
                                                    _advance_plan(_tasks[task_id], prev_short, "complete")
                                        except Exception:
                                            pass

                                    _advance_plan(_tasks[task_id], short_name, "complete")
                                    if tool_name in ARTIFACT_TOOLS and detected_project:
                                        is_top = short_name in ("compile_results", "save_report", "send_email", "fill_workbook")
                                        step_fname = _step_filename(tool_name, step_idx, tool_args)
                                        content_to_save = result_str

                                        vol_path = _save_to_volume(
                                            detected_project, run_id, step_fname,
                                            content_to_save, is_step=True,
                                        )
                                        _cache_local(
                                            detected_project, run_id, step_fname,
                                            content_to_save, is_step=True,
                                        )

                                        if short_name == "compile_results":
                                            rp = _save_to_volume(detected_project, run_id, "report.md", content_to_save)
                                            _cache_local(detected_project, run_id, "report.md", content_to_save)
                                            if rp:
                                                manifest["artifacts"].append({"filename": "report.md", "tool": tool_name, "volume_path": rp})

                                        matched_step["artifact"] = step_fname
                                        matched_step["artifact_volume_path"] = vol_path
                                        manifest["artifacts"].append({
                                            "filename": step_fname,
                                            "tool": tool_name,
                                            "volume_path": vol_path,
                                            "location": "steps",
                                        })

                                        xlsx_name = _get_fill_workbook_xlsx(tool_name, result_str)
                                        if xlsx_name:
                                            matched_step["workbook_artifact"] = xlsx_name
                                            from agent import volume_store as _vs
                                            xlsx_vol = _vs.artifact_path(detected_project, run_id, xlsx_name)
                                            manifest["artifacts"].append({
                                                "filename": xlsx_name,
                                                "tool": "fill_workbook",
                                                "volume_path": xlsx_vol,
                                            })

                        for stream_ev in output_to_responses_items_stream(msgs):
                            if stream_ev.type == "response.output_item.done":
                                outputs.append(stream_ev.item)

                was_cancelled = is_cancelled() or _tasks[task_id].get("cancel_requested")

                manifest["status"] = "cancelled" if was_cancelled else "completed"
                manifest["completed_at"] = datetime.now(timezone.utc).isoformat()
                manifest["total_steps"] = len(_tasks[task_id]["steps"])
                manifest["steps"] = _serialize_steps_for_audit(_tasks[task_id]["steps"])
                manifest["thinking"] = _tasks[task_id].get("thinking", [])
                manifest["plan"] = _tasks[task_id].get("plan")
                if detected_project:
                    from agent import volume_store as _vs

                    # Generate and save the execution log
                    try:
                        exec_log = _generate_execution_log(
                            _tasks[task_id]["steps"], manifest
                        )
                        log_vol = _save_to_volume(
                            detected_project, run_id, "execution_log.md", exec_log
                        )
                        _cache_local(
                            detected_project, run_id, "execution_log.md", exec_log
                        )
                        if log_vol:
                            manifest["artifacts"].append({
                                "filename": "execution_log.md",
                                "tool": "_system",
                                "volume_path": log_vol,
                            })
                    except Exception as exc:
                        print(f"[execution_log] Failed to generate: {exc}")

                    manifest_json = json.dumps(manifest, indent=2)
                    _vs.save_manifest(detected_project, run_id, manifest)
                    _cache_local(detected_project, run_id, "run_manifest.json", manifest_json)

                if was_cancelled:
                    _tasks[task_id]["status"] = "cancelled"
                    _tasks[task_id]["current_step"] = None
                else:
                    _tasks[task_id]["result"] = ResponsesAgentResponse(
                        output=outputs
                    ).model_dump(exclude_none=True)
                    _tasks[task_id]["status"] = "complete"
                    _tasks[task_id]["current_step"] = None

            except CancelledError:
                _tasks[task_id]["status"] = "cancelled"
                _tasks[task_id]["current_step"] = None
            except Exception as e:
                import traceback; traceback.print_exc()
                err_str = str(e)
                if "429" in err_str or "REQUEST_LIMIT_EXCEEDED" in err_str:
                    _tasks[task_id]["error"] = "Rate limit exceeded. The model endpoint is overloaded — please wait a minute and try again."
                else:
                    _tasks[task_id]["error"] = err_str
                _tasks[task_id]["status"] = "error"
                _tasks[task_id]["current_step"] = None

        threading.Thread(target=_run, daemon=True).start()
        return {"task_id": task_id, "status": "running", "run_id": run_id}

    # -- Task polling --------------------------------------------------------
    @app.get("/api/tasks/{task_id}")
    async def get_task(task_id: str):
        task = _tasks.get(task_id)
        if not task:
            raise HTTPException(404, "Task not found or expired")
        _internal_keys = {"started_at", "_call_id", "_step_idx"}
        steps = [{k: v for k, v in s.items() if k not in _internal_keys} for s in task.get("steps", [])]
        run_id = task.get("run_id", "")
        project_dir = task.get("project_dir", "")
        thinking = task.get("thinking", [])
        plan = task.get("plan")
        base = {"task_id": task_id, "steps": steps, "run_id": run_id,
                "project_dir": project_dir, "thinking": thinking, "plan": plan}
        if task["status"] in ("running", "cancelling"):
            elapsed = _time.time() - task.get("created", _time.time())
            return {**base, "status": task["status"], "elapsed_seconds": round(elapsed, 1),
                    "current_step": task.get("current_step")}
        if task["status"] == "cancelled":
            return {**base, "status": "cancelled", "detail": "Cancelled by user"}
        if task["status"] == "error":
            return {**base, "status": "error", "detail": task.get("error", "Unknown error")}
        result = task.get("result", {})
        _tasks.pop(task_id, None)
        return {**base, "status": "complete", **result}

    @app.post("/api/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str):
        """Signal the running agent to stop after the current step."""
        task = _tasks.get(task_id)
        if not task:
            raise HTTPException(404, "Task not found or expired")
        if task["status"] != "running":
            return {"task_id": task_id, "status": task["status"], "message": "Not running"}

        task["cancel_requested"] = True
        task["status"] = "cancelling"

        from agent.graph import request_cancel
        request_cancel()

        return {"task_id": task_id, "status": "cancelling", "message": "Cancel signal sent"}

    # -- Run history & artifact serving --------------------------------------
    @app.get("/api/runs/{project_dir}")
    async def list_runs(project_dir: str):
        """List all runs for a project from UC Volume + local cache, newest first."""
        from agent import volume_store as vs
        from agent.config import PROJECTS_LOCAL_PATH

        vol_runs = vs.list_runs(project_dir)
        vol_ids = {r["run_id"] for r in vol_runs}

        local_runs_dir = Path(PROJECTS_LOCAL_PATH) / project_dir / "runs"
        local_only: list[dict] = []
        if local_runs_dir.is_dir():
            for rd in sorted(local_runs_dir.iterdir(), reverse=True):
                if rd.is_dir() and rd.name not in vol_ids:
                    run_info: dict = {"run_id": rd.name, "source": "local"}
                    manifest_f = rd / "run_manifest.json"
                    if manifest_f.exists():
                        try:
                            m = json.loads(manifest_f.read_text())
                            run_info.update({
                                "status": m.get("status", "unknown"),
                                "started_at": m.get("started_at", ""),
                                "completed_at": m.get("completed_at", ""),
                                "total_steps": m.get("total_steps", 0),
                                "artifact_count": len(m.get("artifacts", [])),
                            })
                        except Exception:
                            pass
                    local_only.append(run_info)

        all_runs = sorted(vol_runs + local_only, key=lambda r: r.get("run_id", ""), reverse=True)
        return {"project_dir": project_dir, "runs": all_runs, "count": len(all_runs)}

    @app.get("/api/artifacts/{project_dir}/{run_id}/{filename:path}")
    async def get_artifact(project_dir: str, run_id: str, filename: str):
        """Serve a run artifact.  Volume-first, local cache fallback."""
        from agent import volume_store as vs
        from agent.config import PROJECTS_LOCAL_PATH

        print(f"[get_artifact] Requested: {project_dir}/{run_id}/{filename}")

        is_binary = filename.endswith((".xlsx", ".pdf", ".png", ".jpg", ".jpeg"))

        raw: bytes | None = vs.download_artifact(project_dir, run_id, filename)
        if raw is not None:
            print(f"[get_artifact] Found in volume ({len(raw)} bytes)")

        if raw is None:
            local_candidates = [
                Path(PROJECTS_LOCAL_PATH) / project_dir / "runs" / run_id / filename,
                Path(PROJECTS_LOCAL_PATH) / project_dir / "runs" / run_id / "steps" / filename,
            ]
            for lp in local_candidates:
                if lp.exists():
                    raw = lp.read_bytes()
                    print(f"[get_artifact] Found locally: {lp} ({len(raw)} bytes)")
                    break

        if raw is None:
            print(f"[get_artifact] NOT FOUND: {project_dir}/{run_id}/{filename}")
            raise HTTPException(
                404,
                f"Artifact not found: {project_dir}/runs/{run_id}/{filename}"
            )

        if is_binary:
            ct = _binary_content_type(filename)
            return Response(content=raw, media_type=ct, headers={
                "Content-Disposition": f'attachment; filename="{Path(filename).name}"',
            })

        content = raw.decode("utf-8")
        if filename.endswith(".md"):
            return PlainTextResponse(content, media_type="text/markdown")
        if filename.endswith(".json"):
            try:
                return JSONResponse(json.loads(content))
            except Exception:
                return PlainTextResponse(content)
        return PlainTextResponse(content)

    # -- SPA catch-all -------------------------------------------------------
    serve_dir = None
    if frontend_dirs:
        for d in frontend_dirs:
            if d.exists():
                serve_dir = d
                break

    if serve_dir:
        _index_html = serve_dir / "index.html"

        @app.get("/{full_path:path}")
        async def spa_catch_all(full_path: str):
            file = serve_dir / full_path
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

    return app


def _binary_content_type(filename: str) -> str:
    if filename.endswith(".xlsx"):
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if filename.endswith(".pdf"):
        return "application/pdf"
    if filename.endswith(".png"):
        return "image/png"
    if filename.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    return "application/octet-stream"
