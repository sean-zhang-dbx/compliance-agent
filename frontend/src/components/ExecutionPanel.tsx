import React, { useState, useEffect, useRef } from "react";
import type { ToolStep, Engagement, EvidenceFile, RunInfo, SubProgress } from "../api";
import type { ProjectInfo } from "../api";
import { fetchArtifact, fetchEngagement, getEvidenceUrl, downloadBinaryArtifact, listRuns, fetchRunManifest } from "../api";

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.round((Date.now() - startTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  return <span style={{ fontSize: 10, color: "#ea580c", fontFamily: "monospace" }}>{elapsed}s</span>;
}

function BatchProgress({ progress }: { progress: SubProgress }) {
  const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>
          {progress.completed}/{progress.total} complete
        </span>
        {progress.detail && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>
            latest: {progress.detail}
          </span>
        )}
      </div>
      <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 2, transition: "width 0.3s ease",
          width: `${pct}%`, background: "linear-gradient(90deg, #f36f21, #f59e0b)",
        }} />
      </div>
    </div>
  );
}

function volumePathToUrl(volPath: string): string | null {
  const vm = volPath.match(/^\/Volumes\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!vm) return null;
  const [, catalog, schema, volume] = vm;
  const hm = window.location.hostname.match(/-(\d{10,})\.(\d+)\.azure\.databricksapps\.com$/);
  if (!hm) return null;
  return `https://adb-${hm[1]}.${hm[2]}.azuredatabricks.net/explore/data/volumes/${catalog}/${schema}/${volume}`;
}

/* ─── Icon & description maps ─── */

const TOOL_ICONS: Record<string, string> = {
  list_projects: "📂", load_engagement: "📋", parse_workbook: "📊",
  extract_workbook_images: "🖼️", review_document: "📄", review_screenshot: "🔍",
  analyze_email: "✉️", execute_test: "🧪", compile_results: "📝",
  fill_workbook: "📗", save_report: "💾", send_email: "📧",
  ask_user: "❓", batch_review_evidence: "📚", batch_execute_tests: "⚡",
  aggregate_test_results: "📊", generate_test_plan: "📋",
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_projects: "Discovering available projects",
  load_engagement: "Loading engagement instructions",
  parse_workbook: "Parsing the audit workbook",
  extract_workbook_images: "Extracting embedded images",
  review_document: "Analyzing a PDF document",
  review_screenshot: "Analyzing a screenshot",
  analyze_email: "Reviewing email evidence",
  execute_test: "Running a test attribute",
  compile_results: "Compiling final report",
  fill_workbook: "Writing results to workbook",
  save_report: "Saving the audit report",
  send_email: "Sending notification email",
  ask_user: "Requesting clarification",
  batch_review_evidence: "Reviewing evidence files in parallel",
  batch_execute_tests: "Executing test attributes in parallel",
  aggregate_test_results: "Aggregating test results",
  generate_test_plan: "Generating test plan",
};

/* ─── Result parsing (reused from original) ─── */

interface TestResult {
  ref: string;
  attributeName: string;
  sampleLabel: string;
  result: "Pass" | "Fail" | "Partial" | "Pending";
  narrative: string;
  duration?: number;
  confidence?: "High" | "Medium" | "Low";
}

interface GroupedAttribute {
  ref: string;
  attributeName: string;
  samples: TestResult[];
  overallResult: "Pass" | "Fail" | "Partial" | "Pending";
  passCount: number;
  failCount: number;
  totalCount: number;
  lowestConfidence?: "High" | "Medium" | "Low";
}

function parseSingleTestResult(s: { args_summary?: string; status: string; result_summary?: string; duration?: number }): TestResult {
  const refMatch = s.args_summary?.match(/\[([A-Z]+)\]/);
  const ref = refMatch ? refMatch[1] : "?";
  const argsText = s.args_summary || "";
  const afterRef = argsText.replace(/^\[[A-Z]+\]\s*/, "");
  const arrowIdx = afterRef.indexOf("→");
  const attributeName = arrowIdx >= 0 ? afterRef.slice(0, arrowIdx).trim() : afterRef.trim();
  const sampleLabel = arrowIdx >= 0 ? afterRef.slice(arrowIdx + 1).trim() : "";
  if (s.status !== "complete" || !s.result_summary) {
    return { ref, attributeName, sampleLabel, result: "Pending", narrative: "", duration: s.duration };
  }
  const summary = s.result_summary;
  const resultMatch = summary.match(/^(Pass|Fail|Not\s*Applicable|Partial|N\/A)\b/i);
  let result: TestResult["result"] = "Pending";
  if (resultMatch) {
    const r = resultMatch[1].toLowerCase();
    if (r === "pass") result = "Pass";
    else if (r === "fail") result = "Fail";
    else result = "Partial";
  }
  const confMatch = summary.match(/\[(High|Medium|Low)\]/i);
  const confidence = confMatch ? confMatch[1] as TestResult["confidence"] : undefined;
  const narrative = summary.replace(/^(Pass|Fail|Not\s*Applicable|Partial|N\/A)\s*\[(?:High|Medium|Low)\]\s*[-—]\s*/i, "")
    .replace(/^(Pass|Fail|Not\s*Applicable|Partial|N\/A)\s*[-—]\s*/i, "") || "";
  return { ref, attributeName, sampleLabel, result, narrative, duration: s.duration, confidence };
}

function extractTestResults(steps: ToolStep[]): TestResult[] {
  const results: TestResult[] = [];
  for (const s of steps) {
    if (s.tool === "execute_test") {
      results.push(parseSingleTestResult(s));
    } else if (s.tool === "batch_execute_tests" && s.status === "complete" && s.result_summary) {
      const lines = s.result_summary.split(/\n|;\s*/);
      for (const line of lines) {
        const m = line.match(/\[([A-Z]+)\]\s*(.+?):\s*(Pass|Fail|Partial|N\/A)/i);
        if (m) {
          results.push({
            ref: m[1], attributeName: m[2].trim(), sampleLabel: "",
            result: m[3].toLowerCase() === "pass" ? "Pass" : m[3].toLowerCase() === "fail" ? "Fail" : "Partial",
            narrative: line.replace(/\[.+?\]\s*/, ""), duration: s.duration,
          });
        }
      }
    }
  }
  return results;
}

