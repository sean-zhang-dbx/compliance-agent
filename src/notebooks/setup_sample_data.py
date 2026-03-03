# Databricks notebook source
# MAGIC %md
# MAGIC # GSK Compliance Agent — Sample Data Setup
# MAGIC
# MAGIC Generates 6 synthetic FRMC control testing projects and uploads them
# MAGIC to a Unity Catalog Volume for the compliance agent to consume.
# MAGIC
# MAGIC | Project | Control | Domain |
# MAGIC |---------|---------|--------|
# MAGIC | `p2p_028` | Payment Proposal Approval | Accounts Payable |
# MAGIC | `itg_015` | User Access Review | IT General Controls |
# MAGIC | `fin_042` | Manual Journal Entry Review | Financial Reporting |
# MAGIC | `hr_003` | Segregation of Duties | HR / IT Controls |
# MAGIC | `rev_019` | Revenue Recognition Cutoff | Revenue |
# MAGIC | `env_007` | Environmental Compliance Inspection | EHS |

# COMMAND ----------

# MAGIC %pip install openpyxl fpdf2 Pillow --quiet
# MAGIC dbutils.library.restartPython()

# COMMAND ----------

dbutils.widgets.text("catalog", "catalog_sandbox_e1b2kq", "UC Catalog")
dbutils.widgets.text("schema", "gsk_compliance", "UC Schema")
dbutils.widgets.text("volume", "evidence_files", "UC Volume")

catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
volume = dbutils.widgets.get("volume")
volume_path = f"/Volumes/{catalog}/{schema}/{volume}"

print(f"Target volume: {volume_path}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1: Import the generation script from the bundle workspace

# COMMAND ----------

import os, sys, tempfile
from pathlib import Path

notebook_path = dbutils.notebook.entry_point.getDbutils().notebook().getContext().notebookPath().get()
bundle_files_root = "/Workspace" + str(Path(notebook_path).parent.parent.parent)
gen_script_dir = os.path.join(bundle_files_root, "sample_data")

print(f"Bundle root: {bundle_files_root}")
print(f"Generation script dir: {gen_script_dir}")

sys.path.insert(0, gen_script_dir)
import generate_all_projects as gen

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2: Generate synthetic data to a temp directory

# COMMAND ----------

tmp_dir = Path(tempfile.mkdtemp(prefix="gsk_compliance_"))
gen.BASE_DIR = tmp_dir / "projects"
gen.BASE_DIR.mkdir(parents=True, exist_ok=True)

print(f"Generating to: {gen.BASE_DIR}\n")

gen.gen_p2p_028()
print("[1/6] P2P-028 ✓")

gen.gen_itg_015()
print("[2/6] ITG-015 ✓")

gen.gen_fin_042()
print("[3/6] FIN-042 ✓")

gen.gen_hr_003()
print("[4/6] HR-003 ✓")

gen.gen_rev_019()
print("[5/6] REV-019 ✓")

gen.gen_env_007()
print("[6/6] ENV-007 ✓")

for d in sorted(gen.BASE_DIR.iterdir()):
    if d.is_dir():
        files = [f for f in d.rglob("*") if f.is_file()]
        print(f"  {d.name}/: {len(files)} files")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3: Upload generated data to UC Volume

# COMMAND ----------

from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

uploaded = 0
errors = 0

for local_file in sorted(gen.BASE_DIR.rglob("*")):
    if not local_file.is_file():
        continue

    relative = local_file.relative_to(tmp_dir)
    target_path = f"{volume_path}/{relative}"

    try:
        with open(local_file, "rb") as f:
            w.files.upload(target_path, f, overwrite=True)
        uploaded += 1
    except Exception as e:
        print(f"  ERROR uploading {relative}: {e}")
        errors += 1

print(f"\nUploaded {uploaded} files to {volume_path}/projects/")
if errors:
    print(f"  ({errors} errors)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 4: Verify upload

# COMMAND ----------

project_dirs = []
for item in w.files.list_directory_contents(f"{volume_path}/projects"):
    if item.is_directory:
        project_dirs.append(item.name)
        files_in_project = list(w.files.list_directory_contents(f"{volume_path}/projects/{item.name}"))
        print(f"  {item.name}/: {len(files_in_project)} entries")

print(f"\n{len(project_dirs)} projects ready in {volume_path}/projects/")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup temp directory

# COMMAND ----------

import shutil
shutil.rmtree(tmp_dir, ignore_errors=True)
print("Temp directory cleaned up.")
