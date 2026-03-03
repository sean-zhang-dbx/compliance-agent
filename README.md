# GSK Controls Evidence Review Agent

An AI-powered compliance testing agent that automates FRMC (Financial Risk Management & Compliance) control testing on Databricks. The agent reads engagement instructions, parses workbooks, reviews evidence documents (PDFs, screenshots, emails), executes tests, and produces audit-ready reports — all driven by LLMs.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                    │
│  Chat · Project sidebar · Execution trace · Confidence UI  │
└────────────────────────┬───────────────────────────────────┘
                         │ REST
┌────────────────────────▼───────────────────────────────────┐
│                   FastAPI Server (server.py)                │
│  Task polling · Step tracking · Artifact serving · Runs    │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│               LangGraph ReAct Agent (graph.py)             │
│  agent ↔ tools loop · Retry/backoff · Cancellation         │
│                                                            │
│  LLMs:                                                     │
│    Claude Sonnet 4.6  → reasoning, test execution, vision  │
│    Claude Haiku 4.5   → fast extraction, document parsing  │
└────────────────────────┬───────────────────────────────────┘
                         │ tool calls
┌────────────────────────▼───────────────────────────────────┐
│                    16 Agent Tools (tools.py)                │
│                                                            │
│  Discovery        Extraction         Testing               │
│  ─────────        ──────────         ───────               │
│  list_projects    parse_workbook     generate_test_plan     │
│  load_engagement  extract_images     execute_test           │
│                   review_document    batch_execute_tests     │
│  Output           review_screenshot  compile_results        │
│  ──────           analyze_email                             │
│  fill_workbook    batch_review       Interaction            │
│  save_report                         ───────────            │
│  send_email                          ask_user               │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│              Unity Catalog Volume (evidence_files)          │
│  /Volumes/{catalog}/{schema}/{volume}/projects/             │
│    ├── fin_042/   engagement.json, workbook.xlsx, evidence/ │
│    ├── p2p_028/   ...                                       │
│    ├── itg_015/   ...                                       │
│    ├── hr_003/    ...                                       │
│    ├── rev_019/   ...                                       │
│    └── env_007/   ...                                       │
└────────────────────────────────────────────────────────────┘
```

## How the Agent Works

The agent is **control-agnostic** — it reads `engagement.json` for each project to learn what control is being tested, what rules apply, and what evidence to review. No control-specific logic is hardcoded.

### Workflow (8 steps)

| Step | Tool(s) | What happens |
|------|---------|-------------|
| **0. Discover** | `list_projects` | Scans the UC Volume for available project directories |
| **1. Load** | `load_engagement` | Reads `engagement.json` — the playbook for the review (control ID, rules, thresholds, attributes, evidence list) |
| **2. Parse** | `parse_workbook`, `extract_workbook_images` | Reads all Excel tabs (population, samples, attributes). Extracts and analyzes embedded images if present |
| **3. Review** | `batch_review_evidence` | Reviews **all** evidence in parallel — PDFs, screenshots, emails — using the appropriate LLM for each type |
| **4. Plan** | `generate_test_plan` | Computes the deterministic matrix of (attribute x sample item) tests to execute |
| **5. Test** | `batch_execute_tests` | Executes every test in parallel with concurrency control. Each test produces a Pass/Fail result with confidence scoring (High/Medium/Low) |
| **6. Report** | `compile_results` | Produces a structured assessment with overall control opinion |
| **7. Output** | `fill_workbook`, `save_report`, `send_email` | Writes results back to the Excel workbook, saves the Markdown report, and emails stakeholders |

### Confidence Scoring

Every test result includes a confidence level:

- **High** — Multiple corroborating evidence sources, clear match to control criteria
- **Medium** — Evidence supports the conclusion but with minor gaps
- **Low** — Insufficient or ambiguous evidence; recommends manual review

Low-confidence results trigger an **Auditor Advisory** banner in the UI.

### Selective Re-run

Individual tests or evidence reviews can be re-run without restarting the full workflow. The UI provides "Re-run" buttons on each test result and "Re-review" buttons on evidence files.

## Example Workflow: FIN-042 (Manual Journal Entry Review)

This walkthrough shows the agent testing control **FIN-042** — verifying that manual journal entries above GBP 100K have proper dual authorization, Finance Director approval, supporting documentation, and correct posting periods.

### 1. The engagement metadata

```json
{
  "control_objective": {
    "control_id": "FIN-042",
    "control_name": "Manual Journal Entry Review and Approval",
    "domain": "Financial Reporting",
    "rules": {
      "threshold_gbp": 100000,
      "no_self_approval": true,
      "posting_window_days": 5
    }
  },
  "testing_attributes": [
    { "ref": "A", "name": "Complete JE listing obtained and sample reconciled", "applies_to": "control_level" },
    { "ref": "B", "name": "Above-threshold JEs (>100K GBP) reviewed by Finance Director", "applies_to": "above_threshold" },
    { "ref": "C", "name": "Dual authorization verified — preparer and approver are different", "applies_to": "all" },
    { "ref": "D", "name": "Supporting documentation is attached and referenced", "applies_to": "all" },
    { "ref": "E", "name": "Journal entry posted within correct accounting period", "applies_to": "all" }
  ],
  "evidence_files": [
    { "path": "evidence/je_listing.pdf", "type": "pdf" },
    { "path": "evidence/approval_email_001.eml", "type": "email" },
    { "path": "evidence/approval_email_002.eml", "type": "email" },
    { "path": "evidence/approval_email_003.eml", "type": "email" },
    { "path": "evidence/je_policy.pdf", "type": "pdf" }
  ]
}
```

### 2. Agent execution trace

```
Step 1  list_projects           → 6 projects found
Step 2  load_engagement         → FIN-042: Manual JE Review, 5 attributes, 5 evidence files
Step 3  parse_workbook          → 4 tabs parsed (Cover, Population, Sample, Test Matrix)
Step 4  batch_review_evidence   → 5/5 files reviewed in parallel (2 PDFs, 3 emails)
Step 5  generate_test_plan      → 21 tests planned (5 attrs × 5 samples, minus control-level)
Step 6  batch_execute_tests     → 21/21 executed — 18 Pass, 2 Fail, 1 Partial
                                  Confidence: 15H 5M 1L