function groupByAttribute(results: TestResult[]): GroupedAttribute[] {
  const map = new Map<string, GroupedAttribute>();
  for (const r of results) {
    if (!map.has(r.ref)) {
      map.set(r.ref, { ref: r.ref, attributeName: r.attributeName || `Attribute ${r.ref}`, samples: [], overallResult: "Pending", passCount: 0, failCount: 0, totalCount: 0 });
    }
    const g = map.get(r.ref)!;
    g.samples.push(r);
    g.totalCount++;
    if (r.result === "Pass") g.passCount++;
    if (r.result === "Fail") g.failCount++;
    if (r.attributeName && r.attributeName.length > g.attributeName.length) g.attributeName = r.attributeName;
  }
  const CONF_RANK: Record<string, number> = { Low: 0, Medium: 1, High: 2 };
  for (const g of map.values()) {
    if (g.failCount > 0) g.overallResult = "Fail";
    else if (g.samples.some((s) => s.result === "Partial")) g.overallResult = "Partial";
    else if (g.passCount === g.totalCount && g.totalCount > 0) g.overallResult = "Pass";
    else g.overallResult = "Pending";
    let lowest = 3;
    for (const s of g.samples) {
      if (s.confidence && CONF_RANK[s.confidence] !== undefined) lowest = Math.min(lowest, CONF_RANK[s.confidence]);
    }
    if (lowest <= 2) g.lowestConfidence = (["Low", "Medium", "High"] as const)[lowest];
  }
  return Array.from(map.values());
}

