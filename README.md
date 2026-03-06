# GSK Controls Evidence Review Agent

An AI-powered compliance testing agent that automates FRMC (Financial Risk Management & Compliance) control testing on Databricks. The agent reads engagement instructions, parses workbooks, reviews evidence documents (PDFs, screenshots, emails), executes tests, and produces audit-ready reports — all orchestrated by a single LangGraph ReAct agent.

---

## Quick Start

### Prerequisites

- **Python 3.10+**
- **Node.js 18+** and npm (for the React frontend)
- **[Databricks CLI v0.230+](https://docs.databricks.com/dev-tools/cli/install.html)** installed and authenticated
- A Databricks workspace with **Foundation Model APIs** enabled (Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5)

### 1. Clone the repo

```bash
git clone https://github.com/sean-zhang-dbx/compliance-agent.git
cd compliance-agent
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 3. Deploy (one command)

```bash
python setup.py --catalog YOUR_CATALOG_NAME
```

This single command will:

1. Sync agent source code into the `deploy_app/` package
2. Build the React frontend (`npm install && npm run build`)
3. Register all 18 tools as Unity Catalog Python functions
4. Generate `deploy_app/app.yaml` with your catalog configuration
5. Deploy the Databricks Asset Bundle (UC schema, volume, app, data job)
6. Run the sample data setup job
7. Start the Databricks App

### Setup options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--catalog` | **Yes** | — | Unity Catalog catalog name |
| `--schema` | No | `gsk_compliance` | UC schema name |
| `--volume` | No | `evidence_files` | UC volume name |
| `--profile` | No | `DEFAULT` | Databricks CLI profile |
| `--target` | No | `dev` | Deployment target (`dev` or `prod`) |
| `--llm-endpoint` | No | `databricks-claude-sonnet-4-6` | Primary LLM for orchestration |
| `--vision-llm-endpoint` | No | `databricks-claude-sonnet-4-6` | Vision LLM for screenshots |
| `--fast-llm-endpoint` | No | `databricks-claude-haiku-4-5` | Fast LLM for extraction |
| `--smtp-email` | No | — | Gmail address for email notifications |
| `--smtp-password` | No | — | Gmail app password |
| `--config-only` | No | — | Generate config files without deploying |
| `--skip-build` | No | — | Skip frontend build (reuse existing `dist/`) |
| `--skip-data` | No | — | Skip sample data setup job |

### Examples

```bash
# Minimal — just specify your catalog
python setup.py --catalog my_catalog

# Use a specific CLI profile and deploy to prod
python setup.py --catalog prod_catalog --profile PROD --target prod

# Full customization
python setup.py \
  --catalog my_catalog \
  --schema compliance_data \
  --volume audit_files \
  --llm-endpoint databricks-claude-opus-4-6 \
  --smtp-email alerts@company.com \
  --smtp-password "app-password-here"

# Generate config files only (skip deploy)
python setup.py --catalog my_catalog --config-only
```

### 4. Open the app

After deployment, find the app URL in your Databricks workspace under **Apps** → `gsk-compliance-agent-dev`.

### Post-deployment commands

```bash
# View app logs
databricks apps logs gsk-compliance-agent-dev

# Restart the app
databricks bundle run compliance_agent

# Refresh sample data
databricks bundle run setup_sample_data

# Tear down everything
databricks bundle destroy
```

---

## Local Development

For iterating on the agent or frontend locally without deploying to Databricks Apps:

### Backend

```bash
# Set required env vars
export UC_CATALOG=your_catalog
export LLM_ENDPOINT=databricks-claude-opus-4-6
export FAST_LLM_ENDPOINT=databricks-claude-haiku-4-5

# Start the FastAPI server
cd app && uvicorn main:app --reload --port 8000
```

The local entry point (`app/main.py`) imports the same `create_app()` factory as the deployed version — the only difference is the frontend path resolution.

### Frontend

```bash
cd frontend
npm install
npm run dev    # Vite dev server with HMR on http://localhost:5173
```

The frontend proxies API calls to `http://localhost:8000` via the Vite config.

### Running in a Databricks notebook

The `notebooks/00_end_to_end_demo.py` notebook walks through the full lifecycle:

1. Install dependencies and configure environment
2. Generate synthetic sample data
3. Explore engagement metadata, workbooks, and evidence
4. Call each tool step-by-step to see intermediate I/O
5. Run the complete agent end-to-end with MLflow tracing
6. Inspect reports, traces, and simulated emails

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                    │
│  Project sidebar · Execution trace · Thinking panel · Chat │
└────────────────────────┬───────────────────────────────────┘
                         │ REST API
┌────────────────────────▼───────────────────────────────────┐
│                   FastAPI Server (server.py)                │
│  Task management · Step tracking · Artifact serving · Runs │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│               LangGraph ReAct Agent (graph.py)             │
│  Single agent ↔ tools loop · Retry/backoff · Cancellation  │
│                                                            │
│  LLMs (Databricks Foundation Model APIs):                  │
│    Claude Opus 4.6    → orchestration, test execution      │
│    Claude Sonnet 4.6  → vision (screenshots, photos)       │
│    Claude Haiku 4.5   → fast extraction, document parsing  │
└────────────────────────┬───────────────────────────────────┘
                         │ tool calls
┌────────────────────────▼───────────────────────────────────┐
│                    18 Agent Tools (tools.py)                │
│                                                            │
│  Discovery        Extraction          Testing              │
│  ─────────        ──────────          ───────              │
│  list_projects    parse_workbook      generate_test_plan   │
│  load_engagement  extract_images      execute_test         │
│  announce_plan    review_document     batch_execute_tests  │
│                   review_screenshot   aggregate_test_results│
│  Delivery         analyze_email       compile_results      │
│  ────────         batch_review                             │
│  fill_workbook                        Interaction          │
│  save_report                          ───────────          │
│  send_email                           ask_user             │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│              Unity Catalog Volume (evidence_files)          │
│  /Volumes/{catalog}/{schema}/{volume}/projects/             │
│    ├── fin_042/  engagement.json, workbook.xlsx, evidence/  │
│    ├── p2p_028/  ...                                        │
│    ├── itg_015/  ...                                        │
│    ├── hr_003/   ...                                        │
│    ├── rev_019/  ...                                        │
│    └── env_007/  ...                                        │
└────────────────────────────────────────────────────────────┘
```

### Key design decisions

- **Single ReAct agent** — The graph is two nodes (`agent ↔ tools`) in a loop. There are no subagents, routers, or handoffs. The 200-line system prompt drives the multi-step workflow.
- **Tools are also registered as UC functions** — `scripts/register_uc_functions.py` registers all 18 tools as Unity Catalog Python functions (for SQL/notebook access). At runtime, the app loads tools from the local `tools.py` module because UC Python function sandboxes don't support `WorkspaceClient()` auth.
- **Volume-first storage** — All artifacts (reports, workbooks, step outputs) are persisted to UC Volumes via `volume_store.py`. Local filesystem is a write-through cache only.
- **MLflow ResponsesAgent wrapper** — `agent.py` wraps the LangGraph graph in MLflow's `ResponsesAgent` interface for model serving compatibility.
- **Parallelism inside tools** — `batch_review_evidence` (up to 4 concurrent) and `batch_execute_tests` (up to 3 concurrent) use `ThreadPoolExecutor` internally. From LangGraph's perspective, they're single tool calls.

---

## Agent Workflow

The agent is **control-agnostic** — it reads `engagement.json` for each project to learn what control is being tested, what rules apply, and what evidence to review. No control-specific logic is hardcoded.

| Step | Tool(s) | What happens |
|------|---------|-------------|
| **0. Discover** | `list_projects` | Scans the UC Volume for available project directories |
| **1. Load** | `load_engagement` | Reads `engagement.json` — the playbook for the review |
| **1b. Plan** | `announce_plan` | Declares the assessment phases to the UI |
| **2. Parse** | `parse_workbook` | Reads all Excel tabs (population, samples, attributes) |
| **2b. Images** | `extract_workbook_images` | Extracts embedded screenshots from Excel (if present) |
| **3. Review** | `batch_review_evidence` | Reviews **all** evidence files in parallel (PDFs, screenshots, emails) |
| **4. Plan tests** | `generate_test_plan` | Computes the deterministic test matrix (attribute × sample) |
| **5. Execute** | `batch_execute_tests` | Executes every test in parallel with concurrency control |
| **5b. Aggregate** | `aggregate_test_results` | Deterministic per-attribute rollup (no LLM judgment) |
| **6. Report** | `compile_results` | Generates the structured assessment report |
| **7. Fill** | `fill_workbook` | Writes results and exceptions back into the Excel workbook |
| **8. Save** | `save_report` | Persists the markdown report to the UC Volume |
| **9. Email** | `send_email` | Emails the report to stakeholders (if configured) |

### Confidence scoring

Every test result includes a confidence level:

- **High** — Direct, unambiguous evidence (matching document numbers, clear approval chain)
- **Medium** — Evidence exists but is indirect or partially legible
- **Low** — Insufficient or contradictory evidence; flagged for mandatory human review

---

## Sample Data Projects

Six synthetic projects cover different FRMC control domains:

| Project | Control | Domain | Evidence Types |
|---------|---------|--------|---------------|
| `fin_042` | Manual Journal Entry Review | Financial Reporting | PDFs, Emails (.eml) |
| `p2p_028` | Payment Proposal Approval | Accounts Payable | PDFs |
| `itg_015` | User Access Review | IT General Controls | PDFs, Screenshots |
| `hr_003` | Segregation of Duties | HR / IT Controls | PDFs, Screenshots |
| `rev_019` | Revenue Recognition Cutoff | Revenue / Financial Reporting | PDFs, Photos |
| `env_007` | EHS Compliance Inspection | Environmental Health & Safety | PDFs, Embedded Excel images |

Sample data is generated by `sample_data/generate_all_projects.py` and uploaded to the UC Volume by the DAB job `setup_sample_data`.

---

## Project Structure

```
compliance-agent/
├── setup.py                       # One-command deployment script
├── databricks.yml                 # DAB config (variables, targets)
├── requirements.txt               # Python dependencies
├── resources/
│   ├── compliance_agent_app.yml   # Databricks App resource definition
│   ├── uc_resources.yml           # UC Schema + Volume
│   └── data_setup_job.yml         # Sample data job
│
├── agent/                         # Core agent logic (single source of truth)
│   ├── graph.py                   # LangGraph state machine (ReAct loop)
│   ├── tools.py                   # 18 agent tools (all control-agnostic)
│   ├── prompts.py                 # System prompt + test/report templates
│   ├── config.py                  # Environment-driven configuration
│   ├── server.py                  # FastAPI server factory (routes, tasks, artifacts)
│   ├── agent.py                   # MLflow ResponsesAgent wrapper
│   ├── run_context.py             # Thread-local run context (contextvars)
│   └── volume_store.py            # UC Volume read/write operations
│
├── frontend/                      # React SPA (TypeScript + Vite)
│   ├── src/
│   │   ├── App.tsx                # Main app with project sidebar + split pane
│   │   ├── api.ts                 # REST client + polling
│   │   └── components/
│   │       ├── ExecutionPanel.tsx  # Tool call trace + results
│   │       ├── ThinkingPanel.tsx   # Agent reasoning + plan timeline
│   │       └── ProjectDashboard.tsx# Project detail + run history
│   ├── vite.config.ts
│   └── package.json
│
├── app/                           # Local dev entry point
│   └── main.py                    # uvicorn wrapper → agent.server.create_app()
│
├── deploy_app/                    # Databricks Apps package (auto-populated by setup.py)
│   ├── main.py                    # App entry point → agent.server.create_app()
│   ├── requirements.txt           # App-specific Python deps
│   ├── agent/                     # Synced from agent/ by setup.py
│   ├── frontend/dist/             # Built React SPA
│   └── static/                    # Static files served by FastAPI
│
├── scripts/
│   └── register_uc_functions.py   # Register all 18 tools as UC Python functions
│
├── notebooks/
│   └── 00_end_to_end_demo.py      # Interactive walkthrough (Databricks notebook)
│
├── src/notebooks/
│   └── setup_sample_data.py       # DAB job: generate + upload to UC Volume
│
├── sample_data/
│   ├── generate_all_projects.py   # Synthetic data generator
│   └── projects/                  # Generated engagement files (6 projects)
│
├── eval/
│   ├── evaluate.py                # Evaluation harness (accuracy, determinism, workflow)
│   └── ground_truth.json          # Expected outcomes per project
│
└── tests/
    └── test_tools.py
```

---

## Configuration

All settings are driven by environment variables (see `agent/config.py`). When deploying via `setup.py`, these are set automatically in `deploy_app/app.yaml`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `UC_CATALOG` | *(required)* | Unity Catalog catalog |
| `UC_SCHEMA` | `gsk_compliance` | UC schema |
| `UC_VOLUME` | `evidence_files` | UC volume for project data |
| `LLM_ENDPOINT` | `databricks-claude-opus-4-6` | Primary LLM (orchestration, test execution) |
| `VISION_LLM_ENDPOINT` | `databricks-claude-sonnet-4-6` | Vision LLM (screenshots, photos) |
| `FAST_LLM_ENDPOINT` | `databricks-claude-haiku-4-5` | Fast LLM (document parsing, extraction) |
| `MAX_PARALLEL_EVIDENCE` | `4` | Concurrent evidence reviews |
| `MAX_PARALLEL_TESTS` | `3` | Concurrent test executions |
| `SMTP_EMAIL` | — | Gmail address for notifications |
| `SMTP_APP_PASSWORD` | — | Gmail app password (or use Databricks secrets scope `gsk-compliance`, key `smtp-app-password`) |
| `APP_BASE_URL` | — | App URL for artifact links in emails |

---

## Evaluation

The `eval/` directory contains a ground-truth evaluation harness with four scorers:

| Scorer | What it measures |
|--------|-----------------|
| **Attribute accuracy** | Per-attribute pass/fail match against ground truth |
| **Exception count** | Total exception count vs. expected |
| **Workflow completeness** | Were all expected tools called in the right order? |
| **Determinism** | Across N runs, how consistent are the results? |

```bash
# Evaluate a single project (1 run)
python eval/evaluate.py fin_042

# Multiple runs for determinism check
python eval/evaluate.py fin_042 --runs 3

# All projects
python eval/evaluate.py all --runs 2

# Use existing result files
python eval/evaluate.py --from-files test-results/fin_042_run1.json
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent framework | [LangGraph](https://github.com/langchain-ai/langgraph) (ReAct state machine) |
| LLMs | Databricks Foundation Model APIs (Claude Opus 4.6, Sonnet 4.6, Haiku 4.5) |
| Observability | [MLflow](https://mlflow.org/) (tracing, autologging, experiment tracking) |
| Backend | FastAPI + Uvicorn |
| Frontend | React 18 + TypeScript + Vite |
| Storage | Unity Catalog Volumes |
| Deployment | Databricks Apps + Databricks Asset Bundles |
| Data generation | openpyxl, fpdf2, Pillow |
