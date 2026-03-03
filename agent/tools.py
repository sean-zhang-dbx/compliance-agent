"""
Tools for the GSK Controls Evidence Review Agent.

Fully general-purpose: no control-specific logic. The agent reads
engagement.json for each project and figures out what to do.

Tools:
  - list_projects            -> Discover available project directories
  - load_engagement          -> Read engagement metadata and instructions
  - parse_workbook           -> Read all tabs from the workbook dynamically
  - extract_workbook_images  -> Extract + analyze images embedded in Excel
  - review_document          -> Analyze PDFs with the LLM
  - review_screenshot        -> Analyze screenshots/photos with vision LLM
  - analyze_email            -> Parse and analyze .eml email files
  - execute_test             -> Run a specific test attribute against a sample item
  - compile_results          -> Produce the final assessment report
  - save_report              -> Persist the report to the project directory
  - send_email               -> Send email via Microsoft Graph API (or simulate)
  - ask_user                 -> Ask the user for clarification
"""

from __future__ import annotations

import base64
import io
import json
import os
import zipfile
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

import mlflow
from langchain_core.tools import tool

from agent.config import VOLUME_PATH, PROJECTS_BASE_PATH, PROJECTS_LOCAL_PATH

SAMPLE_DATA_DIR = Path(__file__).parent.parent / "sample_data"


@mlflow.trace(span_type="RETRIEVER", name="read_file")
def _read_file_bytes(file_path: str) -> bytes:
    """Read a file from local path, bundled sample_data, or UC volume."""
    p = Path(file_path)
    if p.exists():
        return p.read_bytes()

    bundled = SAMPLE_DATA_DIR / p.name
    if bundled.exists():
        return bundled.read_bytes()

    for subdir in SAMPLE_DATA_DIR.rglob("*"):
        if subdir.is_file() and subdir.name == p.name:
            return subdir.read_bytes()

    projects_local = Path(PROJECTS_LOCAL_PATH)
    if projects_local.exists():
        for candidate in projects_local.rglob(p.name):
            if candidate.is_file():
                return candidate.read_bytes()

    if file_path.startswith("/Volumes/"):
        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            resp = w.files.download(file_path)
            return resp.contents.read()
        except Exception:
            pass

    local_fallback = file_path.replace(VOLUME_PATH, str(SAMPLE_DATA_DIR))
    fb = Path(local_fallback)
    if fb.exists():
        return fb.read_bytes()

    raise FileNotFoundError(
        f"Cannot find '{file_path}'. Checked: {p}, sample_data (recursive), UC SDK, {fb}"
    )


def _resolve_project_file(project_path: str, relative_path: str) -> str:
    """Resolve a file path relative to a project directory."""
    local_base = Path(PROJECTS_LOCAL_PATH) / project_path
    local_file = local_base / relative_path
    if local_file.exists():
        return str(local_file)
    return f"{PROJECTS_BASE_PATH}/{project_path}/{relative_path}"


@mlflow.trace(span_type="PARSER", name="parse_excel_tabs")
def _read_excel_tabs(file_path: str) -> dict:
    """Read all tabs from an Excel workbook into structured lists of rows."""
    import openpyxl
    content = _read_file_bytes(file_path)
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    result = {}
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append([str(c) if c is not None else "" for c in row])
        result[sheet_name] = rows
    return result


# =========================================================================
# Project discovery
# =========================================================================

@tool
def list_projects() -> str:
    """List all available control testing projects.
    Each project is a directory containing engagement.json, a workbook,
    and evidence files. Call this FIRST to see what projects are available.

    Returns:
        JSON with a list of projects, each with name, control_id,
        control_name, and domain from the engagement metadata.
    """
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

    return json.dumps({"projects": projects, "count": len(projects)}, indent=2)


# =========================================================================
# Engagement + workbook loading
# =========================================================================