function extractControlInfo(steps: ToolStep[]) {
  const engStep = steps.find((s) => s.tool === "load_engagement" && s.status === "complete");
  if (!engStep?.result_summary) return { controlId: "", controlName: "", attrCount: 0, evidenceCount: 0 };
  const idMatch = engStep.result_summary.match(/^([A-Z]+-[A-Z]*-?\d+)/);
  const nameMatch = engStep.result_summary.match(/—\s*(.+?)\s*\(/);
  const attrMatch = engStep.result_summary.match(/(\d+)\s*attrs/);
  const evidMatch = engStep.result_summary.match(/(\d+)\s*evidence/);
  return { controlId: idMatch?.[1] || "", controlName: nameMatch?.[1] || "", attrCount: attrMatch ? parseInt(attrMatch[1]) : 0, evidenceCount: evidMatch ? parseInt(evidMatch[1]) : 0 };
}

function getOverallAssessment(results: TestResult[]): string {
  if (results.length === 0) return "";
  const fails = results.filter((r) => r.result === "Fail").length;
  const partials = results.filter((r) => r.result === "Partial").length;
  if (fails >= 2) return "Ineffective";
  if (fails === 1 || partials > 0) return "Effective with Exceptions";
  return "Effective";
}

function getStepResultBadge(step: ToolStep): { label: string; color: string } | null {
  if (step.status !== "complete" || !step.result_summary) return null;
  const s = step.result_summary;
  if (/^Pass\b/i.test(s)) return { label: "PASS", color: "#10b981" };
  if (/^Fail\b/i.test(s)) return { label: "FAIL", color: "#ef4444" };
  if (/^Partial|^N\/A/i.test(s)) return { label: "PARTIAL", color: "#f59e0b" };
  if (step.tool === "batch_review_evidence") {
    const m = s.match(/(\d+)\s*files?/i);
    if (m) return { label: `${m[1]} files`, color: "#2563eb" };
  }
  if (step.tool === "batch_execute_tests") {
    const passM = s.match(/(\d+)\s*pass/i);
    const failM = s.match(/(\d+)\s*fail/i);
    if (passM || failM) {
      const p = passM ? parseInt(passM[1]) : 0;
      const f = failM ? parseInt(failM[1]) : 0;
      if (f > 0) return { label: `${p}P ${f}F`, color: "#ef4444" };
      return { label: `${p} pass`, color: "#10b981" };
    }
  }
  return null;
}

const RESULT_COLORS: Record<string, string> = { Pass: "#10b981", Fail: "#ef4444", Partial: "#f59e0b", Pending: "#9ca3af" };
const CONFIDENCE_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  High: { bg: "#ecfdf5", color: "#059669", border: "#a7f3d0" },
  Medium: { bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
  Low: { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
};
const ASSESSMENT_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  Effective: { bg: "#ecfdf5", color: "#059669", border: "#a7f3d0" },
  "Effective with Exceptions": { bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
  Ineffective: { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
};

/* ─── Component ─── */

interface Props {
  project: ProjectInfo | null;
  steps: ToolStep[];
  currentStep: string | null;
  elapsed: number;
  isRunning: boolean;
  isComplete: boolean;
  runId: string;
  projectDir: string;
  cancelling?: boolean;
  onRerunTest?: (projectDir: string, ref: string, attribute: string) => void;
  onReviewEvidence?: (projectDir: string, filePath: string, fileType: string) => void;
  onStop?: () => void;
  onStartOver?: () => void;
  onContinue?: () => void;
  wasCancelled?: boolean;
}

type ViewMode = "live" | "history";

export default function ExecutionPanel({
  project, steps, currentStep, elapsed, isRunning, isComplete, runId, projectDir,
  cancelling, onRerunTest, onReviewEvidence, onStop, onStartOver, onContinue, wasCancelled,
}: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [emailPreview, setEmailPreview] = useState<{ name: string; content: string } | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [pastRuns, setPastRuns] = useState<RunInfo[]>([]);
  const [historySteps, setHistorySteps] = useState<ToolStep[]>([]);
  const [historyRunId, setHistoryRunId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const stepStartTimes = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (projectDir) {
      fetchEngagement(projectDir).then((e) => e && setEngagement(e));
      listRuns(projectDir).then((runs) => setPastRuns(runs));
    }
  }, [projectDir]);

  useEffect(() => { if (isRunning) setViewMode("live"); }, [isRunning]);

  useEffect(() => {
    steps.forEach((s, idx) => {
      if (s.status === "running" && !stepStartTimes.current.has(idx)) {
        stepStartTimes.current.set(idx, Date.now());
      }
    });
  }, [steps]);

  const displaySteps = viewMode === "history" ? historySteps : steps;
  const displayRunId = viewMode === "history" ? historyRunId : runId;

  const testResults = extractTestResults(displaySteps);
  const groupedAttrs = groupByAttribute(testResults);
  const controlInfo = extractControlInfo(displaySteps);
  const assessment = getOverallAssessment(testResults);
  const completedCount = displaySteps.filter((s) => s.status === "complete").length;
  const totalDuration = displaySteps.reduce((acc, s) => acc + (s.duration || 0), 0);

  const saveStep = displaySteps.find((s) => s.tool === "save_report" && s.status === "complete");
  let reportAppUrl = "";
  if (saveStep?.result_summary) {
    const parts = saveStep.result_summary.split(" — ");
    const urlPart = parts.slice(1).join(" — ");
    if (urlPart.startsWith("http")) reportAppUrl = urlPart;
  }
  if (!reportAppUrl && projectDir && displayRunId) {
    reportAppUrl = `${window.location.origin}/api/artifacts/${projectDir}/${displayRunId}/report.md`;
  }

  const wbStep = displaySteps.find((s) => s.tool === "fill_workbook" && s.status === "complete");
  let wbFilename = "";
  if (wbStep?.result_summary) {
    const parts = wbStep.result_summary.split(" — ");
    wbFilename = parts[0] || "";
  }

  const emailStep = displaySteps.find((s) => s.tool === "send_email" && s.status === "complete");
  const emailSent = emailStep?.result_summary?.toLowerCase().includes("sent") ?? false;

  const showCompleteState = viewMode === "history" || (isComplete && !isRunning);
  const passCount = groupedAttrs.filter((g) => g.overallResult === "Pass").length;
  const failCount = groupedAttrs.filter((g) => g.overallResult === "Fail").length;
  const exceptionsCount = groupedAttrs.reduce((acc, g) => acc + g.failCount, 0);

  const handleLoadHistoryRun = async (run: RunInfo) => {
    setHistoryLoading(true);
    setHistoryRunId(run.run_id);
    setViewMode("history");
    try {
      const manifest = await fetchRunManifest(projectDir, run.run_id);
      if (manifest?.steps) setHistorySteps(manifest.steps);
      else setHistorySteps([]);
    } catch { setHistorySteps([]); }
    finally { setHistoryLoading(false); }
  };

  const handleArtifactClick = async (step: ToolStep, idx: number) => {
    if (expandedIdx === idx && artifactContent !== null) { setExpandedIdx(null); setArtifactContent(null); return; }
    setExpandedIdx(idx);
    const effectiveRunId = viewMode === "history" ? historyRunId : runId;
    if (step.artifact && projectDir && effectiveRunId) {
      setArtifactLoading(true);
      try { setArtifactContent(await fetchArtifact(projectDir, effectiveRunId, step.artifact)); }
      catch { setArtifactContent(step.result_summary || "No content available"); }
      finally { setArtifactLoading(false); }
    } else { setArtifactContent(step.result_summary || null); }
  };

  const handleReportClick = async () => {
    if (showReport) { setShowReport(false); return; }
    setShowReport(true);
    if (reportContent) return;
    setReportLoading(true);
    const effectiveRunId = viewMode === "history" ? historyRunId : runId;
    try { setReportContent(await fetchArtifact(projectDir, effectiveRunId, "report.md")); }
    catch {
      try {
        const compileStep = displaySteps.find((s) => s.tool === "compile_results" && s.artifact);
        if (compileStep?.artifact) setReportContent(await fetchArtifact(projectDir, effectiveRunId, compileStep.artifact));
        else setReportContent("Report not available.");
      } catch { setReportContent("Report not available."); }
    } finally { setReportLoading(false); }
  };

  /* ─── Render ─── */

  return (
    <div style={S.panel}>
      {/* Report overlay */}
      {showReport && (
        <div style={S.overlay}>
          <div style={S.overlayHeader}>
            <div style={S.overlayTitle}>📄 Report — {controlInfo.controlId || projectDir}</div>
            <button style={S.overlayClose} onClick={() => setShowReport(false)}>✕</button>
          </div>
          <div style={S.overlayBody}>
            {reportLoading ? <div style={S.loadingText}>Loading report...</div> : (
              <pre style={S.reportPre}>{reportContent || "No report content"}</pre>
            )}
          </div>
        </div>
      )}

      {/* ─── 1. Header bar ─── */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          {controlInfo.controlId ? (
            <>
              <span style={S.headerControlId}>{controlInfo.controlId}</span>
              <span style={S.headerControlName}>{controlInfo.controlName}</span>
            </>
          ) : project ? (
            <>
              <span style={S.headerControlId}>{project.control_id || project.project_dir}</span>
              <span style={S.headerControlName}>{project.control_name || ""}</span>
            </>
          ) : (
            <span style={S.headerControlName}>Controls Evidence Review</span>
          )}
          {(project?.domain || controlInfo.controlId) && (
            <span style={S.domainTag}>{project?.domain || ""}</span>
          )}
        </div>
        <div style={S.headerRight}>
          {isRunning && (
            <div style={S.statusRunning}>
              <span style={S.statusPulse} />
              {cancelling ? "Stopping..." : `Running · ${Math.round(elapsed)}s`}
            </div>
          )}
          {showCompleteState && displaySteps.length > 0 && !wasCancelled && (
            <div style={S.statusComplete}>✓ Completed · {Math.round(totalDuration)}s</div>
          )}
          {showCompleteState && displaySteps.length > 0 && wasCancelled && (
            <div style={S.statusStopped}>⏸ Stopped · {completedCount}/{displaySteps.length} steps</div>
          )}
          {isRunning && !cancelling && onStop && (
            <button style={S.stopBtn} onClick={onStop}>Stop</button>
          )}
          {!isRunning && displaySteps.length > 0 && onStartOver && (
            <button style={S.startOverBtn} onClick={onStartOver}>Start Over</button>
          )}
          {!isRunning && wasCancelled && onContinue && (
            <button style={S.continueBtn} onClick={onContinue}>Continue Run ▶</button>
          )}

          {/* View toggle */}
          {pastRuns.length > 0 && (
            <div style={S.viewToggle}>
              <button style={{ ...S.viewToggleBtn, ...(viewMode === "live" ? S.viewToggleBtnActive : {}) }} onClick={() => setViewMode("live")}>
                Current
              </button>
              <button style={{ ...S.viewToggleBtn, ...(viewMode === "history" ? S.viewToggleBtnActive : {}) }} onClick={() => setViewMode("history")}>
                History ({pastRuns.length})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {displaySteps.length > 0 && (
        <div style={S.progressBar}>
          <div style={{
            ...S.progressFill,
            width: `${(completedCount / Math.max(displaySteps.length, 1)) * 100}%`,
            ...(showCompleteState ? { background: "#10b981" } : {}),
          }} />
        </div>
      )}

      {/* Completion banner */}
      {showCompleteState && !wasCancelled && assessment && displaySteps.length > 0 && (
        <div style={{
          margin: "16px 24px 0", padding: "16px 20px", borderRadius: 12,
          background: ASSESSMENT_STYLES[assessment]?.bg || "#f9fafb",
          border: `2px solid ${ASSESSMENT_STYLES[assessment]?.border || "#e5e7eb"}`,
          display: "flex", alignItems: "center", gap: 16, flexShrink: 0,
        }}>
          <div style={{ fontSize: 32 }}>
            {assessment === "Effective" ? "✅" : assessment === "Ineffective" ? "❌" : "⚠️"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 18, fontWeight: 800,
              color: ASSESSMENT_STYLES[assessment]?.color || "#374151",
            }}>
              {assessment}
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              {passCount}/{groupedAttrs.length} attributes passed · {exceptionsCount} exception{exceptionsCount !== 1 ? "s" : ""} · {Math.round(totalDuration)}s
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {displaySteps.some(s => s.tool === "compile_results" && s.status === "complete") && (
              <button onClick={handleReportClick} style={{
                padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer",
                background: ASSESSMENT_STYLES[assessment]?.color || "#374151", color: "#fff",
                fontSize: 12, fontWeight: 600,
              }}>
                View Report
              </button>
            )}
            {wbStep && wbFilename && (
              <button onClick={async () => {
                try {
                  const effectiveRunId = viewMode === "history" ? historyRunId : runId;
                  if (projectDir && effectiveRunId) await downloadBinaryArtifact(projectDir, effectiveRunId, wbFilename);
                } catch { /* ignore */ }
              }} style={{
                padding: "8px 16px", borderRadius: 8, border: `1px solid ${ASSESSMENT_STYLES[assessment]?.border || "#e5e7eb"}`,
                background: "#fff", color: ASSESSMENT_STYLES[assessment]?.color || "#374151",
                fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>
                Download Workbook
              </button>
            )}
          </div>
        </div>
      )}

      {/* History run selector */}
      {viewMode === "history" && !historyRunId && (
        <div style={S.historyList}>
          <div style={S.sectionLabel}>Past Runs</div>
          {pastRuns.map((run) => (
            <div key={run.run_id} style={S.historyCard} onClick={() => handleLoadHistoryRun(run)}>
              <span style={{ ...S.historyDot, background: run.status === "complete" ? "#10b981" : run.status === "error" ? "#ef4444" : "#9ca3af" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.historyRunId}>{run.run_id}</div>
                <div style={S.historyMeta}>{run.started_at ? new Date(run.started_at).toLocaleString() : ""}{run.total_steps ? ` · ${run.total_steps} steps` : ""}</div>
              </div>
              <span style={{ color: "#9ca3af" }}>→</span>
            </div>
          ))}
        </div>
      )}
      {historyLoading && <div style={{ padding: 20, textAlign: "center" as const, color: "#9ca3af" }}><span style={S.spinner} /> Loading...</div>}
      {viewMode === "history" && historyRunId && !historyLoading && (
        <div style={{ padding: "8px 24px" }}>
          <button style={S.backBtn} onClick={() => { setHistoryRunId(""); setHistorySteps([]); }}>← Back to Run History</button>
        </div>
      )}

      {/* Scrollable content */}
      <div style={S.scrollArea}>

        {/* ─── 2. Overview metrics strip ─── */}
        {(groupedAttrs.length > 0 || isRunning) && (
          <div style={S.metricsStrip}>
            <div style={S.metricCard}>
              <div style={S.metricValue}>{groupedAttrs.length || "—"}</div>
              <div style={S.metricLabel}>Attributes</div>
            </div>
            <div style={S.metricCard}>
              <div style={{ ...S.metricValue, color: passCount === groupedAttrs.length && groupedAttrs.length > 0 ? "#059669" : "#374151" }}>
                {groupedAttrs.length > 0 ? `${Math.round((passCount / groupedAttrs.length) * 100)}%` : "—"}
              </div>
              <div style={S.metricLabel}>Pass Rate</div>
            </div>
            <div style={S.metricCard}>
              <div style={{ ...S.metricValue, color: exceptionsCount > 0 ? "#dc2626" : "#059669" }}>
                {showCompleteState ? exceptionsCount : "—"}
              </div>
              <div style={S.metricLabel}>Exceptions</div>
            </div>
            {assessment && (
              <div style={{
                ...S.metricCard,
                background: ASSESSMENT_STYLES[assessment]?.bg || "#f3f4f6",
                border: `1px solid ${ASSESSMENT_STYLES[assessment]?.border || "#e5e7eb"}`,
              }}>
                <div style={{ ...S.metricValue, color: ASSESSMENT_STYLES[assessment]?.color || "#374151", fontSize: 15 }}>
                  {assessment}
                </div>
                <div style={S.metricLabel}>Assessment</div>
              </div>
            )}
          </div>
        )}

        {/* ─── 3. Test Results ─── */}
        {groupedAttrs.length > 0 && (
          <div style={S.section}>
            <div style={S.sectionLabel}>Test Results ({testResults.filter((r) => r.result !== "Pending").length}/{testResults.length} complete)</div>
            <div style={S.testGrid}>
              {groupedAttrs.map((group) => {
                const color = RESULT_COLORS[group.overallResult];
                const firstNarrative = group.samples.find((s) => s.narrative)?.narrative || "";
                const narrativeSnippet = firstNarrative.length > 140 ? firstNarrative.slice(0, 140) + "…" : firstNarrative;
                const confStyle = group.lowestConfidence ? CONFIDENCE_STYLES[group.lowestConfidence] : null;
                return (
                  <div key={group.ref} style={{ ...S.testCard, borderLeftColor: color }}>
                    <div style={S.testCardHeader}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 18, fontWeight: 800, color }}>{group.ref}</span>
                        <span style={S.testCardName}>{group.attributeName}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                        {confStyle && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: confStyle.bg, color: confStyle.color, border: `1px solid ${confStyle.border}`, textTransform: "uppercase" as const }}>
                            {group.lowestConfidence}
                          </span>
                        )}
                        <span style={{ ...S.resultBadge, background: color }}>{group.overallResult}</span>
                      </div>
                    </div>
                    {group.totalCount > 1 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" as const }}>{group.passCount}/{group.totalCount} passed</span>
                        <div style={{ flex: 1, height: 4, background: "#e5e7eb", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 2, width: `${(group.passCount / group.totalCount) * 100}%`, background: group.failCount > 0 ? "#f59e0b" : "#10b981", transition: "width 0.4s" }} />
                        </div>
                      </div>
                    )}
                    {group.failCount > 0 && group.samples.filter((s) => s.result === "Fail").length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {group.samples.filter((s) => s.result === "Fail").map((s, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "2px 0" }}>
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#ef4444", marginTop: 5, flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: "#dc2626", lineHeight: 1.4 }}>
                              {s.sampleLabel ? `${s.sampleLabel}: ` : ""}{s.narrative.length > 100 ? s.narrative.slice(0, 100) + "…" : s.narrative}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {narrativeSnippet && group.failCount === 0 && (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 8, lineHeight: 1.5, fontStyle: "italic" }}>{narrativeSnippet}</div>
                    )}
                    {showCompleteState && !isRunning && onRerunTest && (
                      <div style={{ marginTop: 8 }}>
                        <button style={S.rerunBtn} onClick={() => onRerunTest(projectDir, group.ref, group.attributeName)}>Re-run {group.ref}</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Low confidence advisory */}
            {groupedAttrs.some((g) => g.lowestConfidence === "Low") && (
              <div style={S.advisory}>
                <strong>Auditor Advisory:</strong> Attributes {groupedAttrs.filter((g) => g.lowestConfidence === "Low").map((g) => g.ref).join(", ")} have Low confidence — recommend manual review.
              </div>
            )}
          </div>
        )}

        {/* ─── 4. Evidence & Artifacts grid ─── */}
        <div style={S.gridRow}>
          {/* Evidence files */}
          {engagement?.evidence_files && engagement.evidence_files.length > 0 && viewMode === "live" && (
            <div style={S.gridCol}>
              <div style={S.sectionLabel}>Evidence Files ({engagement.evidence_files.length})</div>
              {engagement.instructions && (
                <div style={S.instructionToggle} onClick={() => setShowInstructions(!showInstructions)}>
                  📋 Engagement Instructions {showInstructions ? "▾" : "▸"}
                </div>
              )}
              {showInstructions && engagement.instructions && (
                <div style={S.instructionsBox}>
                  <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.7, margin: 0 }}>{engagement.instructions}</p>
                  {engagement.control_objective?.rules && (
                    <div style={{ marginTop: 10, padding: "8px 10px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.5, color: "#9ca3af", marginBottom: 4 }}>Rules</div>
                      {Object.entries(engagement.control_objective.rules).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
                          <span style={{ color: "#6b7280", textTransform: "capitalize" as const }}>{k.replace(/_/g, " ")}</span>
                          <span style={{ fontWeight: 600, fontFamily: "monospace" }}>{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {engagement.testing_attributes && engagement.testing_attributes.length > 0 && (
                    <div style={{ marginTop: 10, padding: "8px 10px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.5, color: "#9ca3af", marginBottom: 4 }}>Testing Attributes</div>
                      {engagement.testing_attributes.map((a) => (
                        <div key={a.ref} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 11 }}>
                          <span style={{ fontWeight: 700, color: "#f36f21", width: 16, textAlign: "center" as const }}>{a.ref}</span>
                          <span style={{ flex: 1, color: "#374151" }}>{a.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {engagement.evidence_files.map((ef: EvidenceFile, i: number) => {
                const fileName = ef.path.split("/").pop() || ef.path;
                const ext = fileName.split(".").pop()?.toLowerCase() || "";
                const isPdf = ext === "pdf";
                const isImage = ["png", "jpg", "jpeg", "gif"].includes(ext);
                const isEmail = ["eml", "msg"].includes(ext);
                const icon = isPdf ? "📄" : isImage ? "🖼️" : isEmail ? "✉️" : "📎";
                const typeLabel = isPdf ? "PDF" : isImage ? "Image" : isEmail ? "Email" : ext.toUpperCase();
                const url = getEvidenceUrl(projectDir, ef.path);
                return (
                  <div key={i}>
                    <div style={S.evidenceItem} onClick={async () => {
                      if (isPdf || isImage) window.open(url, "_blank");
                      else if (isEmail) {
                        if (emailPreview?.name === fileName) setEmailPreview(null);
                        else { try { const resp = await fetch(url, { credentials: "include" }); setEmailPreview({ name: fileName, content: await resp.text() }); } catch { setEmailPreview({ name: fileName, content: "Could not load." }); } }
                      } else window.open(url, "_blank");
                    }}>
                      <span style={{ fontSize: 16 }}>{icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{fileName}</div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2 }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: isPdf ? "#fef2f2" : isImage ? "#f0fdf4" : isEmail ? "#eff6ff" : "#f3f4f6", color: isPdf ? "#dc2626" : isImage ? "#16a34a" : isEmail ? "#2563eb" : "#6b7280", textTransform: "uppercase" as const }}>{typeLabel}</span>
                          {ef.focus && <span style={{ fontSize: 10, color: "#9ca3af", textTransform: "capitalize" as const }}>{ef.focus.replace(/_/g, " ")}</span>}
                        </div>
                      </div>
                      <span style={{ color: "#9ca3af", fontSize: 12 }}>↗</span>
                      {showCompleteState && !isRunning && onReviewEvidence && (
                        <button style={{ ...S.rerunBtn, marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); onReviewEvidence(projectDir, ef.path, ef.type); }}>Re-review</button>
                      )}
                    </div>
                    {emailPreview?.name === fileName && (
                      <div style={S.emailPreview}>
                        <div style={S.emailPreviewHead}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: "#2563eb" }}>✉️ {fileName}</span>
                          <button style={S.overlayClose} onClick={() => setEmailPreview(null)}>✕</button>
                        </div>
                        <pre style={S.emailPreviewBody}>{emailPreview.content}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Artifacts column */}
          {showCompleteState && displaySteps.length > 0 && (
            <div style={S.gridCol}>
              <div style={S.sectionLabel}>Artifacts & Deliverables</div>

              {/* Report */}
              {(displaySteps.some((s) => s.tool === "compile_results" && s.status === "complete")) && (() => {
                const compileStep = displaySteps.find((s) => s.tool === "compile_results" && s.status === "complete");
                const reportVolUrl = compileStep?.artifact_volume_path ? volumePathToUrl(compileStep.artifact_volume_path) : null;
                return (
                  <div style={S.artifactCard}>
                    <span style={{ fontSize: 22 }}>📄</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#059669" }}>Audit Report</div>
                      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                        <span style={{ fontSize: 11, color: "#059669", cursor: "pointer", fontWeight: 500 }} onClick={handleReportClick}>View report →</span>
                        {reportVolUrl && (
                          <a href={reportVolUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#6b7280", textDecoration: "none", fontWeight: 500 }} onClick={(e) => e.stopPropagation()}>Open in UC →</a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Workbook */}
              {wbStep && wbFilename && (() => {
                const wbVolUrl = wbStep.artifact_volume_path ? volumePathToUrl(wbStep.artifact_volume_path) : null;
                return (
                  <div style={{ ...S.artifactCard, background: "#f0fdf4", borderColor: "#bbf7d0" }}>
                    <span style={{ fontSize: 22 }}>📗</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>{wbFilename}</div>
                      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                        {wbStep.result_summary?.match(/(\d+) attrs filled/)?.[0] || ""}
                        {wbStep.result_summary?.match(/(\d+) exceptions/)?.[0] ? ` · ${wbStep.result_summary.match(/(\d+) exceptions/)?.[0]}` : ""}
                      </div>
                      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                        <span style={{ fontSize: 11, color: "#15803d", cursor: "pointer", fontWeight: 500 }} onClick={async () => {
                          try {
                            const effectiveRunId = viewMode === "history" ? historyRunId : runId;
                            if (projectDir && effectiveRunId) await downloadBinaryArtifact(projectDir, effectiveRunId, wbFilename);
                          } catch { alert("Download failed."); }
                        }}>Download .xlsx →</span>
                        {wbVolUrl && (
                          <a href={wbVolUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#6b7280", textDecoration: "none", fontWeight: 500 }} onClick={(e) => e.stopPropagation()}>Open in UC →</a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Email status */}
              {emailStep && (
                <div style={{ ...S.artifactCard, background: emailSent ? "#eff6ff" : "#f3f4f6", borderColor: emailSent ? "#bfdbfe" : "#e5e7eb" }}>
                  <span style={{ fontSize: 22 }}>📧</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: emailSent ? "#2563eb" : "#6b7280" }}>
                      {emailSent ? "Email Sent" : "Email Not Sent"}
                    </div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                      {emailStep.result_summary?.slice(0, 80) || ""}
                    </div>
                  </div>
                </div>
              )}

              {/* Run ID */}
              {displayRunId && (
                <div style={{ marginTop: 12, fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>
                  Run ID: {displayRunId}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ─── 5. Execution Trace (collapsible) ─── */}
        {displaySteps.length > 0 && (
          <div style={S.section}>
            <div style={S.timelineHeader} onClick={() => setTimelineOpen(!timelineOpen)}>
              <div style={S.sectionLabel}>Execution Trace ({completedCount}/{displaySteps.length} steps)</div>
              <span style={{ fontSize: 12, color: "#9ca3af", cursor: "pointer" }}>{timelineOpen ? "▾ Hide" : "▸ Show"}</span>
            </div>

            {timelineOpen && (
              <div style={S.timeline}>
                {displaySteps.map((step, idx) => {
                  const isDone = step.status === "complete";
                  const isActive = step.status === "running";
                  const isError = step.status === "error";
                  const isExpanded = expandedIdx === idx;
                  const icon = TOOL_ICONS[step.tool] || "⚙️";
                  const hasArtifact = !!step.artifact;
                  const isBatch = step.tool === "batch_review_evidence" || step.tool === "batch_execute_tests";
                  const resultBadge = getStepResultBadge(step);

                  return (
                    <div key={idx} style={S.timelineItem}>
                      <div
                        style={{ ...S.stepNode, ...(isActive ? S.stepNodeActive : {}), ...(isDone ? S.stepNodeDone : {}), ...(isBatch && isDone ? S.stepNodeBatch : {}), cursor: (step.result_summary || hasArtifact) ? "pointer" : "default" }}
                        onClick={() => { if (step.result_summary || hasArtifact) handleArtifactClick(step, idx); }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flex: 1, minWidth: 0 }}>
                          <div style={{ ...S.stepDot, ...(isDone ? { background: "#10b981" } : {}), ...(isActive ? { background: "#f36f21", animation: "pulse 1.5s infinite" } : {}), ...(isError ? { background: "#ef4444" } : {}) }}>
                            {isDone ? "✓" : isError ? "✕" : ""}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: "#9ca3af", fontFamily: "monospace", minWidth: 18 }}>#{idx + 1}</span>
                              <span style={{ fontSize: 13 }}>{icon}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{step.label}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1 }}>{TOOL_DESCRIPTIONS[step.tool] || step.tool}</div>
                            {step.args_summary && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{step.args_summary}</div>}
                            {isDone && step.result_summary && !isExpanded && (
                              <div style={{ fontSize: 10, color: "#059669", marginTop: 3, background: "#ecfdf5", padding: "2px 6px", borderRadius: 4, display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                                {step.result_summary.length > 120 ? step.result_summary.slice(0, 120) + "…" : step.result_summary}
                              </div>
                            )}
                            {isDone && step.image_previews && step.image_previews.length > 0 && !isExpanded && (
                              <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                {step.image_previews.slice(0, 3).map((img, pi) => (
                                  <img key={pi} src={img.data_uri} alt={img.label} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                                ))}
                                {step.image_previews.length > 3 && (
                                  <div style={{ width: 48, height: 48, borderRadius: 4, border: "1px solid #e5e7eb", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#6b7280", fontWeight: 600 }}>
                                    +{step.image_previews.length - 3}
                                  </div>
                                )}
                              </div>
                            )}
                            {isActive && !step.sub_progress && (
                              <div style={{ height: 2, background: "#fed7aa", borderRadius: 1, marginTop: 4, overflow: "hidden", width: "80%" }}>
                                <div style={{ height: "100%", width: "40%", background: "#f36f21", borderRadius: 1, animation: "indeterminate 1.5s infinite ease-in-out" }} />
                              </div>
                            )}
                            {isActive && step.sub_progress && (
                              <BatchProgress progress={step.sub_progress} />
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 2 }}>
                          {resultBadge && <span style={{ color: "#fff", fontSize: 8, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: resultBadge.color, textTransform: "uppercase" as const }}>{resultBadge.label}</span>}
                          {isDone && step.duration !== undefined && <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>{step.duration}s</span>}
                          {isActive && <ElapsedTimer startTime={stepStartTimes.current.get(idx) || Date.now()} />}
                          {isActive && <span style={S.spinner} />}
                          {(step.result_summary || hasArtifact) && <span style={{ fontSize: 10, color: "#9ca3af" }}>{isExpanded ? "▾" : "▸"}</span>}
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={S.expandedOutput}>
                          <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.5, color: "#9ca3af", marginBottom: 4 }}>Output</div>
                          {hasArtifact && projectDir && displayRunId && (() => {
                            const effectiveRunId = viewMode === "history" ? historyRunId : runId;
                            const isBinary = /\.(xlsx|pdf|png|jpg|jpeg)$/i.test(step.artifact || "");
                            const xlsxName = step.workbook_artifact || (step.tool === "fill_workbook" && wbFilename ? wbFilename : null);
                            return (
                              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 8, padding: "6px 8px", background: "#fff", borderRadius: 4, border: "1px solid #e5e7eb" }}>
                                <span style={{ fontSize: 11, color: "#2563eb", fontWeight: 500, cursor: "pointer" }} onClick={async (e) => { e.stopPropagation(); try { await downloadBinaryArtifact(projectDir, effectiveRunId, step.artifact!); } catch { /* ignore */ } }}>{isBinary ? "📎" : "📄"} {step.artifact} ↓</span>
                                {xlsxName && (
                                  <span style={{ fontSize: 11, color: "#059669", fontWeight: 500, cursor: "pointer" }} onClick={async (e) => { e.stopPropagation(); try { await downloadBinaryArtifact(projectDir, effectiveRunId, xlsxName); } catch { /* ignore */ } }}>📥 Download .xlsx</span>
                                )}
                                {step.artifact_volume_path && (() => {
                                  const volUrl = volumePathToUrl(step.artifact_volume_path);
                                  return volUrl ? (
                                    <a href={volUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace", wordBreak: "break-all" as const, textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>
                                      🔗 Open in Catalog Explorer
                                    </a>
                                  ) : (
                                    <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", wordBreak: "break-all" as const }}>UC: {step.artifact_volume_path}</div>
                                  );
                                })()}
                              </div>
                            );
                          })()}
                          {step.image_previews && step.image_previews.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 8 }}>
                              {step.image_previews.map((img, pi) => (
                                <div key={pi} style={{ border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden", background: "#fafafa" }}>
                                  <img src={img.data_uri} alt={img.label} style={{ maxWidth: "100%", maxHeight: 300, display: "block" }} />
                                  <div style={{ padding: "4px 8px", fontSize: 10, color: "#6b7280", background: "#f9fafb", borderTop: "1px solid #e5e7eb" }}>
                                    {img.label}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {artifactLoading ? <div style={S.loadingText}>Loading artifact...</div> : (
                            <pre style={{ fontSize: 11, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, fontFamily: "'SF Mono', 'Fira Code', monospace", margin: 0 }}>
                              {artifactContent || step.result_summary || "No output"}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {isRunning && viewMode === "live" && currentStep && displaySteps.every((s) => s.tool !== currentStep || s.status !== "running") && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontSize: 11, color: "#9ca3af" }}>
                    <span style={S.spinner} />
                    <span style={{ fontStyle: "italic" }}>{TOOL_ICONS[currentStep] || "⚙️"} {currentStep}...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} style={{ height: 24 }} />
      </div>
    </div>
  );
}

/* ─── Styles ─── */

const S: Record<string, React.CSSProperties> = {
  panel: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", background: "#fff" },
  scrollArea: { flex: 1, overflow: "auto", padding: "0 24px" },

  /* Overlay */
  overlay: { position: "absolute", inset: 0, background: "#fff", zIndex: 50, display: "flex", flexDirection: "column" },
  overlayHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid #e5e7eb", background: "#f9fafb", flexShrink: 0 },
  overlayTitle: { fontSize: 14, fontWeight: 600, color: "#111827" },
  overlayClose: { border: "none", background: "none", fontSize: 16, cursor: "pointer", color: "#6b7280", padding: "2px 6px", borderRadius: 4 },
  overlayBody: { flex: 1, overflow: "auto", padding: 24 },
  reportPre: { fontSize: 12, lineHeight: 1.8, color: "#374151", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, fontFamily: "'SF Mono', 'Fira Code', monospace", margin: 0 },
  loadingText: { fontSize: 12, color: "#9ca3af", fontStyle: "italic", padding: "8px 0" },

  /* Header */
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: "1px solid #e5e7eb", background: "#fff", flexShrink: 0, gap: 16, flexWrap: "wrap" as const },
  headerLeft: { display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 },
  headerControlId: { fontSize: 13, fontWeight: 700, color: "#f36f21", letterSpacing: 0.5, textTransform: "uppercase" as const, flexShrink: 0 },
  headerControlName: { fontSize: 16, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  domainTag: { fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 6, flexShrink: 0 },
  headerRight: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  statusRunning: { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 12, background: "#fff7ed", border: "1px solid #fed7aa", fontSize: 12, fontWeight: 600, color: "#ea580c" },
  statusPulse: { width: 6, height: 6, borderRadius: "50%", background: "#f36f21", animation: "pulse 1.5s infinite" },
  statusComplete: { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 12, background: "#ecfdf5", border: "1px solid #a7f3d0", fontSize: 12, fontWeight: 600, color: "#059669" },
  stopBtn: { padding: "6px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  startOverBtn: { padding: "6px 14px", background: "#fff", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  continueBtn: { padding: "6px 14px", background: "#f36f21", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  statusStopped: { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 12, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12, fontWeight: 600, color: "#d97706" },
  viewToggle: { display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #e5e7eb" },
  viewToggleBtn: { padding: "4px 10px", border: "none", background: "#f9fafb", fontSize: 10, fontWeight: 600, color: "#6b7280", cursor: "pointer" },
  viewToggleBtnActive: { background: "#f36f21", color: "#fff" },

  /* Progress */
  progressBar: { height: 3, background: "#f3f4f6", overflow: "hidden", flexShrink: 0 },
  progressFill: { height: "100%", background: "linear-gradient(90deg, #f36f21, #f59e0b)", transition: "width 0.4s ease" },

  /* History */
  historyList: { padding: "14px 24px", borderBottom: "1px solid #f3f4f6" },
  historyCard: { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, background: "#f9fafb", marginBottom: 6, cursor: "pointer", border: "1px solid #e5e7eb" },
  historyDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  historyRunId: { fontSize: 11, fontWeight: 600, color: "#374151", fontFamily: "monospace" },
  historyMeta: { fontSize: 10, color: "#9ca3af", marginTop: 1 },
  backBtn: { background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 12px", fontSize: 11, fontWeight: 600, color: "#6b7280", cursor: "pointer" },

  /* Metrics strip */
  metricsStrip: { display: "flex", gap: 12, padding: "20px 0 8px", flexWrap: "wrap" as const },
  metricCard: { flex: "1 1 120px", padding: "14px 16px", background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb", textAlign: "center" as const, minWidth: 100 },
  metricValue: { fontSize: 22, fontWeight: 800, color: "#111827" },
  metricLabel: { fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.5, color: "#9ca3af", marginTop: 4 },

  /* Sections */
  section: { padding: "16px 0", borderBottom: "1px solid #f3f4f6" },
  sectionLabel: { fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.8, color: "#9ca3af", marginBottom: 10 },

  /* Test grid */
  testGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 },
  testCard: { padding: "14px 16px", borderRadius: 10, background: "#f9fafb", borderLeft: "4px solid #e5e7eb" },
  testCardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  testCardName: { fontSize: 12, fontWeight: 500, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  resultBadge: { color: "#fff", fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 5, textTransform: "uppercase" as const, flexShrink: 0 },
  rerunBtn: { padding: "3px 10px", fontSize: 10, fontWeight: 600, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap" as const },
  advisory: { marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "#dc2626", lineHeight: 1.5 },

  /* Grid layout for evidence + artifacts */
  gridRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: "16px 0", borderBottom: "1px solid #f3f4f6" },
  gridCol: {},

  /* Evidence */
  evidenceItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", transition: "background 0.12s" },
  instructionToggle: { padding: "8px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#374151", marginBottom: 6 },
  instructionsBox: { margin: "0 0 10px", padding: "12px 14px", background: "#f9fafb", borderRadius: 8, borderLeft: "3px solid #2563eb" },
  emailPreview: { margin: "0 10px 8px", background: "#f9fafb", borderRadius: 6, border: "1px solid #e5e7eb", overflow: "hidden", maxHeight: 300, display: "flex", flexDirection: "column" as const },
  emailPreviewHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "#eff6ff", borderBottom: "1px solid #dbeafe", flexShrink: 0 },
  emailPreviewBody: { fontSize: 11, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, fontFamily: "'SF Mono', 'Fira Code', monospace", margin: 0, padding: "10px 12px", overflow: "auto", flex: 1 },

  /* Artifacts */
  artifactCard: { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, cursor: "pointer", transition: "background 0.15s", marginBottom: 8 },

  /* Timeline */
  timelineHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", padding: "4px 0" },
  timeline: { display: "flex", flexDirection: "column" as const },
  timelineItem: { position: "relative" as const },
  stepNode: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, marginBottom: 2, transition: "all 0.15s" },
  stepNodeActive: { background: "#fff7ed", border: "1px solid #fed7aa" },
  stepNodeDone: { background: "#f9fafb" },
  stepNodeBatch: { background: "#eff6ff", borderLeft: "3px solid #3b82f6" },
  stepDot: { width: 22, height: 22, borderRadius: "50%", background: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0, marginTop: 1 },
  expandedOutput: { margin: "0 10px 8px 38px", padding: "8px 12px", background: "#f9fafb", borderRadius: 6, borderLeft: "3px solid #f36f21", maxHeight: 300, overflow: "auto" },
  spinner: { width: 12, height: 12, border: "2px solid #fed7aa", borderTopColor: "#f36f21", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" },
};
