# GSK Controls Evidence Review Agent

An AI-powered compliance testing agent that automates FRMC (Financial Risk Management & Compliance) control testing on Databricks. The agent reads engagement instructions, parses workbooks, reviews evidence documents (PDFs, screenshots, emails), executes tests, and produces audit-ready reports — all driven by LLMs.

## Quick Start — Deploy to Any Workspace

### Prerequisites

- [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html) installed and configured
- Node.js 18+ and npm (for frontend build)
- Python 3.10+
- A Databricks workspace with Foundation Model APIs enabled

### One-command deploy

```bash
python setup.py --catalog YOUR_CATALOG_NAME
```

That's it. The script will:

1. Sync agent source code into the deployment package
2. Build the React frontend
3. Generate `app.yaml` with your catalog configuration
4. Deploy the Databricks Asset Bundle (UC schema, volume, app, data job)
5. Run the sample data setup job
6. Start the app

### What you need to provide

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `--catalog` | **Yes** | — | Unity Catalog catalog name |
| `--schema` | No | `gsk_compliance` | UC schema name |
| `--volume` | No | `evidence_files` | UC volume name |
| `--profile` | No | `DEFAULT` | Databricks CLI profile |
| `--target` | No | `dev` | Deployment target (`dev` or `prod`) |
| `--llm-endpoint` | No | `databricks-claude-sonnet-4-6` | Primary LLM |
| `--fast-llm-endpoint` | No | `databricks-claude-haiku-4-5` | Fast LLM |
| `--smtp-email` | No | — | SMTP email for notifications |
| `--smtp-password` | No | — | SMTP app password |

### Examples

```bash
# Deploy to dev (minimal)
python setup.py --catalog my_catalog

# Deploy to prod with a specific CLI profile
python setup.py --catalog prod_catalog --profile PROD --target prod

# Full customization
python setup.py \
  --catalog my_catalog \
  --schema compliance_data \
  --volume audit_files \
  --llm-endpoint databricks-claude-opus-4-6 \
  --smtp-email alerts@company.com \
  --smtp-password "app-password-here"

# Only generate config files (skip deploy)
python setup.py --catalog my_catalog --config-only

# Skip frontend build (already built)
python setup.py --catalog my_catalog --skip-build

# Skip sample data job
python setup.py --catalog my_catalog --skip-data
```

### After deployment

```bash
# View logs
databricks apps logs gsk-compliance-agent-dev

# Restart the app
databricks bundle run compliance_agent

# Refresh sample data
databricks bundle run setup_sample_data

# Tear down everything
databricks bundle destroy
```

---

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
| **1. Load** | `load_engagement` | Reads `engagement.json` — the playbook for the review |
| **2. Parse** | `parse_workbook`, `extract_workbook_images` | Reads all Excel tabs (population, samples, attributes) |
| **3. Review** | `batch_review_evidence` | Reviews **all** evidence in parallel — PDFs, screenshots, emails |
| **4. Plan** | `generate_test_plan` | Computes the deterministic matrix of (attribute x sample item) tests |
| **5. Test** | `batch_execute_tests` | Executes every test in parallel with concurrency control |
| **6. Report** | `compile_results` | Produces a structured assessment with overall control opinion |
| **7. Output** | `fill_workbook`, `save_report`, `send_email` | Writes results, saves report, emails stakeholders |

### Confidence Scoring

Every test result includes a confidence level:

- **High** — Multiple corroborating evidence sources, clear match to control criteria
- **Medium** — Evidence supports the conclusion but with minor gaps
- **Low** — Insufficient or ambiguous evidence; recommends manual review

## Sample Data Projects

Seven synthetic projects cover different FRMC control domains:

| Project | Control | Domain | Evidence Types |
|---------|---------|--------|---------------|
| `p2p_028` | Payment Proposal Approval | Accounts Payable | PDFs |
| `itg_015` | User Access Review | IT General Controls | PDFs |
| `fin_042` | Manual Journal Entry Review | Financial Reporting | PDFs, Emails |
| `hr_003` | Segregation of Duties | HR / IT Controls | PDFs, Screenshots |
| `rev_019` | Revenue Recognition Cutoff | Revenue | PDFs |
| `env_007` | EHS Compliance Inspection | Environmental Health & Safety | PDFs |
| `inv_031` | Inventory Cycle Count Reconciliation | Inventory / Supply Chain | PDFs, Emails |