@tool
def load_engagement(project_path: str) -> str:
    """Load the engagement metadata and instructions from a project.

    Args:
        project_path: Project directory name (e.g. "p2p_028") or full path
                      to the engagement.json file.

    Returns:
        JSON string with engagement metadata including control_objective
        (with rules), testing_attributes, instructions, and evidence_files.
    """
    if project_path.endswith(".json"):
        file_path = project_path
    else:
        file_path = _resolve_project_file(project_path, "engagement.json")

    content = _read_file_bytes(file_path)
    engagement = json.loads(content)
    mlflow.update_current_trace(tags={
        "engagement_number": engagement.get("number", ""),
        "control_id": engagement.get("control_objective", {}).get("control_id", ""),
        "project": project_path,
    })
    return json.dumps(engagement, indent=2)


@tool
def parse_workbook(file_path: str) -> str:
    """Parse the engagement workbook (XLSX) and extract all tabs dynamically.
    Also detects if any worksheet contains embedded images (screenshots pasted
    into Excel). If so, the returned JSON includes has_embedded_images=true
    and per-tab image counts so you know to call extract_workbook_images.

    Args:
        file_path: Path to the workbook (.xlsx), or a project directory name.

    Returns:
        JSON with tab_names, tabs data, sampling_config, selected_sample,
        testing_attributes, and has_embedded_images with image_counts_by_tab.
    """
    if not file_path.endswith(".xlsx"):
        file_path = _resolve_project_file(file_path, "engagement_workbook.xlsx")

    tabs = _read_excel_tabs(file_path)

    # Detect embedded images
    import openpyxl
    wb_content = _read_file_bytes(file_path)
    wb = openpyxl.load_workbook(io.BytesIO(wb_content))
    image_counts = {}
    total_images = 0
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        count = len(ws._images)
        if count > 0:
            image_counts[sheet_name] = count
            total_images += count

    # Also check the ZIP archive for images openpyxl might miss
    zip_image_count = 0
    try:
        with zipfile.ZipFile(io.BytesIO(wb_content), "r") as zf:
            zip_image_count = sum(1 for n in zf.namelist() if n.startswith("xl/media/"))
    except Exception:
        pass

    result = {
        "tab_names": list(tabs.keys()),
        "tabs": {},
        "sampling_config": {},
        "selected_sample": [],
        "testing_attributes": [],
        "has_embedded_images": total_images > 0 or zip_image_count > 0,
        "image_counts_by_tab": image_counts,
        "total_embedded_images": max(total_images, zip_image_count),
    }

    for tab_name, rows in tabs.items():
        if not rows:
            result["tabs"][tab_name] = {"headers": [], "row_count": 0, "data_preview": []}
            continue

        first_data_row = 0
        for i, row in enumerate(rows):
            non_empty = [c for c in row if c and c.strip()]
            if len(non_empty) >= 2:
                first_data_row = i
                break

        headers = rows[first_data_row] if first_data_row < len(rows) else []
        data_rows = rows[first_data_row + 1:] if first_data_row + 1 < len(rows) else []
        non_empty_rows = [r for r in data_rows if any(c.strip() for c in r)]

        result["tabs"][tab_name] = {
            "headers": headers,
            "row_count": len(non_empty_rows),
            "data_preview": non_empty_rows[:30],
        }

    for tab_name, rows in tabs.items():
        lower = tab_name.lower()
        if "sampling" in lower or "sample" in lower:
            in_config = True
            in_sample = False
            sample_headers = []

            for row in rows:
                if row[0] and "Selected Sample" in row[0]:
                    in_config = False
                    in_sample = True
                    continue

                if in_config and row[0] and row[0].strip() and row[1] and row[1].strip():
                    key = row[0].strip()
                    if key not in ("Sampling", "Sampling Methodology"):
                        result["sampling_config"][key] = row[1].strip()

                if in_sample and not sample_headers and any(c.strip() for c in row):
                    sample_headers = [h for h in row if h.strip()]
                    continue

                if in_sample and sample_headers and any(c.strip() for c in row):
                    item = {}
                    for i, h in enumerate(sample_headers):
                        if i < len(row):
                            item[h] = row[i]
                    if any(v.strip() for v in item.values()):
                        result["selected_sample"].append(item)

        if "testing" in lower and "table" in lower:
            for row in rows:
                if len(row) >= 2 and row[0].strip() and len(row[0].strip()) <= 2:
                    ref = row[0].strip()
                    if ref.isalpha() and ref.isupper():
                        result["testing_attributes"].append({
                            "ref": ref,
                            "attribute": row[1].strip() if len(row) > 1 else "",
                            "procedure": row[2].strip() if len(row) > 2 else "",
                            "answer": row[3].strip() if len(row) > 3 else "",
                        })

    return json.dumps(result, indent=2)


