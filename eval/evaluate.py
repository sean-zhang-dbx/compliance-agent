"""
Evaluate the compliance agent against ground-truth expected outcomes.

Uses MLflow evaluation with custom scorers to assess:
  1. Attribute-level accuracy: does each ref letter match expected pass/fail?
  2. Exception count accuracy: does total exception count match?
  3. Workflow completeness: were all expected tools called?
  4. Determinism: across N runs, how consistent are the results?

Usage:
    # Single project, 1 run (quick check)
    python eval/evaluate.py fin_042

    # Multiple runs for determinism check
    python eval/evaluate.py fin_042 --runs 3

    # All projects, 2 runs each
    python eval/evaluate.py all --runs 2

    # Use existing test-results JSON files instead of live runs
    python eval/evaluate.py --from-files test-results/fin_042_run1.json test-results/fin_042_run2.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from databricks.sdk import WorkspaceClient

EVAL_DIR = Path(__file__).parent
GROUND_TRUTH_PATH = EVAL_DIR / "ground_truth.json"
PROJECT_ROOT = EVAL_DIR.parent
RESULTS_DIR = PROJECT_ROOT / "test-results"

APP_URL = "https://gsk-compliance-agent-v3-7405607844735163.3.azure.databricksapps.com"

PROMPTS = {
    "fin_042": 'Run the full controls evidence review for project "fin_042" (Control FIN-042). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "env_007": 'Run the full controls evidence review for project "env_007" (Control ENV-007). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "p2p_028": 'Run the full controls evidence review for project "p2p_028" (Control P2P-028). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "itg_015": 'Run the full controls evidence review for project "itg_015" (Control ITG-015). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "rev_019": 'Run the full controls evidence review for project "rev_019" (Control REV-019). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "hr_003": 'Run the full controls evidence review for project "hr_003" (Control HR-003). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
    "inv_031": 'Run the full controls evidence review for project "inv_031" (Control INV-031). Load the engagement, parse the workbook, review all evidence, execute all tests, compile results, fill workbook, save report, and email if configured.',
}

EXPECTED_TOOLS = [
    "load_engagement", "parse_workbook",
    "batch_review_evidence", "generate_test_plan", "batch_execute_tests",
    "aggregate_test_results", "compile_results", "fill_workbook",
    "save_report", "send_email",
]


# ---------------------------------------------------------------------------
# Ground truth loading
# ---------------------------------------------------------------------------

def load_ground_truth() -> dict:
    with open(GROUND_TRUTH_PATH) as f:
        return json.load(f)["projects"]


# ---------------------------------------------------------------------------
# Live agent invocation (reuses test_consistency.py logic)
# ---------------------------------------------------------------------------

def _get_auth_headers():
    w = WorkspaceClient()
    h = w.config.authenticate()
    h["Content-Type"] = "application/json"
    return h


def _short_tool(name: str) -> str:
    return name.rsplit("__", 1)[-1] if "__" in name else name


def invoke_agent(project: str) -> dict:
    """Invoke the deployed agent for a project and poll until done."""
    prompt = PROMPTS[project]
    headers = _get_auth_headers()

    resp = requests.post(
        f"{APP_URL}/invocations",
        json={"input": [{"role": "user", "content": prompt}]},
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    task_id = body.get("task_id")
    if not task_id:
        return {"error": "no task_id", "raw": body}

    print(f"  task_id={task_id}, polling...")
    start = time.time()
    while time.time() - start < 600:
        time.sleep(8)
        poll = requests.get(
            f"{APP_URL}/api/tasks/{task_id}",
            headers=_get_auth_headers(),
            timeout=15,
        )
        if poll.status_code != 200:
            continue
        pdata = poll.json()
        status = pdata.get("status", "")
        steps = pdata.get("steps", [])
        elapsed = int(time.time() - start)
        tool_names = [_short_tool(s.get("tool", "")) for s in steps]
        print(f"  [{elapsed}s] status={status} steps={len(steps)} tools={tool_names[-3:]}")
        if status in ("done", "error", "cancelled", "complete"):
            return pdata
    return {"error": "timeout", "task_id": task_id}


# ---------------------------------------------------------------------------
# Result extraction
# ---------------------------------------------------------------------------

def extract_results(pdata: dict) -> dict:
    """Extract structured results from a completed agent run.

    The task API returns steps with `result_summary` (short text) and
    sometimes a longer `result` field. We parse both to extract
    per-attribute results and exception counts.
    """
    import re
    steps = pdata.get("steps", [])

    tool_sequence = []
    attr_results: dict[str, str] = {}
    exception_count = 0
    email_sent = False
    aggregate_used = False

    for step in steps:
        short = _short_tool(step.get("tool", ""))
        tool_sequence.append(short)
        result_text = step.get("result", "") or step.get("result_summary", "")
        summary = step.get("result_summary", "")

        if short == "aggregate_test_results":
            aggregate_used = True
            text = result_text if result_text else summary
            try:
                agg_list = json.loads(text) if isinstance(text, str) else text
                if isinstance(agg_list, list):
                    for entry in agg_list:
                        ref = entry.get("ref", "?")
                        attr_results[ref] = entry.get("result", "Unknown")
                        exception_count += len(entry.get("exceptions", []))
            except (json.JSONDecodeError, TypeError):
                compact = summary if summary else text
                if isinstance(compact, str) and "|" in compact:
                    for segment in compact.split("|"):
                        segment = segment.strip()
                        if ":" in segment:
                            ref_part, res_part = segment.split(":", 1)
                            ref = ref_part.strip().upper()
                            res = res_part.strip().split()[0]
                            attr_results[ref] = res
                            exc_m = re.search(r"\((\d+)\s*exc\)", segment)
                            if exc_m:
                                exception_count += int(exc_m.group(1))

        if short == "fill_workbook":
            text = summary if summary else result_text
            if isinstance(text, str):
                m_exc = re.search(r"(\d+)\s*exception", text)
                if m_exc and not attr_results:
                    exception_count = int(m_exc.group(1))
                m_attrs = re.findall(r"([A-Z]):\s*(Pass|Fail|Partial|Not Applicable)", text)
                if m_attrs and not attr_results:
                    for ref, res in m_attrs:
                        attr_results[ref] = res

        if short == "send_email":
            text = summary if summary else result_text
            if isinstance(text, str):
                low = text.lower()
                email_sent = "sent" in low and "not" not in low.split("sent")[0][-10:]

    return {
        "tool_sequence": tool_sequence,
        "attribute_results": attr_results,
        "exception_count": exception_count,
        "email_sent": email_sent,
        "status": pdata.get("status", "unknown"),
        "aggregate_used": aggregate_used,
    }


# ---------------------------------------------------------------------------
# Scorers
# ---------------------------------------------------------------------------

def score_attribute_accuracy(actual: dict, expected: dict) -> dict:
    """Compare per-attribute pass/fail against ground truth."""
    expected_attrs = expected.get("attributes", {})
    actual_attrs = actual.get("attribute_results", {})

    matches = 0
    mismatches = []
    total = len(expected_attrs)

    for ref, info in expected_attrs.items():
        expected_result = info["expected_result"].lower()
        actual_result = actual_attrs.get(ref, "missing").lower()

        if actual_result == expected_result:
            matches += 1
        elif actual_result == "partial" and expected_result == "fail":
            matches += 0.5
        else:
            mismatches.append({
                "ref": ref,
                "name": info.get("name", ""),
                "expected": info["expected_result"],
                "actual": actual_attrs.get(ref, "MISSING"),
            })

    accuracy = matches / total if total > 0 else 0
    return {
        "attribute_accuracy": round(accuracy, 3),
        "matches": int(matches),
        "total": total,
        "mismatches": mismatches,
    }


def score_exception_count(actual: dict, expected: dict) -> dict:
    """Compare exception count against ground truth."""
    expected_count = expected.get("expected_exception_count", 0)
    actual_count = actual.get("exception_count", -1)
    exact_match = actual_count == expected_count
    delta = actual_count - expected_count
    return {
        "exception_count_match": exact_match,
        "expected": expected_count,
        "actual": actual_count,
        "delta": delta,
    }


def score_workflow_completeness(actual: dict) -> dict:
    """Check that all expected tools were called."""
    called = set(actual.get("tool_sequence", []))
    missing = [t for t in EXPECTED_TOOLS if t not in called]
    completeness = (len(EXPECTED_TOOLS) - len(missing)) / len(EXPECTED_TOOLS)
    return {
        "workflow_completeness": round(completeness, 3),
        "missing_tools": missing,
        "aggregate_used": actual.get("aggregate_used", False),
    }


def score_determinism(runs: list[dict]) -> dict:
    """Across multiple runs, measure result consistency."""
    if len(runs) < 2:
        return {"determinism": "N/A (single run)"}

    exception_counts = [r.get("exception_count", -1) for r in runs]
    attr_results_list = [r.get("attribute_results", {}) for r in runs]

    all_refs = set()
    for ar in attr_results_list:
        all_refs.update(ar.keys())

    consistent_attrs = 0
    inconsistent_attrs = []
    for ref in sorted(all_refs):
        values = [ar.get(ref, "missing") for ar in attr_results_list]
        if len(set(values)) == 1:
            consistent_attrs += 1
        else:
            inconsistent_attrs.append({"ref": ref, "values": values})

    total_attrs = len(all_refs) if all_refs else 1
    return {
        "determinism_score": round(consistent_attrs / total_attrs, 3),
        "exception_counts": exception_counts,
        "exception_spread": max(exception_counts) - min(exception_counts),
        "inconsistent_attributes": inconsistent_attrs,
        "num_runs": len(runs),
    }


# ---------------------------------------------------------------------------
# Evaluation runner
# ---------------------------------------------------------------------------

def evaluate_project(project: str, num_runs: int, ground_truth: dict, from_files: list[str] | None = None) -> dict:
    """Evaluate a single project with N runs."""
    expected = ground_truth.get(project, {})
    if not expected:
        return {"error": f"No ground truth for {project}"}

    runs = []

    if from_files:
        for fpath in from_files:
            with open(fpath) as f:
                pdata = json.load(f)
            runs.append(extract_results(pdata))
    else:
        for i in range(num_runs):
            print(f"\n[{project}] Run {i+1}/{num_runs}")
            pdata = invoke_agent(project)

            RESULTS_DIR.mkdir(exist_ok=True)
            outfile = RESULTS_DIR / f"{project}_eval_run{i+1}.json"
            with open(outfile, "w") as f:
                json.dump(pdata, f, indent=2)
            print(f"  -> saved to {outfile}")

            runs.append(extract_results(pdata))

    scores = []
    for run_result in runs:
        scores.append({
            "attribute_accuracy": score_attribute_accuracy(run_result, expected),
            "exception_count": score_exception_count(run_result, expected),
            "workflow": score_workflow_completeness(run_result),
        })

    determinism = score_determinism(runs)

    summary = {
        "project": project,
        "control_id": expected.get("control_id"),
        "num_runs": len(runs),
        "per_run_scores": scores,
        "determinism": determinism,
    }

    attr_accs = [s["attribute_accuracy"]["attribute_accuracy"] for s in scores]
    exc_matches = [s["exception_count"]["exception_count_match"] for s in scores]
    wf_comps = [s["workflow"]["workflow_completeness"] for s in scores]

    summary["avg_attribute_accuracy"] = round(sum(attr_accs) / len(attr_accs), 3)
    summary["exception_count_match_rate"] = round(sum(exc_matches) / len(exc_matches), 3)
    summary["avg_workflow_completeness"] = round(sum(wf_comps) / len(wf_comps), 3)

    return summary


def print_summary(results: list[dict]):
    """Print a clean summary table."""
    print("\n" + "=" * 80)
    print("EVALUATION SUMMARY")
    print("=" * 80)
    print(f"{'Project':<12} {'Attr Acc':>10} {'Exc Match':>10} {'Workflow':>10} {'Determinism':>12} {'Exc Spread':>11}")
    print("-" * 80)

    for r in results:
        project = r.get("project", "?")
        attr_acc = r.get("avg_attribute_accuracy", 0)
        exc_match = r.get("exception_count_match_rate", 0)
        wf = r.get("avg_workflow_completeness", 0)
        det = r.get("determinism", {})
        det_score = det.get("determinism_score", "N/A")
        exc_spread = det.get("exception_spread", "N/A")

        print(f"{project:<12} {attr_acc:>10.1%} {exc_match:>10.1%} {wf:>10.1%} {str(det_score):>12} {str(exc_spread):>11}")

    print("=" * 80)


def main():
    parser = argparse.ArgumentParser(description="Evaluate compliance agent against ground truth")
    parser.add_argument("project", nargs="?", default="all", help="Project name or 'all'")
    parser.add_argument("--runs", type=int, default=1, help="Number of runs per project")
    parser.add_argument("--from-files", nargs="*", help="Use existing result JSON files instead of live runs")
    parser.add_argument("--output", type=str, help="Write full evaluation report to JSON file")
    args = parser.parse_args()

    gt = load_ground_truth()

    projects = list(gt.keys()) if args.project == "all" else [args.project]

    all_results = []
    for project in projects:
        print(f"\n{'#' * 70}")
        print(f"# Evaluating: {project}")
        print(f"{'#' * 70}")

        result = evaluate_project(project, args.runs, gt, from_files=args.from_files)
        all_results.append(result)

        print(f"\n  Attr Accuracy: {result.get('avg_attribute_accuracy', 0):.1%}")
        print(f"  Exc Match Rate: {result.get('exception_count_match_rate', 0):.1%}")
        print(f"  Workflow Completeness: {result.get('avg_workflow_completeness', 0):.1%}")
        if result.get("determinism", {}).get("determinism_score") != "N/A (single run)":
            print(f"  Determinism: {result['determinism'].get('determinism_score', 'N/A')}")

    print_summary(all_results)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump({"evaluations": all_results}, f, indent=2)
        print(f"\nFull report saved to {output_path}")


if __name__ == "__main__":
    main()