Step 7  compile_results         → Overall: Qualified — 2 exceptions found
Step 8  fill_workbook           → Results written back to engagement_workbook.xlsx
Step 9  save_report             → report_20241115_143022.md saved
Step 10 send_email              → Report emailed to engagement lead
```

### 3. Key findings

The agent discovers that **JE-2024-0043** was self-approved (preparer = approver), failing attribute C. It also flags that one entry exceeded the GBP 100K threshold without Finance Director review, failing attribute B. The final report is marked **Qualified** with two exceptions and a recommendation for remediation.

## Sample Data Projects

Six synthetic projects cover different FRMC control domains:

| Project | Control | Domain | Evidence Types |
|---------|---------|--------|---------------|
| `p2p_028` | Payment Proposal Approval | Accounts Payable | PDFs |
| `itg_015` | User Access Review | IT General Controls | PDFs |
| `fin_042` | Manual Journal Entry Review | Financial Reporting | PDFs, Emails |
| `hr_003` | Segregation of Duties | HR / IT Controls | PDFs, Screenshots |
| `rev_019` | Revenue Recognition Cutoff | Revenue | PDFs |
| `env_007` | EHS Compliance Inspection | Environmental Health & Safety | PDFs, Embedded images |

Generate sample data:

```bash
cd sample_data && python generate_all_projects.py
```

## Project Structure

```
compliance-agent/
├── databricks.yml              # DAB main config + targets
├── resources/
│   ├── compliance_agent_app.yml    # Databricks App resource
│   ├── uc_resources.yml            # UC Schema + Volume
│   └── data_setup_job.yml          # Sample data setup job
│
├── agent/                      # Core agent logic (shared)
│   ├── graph.py                    # LangGraph state machine (ReAct loop)
│   ├── tools.py                    # 16 agent tools
│   ├── prompts.py                  # System prompt (control-agnostic)
│   ├── config.py                   # Environment-driven configuration
│   ├── server.py                   # FastAPI server factory
│   ├── agent.py                    # MLflow ResponsesAgent wrapper
│   ├── run_context.py              # Thread-local run context
│   └── volume_store.py             # UC Volume read/write
│
├── frontend/                   # React SPA (TypeScript + Vite)
│   └── src/
│       ├── App.tsx                 # Main app (chat, sidebar, execution panel)
│       ├── api.ts                  # REST client
│       └── components/
│           ├── ExecutionPanel.tsx   # Live step trace + confidence badges
│           ├── ChatMessage.tsx      # Markdown message renderer
│           └── FileUpload.tsx       # File upload component
│
├── deploy_app/                 # Databricks Apps deployment package
│   ├── app.yaml                    # App config (env vars, resources)
│   ├── main.py                     # Entry point (uvicorn)
│   ├── requirements.txt            # Python dependencies
│   ├── agent/                      # Agent code (mirrored)
│   ├── frontend/dist/              # Built React SPA
│   └── sample_data/                # Bundled sample data
│
├── app/                        # Local dev entry point
│   ├── main.py
│   └── app.yaml
│
├── src/notebooks/
│   └── setup_sample_data.py    # DAB notebook: generate + upload to volume
├── notebooks/
│   └── 00_end_to_end_demo.py   # Interactive demo notebook
├── sample_data/
│   └── generate_all_projects.py    # Synthetic data generator
└── tests/
    └── test_tools.py               # Unit tests