# =========================================================================
# Embedded image extraction from Excel
# =========================================================================

@tool
def extract_workbook_images(file_path: str, context: str = "") -> str:
    """Extract and analyze images embedded inside an Excel workbook.
    Some controls have screenshots or photos pasted directly into Excel
    tabs rather than stored as separate files. This tool extracts them
    and sends each to the vision LLM for analysis.

    Call this AFTER parse_workbook if has_embedded_images is true.

    Args:
        file_path: Path to the workbook (.xlsx) or project directory name.
        context: Control context (control_id, rules) for the LLM.

    Returns:
        JSON with a list of extracted images, each with sheet name,
        approximate cell anchor, image format, and the LLM's analysis.
    """
    if not file_path.endswith(".xlsx"):
        file_path = _resolve_project_file(file_path, "engagement_workbook.xlsx")

    from databricks_langchain import ChatDatabricks
    from langchain_core.messages import HumanMessage
    from agent.config import VISION_LLM_ENDPOINT

    wb_bytes = _read_file_bytes(file_path)
    images_found = []

    with mlflow.start_span(name="extract_workbook_images", span_type="PARSER") as span:
        span.set_inputs({"file_path": file_path})

        # Method 1: openpyxl _images (anchored images)
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(wb_bytes))
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            for idx, img in enumerate(ws._images):
                try:
                    anchor_cell = f"{img.anchor._from.col}:{img.anchor._from.row}" if hasattr(img.anchor, '_from') else "unknown"
                except Exception:
                    anchor_cell = "unknown"
                img_data = img._data()
                images_found.append({
                    "sheet": sheet_name,
                    "anchor": anchor_cell,
                    "source": "openpyxl",
                    "data": img_data,
                    "index": idx,
                })

        # Method 2: ZIP archive xl/media/ (catches images openpyxl misses)
        if not images_found:
            try:
                with zipfile.ZipFile(io.BytesIO(wb_bytes), "r") as zf:
                    for name in sorted(zf.namelist()):
                        if name.startswith("xl/media/"):
                            images_found.append({
                                "sheet": "archive",
                                "anchor": name,
                                "source": "zip_media",
                                "data": zf.read(name),
                                "index": len(images_found),
                            })
            except Exception:
                pass

        span.set_outputs({"images_found": len(images_found)})

    ctx = context or "GSK FRMC control testing"
    llm = ChatDatabricks(endpoint=VISION_LLM_ENDPOINT, temperature=0)
    analyses = []

    for img_info in images_found:
        with mlflow.start_span(name=f"analyze_embedded_image_{img_info['index']}", span_type="TOOL") as span:
            b64 = base64.b64encode(img_info["data"]).decode("utf-8")
            # Detect image type from header bytes
            header = img_info["data"][:8]
            if header[:4] == b'\x89PNG':
                mime = "image/png"
            elif header[:2] == b'\xff\xd8':
                mime = "image/jpeg"
            else:
                mime = "image/png"

            prompt = (
                f"You are analyzing an image extracted from an Excel workbook for {ctx}.\n"
                f"This image was found in sheet '{img_info['sheet']}' at position '{img_info['anchor']}'.\n\n"
                f"Analyze the image and report:\n"
                f"1. What does this image show? (dashboard, screenshot, photo, chart)\n"
                f"2. Key data visible (readings, statuses, dates, measurements)\n"
                f"3. Any EXCEPTIONS (values exceeding limits, red flags, non-compliance)\n"
                f"4. Relevance to the control being tested\n"
            )

            message = HumanMessage(content=[
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ])

            response = llm.invoke([message])
            span.set_outputs({"response_length": len(response.content)})

            analyses.append({
                "sheet": img_info["sheet"],
                "anchor": img_info["anchor"],
                "image_format": mime,
                "size_bytes": len(img_info["data"]),
                "analysis": response.content,
            })

    return json.dumps({
        "file_path": file_path,
        "images_extracted": len(analyses),
        "analyses": analyses,
    }, indent=2)


