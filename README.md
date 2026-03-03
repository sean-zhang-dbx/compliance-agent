# GSK Controls Evidence Review Agent

Automated compliance testing agent for GSK's Financial Risk Management & Compliance (FRMC) function. Built with **LangGraph** on **Databricks**, using Foundation Model APIs, Unity Catalog tools, and MLflow tracing.

The agent reads an engagement workbook containing control testing procedures (attributes A-F), ingests population data and supporting documents (PDFs, images), executes each test programmatically, and produces an audit-ready assessment report.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     User Interface                       │
│  React Chat UI (Databricks Apps or Azure App Service)    │
└────────────────────────┬────────────────────────────────┘
                         │ /invocations
┌────────────────────────▼────────────────────────────────┐
│              FastAPI / MLflow AgentServer                 │
│         (Databricks Apps or Model Serving)                │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│            LangGraph State Machine                       │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐             │
│  │  Parse    │→│  Validate  │→│  Sample   │             │
│  │ Workbook  │  │ Population │  │  Data    │             │
│  └──────────┘  └───────────┘  └────┬─────┘             │
│                                     │                    │
│  ┌──────────────────────────────────▼─────────────────┐ │
│  │         Execute Tests (A → B → C → D → E → F)      │ │
│  │    ┌──────────┐  ┌──────────┐  ┌──────────┐       │ │
│  │    │ Review    │  │ Threshold│  │ Policy   │       │ │
│  │    │ Documents │  │ Check    │  │ Alignment│       │ │
│  │    └──────────┘  └──────────┘  └──────────┘       │ │
│  └────────────────────────┬───────────────────────────┘ │
│                           │                              │
│  ┌────────────────────────▼──────────────────────────┐  │
│  │           Generate Report (TOE/Issue Template)     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  Claude   │   │    UC    │   │    UC    │
   │  3.7 via  │   │ Functions│   │  Volumes │
   │  FMAPI    │   │          │   │  (Files) │
   └──────────┘   └──────────┘   └──────────┘