```

## Deployment

### Databricks Asset Bundle (recommended)

The project includes a full [Databricks Asset Bundle](https://docs.databricks.com/dev-tools/bundles/) that manages the app, UC resources, and data setup job.

```bash
# Validate the bundle
databricks bundle validate

# Deploy to dev
databricks bundle deploy

# Run the sample data setup job (generates projects → uploads to UC Volume)
databricks bundle run setup_sample_data

# Start the app
databricks bundle run compliance_agent

# Deploy to production
databricks bundle deploy -t prod

# Tear down
databricks bundle destroy
```

### Manual deployment

```bash
# 1. Build the frontend
cd frontend && npm install && npm run build && cd ..

# 2. Sync to deploy_app/
cp -r frontend/dist deploy_app/frontend/dist

# 3. Upload to workspace
databricks workspace import-dir deploy_app /Workspace/Users/$USER/gsk-compliance-agent --overwrite

# 4. Create and deploy the app
databricks apps create gsk-compliance-agent
databricks apps deploy gsk-compliance-agent --source-code-path /Workspace/Users/$USER/gsk-compliance-agent
```

### Local development

```bash
# Install dependencies
pip install -r requirements.txt

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Run locally
cd app && uvicorn main:app --reload --port 8000
```

## Configuration

All settings are driven by environment variables (see `agent/config.py`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_ENDPOINT` | `databricks-claude-sonnet-4-6` | Primary LLM for reasoning |
| `VISION_LLM_ENDPOINT` | `databricks-claude-sonnet-4-6` | Vision LLM for screenshots |
| `FAST_LLM_ENDPOINT` | `databricks-claude-haiku-4-5` | Fast LLM for extraction |
| `UC_CATALOG` | `catalog_sandbox_e1b2kq` | Unity Catalog catalog |
| `UC_SCHEMA` | `gsk_compliance` | UC schema |
| `UC_VOLUME` | `evidence_files` | UC volume for project data |
| `PROJECTS_LOCAL_PATH` | `sample_data/projects` | Local fallback path |
| `MAX_PARALLEL_EVIDENCE` | `4` | Concurrent evidence reviews |
| `MAX_PARALLEL_TESTS` | `3` | Concurrent test executions |

## Tech Stack

- **Agent framework**: [LangGraph](https://github.com/langchain-ai/langgraph) (ReAct state machine)
- **LLMs**: Databricks Foundation Model APIs (Claude Sonnet 4.6, Claude Haiku 4.5)
- **Tracing**: [MLflow](https://mlflow.org/) (spans, metrics, experiment tracking)
- **Backend**: FastAPI + Uvicorn
- **Frontend**: React 18 + TypeScript + Vite
- **Storage**: Unity Catalog Volumes
- **Deployment**: Databricks Apps + Asset Bundles
- **Data generation**: openpyxl, fpdf2, Pillow