## Project Structure

```
compliance-agent/
├── setup.py                   # One-command deployment script
├── databricks.yml             # DAB main config + targets
├── resources/
│   ├── compliance_agent_app.yml   # Databricks App resource
│   ├── uc_resources.yml           # UC Schema + Volume
│   └── data_setup_job.yml         # Sample data setup job
│
├── agent/                     # Core agent logic (single source of truth)
│   ├── graph.py                   # LangGraph state machine (ReAct loop)
│   ├── tools.py                   # 16 agent tools
│   ├── prompts.py                 # System prompt (control-agnostic)
│   ├── config.py                  # Environment-driven configuration
│   ├── server.py                  # FastAPI server factory
│   ├── agent.py                   # MLflow ResponsesAgent wrapper
│   ├── run_context.py             # Thread-local run context
│   └── volume_store.py            # UC Volume read/write
│
├── frontend/                  # React SPA (TypeScript + Vite)
│   └── src/
│       ├── App.tsx
│       ├── api.ts
│       └── components/
│           ├── ExecutionPanel.tsx
│           ├── ThinkingPanel.tsx
│           └── ProjectDashboard.tsx
│
├── deploy_app/                # Databricks Apps package (auto-populated by setup.py)
│   ├── app.yaml                   # Generated by setup.py
│   ├── main.py                    # Entry point (uvicorn)
│   ├── requirements.txt
│   ├── agent/                     # Synced from agent/ by setup.py
│   └── frontend/dist/             # Built React SPA
│
├── src/notebooks/
│   └── setup_sample_data.py   # DAB notebook: generate + upload to volume
├── sample_data/
│   └── generate_all_projects.py   # Synthetic data generator
├── eval/                      # Evaluation harness (ground truth + scorers)
└── tests/
    └── test_tools.py
```

## Manual Deployment (without setup.py)

### Databricks Asset Bundle

```bash
databricks bundle validate
databricks bundle deploy
databricks bundle run setup_sample_data
databricks bundle run compliance_agent
```

### Manual upload

```bash
cd frontend && npm install && npm run build && cd ..
cp -r agent/* deploy_app/agent/
cp -r frontend/dist deploy_app/frontend/dist
databricks workspace import-dir deploy_app /Workspace/Users/$USER/gsk-compliance-agent --overwrite
databricks apps deploy gsk-compliance-agent --source-code-path /Workspace/Users/$USER/gsk-compliance-agent
```

### Local development

```bash
pip install -r app/requirements.txt
cd frontend && npm install && npm run build && cd ..
cd app && uvicorn main:app --reload --port 8000
```

## Configuration

All settings are driven by environment variables (see `agent/config.py`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `UC_CATALOG` | *(required)* | Unity Catalog catalog |
| `UC_SCHEMA` | `gsk_compliance` | UC schema |
| `UC_VOLUME` | `evidence_files` | UC volume for project data |
| `LLM_ENDPOINT` | `databricks-claude-sonnet-4-6` | Primary LLM for reasoning |
| `VISION_LLM_ENDPOINT` | `databricks-claude-sonnet-4-6` | Vision LLM for screenshots |
| `FAST_LLM_ENDPOINT` | `databricks-claude-haiku-4-5` | Fast LLM for extraction |
| `MAX_PARALLEL_EVIDENCE` | `4` | Concurrent evidence reviews |
| `MAX_PARALLEL_TESTS` | `3` | Concurrent test executions |
| `SMTP_EMAIL` | — | Email address for notifications |
| `SMTP_APP_PASSWORD` | — | SMTP app password (or use Databricks secrets) |

## Tech Stack

- **Agent framework**: [LangGraph](https://github.com/langchain-ai/langgraph) (ReAct state machine)
- **LLMs**: Databricks Foundation Model APIs (Claude Sonnet 4.6, Claude Haiku 4.5)
- **Tracing**: [MLflow](https://mlflow.org/) (spans, metrics, experiment tracking)
- **Backend**: FastAPI + Uvicorn
- **Frontend**: React 18 + TypeScript + Vite
- **Storage**: Unity Catalog Volumes
- **Deployment**: Databricks Apps + Asset Bundles
- **Data generation**: openpyxl, fpdf2