```

## Quick Start

### 1. Generate Synthetic Data

```bash
pip install openpyxl fpdf2
python sample_data/generate_data.py
```

This creates:
- `sample_data/engagement_workbook.xlsx` — 4-tab workbook (Population determination, Sampling, Testing Table, Issue template)
- `sample_data/population_data.csv` — 200 financial transaction rows
- `sample_data/supporting_docs/*.pdf` — Payment proposal, approval evidence, policy reference

### 2. Set Up Databricks Resources

Run the setup notebooks on a Databricks cluster:

```
notebooks/01_setup_data.py       # Creates UC catalog/schema/volume, uploads data
notebooks/02_create_uc_functions.py  # Registers threshold_checker, population_summary, data_quality_check
```

### 3. Test the Agent

**Option A: Interactive notebook**
```
notebooks/03_test_agent.py       # Step-by-step testing with tool-level visibility
```

**Option B: Standalone Python**
```bash
pip install -r requirements.txt
python run_agent.py --verbose
```

**Option C: Run via API**
```bash
# Start the backend
cd app && uvicorn main:app --reload
# Query it
curl -X POST http://localhost:8000/invocations \
  -H "Content-Type: application/json" \
  -d '{"input": [{"role": "user", "content": "Parse the engagement workbook at sample_data/engagement_workbook.xlsx"}]}'
```

## Deployment

### Mode 1: Databricks Apps (recommended for demo)

```bash
# Install Databricks CLI
pip install databricks-cli

# Create the app
databricks apps create gsk-compliance-agent

# Upload code
DATABRICKS_USER=$(databricks current-user me | jq -r .userName)
databricks sync . "/Users/$DATABRICKS_USER/gsk-compliance-agent"

# Deploy
databricks apps deploy gsk-compliance-agent \
  --source-code-path "/Workspace/Users/$DATABRICKS_USER/gsk-compliance-agent"
```

The app will be accessible at `https://gsk-compliance-agent.<workspace>.databricksapps.com`.

### Mode 2: Model Serving Endpoint

```
notebooks/04_log_and_deploy.py   # Logs to MLflow, registers in UC, deploys to serving
```

The agent will be available as a REST endpoint. Query via:
```python
from databricks.sdk import WorkspaceClient
w = WorkspaceClient()
response = w.serving_endpoints.query(
    name="agents-catalog_sandbox_e1b2kq-gsk_compliance-compliance_review_agent",
    messages=[{"role": "user", "content": "Run the full control review"}]
)
```

### Mode 3: Azure App Service (for Microsoft deployment)

```bash
# Build the React frontend
cd frontend
npm install && npm run build

# Build and push Docker image
docker build -t gsk-compliance-ui .
docker tag gsk-compliance-ui <your-acr>.azurecr.io/gsk-compliance-ui
docker push <your-acr>.azurecr.io/gsk-compliance-ui

# Deploy to Azure App Service
az webapp create --name gsk-compliance-ui \
  --resource-group <rg> \
  --plan <plan> \
  --deployment-container-image-name <your-acr>.azurecr.io/gsk-compliance-ui
```

Set `BACKEND_URL` to point at the Databricks Model Serving endpoint.

## Project Structure

```
compliance-agent/
├── agent/                        # Core agent (shared across all deployments)
│   ├── agent.py                  # ResponsesAgent wrapper (MLflow interface)
│   ├── graph.py                  # LangGraph state machine
│   ├── tools.py                  # 6 tools: parse, validate, sample, review, test, report
│   ├── config.py                 # Endpoints, catalog/schema, thresholds
│   └── prompts.py                # System prompt and instruction templates
├── app/                          # Databricks Apps deployment
│   ├── app.yaml                  # App resources and config
│   ├── main.py                   # FastAPI server (/invocations, /api/upload, etc.)
│   └── requirements.txt
├── frontend/                     # React chat UI
│   ├── src/App.tsx               # Main chat interface (GSK branded)
│   ├── src/components/           # ChatMessage, FileUpload, TestResultsPanel
│   ├── Dockerfile                # For Azure App Service deployment
│   └── nginx.conf
├── notebooks/                    # Databricks notebook walkthrough
│   ├── 01_setup_data.py
│   ├── 02_create_uc_functions.py
│   ├── 03_test_agent.py
│   └── 04_log_and_deploy.py
├── sample_data/                  # Synthetic demo data
│   ├── generate_data.py
│   ├── engagement_workbook.xlsx
│   ├── population_data.csv
│   └── supporting_docs/          # 3 PDFs
├── run_agent.py                  # Standalone CLI runner
├── requirements.txt
└── README.md
```

## Databricks Components Used

| Component | Usage |
|-----------|-------|
| **Foundation Model API** | Claude 3.7 Sonnet for reasoning, document analysis, test execution |
| **Unity Catalog Volumes** | Store workbooks, population data, PDFs |
| **Unity Catalog Functions** | `threshold_checker`, `population_summary`, `data_quality_check` |
| **Model Serving** | Deploy agent as REST endpoint |
| **Databricks Apps** | Full-stack app deployment (FastAPI + React) |
| **MLflow Tracing** | End-to-end observability of every agent step |
| **MLflow Model Registry** | Version and register the agent in UC |

## Control Testing Attributes (P2P-028)

| Ref | Attribute | What the Agent Does |
|-----|-----------|---------------------|
| A | Payment proposal list obtained? | Checks supporting docs for complete SAP export |
| B | Proposal above threshold? | Runs threshold analysis (£50K GBP) on sampled data |
| C | Above-threshold approved? | Reviews approval evidence PDFs for sign-offs |
| D | Supporting docs reviewed? | Analyzes POs, receipts, contracts via vision LLM |
| E | Blocking functionality appropriate? | Checks blocked payments register and release approvals |
| F | Prepayments/debit balances reviewed? | Validates reconciliation and clearance procedures |

## Configuration

Environment variables (set in `app.yaml`, `.env`, or Databricks secrets):

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_ENDPOINT` | `databricks-claude-3-7-sonnet` | LLM for reasoning |
| `VISION_LLM_ENDPOINT` | `databricks-claude-3-7-sonnet` | LLM for document analysis |
| `UC_CATALOG` | `catalog_sandbox_e1b2kq` | Unity Catalog name |
| `UC_SCHEMA` | `gsk_compliance` | Schema name |
| `UC_VOLUME` | `evidence_files` | Volume for file storage |
| `THRESHOLD_GBP` | `50000` | GBP threshold for escalation |