# =========================================================================
# Evidence review tools
# =========================================================================

@tool
def review_document(file_path: str, context: str = "", focus_area: Optional[str] = None) -> str:
    """Review a supporting document (PDF) using the LLM.

    Args:
        file_path: Path to the PDF document.
        context: Control context from the engagement.
        focus_area: What to look for.

    Returns:
        JSON string with file_path, document_type, review_focus, and analysis.
    """
    from databricks_langchain import ChatDatabricks
    from agent.config import VISION_LLM_ENDPOINT

    content = _read_file_bytes(file_path)
    ext = Path(file_path).suffix.lower()
    text_content: str | None = None

    with mlflow.start_span(name="extract_document_text", span_type="PARSER") as span:
        span.set_inputs({"file_path": file_path, "ext": ext, "size_bytes": len(content)})
        if ext == ".pdf":
            try:
                import fitz
                doc = fitz.open(stream=content, filetype="pdf")
                text_content = ""
                for page in doc:
                    text_content += page.get_text() + "\n"
                doc.close()
                span.set_outputs({"chars_extracted": len(text_content), "method": "PyMuPDF"})
            except ImportError:
                text_content = f"[PDF at {file_path}, {len(content)} bytes]"
                span.set_outputs({"chars_extracted": 0, "method": "fallback"})
        else:
            text_content = content.decode("utf-8", errors="replace")
            span.set_outputs({"chars_extracted": len(text_content), "method": "raw_text"})

    focus = focus_area or "general compliance review"
    ctx = context or "GSK FRMC control testing"
    prompt = (
        f"You are reviewing a document for {ctx}.\n"
        f"Focus area: {focus}\n\n"
        f"Extract and report:\n"
        f"1. Document type and purpose\n"
        f"2. Key data points (amounts, dates, document numbers, user IDs)\n"
        f"3. Any approvals, sign-offs, or authorizations visible\n"
        f"4. Any EXCEPTIONS noted (policy violations, missing items, overdue actions)\n"
        f"5. Any thresholds or limits mentioned and whether they are breached\n"
        f"6. Summary of findings relevant to {focus}\n\n"
        f"Document text content:\n\n{text_content[:10000]}"
    )

    llm = ChatDatabricks(endpoint=VISION_LLM_ENDPOINT, temperature=0)
    response = llm.invoke(prompt)

    return json.dumps({
        "file_path": file_path,
        "document_type": ext,
        "file_size_bytes": len(content),
        "review_focus": focus,
        "analysis": response.content,
    }, indent=2)


@tool
def review_screenshot(file_path: str, context: str = "", focus_area: Optional[str] = None) -> str:
    """Review a screenshot or photo using the vision LLM.

    Args:
        file_path: Path to the image (PNG, JPG, JPEG).
        context: Control context from the engagement.
        focus_area: What to look for.

    Returns:
        JSON string with file_path, review_focus, and analysis.
    """
    from databricks_langchain import ChatDatabricks
    from langchain_core.messages import HumanMessage
    from agent.config import VISION_LLM_ENDPOINT

    content = _read_file_bytes(file_path)
    ext = Path(file_path).suffix.lower()

    with mlflow.start_span(name="review_screenshot", span_type="PARSER") as span:
        span.set_inputs({"file_path": file_path, "ext": ext, "size_bytes": len(content)})
        b64 = base64.b64encode(content).decode("utf-8")
        mime = "image/png" if ext == ".png" else "image/jpeg"

        focus = focus_area or "general visual inspection"
        ctx = context or "GSK FRMC control testing"
        prompt = (
            f"You are reviewing a screenshot/photo for {ctx}.\n"
            f"Focus area: {focus}\n\n"
            f"Analyze the image and report:\n"
            f"1. What the screenshot/photo shows\n"
            f"2. Key data visible (dates, statuses, user IDs, names, quantities)\n"
            f"3. Any status indicators (completed, overdue, pending, flagged)\n"
            f"4. Any EXCEPTIONS visible (red flags, overdue items, policy violations)\n"
            f"5. Summary of findings relevant to {focus}\n"
        )

        message = HumanMessage(content=[
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ])

        llm = ChatDatabricks(endpoint=VISION_LLM_ENDPOINT, temperature=0)
        response = llm.invoke([message])
        span.set_outputs({"response_length": len(response.content)})

    return json.dumps({
        "file_path": file_path,
        "image_type": ext,
        "file_size_bytes": len(content),
        "review_focus": focus,
        "analysis": response.content,
    }, indent=2)


