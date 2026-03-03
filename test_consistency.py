"""
Consistency test: run the same control multiple times and compare results.
Usage: python test_consistency.py <control_name> <run_label>
"""

import sys
import json
import time
import requests
from databricks.sdk import WorkspaceClient

APP_URL = "https://gsk-compliance-agent-7405607844735163.3.azure.databricksapps.com"

PROMPTS = {
    "fin_042": "Run the full assessment for fin_042",
    "env_007": "Run the full assessment for env_007",
    "p2p_028": "Run the full assessment for p2p_028",
    "itg_015": "Run the full assessment for itg_015",
    "rev_019": "Run the full assessment for rev_019",
    "hr_003": "Run the full assessment for hr_003",
}


def get_auth_headers():
    w = WorkspaceClient()
    return w.config.authenticate()


def run_test(control: str, label: str):
    prompt = PROMPTS[control]
    print(f"[{label}] Sending prompt: {prompt}")

    headers = get_auth_headers()
    headers["Content-Type"] = "application/json"

    resp = requests.post(
        f"{APP_URL}/invocations",
        json={"input": [{"role": "user", "content": prompt}]},
        headers=headers,
        timeout=30,
    )
    print(f"[{label}] POST status: {resp.status_code}")
    if resp.status_code != 200:
        print(f"[{label}] Response: {resp.text[:500]}")
        return
    data = resp.json()

    task_id = data.get("task_id")
    if not task_id:
        print(f"[{label}] ERROR: No task_id returned. Response: {json.dumps(data)[:300]}")
        return

    print(f"[{label}] Task ID: {task_id}")

    start = time.time()
    max_wait = 600
    poll_interval = 5
    pdata = {}

    while time.time() - start < max_wait:
        time.sleep(poll_interval)
        poll = requests.get(
            f"{APP_URL}/api/tasks/{task_id}",
            headers=get_auth_headers(),
            timeout=15,
        )
        if not poll.ok:
            print(f"[{label}] Poll error: {poll.status_code}")
            continue
        pdata = poll.json()

        status = pdata.get("status", "unknown")
        steps = pdata.get("steps", [])
        elapsed = pdata.get("elapsed_seconds", 0)

        running = [s for s in steps if s.get("status") == "running"]
        complete = [s for s in steps if s.get("status") == "complete"]

        if running:
            tool = running[0].get("tool", "?")
            args = running[0].get("args_summary", "")[:60]
            print(f"[{label}] {elapsed:.0f}s — {len(complete)}/{len(steps)} done — {tool}: {args}")
        else:
            print(f"[{label}] {elapsed:.0f}s — {status} — {len(complete)}/{len(steps)} steps")

        if poll_interval < 15:
            poll_interval += 2

        if status in ("complete", "error", "cancelled"):
            break

    elapsed_total = time.time() - start

    results = {}
    for step in pdata.get("steps", []):
        if step.get("tool") == "execute_test" and step.get("status") == "complete":
            summary = step.get("result_summary", "")
            result_val = "Unknown"
            if summary.startswith("Pass"):
                result_val = "Pass"
            elif summary.startswith("Fail"):
                result_val = "Fail"
            elif summary.startswith("Partial"):
                result_val = "Partial"

            args_summary = step.get("args_summary", "")
            results[args_summary] = result_val

    output = {
        "control": control,
        "label": label,
        "status": pdata.get("status"),
        "elapsed_seconds": round(elapsed_total, 1),
        "total_steps": len(pdata.get("steps", [])),
        "test_results": results,
    }

    outfile = f"/tmp/consistency_{control}_{label}.json"
    with open(outfile, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n[{label}] DONE in {elapsed_total:.0f}s — {pdata.get('status')}")
    print(f"[{label}] Test results ({len(results)} tests):")
    for k, v in sorted(results.items()):
        print(f"  {v:8s} | {k}")
    print(f"[{label}] Saved to {outfile}")


if __name__ == "__main__":
    control = sys.argv[1] if len(sys.argv) > 1 else "fin_042"
    label = sys.argv[2] if len(sys.argv) > 2 else "run1"
    run_test(control, label)
