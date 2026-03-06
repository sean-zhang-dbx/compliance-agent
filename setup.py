#!/usr/bin/env python3
"""
GSK Compliance Agent — One-command deployment script.

Usage:
    python setup.py --catalog my_catalog
    python setup.py --catalog my_catalog --profile MY_PROFILE --target prod
    python setup.py --catalog my_catalog --schema my_schema --smtp-email me@gmail.com

Run `python setup.py --help` for all options.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
DEPLOY_APP = ROOT / "deploy_app"
AGENT_SRC = ROOT / "agent"
FRONTEND_SRC = ROOT / "frontend"

FOUNDATION_MODEL_ENDPOINTS = {
    "llm": "databricks-claude-sonnet-4-6",
    "vision": "databricks-claude-sonnet-4-6",
    "fast": "databricks-claude-haiku-4-5",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd, check=check, text=True,
                          capture_output=False)


def section(title: str):
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


# ---------------------------------------------------------------------------
# Step 1: Sync agent source → deploy_app/agent
# ---------------------------------------------------------------------------

def sync_agent():
    section("Syncing agent/ → deploy_app/agent/")
    dest = DEPLOY_APP / "agent"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(AGENT_SRC, dest)
    count = sum(1 for _ in dest.rglob("*.py"))
    print(f"  Copied {count} Python files")


# ---------------------------------------------------------------------------
# Step 2: Build frontend
# ---------------------------------------------------------------------------

def build_frontend():
    section("Building frontend")
    if not (FRONTEND_SRC / "node_modules").exists():
        print("  Installing npm dependencies...")
        run(["npm", "install"], cwd=FRONTEND_SRC)

    run(["npm", "run", "build"], cwd=FRONTEND_SRC)

    for dest_dir in [DEPLOY_APP / "frontend" / "dist", DEPLOY_APP / "static"]:
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
    shutil.copytree(FRONTEND_SRC / "dist", DEPLOY_APP / "frontend" / "dist")
    static = DEPLOY_APP / "static"
    static.mkdir(parents=True, exist_ok=True)
    shutil.copy2(FRONTEND_SRC / "dist" / "index.html", static / "index.html")
    if (FRONTEND_SRC / "dist" / "assets").exists():
        shutil.copytree(FRONTEND_SRC / "dist" / "assets", static / "assets")
    print("  Frontend built and copied to deploy_app/")


# ---------------------------------------------------------------------------
# Step 3: Generate deploy_app/app.yaml from user inputs
# ---------------------------------------------------------------------------

def generate_app_yaml(args: argparse.Namespace):
    section("Generating deploy_app/app.yaml")

    resources = [
        {"name": "sonnet-endpoint", "serving_endpoint": args.llm_endpoint, "permission": "CAN_QUERY"},
        {"name": "haiku-endpoint", "serving_endpoint": args.fast_llm_endpoint, "permission": "CAN_QUERY"},
        {"name": "mlflow-experiment", "mlflow_experiment": f"/Users/${{DATABRICKS_USER}}/gsk-compliance-agent", "permission": "CAN_EDIT"},
    ]
    if args.llm_endpoint != args.vision_llm_endpoint:
        resources.insert(1, {
            "name": "vision-endpoint",
            "serving_endpoint": args.vision_llm_endpoint,
            "permission": "CAN_QUERY",
        })

    env_vars = [
        ("LLM_ENDPOINT", args.llm_endpoint),
        ("VISION_LLM_ENDPOINT", args.vision_llm_endpoint),
        ("FAST_LLM_ENDPOINT", args.fast_llm_endpoint),
        ("UC_CATALOG", args.catalog),
        ("UC_SCHEMA", args.schema),
        ("UC_VOLUME", args.volume),
        ("PROJECTS_LOCAL_PATH", "/tmp/compliance_local_cache"),
        ("MLFLOW_EXPERIMENT_NAME", "/Users/${DATABRICKS_USER}/gsk-compliance-agent"),
    ]
    if args.smtp_email:
        env_vars.append(("SMTP_EMAIL", args.smtp_email))
    if args.smtp_password:
        env_vars.append(("SMTP_APP_PASSWORD", args.smtp_password))

    lines = [
        "command:",
        '  - uvicorn',
        '  - main:app',
        '  - --host=0.0.0.0',
        '  - --port=8000',
        '',
        'env:',
    ]
    for name, value in env_vars:
        lines.append(f'  - name: {name}')
        lines.append(f'    value: "{value}"')

    lines.append('')
    lines.append('resources:')
    for r in resources:
        lines.append(f'  - name: {r["name"]}')
        if "serving_endpoint" in r:
            lines.append(f'    serving_endpoint: {r["serving_endpoint"]}')
        elif "mlflow_experiment" in r:
            lines.append(f'    mlflow_experiment: {r["mlflow_experiment"]}')
        lines.append(f'    permission: {r["permission"]}')

    content = '\n'.join(lines) + '\n'
    (DEPLOY_APP / "app.yaml").write_text(content)
    print(f"  Written to deploy_app/app.yaml")
    print(f"  Catalog:  {args.catalog}")
    print(f"  Schema:   {args.schema}")
    print(f"  Volume:   {args.volume}")
    print(f"  LLM:      {args.llm_endpoint}")
    print(f"  Fast LLM: {args.fast_llm_endpoint}")


# ---------------------------------------------------------------------------
# Step 4: Update databricks.yml variables
# ---------------------------------------------------------------------------

def write_databricks_yml(args: argparse.Namespace):
    section("Writing databricks.yml")

    profile_line = ""
    if args.profile and args.profile != "DEFAULT":
        profile_line = f"      profile: {args.profile}"

    content = textwrap.dedent(f"""\
    bundle:
      name: gsk-compliance-agent

    include:
      - resources/*.yml

    variables:
      catalog:
        description: Unity Catalog catalog for all project data and artifacts
        default: {args.catalog}
      schema:
        description: Schema within the catalog for compliance agent tables and volumes
        default: {args.schema}
      volume:
        description: UC Volume name for evidence files and project data
        default: {args.volume}
      warehouse_id:
        description: SQL warehouse for dashboard queries and data setup
        lookup:
          warehouse: "Serverless Starter Warehouse"
      llm_endpoint:
        description: Primary LLM endpoint (reasoning, orchestration)
        default: {args.llm_endpoint}
      vision_llm_endpoint:
        description: Vision-capable LLM endpoint (screenshot analysis)
        default: {args.vision_llm_endpoint}
      fast_llm_endpoint:
        description: Fast LLM endpoint (extraction, parsing)
        default: {args.fast_llm_endpoint}

    targets:
      dev:
        default: true
        mode: development
        workspace:
          root_path: /Workspace/Users/${{workspace.current_user.userName}}/.bundle/${{bundle.name}}/${{bundle.target}}
    {profile_line}
      prod:
        mode: production
        workspace:
          root_path: /Workspace/Users/${{workspace.current_user.userName}}/.bundle/${{bundle.name}}/${{bundle.target}}
    """)

    (ROOT / "databricks.yml").write_text(content)
    print(f"  Written databricks.yml with catalog={args.catalog}")


# ---------------------------------------------------------------------------
# Step 5: Deploy via DAB
# ---------------------------------------------------------------------------

def register_uc_functions(args: argparse.Namespace):
    section("Registering UC functions")
    cmd = [
        sys.executable, str(ROOT / "scripts" / "register_uc_functions.py"),
        "--catalog", args.catalog,
        "--schema", args.schema,
        "--volume", args.volume,
        "--llm-endpoint", args.llm_endpoint,
        "--vision-llm-endpoint", args.vision_llm_endpoint,
        "--fast-llm-endpoint", args.fast_llm_endpoint,
    ]
    if args.smtp_email:
        cmd.extend(["--smtp-email", args.smtp_email])
    result = run(cmd, cwd=ROOT, check=False)
    if result.returncode != 0:
        print("  WARNING: UC function registration failed. The app may not work correctly.")
        print("  You can retry manually: python scripts/register_uc_functions.py --catalog", args.catalog)


def deploy_bundle(args: argparse.Namespace):
    section(f"Deploying bundle (target: {args.target})")

    cmd = ["databricks", "bundle", "validate", "-t", args.target]
    if args.profile:
        cmd.extend(["--profile", args.profile])
    run(cmd, cwd=ROOT)

    cmd = ["databricks", "bundle", "deploy", "-t", args.target, "--auto-approve"]
    if args.profile:
        cmd.extend(["--profile", args.profile])
    run(cmd, cwd=ROOT)

    print(f"\n  Bundle deployed to target '{args.target}'")


# ---------------------------------------------------------------------------
# Step 6: Run sample data setup job
# ---------------------------------------------------------------------------

def run_data_setup(args: argparse.Namespace):
    section("Running sample data setup job")
    cmd = ["databricks", "bundle", "run", "setup_sample_data", "-t", args.target]
    if args.profile:
        cmd.extend(["--profile", args.profile])
    run(cmd, cwd=ROOT, check=False)


# ---------------------------------------------------------------------------
# Step 7: Start the app
# ---------------------------------------------------------------------------

def start_app(args: argparse.Namespace):
    section("Starting the compliance agent app")
    cmd = ["databricks", "bundle", "run", "compliance_agent", "-t", args.target]
    if args.profile:
        cmd.extend(["--profile", args.profile])
    result = run(cmd, cwd=ROOT, check=False)
    if result.returncode == 0:
        print("\n  App started! Check the Databricks workspace for the URL.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Deploy the GSK Compliance Agent to any Databricks workspace.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
        Examples:
          # Minimal — just specify your catalog
          python setup.py --catalog my_catalog

          # With a specific CLI profile and prod target
          python setup.py --catalog prod_catalog --profile PROD --target prod

          # Full customization
          python setup.py \\
            --catalog my_catalog \\
            --schema compliance_data \\
            --volume audit_files \\
            --llm-endpoint databricks-claude-opus-4-6 \\
            --smtp-email alerts@company.com \\
            --smtp-password "app-password-here"

          # Skip build (frontend already built)
          python setup.py --catalog my_catalog --skip-build

          # Only generate config (no deploy)
          python setup.py --catalog my_catalog --config-only
        """),
    )

    parser.add_argument("--catalog", required=True,
                        help="Unity Catalog catalog name (REQUIRED)")
    parser.add_argument("--schema", default="gsk_compliance",
                        help="UC schema name (default: gsk_compliance)")
    parser.add_argument("--volume", default="evidence_files",
                        help="UC volume name (default: evidence_files)")

    parser.add_argument("--llm-endpoint", default=FOUNDATION_MODEL_ENDPOINTS["llm"],
                        dest="llm_endpoint",
                        help=f"Primary LLM endpoint (default: {FOUNDATION_MODEL_ENDPOINTS['llm']})")
    parser.add_argument("--vision-llm-endpoint", default=FOUNDATION_MODEL_ENDPOINTS["vision"],
                        dest="vision_llm_endpoint",
                        help=f"Vision LLM endpoint (default: {FOUNDATION_MODEL_ENDPOINTS['vision']})")
    parser.add_argument("--fast-llm-endpoint", default=FOUNDATION_MODEL_ENDPOINTS["fast"],
                        dest="fast_llm_endpoint",
                        help=f"Fast LLM endpoint (default: {FOUNDATION_MODEL_ENDPOINTS['fast']})")

    parser.add_argument("--smtp-email", default="", dest="smtp_email",
                        help="SMTP email for notifications (optional)")
    parser.add_argument("--smtp-password", default="", dest="smtp_password",
                        help="SMTP app password (optional)")

    parser.add_argument("--profile", default="DEFAULT",
                        help="Databricks CLI profile (default: DEFAULT)")
    parser.add_argument("--target", default="dev", choices=["dev", "prod"],
                        help="Deployment target (default: dev)")

    parser.add_argument("--skip-build", action="store_true",
                        help="Skip frontend build (use existing dist/)")
    parser.add_argument("--skip-data", action="store_true",
                        help="Skip sample data setup job")
    parser.add_argument("--config-only", action="store_true",
                        help="Only generate config files, don't deploy")

    args = parser.parse_args()

    print("=" * 60)
    print("  GSK Compliance Agent — Deployment Setup")
    print("=" * 60)
    print(f"  Catalog:   {args.catalog}")
    print(f"  Schema:    {args.schema}")
    print(f"  Volume:    {args.volume}")
    print(f"  Target:    {args.target}")
    print(f"  Profile:   {args.profile}")

    sync_agent()

    if not args.skip_build:
        build_frontend()
    else:
        print("\n  Skipping frontend build (--skip-build)")

    generate_app_yaml(args)
    write_databricks_yml(args)
    register_uc_functions(args)

    if args.config_only:
        section("Config-only mode — files generated, skipping deploy")
        print("  deploy_app/app.yaml ✓")
        print("  databricks.yml ✓")
        print("\n  To deploy manually:")
        print(f"    databricks bundle deploy -t {args.target}")
        print(f"    databricks bundle run setup_sample_data -t {args.target}")
        print(f"    databricks bundle run compliance_agent -t {args.target}")
        return

    deploy_bundle(args)

    if not args.skip_data:
        run_data_setup(args)
    else:
        print("\n  Skipping sample data setup (--skip-data)")

    start_app(args)

    section("Deployment Complete")
    app_name = f"gsk-compliance-agent-{args.target}"
    print(f"  App name:    {app_name}")
    print(f"  Catalog:     {args.catalog}.{args.schema}")
    print(f"  Volume:      /Volumes/{args.catalog}/{args.schema}/{args.volume}")
    print()
    print("  Next steps:")
    print(f"    1. Open the app URL from the Databricks workspace")
    print(f"    2. Select a project and run an assessment")
    print()
    print("  Useful commands:")
    print(f"    databricks bundle run compliance_agent -t {args.target}  # Restart app")
    print(f"    databricks bundle run setup_sample_data -t {args.target}  # Refresh data")
    print(f"    databricks apps logs {app_name}  # View logs")
    print(f"    databricks bundle destroy -t {args.target}  # Tear down")


if __name__ == "__main__":
    main()