@tool
def analyze_email(file_path: str, context: str = "", focus_area: Optional[str] = None) -> str:
    """Parse and analyze an email file (.eml) for compliance evidence.

    Args:
        file_path: Path to the .eml email file.
        context: Control context from the engagement.
        focus_area: What to look for.

    Returns:
        JSON string with email metadata and analysis.
    """
    from databricks_langchain import ChatDatabricks
    from agent.config import LLM_ENDPOINT
    import email
    from email import policy as email_policy

    content = _read_file_bytes(file_path)

    with mlflow.start_span(name="parse_email", span_type="PARSER") as span:
        span.set_inputs({"file_path": file_path, "size_bytes": len(content)})

        msg = email.message_from_bytes(content, policy=email_policy.default)
        email_from = str(msg.get("From", ""))
        email_to = str(msg.get("To", ""))
        email_subject = str(msg.get("Subject", ""))
        email_date = str(msg.get("Date", ""))

        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body = part.get_content()
                    break
        else:
            body = msg.get_content()

        span.set_outputs({"from": email_from, "to": email_to, "subject": email_subject})

    focus = focus_area or "authorization and approval"
    ctx = context or "GSK FRMC control testing"
    prompt = (
        f"You are analyzing an email for {ctx}.\n"
        f"Focus area: {focus}\n\n"
        f"Email metadata:\n"
        f"- From: {email_from}\n"
        f"- To: {email_to}\n"
        f"- Subject: {email_subject}\n"
        f"- Date: {email_date}\n\n"
        f"Email body:\n{body[:5000]}\n\n"
        f"Analyze and report:\n"
        f"1. Who is the sender and their role/authority level?\n"
        f"2. Who is the recipient?\n"
        f"3. What action is being requested or confirmed?\n"
        f"4. Is this a proper authorization/approval?\n"
        f"5. Any EXCEPTIONS: self-approval (From == To), unauthorized approver, "
        f"missing information, policy violations\n"
        f"6. Summary of compliance findings\n"
    )

    llm = ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0)
    response = llm.invoke(prompt)

    return json.dumps({
        "file_path": file_path,
        "email_from": email_from,
        "email_to": email_to,
        "email_subject": email_subject,
        "email_date": email_date,
        "review_focus": focus,
        "analysis": response.content,
    }, indent=2)


# =========================================================================
# Test execution + report
# =========================================================================

@tool
def execute_test(
    test_ref: str,
    attribute: str,
    procedure: str,
    control_context: str,
    sample_item_json: str,
    evidence_summary: str = "",
) -> str:
    """Execute a specific testing attribute against a SINGLE sample item.

    Args:
        test_ref: The testing attribute reference (A, B, C, D, etc.).
        attribute: The testing attribute question/name.
        procedure: The testing procedure to follow.
        control_context: JSON string with control_id, control_name, domain, and rules.
        sample_item_json: JSON string of the single sample item to test.
        evidence_summary: Summary of reviewed supporting documents.

    Returns:
        JSON string with test_ref, sample_item, and llm_analysis.
    """
    from databricks_langchain import ChatDatabricks
    from agent.config import LLM_ENDPOINT
    from agent.prompts import TEST_EXECUTION_PROMPT

    sample_item = json.loads(sample_item_json) if sample_item_json else {}

    with mlflow.start_span(name=f"test_{test_ref}", span_type="TOOL") as span:
        span.set_inputs({"test_ref": test_ref, "attribute": attribute, "sample_item": sample_item})

        prompt = TEST_EXECUTION_PROMPT.format(
            ref=test_ref,
            control_context=control_context[:2000],
            attribute=attribute,
            procedure=procedure,
            sample_item=sample_item_json[:2000],
            evidence_summary=evidence_summary[:3000],
        )

        llm = ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0)
        response = llm.invoke(prompt)
        span.set_outputs({"response_length": len(response.content)})

    return json.dumps({
        "test_ref": test_ref,
        "sample_item": sample_item,
        "llm_analysis": response.content,
    }, indent=2)


@tool
def compile_results(
    control_id: str,
    control_name: str,
    engagement_number: str,
    domain: str,
    population_size: int,
    sample_size: int,
    testing_attributes_json: str,
    test_results_json: str,
    rules_json: str = "{}",
) -> str:
    """Compile all test results into the final assessment report.

    Args:
        control_id: The control identifier.
        control_name: The control name.
        engagement_number: The engagement reference number.
        domain: The control domain.
        population_size: Total items in the population.
        sample_size: Number of sampled items tested.
        testing_attributes_json: JSON of testing attributes.
        test_results_json: JSON of ALL test results.
        rules_json: JSON of control-specific rules.

    Returns:
        Formatted markdown report.
    """
    from databricks_langchain import ChatDatabricks
    from agent.config import LLM_ENDPOINT
    from agent.prompts import REPORT_GENERATION_PROMPT

    with mlflow.start_span(name="generate_report", span_type="TOOL") as span:
        span.set_inputs({
            "control_id": control_id,
            "engagement_number": engagement_number,
            "domain": domain,
            "population_size": population_size,
            "sample_size": sample_size,
        })

        prompt = REPORT_GENERATION_PROMPT.format(
            control_id=control_id,
            control_name=control_name,
            engagement_number=engagement_number,
            domain=domain,
            population_size=population_size,
            sample_size=sample_size,
            testing_attributes=testing_attributes_json[:3000],
            test_results=test_results_json[:8000],
            rules=rules_json[:2000],
        )

        llm = ChatDatabricks(endpoint=LLM_ENDPOINT, temperature=0)
        response = llm.invoke(prompt)

        span.set_outputs({
            "report_length": len(response.content),
            "has_exceptions": "ISS-" in response.content,
        })

    return response.content


@tool
def save_report(project_path: str, report_content: str, report_format: str = "markdown") -> str:
    """Save the final report to the project directory.

    Args:
        project_path: Project directory name.
        report_content: The full report content (markdown).
        report_format: "markdown" or "both" (markdown + JSON summary).

    Returns:
        JSON with saved file paths and status.
    """
    with mlflow.start_span(name="save_report", span_type="TOOL") as span:
        span.set_inputs({"project_path": project_path, "format": report_format})

        saved_files = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        local_dir = Path(PROJECTS_LOCAL_PATH) / project_path
        if local_dir.exists():
            report_file = local_dir / f"report_{timestamp}.md"
            report_file.write_text(report_content)
            saved_files.append(str(report_file))

            if report_format == "both":
                summary = {
                    "generated_at": timestamp,
                    "report_length": len(report_content),
                    "has_exceptions": "ISS-" in report_content,
                    "assessment": "",
                }
                for line in report_content.split("\n"):
                    if "**Effective" in line or "Effective with" in line or "Ineffective" in line:
                        summary["assessment"] = line.strip()
                        break
                json_file = local_dir / f"report_{timestamp}.json"
                json_file.write_text(json.dumps(summary, indent=2))
                saved_files.append(str(json_file))

        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            uc_path = f"{PROJECTS_BASE_PATH}/{project_path}/report_{timestamp}.md"
            w.files.upload(uc_path, report_content.encode("utf-8"), overwrite=True)
            saved_files.append(uc_path)
        except Exception:
            pass

        span.set_outputs({"saved_files": saved_files})

    return json.dumps({"status": "saved", "files": saved_files, "report_length": len(report_content)}, indent=2)


# =========================================================================
# Email sending via Microsoft Graph API
# =========================================================================

def _get_graph_token() -> Optional[str]:
    """Acquire an access token from Azure AD using client credentials."""
    import requests
    from agent.config import GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET

    if not all([GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET]):
        return None

    resp = requests.post(
        f"https://login.microsoftonline.com/{GRAPH_TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": GRAPH_CLIENT_ID,
            "client_secret": GRAPH_CLIENT_SECRET,
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


@tool
def send_email(
    to: str,
    subject: str,
    body: str,
    cc: str = "",
    importance: str = "normal",
    project_path: str = "",
) -> str:
    """Send an email via Microsoft Graph API. Use this to:
    - Email the final report to the engagement lead
    - Notify control owners of exceptions found
    - Request follow-up documentation

    If Graph API credentials are not configured, falls back to writing
    a simulated .eml file to the project directory.

    Args:
        to: Recipient email address (comma-separated for multiple).
        subject: Email subject line.
        body: Email body (HTML supported).
        cc: Optional CC recipients (comma-separated).
        importance: "low", "normal", or "high".
        project_path: Optional project dir for saving simulated emails.

    Returns:
        JSON with status ("sent" or "simulated"), recipient, and details.
    """
    with mlflow.start_span(name="send_email", span_type="TOOL") as span:
        span.set_inputs({"to": to, "subject": subject, "importance": importance})

        token = None
        try:
            token = _get_graph_token()
        except Exception:
            pass

        if token:
            import requests
            from agent.config import GRAPH_SENDER_EMAIL

            to_recipients = [{"emailAddress": {"address": addr.strip()}} for addr in to.split(",")]
            cc_recipients = [{"emailAddress": {"address": addr.strip()}} for addr in cc.split(",") if addr.strip()]

            payload = {
                "message": {
                    "subject": subject,
                    "body": {"contentType": "HTML", "content": body},
                    "toRecipients": to_recipients,
                    "importance": importance,
                },
                "saveToSentItems": True,
            }
            if cc_recipients:
                payload["message"]["ccRecipients"] = cc_recipients

            resp = requests.post(
                f"https://graph.microsoft.com/v1.0/users/{GRAPH_SENDER_EMAIL}/sendMail",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()

            span.set_outputs({"status": "sent", "graph_status": resp.status_code})
            return json.dumps({
                "status": "sent",
                "to": to,
                "subject": subject,
                "method": "microsoft_graph_api",
            }, indent=2)

        else:
            # Fallback: write a simulated .eml file
            msg = EmailMessage()
            msg["From"] = "gsk-compliance-agent@gsk.com"
            msg["To"] = to
            msg["Subject"] = subject
            msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0000")
            if cc:
                msg["Cc"] = cc
            msg.set_content(body)

            saved_path = None
            if project_path:
                local_dir = Path(PROJECTS_LOCAL_PATH) / project_path
                if local_dir.exists():
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    eml_file = local_dir / f"sent_email_{timestamp}.eml"
                    eml_file.write_text(msg.as_string())
                    saved_path = str(eml_file)

            span.set_outputs({"status": "simulated", "saved_path": saved_path})
            return json.dumps({
                "status": "simulated",
                "to": to,
                "subject": subject,
                "method": "eml_fallback",
                "note": "Graph API credentials not configured. Email saved as .eml file.",
                "saved_path": saved_path,
            }, indent=2)


# =========================================================================
# User interaction
# =========================================================================

@tool
def ask_user(question: str, options: Optional[str] = None) -> str:
    """Ask the user for clarification when uncertain.

    Args:
        question: The question to ask.
        options: Optional comma-separated suggested options.

    Returns:
        A message for the user; their response arrives as the next message.
    """
    result = {"type": "user_question", "question": question}
    if options:
        result["suggested_options"] = [o.strip() for o in options.split(",")]
    return json.dumps(result, indent=2)


ALL_TOOLS = [
    list_projects,
    load_engagement,
    parse_workbook,
    extract_workbook_images,
    review_document,
    review_screenshot,
    analyze_email,
    execute_test,
    compile_results,
    save_report,
    send_email,
    ask_user,
]
