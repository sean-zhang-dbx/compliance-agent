import React, { useState, useEffect, useRef } from "react";
import type { ToolStep, Engagement, EvidenceFile, RunInfo } from "../api";
import type { ProjectInfo } from "../api";
import { fetchArtifact, fetchEngagement, getEvidenceUrl, downloadBinaryArtifact, listRuns, fetchRunManifest } from "../api";

const TOOL_ICONS: Record<string, string> = {
  list_projects: "📂",
  load_engagement: "📋",
  parse_workbook: "📊",
  extract_workbook_images: "🖼️",
  review_document: "📄",
  review_screenshot: "🔍",
  analyze_email: "✉️",
  execute_test: "🧪",
  compile_results: "📝",
  fill_workbook: "📗",
  save_report: "💾",
  send_email: "📧",
  ask_user: "❓",
  batch_review_evidence: "📚",
  batch_execute_tests: "⚡",
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_projects: "Discovering available projects",
  load_engagement: "Loading engagement instructions and control details",
  parse_workbook: "Parsing the audit workbook for test attributes",
  extract_workbook_images: "Extracting embedded images from workbook",
  review_document: "Reading and analyzing a PDF document",
  review_screenshot: "Analyzing a screenshot for control evidence",
  analyze_email: "Reviewing email for approval evidence",
  execute_test: "Running a single test attribute",
  compile_results: "Compiling all results into final report",
  fill_workbook: "Writing results back into audit workbook",
  save_report: "Saving the audit report to storage",
  send_email: "Sending notification email with results",
  ask_user: "Requesting clarification from user",
  batch_review_evidence: "Reviewing multiple evidence files in parallel",
  batch_execute_tests: "Executing multiple test attributes in parallel",
};

interface TestResult {
  ref: string;
  attributeName: string;
  sampleLabel: string;
  result: "Pass" | "Fail" | "Partial" | "Pending";
  narrative: string;
  duration?: number;
  confidence?: "High" | "Medium" | "Low";
  confidenceRationale?: string;
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
          const ref = m[1];
          const name = m[2].trim();
          const r = m[3].toLowerCase();
          results.push({
            ref,
            attributeName: name,
            sampleLabel: "",
            result: r === "pass" ? "Pass" : r === "fail" ? "Fail" : "Partial",
            narrative: line.replace(/\[.+?\]\s*/, ""),
            duration: s.duration,
          });
        }
      }
      if (results.length === 0 && s.result_summary) {
        const countMatch = s.result_summary.match(/(\d+)\s*tests?/i);
        if (countMatch) {
          const passMatch = s.result_summary.match(/(\d+)\s*pass/i);
          const failMatch = s.result_summary.match(/(\d+)\s*fail/i);
          if (passMatch || failMatch) {
            const pn = passMatch ? parseInt(passMatch[1]) : 0;
            const fn = failMatch ? parseInt(failMatch[1]) : 0;
            for (let i = 0; i < pn; i++) results.push({ ref: `T${i+1}`, attributeName: `Test ${i+1}`, sampleLabel: "", result: "Pass", narrative: "", duration: s.duration });
            for (let i = 0; i < fn; i++) results.push({ ref: `F${i+1}`, attributeName: `Test ${pn+i+1}`, sampleLabel: "", result: "Fail", narrative: "", duration: s.duration });
          }
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
      map.set(r.ref, {
        ref: r.ref,
        attributeName: r.attributeName || `Attribute ${r.ref}`,
        samples: [],
        overallResult: "Pending",
        passCount: 0,
        failCount: 0,
        totalCount: 0,
      });
    }
    const group = map.get(r.ref)!;
    group.samples.push(r);
    group.totalCount++;
    if (r.result === "Pass") group.passCount++;
    if (r.result === "Fail") group.failCount++;
    if (r.attributeName && r.attributeName.length > group.attributeName.length) {
      group.attributeName = r.attributeName;
    }
  }
  const CONF_RANK: Record<string, number> = { Low: 0, Medium: 1, High: 2 };
  for (const group of map.values()) {
    if (group.failCount > 0) group.overallResult = "Fail";
    else if (group.samples.some((s) => s.result === "Partial")) group.overallResult = "Partial";
    else if (group.passCount === group.totalCount && group.totalCount > 0) group.overallResult = "Pass";
    else group.overallResult = "Pending";

    let lowest = 3;
    for (const s of group.samples) {
      if (s.confidence && CONF_RANK[s.confidence] !== undefined) {
        lowest = Math.min(lowest, CONF_RANK[s.confidence]);
      }
    }
    if (lowest <= 2) {
      group.lowestConfidence = (["Low", "Medium", "High"] as const)[lowest];
    }
  }
  return Array.from(map.values());
}

function extractControlInfo(steps: ToolStep[]): {
  controlId: string;
  controlName: string;
  attrCount: number;
  evidenceCount: number;
} {
  const engStep = steps.find((s) => s.tool === "load_engagement" && s.status === "complete");
  if (!engStep?.result_summary) return { controlId: "", controlName: "", attrCount: 0, evidenceCount: 0 };
  const idMatch = engStep.result_summary.match(/^([A-Z]+-[A-Z]*-?\d+)/);
  const nameMatch = engStep.result_summary.match(/—\s*(.+?)\s*\(/);
  const attrMatch = engStep.result_summary.match(/(\d+)\s*attrs/);
  const evidMatch = engStep.result_summary.match(/(\d+)\s*evidence/);
  return {
    controlId: idMatch?.[1] || "",
    controlName: nameMatch?.[1] || "",
    attrCount: attrMatch ? parseInt(attrMatch[1]) : 0,
    evidenceCount: evidMatch ? parseInt(evidMatch[1]) : 0,
  };
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
  const confMatch = s.match(/\[(High|Medium|Low)\]/i);
  const confSuffix = confMatch ? ` ${confMatch[1][0]}` : "";
  if (/^Pass\b/i.test(s)) return { label: `PASS${confSuffix}`, color: "#10b981" };
  if (/^Fail\b/i.test(s)) return { label: `FAIL${confSuffix}`, color: "#ef4444" };
  if (/^Partial|^N\/A/i.test(s)) return { label: `PARTIAL${confSuffix}`, color: "#f59e0b" };

  if (step.tool === "batch_review_evidence") {
    const m = s.match(/(\d+)\s*files?/i);
    if (m) return { label: `${m[1]} files`, color: "#2563eb" };
  }
  if (step.tool === "batch_execute_tests") {
    const passM = s.match(/(\d+)\s*pass/i);
    const failM = s.match(/(\d+)\s*fail/i);
    const lowM = s.match(/(\d+)L/);
    if (passM || failM) {
      const p = passM ? parseInt(passM[1]) : 0;
      const f = failM ? parseInt(failM[1]) : 0;
      const lowCount = lowM ? parseInt(lowM[1]) : 0;
      const lowTag = lowCount > 0 ? ` ${lowCount}?` : "";
      if (f > 0) return { label: `${p}P ${f}F${lowTag}`, color: "#ef4444" };
      if (lowCount > 0) return { label: `${p}P${lowTag}`, color: "#f59e0b" };
      return { label: `${p} pass`, color: "#10b981" };
    }
  }
  return null;
}

function getBatchSubItems(step: ToolStep): string[] {
  if (step.status !== "complete" || !step.result_summary) return [];
  return step.result_summary
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10);
}

const RESULT_COLORS: Record<string, string> = {
  Pass: "#10b981",
  Fail: "#ef4444",
  Partial: "#f59e0b",
  Pending: "#9ca3af",
};

const CONFIDENCE_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  High: { bg: "#ecfdf5", color: "#059669", border: "#a7f3d0" },
  Medium: { bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
  Low: { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
};

const ASSESSMENT_STYLES: Record<string, { bg: string; color: string }> = {
  Effective: { bg: "#ecfdf5", color: "#059669" },
  "Effective with Exceptions": { bg: "#fffbeb", color: "#d97706" },
  Ineffective: { bg: "#fef2f2", color: "#dc2626" },
};

interface Props {
  project: ProjectInfo | null;
  steps: ToolStep[];
  currentStep: string | null;
  elapsed: number;
  isRunning: boolean;
  isComplete: boolean;
  runId: string;
  projectDir: string;
  onRerunTest?: (projectDir: string, ref: string, attribute: string) => void;
  onReviewEvidence?: (projectDir: string, filePath: string, fileType: string) => void;
}

type ViewMode = "live" | "history";

export default function ExecutionPanel({
  project,
  steps,
  currentStep,
  elapsed,
  isRunning,
  isComplete,
  runId,
  projectDir,
  onRerunTest,
  onReviewEvidence,
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
  const bottomRef = useRef<HTMLDivElement>(null);

  // Run history state
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [pastRuns, setPastRuns] = useState<RunInfo[]>([]);
  const [historySteps, setHistorySteps] = useState<ToolStep[]>([]);
  const [historyRunId, setHistoryRunId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (projectDir) {
      fetchEngagement(projectDir).then((e) => e && setEngagement(e));
      listRuns(projectDir).then((runs) => setPastRuns(runs));
    }
  }, [projectDir]);

  // Switch to live view when a new run starts
  useEffect(() => {
    if (isRunning) setViewMode("live");
  }, [isRunning]);

  useEffect(() => {
    if (isRunning) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [steps.length, isRunning]);

  const displaySteps = viewMode === "history" ? historySteps : steps;
  const displayRunId = viewMode === "history" ? historyRunId : runId;

  const testResults = extractTestResults(displaySteps);
  const groupedAttrs = groupByAttribute(testResults);
  const controlInfo = extractControlInfo(displaySteps);
  const assessment = getOverallAssessment(testResults);
  const completedCount = displaySteps.filter((s) => s.status === "complete").length;
  const totalDuration = displaySteps.reduce((acc, s) => acc + (s.duration || 0), 0);

  const saveStep = displaySteps.find((s) => s.tool === "save_report" && s.status === "complete");
  let reportFilename = "";
  let reportAppUrl = "";
  if (saveStep?.result_summary) {
    const parts = saveStep.result_summary.split(" — ");
    reportFilename = parts[0] || "";
    const urlPart = parts.slice(1).join(" — ");
    if (urlPart.startsWith("http")) reportAppUrl = urlPart;
  }
  if (!reportAppUrl && projectDir && displayRunId) {
    reportAppUrl = `${window.location.origin}/api/artifacts/${projectDir}/${displayRunId}/report.md`;
  }

  const wbStep = displaySteps.find((s) => s.tool === "fill_workbook" && s.status === "complete");
  let wbFilename = "";
  let wbDownloadUrl = "";
  if (wbStep?.result_summary) {
    const parts = wbStep.result_summary.split(" — ");
    wbFilename = parts[0] || "";
    const urlPart = parts.find((p) => p.startsWith("http"));
    if (urlPart) wbDownloadUrl = urlPart;
  }
  if (!wbDownloadUrl && wbFilename && projectDir && displayRunId) {
    wbDownloadUrl = `${window.location.origin}/api/artifacts/${projectDir}/${displayRunId}/${wbFilename}`;
  }

  const hasContent = displaySteps.length > 0 || project;
  if (!hasContent) return null;

  const handleLoadHistoryRun = async (run: RunInfo) => {
    setHistoryLoading(true);
    setHistoryRunId(run.run_id);
    setViewMode("history");
    try {
      const manifest = await fetchRunManifest(projectDir, run.run_id);
      if (manifest?.steps) {
        setHistorySteps(manifest.steps);
      } else {
        setHistorySteps([]);
      }
    } catch {
      setHistorySteps([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleArtifactClick = async (step: ToolStep, idx: number) => {
    if (expandedIdx === idx && artifactContent !== null) {
      setExpandedIdx(null);
      setArtifactContent(null);
      return;
    }
    setExpandedIdx(idx);
    const effectiveRunId = viewMode === "history" ? historyRunId : runId;
    if (step.artifact && projectDir && effectiveRunId) {
      setArtifactLoading(true);
      try {
        const content = await fetchArtifact(projectDir, effectiveRunId, step.artifact);
        setArtifactContent(content);
      } catch {
        setArtifactContent(step.result_summary || "No content available");
      } finally {
        setArtifactLoading(false);
      }
    } else {
      setArtifactContent(step.result_summary || null);
    }
  };

  const handleReportClick = async () => {
    if (showReport) { setShowReport(false); return; }
    setShowReport(true);
    if (reportContent) return;
    setReportLoading(true);
    const effectiveRunId = viewMode === "history" ? historyRunId : runId;
    try {
      const content = await fetchArtifact(projectDir, effectiveRunId, "report.md");
      setReportContent(content);
    } catch {
      try {
        const compileStep = displaySteps.find((s) => s.tool === "compile_results" && s.artifact);
        if (compileStep?.artifact) {
          const content = await fetchArtifact(projectDir, effectiveRunId, compileStep.artifact);
          setReportContent(content);
        } else {
          setReportContent("Report not available — artifact not found.");
        }
      } catch {
        setReportContent("Report not available — artifact not found.");
      }
    } finally {
      setReportLoading(false);
    }
  };

  const showCompleteState = viewMode === "history" || (isComplete && !isRunning);

  return (
    <div style={styles.panel}>
      {/* Report overlay */}
      {showReport && (
        <div style={styles.overlay}>
          <div style={styles.overlayHeader}>
            <div style={styles.overlayTitle}>📄 Report — {controlInfo.controlId || projectDir}</div>
            <button style={styles.overlayClose} onClick={() => setShowReport(false)}>✕</button>
          </div>
          <div style={styles.overlayBody}>
            {reportLoading ? (
              <div style={styles.loadingText}>Loading report...</div>
            ) : (
              <pre style={styles.reportPre}>{reportContent || "No report content"}</pre>
            )}
          </div>
        </div>
      )}

      {/* Header: Control Info */}
      <div style={styles.controlHeader}>
        {controlInfo.controlId ? (
          <>
            <div style={styles.controlId}>{controlInfo.controlId}</div>
            <div style={styles.controlName}>{controlInfo.controlName}</div>
            <div style={styles.controlMeta}>
              {controlInfo.attrCount} attributes &middot; {controlInfo.evidenceCount} evidence files
            </div>
          </>
        ) : project ? (
          <>
            <div style={styles.controlId}>{project.control_id || project.project_dir}</div>
            <div style={styles.controlName}>{project.control_name || ""}</div>
            <div style={styles.controlDomain}>{project.domain || ""}</div>
          </>
        ) : (
          <div style={styles.controlId}>Execution Trace</div>
        )}

        <div style={styles.statusRow}>
          {isRunning && viewMode === "live" && (
            <div style={styles.statusBadgeRunning}>
              <span style={styles.statusDot} />
              Running &middot; {Math.round(elapsed)}s
            </div>
          )}
          {showCompleteState && displaySteps.length > 0 && (
            <div style={styles.statusBadgeComplete}>
              Completed &middot; {Math.round(totalDuration)}s
            </div>
          )}
          {!isRunning && !isComplete && displaySteps.length === 0 && viewMode === "live" && (
            <div style={styles.statusBadgeIdle}>Ready</div>
          )}
          {displayRunId && (
            <div style={styles.runIdBadge} title={`Run: ${displayRunId}`}>
              {displayRunId}
            </div>
          )}
        </div>

        {/* View mode toggle */}
        {pastRuns.length > 0 && (
          <div style={styles.viewToggle}>
            <button
              style={{ ...styles.viewToggleBtn, ...(viewMode === "live" ? styles.viewToggleBtnActive : {}) }}
              onClick={() => setViewMode("live")}
            >
              Current Run
            </button>
            <button
              style={{ ...styles.viewToggleBtn, ...(viewMode === "history" ? styles.viewToggleBtnActive : {}) }}
              onClick={() => setViewMode("history")}
            >
              Run History ({pastRuns.length})
            </button>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {displaySteps.length > 0 && (
        <div style={styles.progressBar}>
          <div
            style={{
              ...styles.progressFill,
              width: `${(completedCount / Math.max(displaySteps.length, 1)) * 100}%`,
              ...(showCompleteState ? { background: "#10b981" } : {}),
            }}
          />
        </div>
      )}

      {/* Run History list */}
      {viewMode === "history" && !historyRunId && (
        <div style={styles.historyList}>
          <div style={styles.sectionLabel}>Past Runs</div>
          {pastRuns.map((run) => (
            <div
              key={run.run_id}
              style={styles.historyCard}
              onClick={() => handleLoadHistoryRun(run)}
            >
              <div style={styles.historyCardLeft}>
                <span style={{
                  ...styles.historyDot,
                  background: run.status === "complete" ? "#10b981" : run.status === "error" ? "#ef4444" : "#9ca3af",
                }} />
                <div>
                  <div style={styles.historyRunId}>{run.run_id}</div>
                  <div style={styles.historyMeta}>
                    {run.started_at ? new Date(run.started_at).toLocaleString() : ""}
                    {run.total_steps ? ` · ${run.total_steps} steps` : ""}
                  </div>
                </div>
              </div>
              <span style={styles.historyArrow}>→</span>
            </div>
          ))}
        </div>
      )}

      {/* History loading indicator */}
      {historyLoading && (
        <div style={{ padding: "20px 18px", textAlign: "center" as const }}>
          <span style={styles.spinner} /> Loading run data...
        </div>
      )}

      {/* Back to history list button when viewing a specific historical run */}
      {viewMode === "history" && historyRunId && !historyLoading && (
        <div style={styles.historyBackRow}>
          <button style={styles.historyBackBtn} onClick={() => { setHistoryRunId(""); setHistorySteps([]); setExpandedIdx(null); setArtifactContent(null); }}>
            ← Back to Run History
          </button>
        </div>
      )}

      {/* Engagement Instructions & Evidence */}
      {engagement && viewMode === "live" && (
        <div style={styles.evidenceSection}>
          {engagement.instructions && (
            <div style={styles.evidenceBlock}>
              <div
                style={styles.evidenceItemClickable}
                onClick={() => setShowInstructions(!showInstructions)}
              >
                <span style={styles.evidenceIcon}>📋</span>
                <div style={styles.evidenceItemInfo}>
                  <div style={styles.evidenceItemName}>Engagement Instructions</div>
                  <div style={styles.evidenceItemMeta}>
                    {engagement.control_objective?.policy_reference || ""}
                  </div>
                </div>
                <span style={styles.expandArrow}>{showInstructions ? "▾" : "▸"}</span>
              </div>
              {showInstructions && (
                <div style={styles.instructionsExpanded}>
                  <p style={styles.instructionsText}>{engagement.instructions}</p>
                  {engagement.control_objective?.rules && (
                    <div style={styles.rulesBox}>
                      <div style={styles.rulesLabel}>Rules</div>
                      {Object.entries(engagement.control_objective.rules).map(([k, v]) => (
                        <div key={k} style={styles.ruleRow}>
                          <span style={styles.ruleKey}>{k.replace(/_/g, " ")}</span>
                          <span style={styles.ruleValue}>{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {engagement.testing_attributes && engagement.testing_attributes.length > 0 && (
                    <div style={styles.attrsBox}>
                      <div style={styles.rulesLabel}>Testing Attributes</div>
                      {engagement.testing_attributes.map((a) => (
                        <div key={a.ref} style={styles.attrRow}>
                          <span style={styles.attrRef}>{a.ref}</span>
                          <span style={styles.attrName}>{a.name}</span>
                          <span style={styles.attrScope}>{a.applies_to || ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {engagement.evidence_files && engagement.evidence_files.length > 0 && (
            <div style={styles.evidenceBlock}>
              <div style={styles.sectionLabel}>
                Evidence Files ({engagement.evidence_files.length})
              </div>
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
                    <div
                      style={styles.evidenceItemClickable}
                      onClick={async () => {
                        if (isPdf || isImage) {
                          window.open(url, "_blank");
                        } else if (isEmail) {
                          if (emailPreview?.name === fileName) {
                            setEmailPreview(null);
                          } else {
                            try {
                              const resp = await fetch(url, { credentials: "include" });
                              const text = await resp.text();
                              setEmailPreview({ name: fileName, content: text });
                            } catch {
                              setEmailPreview({ name: fileName, content: "Could not load email." });
                            }
                          }
                        } else {
                          window.open(url, "_blank");
                        }
                      }}
                    >
                      <span style={styles.evidenceIcon}>{icon}</span>
                      <div style={styles.evidenceItemInfo}>
                        <div style={styles.evidenceItemName}>{fileName}</div>
                        <div style={styles.evidenceItemMeta}>
                          <span style={{
                            ...styles.typeBadge,
                            background: isPdf ? "#fef2f2" : isImage ? "#f0fdf4" : isEmail ? "#eff6ff" : "#f3f4f6",
                            color: isPdf ? "#dc2626" : isImage ? "#16a34a" : isEmail ? "#2563eb" : "#6b7280",
                          }}>
                            {typeLabel}
                          </span>
                          {ef.focus && <span style={styles.focusLabel}>{ef.focus.replace(/_/g, " ")}</span>}
                        </div>
                      </div>
                      <span style={styles.openArrow}>↗</span>
                      {showCompleteState && !isRunning && onReviewEvidence && (
                        <button
                          style={{ ...styles.rerunBtn, marginLeft: 4, flexShrink: 0 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onReviewEvidence(projectDir, ef.path, ef.type);
                          }}
                          title={`Re-review ${fileName}`}
                        >
                          Re-review
                        </button>
                      )}
                    </div>
                    {emailPreview?.name === fileName && (
                      <div style={styles.emailPreviewBox}>
                        <div style={styles.emailPreviewHeader}>
                          <span style={styles.emailPreviewTitle}>✉️ {fileName}</span>
                          <button style={styles.overlayClose} onClick={() => setEmailPreview(null)}>✕</button>
                        </div>
                        <pre style={styles.emailPreviewBody}>{emailPreview.content}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Test Results Summary */}
      {groupedAttrs.length > 0 && (
        <div style={styles.resultsSection}>
          <div style={styles.sectionLabel}>
            Test Results ({testResults.filter((r) => r.result !== "Pending").length}/{testResults.length} complete)
          </div>

          {groupedAttrs.map((group) => {
            const color = RESULT_COLORS[group.overallResult];
            const firstNarrative = group.samples.find((s) => s.narrative)?.narrative || "";
            const narrativeSnippet = firstNarrative.length > 120 ? firstNarrative.slice(0, 120) + "…" : firstNarrative;
            const confStyle = group.lowestConfidence ? CONFIDENCE_STYLES[group.lowestConfidence] : null;
            return (
              <div key={group.ref} style={{ ...styles.attrResultCard, borderLeftColor: color }}>
                <div style={styles.attrResultHeader}>
                  <div style={styles.attrResultLeft}>
                    <span style={{ ...styles.attrResultRef, color }}>{group.ref}</span>
                    <span style={styles.attrResultName}>{group.attributeName}</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                    {confStyle && (
                      <span
                        style={{
                          fontSize: 8,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: confStyle.bg,
                          color: confStyle.color,
                          border: `1px solid ${confStyle.border}`,
                          textTransform: "uppercase" as const,
                          letterSpacing: 0.3,
                        }}
                        title={`Confidence: ${group.lowestConfidence}${group.lowestConfidence === "Low" ? " — recommend human review" : ""}`}
                      >
                        {group.lowestConfidence}
                      </span>
                    )}
                    <div style={{ ...styles.attrResultBadge, background: color }}>
                      {group.overallResult}
                    </div>
                  </div>
                </div>
                {group.totalCount > 1 && (
                  <div style={styles.attrSampleBar}>
                    <span style={styles.attrSampleText}>{group.passCount}/{group.totalCount} samples passed</span>
                    <div style={styles.attrSampleTrack}>
                      <div style={{
                        ...styles.attrSampleFill,
                        width: `${(group.passCount / group.totalCount) * 100}%`,
                        background: group.failCount > 0 ? "#f59e0b" : "#10b981",
                      }} />
                    </div>
                  </div>
                )}
                {group.failCount > 0 && group.samples.filter((s) => s.result === "Fail").length > 0 && (
                  <div style={styles.attrExceptions}>
                    {group.samples.filter((s) => s.result === "Fail").map((s, i) => (
                      <div key={i} style={styles.attrExceptionRow}>
                        <span style={styles.attrExceptionDot} />
                        <span style={styles.attrExceptionText}>
                          {s.sampleLabel ? `${s.sampleLabel}: ` : ""}
                          {s.narrative.length > 80 ? s.narrative.slice(0, 80) + "…" : s.narrative}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {narrativeSnippet && group.failCount === 0 && (
                  <div style={styles.attrNarrative}>{narrativeSnippet}</div>
                )}
                {showCompleteState && !isRunning && onRerunTest && (
                  <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                    <button
                      style={styles.rerunBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRerunTest(projectDir, group.ref, group.attributeName);
                      }}
                      title={`Re-execute test attribute ${group.ref}`}
                    >
                      Re-run {group.ref}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {assessment && (
            <div style={{
              ...styles.assessment,
              background: ASSESSMENT_STYLES[assessment]?.bg || "#f3f4f6",
              color: ASSESSMENT_STYLES[assessment]?.color || "#374151",
            }}>
              Overall: <strong>{assessment}</strong>
            </div>
          )}
          {groupedAttrs.some((g) => g.lowestConfidence === "Low") && (
            <div style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 6,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              fontSize: 11,
              color: "#dc2626",
              lineHeight: 1.5,
            }}>
              <strong>Auditor Advisory:</strong> Attributes{" "}
              {groupedAttrs.filter((g) => g.lowestConfidence === "Low").map((g) => g.ref).join(", ")}{" "}
              have <strong>Low</strong> confidence — recommend manual review by a senior auditor before sign-off.
            </div>
          )}
        </div>
      )}

      {/* Report Output */}
      {(reportFilename || displaySteps.some((s) => s.tool === "compile_results" && s.status === "complete")) && showCompleteState && (
        <div style={styles.reportSection}>
          <div style={styles.sectionLabel}>Report</div>
          <div style={styles.reportCard} onClick={handleReportClick}>
            <div style={styles.reportIcon}>📄</div>
            <div style={styles.reportInfo}>
              <div style={styles.reportFilename}>{reportFilename || "View Report"}</div>
              <div style={styles.reportLink}>Click to view full report →</div>
            </div>
          </div>
          {reportAppUrl && (
            <div style={styles.reportUrlRow}>
              <a href={reportAppUrl} target="_blank" rel="noopener noreferrer" style={styles.reportUrlLink} onClick={(e) => e.stopPropagation()}>
                {reportAppUrl}
              </a>
              <button style={styles.copyBtn} title="Copy link" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(reportAppUrl); }}>
                📋
              </button>
            </div>
          )}
        </div>
      )}

      {/* Completed Workbook */}
      {wbStep && showCompleteState && wbFilename && (
        <div style={styles.reportSection}>
          <div style={styles.sectionLabel}>Completed Workbook</div>
          <div
            style={{ ...styles.workbookCard, cursor: "pointer" }}
            onClick={async (e) => {
              e.stopPropagation();
              try {
                const effectiveRunId = viewMode === "history" ? historyRunId : runId;
                if (projectDir && effectiveRunId) await downloadBinaryArtifact(projectDir, effectiveRunId, wbFilename);
              } catch (err) {
                console.error("Workbook download failed:", err);
                alert("Failed to download workbook. Please try again.");
              }
            }}
          >
            <div style={styles.reportIcon}>📗</div>
            <div style={styles.reportInfo}>
              <div style={styles.workbookFilename}>{wbFilename || "Download Workbook"}</div>
              <div style={styles.workbookMeta}>
                {wbStep.result_summary?.match(/(\d+) attrs filled/)?.[0] || ""}
                {wbStep.result_summary?.match(/(\d+) exceptions/)?.[0] ? ` · ${wbStep.result_summary.match(/(\d+) exceptions/)?.[0]}` : ""}
              </div>
              <div style={styles.reportLink}>Click to download .xlsx →</div>
            </div>
          </div>
        </div>
      )}

      {/* Execution Timeline */}
      <div style={styles.timelineSection}>
        <div style={styles.sectionLabel}>
          Execution Trace ({completedCount}/{displaySteps.length})
        </div>

        <div style={styles.timeline}>
          {displaySteps.map((step, idx) => {
            const isActive = step.status === "running";
            const isDone = step.status === "complete";
            const isError = step.status === "error";
            const isExpanded = expandedIdx === idx;
            const icon = TOOL_ICONS[step.tool] || "⚙️";
            const hasArtifact = !!step.artifact;
            const isBatch = step.tool === "batch_review_evidence" || step.tool === "batch_execute_tests";
            const resultBadge = getStepResultBadge(step);
            const batchSubItems = isBatch ? getBatchSubItems(step) : [];
            const description = TOOL_DESCRIPTIONS[step.tool] || step.tool;

            return (
              <div key={idx} style={styles.timelineItem}>
                {idx > 0 && (
                  <div style={{
                    ...styles.connectorLine,
                    background: isDone || isActive ? "#f36f21" : isError ? "#ef4444" : "#e5e7eb",
                  }} />
                )}

                <div
                  style={{
                    ...styles.stepNode,
                    ...(isActive ? styles.stepNodeActive : {}),
                    ...(isDone ? styles.stepNodeDone : {}),
                    ...(isBatch && isDone ? styles.stepNodeBatch : {}),
                    cursor: (step.result_summary || hasArtifact) ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (step.result_summary || hasArtifact) handleArtifactClick(step, idx);
                  }}
                >
                  <div style={styles.stepNodeLeft}>
                    <div style={{
                      ...styles.stepDot,
                      ...(isDone ? styles.stepDotDone : {}),
                      ...(isActive ? styles.stepDotActive : {}),
                      ...(isError ? styles.stepDotError : {}),
                    }}>
                      {isDone ? "✓" : isError ? "✕" : ""}
                    </div>
                    <div style={styles.stepInfo}>
                      <div style={styles.stepToolRow}>
                        <span style={styles.stepNumber}>#{idx + 1}</span>
                        <span style={styles.stepIcon}>{icon}</span>
                        <span style={styles.stepLabel}>{step.label}</span>
                      </div>
                      <div style={styles.stepDescription}>{description}</div>
                      {step.args_summary && (
                        <div style={styles.stepArgs}>{step.args_summary}</div>
                      )}
                      {/* Inline result summary for completed steps */}
                      {isDone && step.result_summary && !isExpanded && (
                        <div style={styles.stepInlineResult}>
                          {step.result_summary.length > 100
                            ? step.result_summary.slice(0, 100) + "…"
                            : step.result_summary}
                        </div>
                      )}
                      {isActive && (
                        <div style={styles.activeBar}>
                          <div style={styles.activeBarFill} />
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={styles.stepRight}>
                    {resultBadge && (
                      <span style={{ ...styles.resultBadge, background: resultBadge.color }}>
                        {resultBadge.label}
                      </span>
                    )}
                    {isDone && step.duration !== undefined && (
                      <span style={styles.stepDuration}>{step.duration}s</span>
                    )}
                    {hasArtifact && isDone && (
                      <span style={styles.artifactBadge} title="Artifact saved">●</span>
                    )}
                    {isActive && <span style={styles.spinner} />}
                    {(step.result_summary || hasArtifact) && (
                      <span style={styles.expandArrow}>{isExpanded ? "▾" : "▸"}</span>
                    )}
                  </div>
                </div>

                {/* Batch sub-items (collapsed view) */}
                {isBatch && isDone && !isExpanded && batchSubItems.length > 0 && (
                  <div style={styles.batchSubItems}>
                    {batchSubItems.slice(0, 3).map((item, si) => (
                      <div key={si} style={styles.batchSubItem}>
                        <span style={styles.batchSubDot} />
                        <span style={styles.batchSubText}>{item}</span>
                      </div>
                    ))}
                    {batchSubItems.length > 3 && (
                      <div style={styles.batchSubMore}>+{batchSubItems.length - 3} more</div>
                    )}
                  </div>
                )}

                {isExpanded && (
                  <div style={styles.expandedOutput}>
                    <div style={styles.outputHeader}>
                      <div style={styles.outputLabel}>Output</div>
                    </div>
                    {hasArtifact && projectDir && displayRunId && (() => {
                      const effectiveRunId = viewMode === "history" ? historyRunId : runId;
                      const isBinary = /\.(xlsx|pdf|png|jpg|jpeg)$/i.test(step.artifact || "");
                      const xlsxName = step.workbook_artifact || (step.tool === "fill_workbook" && wbFilename ? wbFilename : null);
                      const handleArtifactDownload = async (fname: string) => {
                        try { await downloadBinaryArtifact(projectDir, effectiveRunId, fname); }
                        catch (err) { console.error("Artifact download failed:", err); }
                      };
                      return (
                        <div style={styles.artifactLinkBar}>
                          {isBinary ? (
                            <span style={{ ...styles.artifactLink, cursor: "pointer" }}
                              onClick={async (e) => { e.stopPropagation(); await handleArtifactDownload(step.artifact!); }}>
                              📎 {step.artifact} ↓
                            </span>
                          ) : (
                            <span style={styles.artifactLink}>📎 {step.artifact}</span>
                          )}
                          {xlsxName && (
                            <span style={{ ...styles.artifactDownload, cursor: "pointer" }}
                              onClick={async (e) => { e.stopPropagation(); await handleArtifactDownload(xlsxName); }}>
                              📥 Download .xlsx
                            </span>
                          )}
                          {step.artifact_volume_path && (
                            <div style={styles.volumePath} title={step.artifact_volume_path}>
                              UC: {step.artifact_volume_path}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {artifactLoading ? (
                      <div style={styles.loadingText}>Loading artifact...</div>
                    ) : (
                      <pre style={styles.outputText}>
                        {artifactContent || step.result_summary || "No output"}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {isRunning && viewMode === "live" && currentStep && displaySteps.every((s) => s.tool !== currentStep || s.status !== "running") && (
            <div style={styles.pendingStep}>
              <span style={styles.spinner} />
              <span style={styles.pendingText}>
                {TOOL_ICONS[currentStep] || "⚙️"} {currentStep}...
              </span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 400,
    background: "#fff",
    borderLeft: "1px solid #e5e7eb",
    display: "flex",
    flexDirection: "column",
    overflow: "auto",
    flexShrink: 0,
    position: "relative",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "#fff",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
  },
  overlayHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
    flexShrink: 0,
  },
  overlayTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#111827",
  },
  overlayClose: {
    border: "none",
    background: "none",
    fontSize: 16,
    cursor: "pointer",
    color: "#6b7280",
    padding: "2px 6px",
    borderRadius: 4,
  },
  overlayBody: {
    flex: 1,
    overflow: "auto",
    padding: "16px",
  },
  reportPre: {
    fontSize: 11,
    lineHeight: 1.7,
    color: "#374151",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    margin: 0,
  },
  loadingText: {
    fontSize: 12,
    color: "#9ca3af",
    fontStyle: "italic",
    padding: "8px 0",
  },
  controlHeader: {
    padding: "16px 18px 12px",
    borderBottom: "1px solid #f3f4f6",
  },
  controlId: {
    fontSize: 12,
    fontWeight: 700,
    color: "#f36f21",
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  controlName: {
    fontSize: 15,
    fontWeight: 600,
    color: "#111827",
    marginTop: 2,
    lineHeight: 1.3,
  },
  controlDomain: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 2,
  },
  controlMeta: {
    fontSize: 11,
    color: "#9ca3af",
    marginTop: 4,
  },
  statusRow: {
    marginTop: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  statusBadgeRunning: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 12,
    background: "#fff7ed",
    border: "1px solid #fed7aa",
    fontSize: 11,
    fontWeight: 600,
    color: "#ea580c",
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#f36f21",
    animation: "pulse 1.5s infinite",
  },
  statusBadgeComplete: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 12,
    background: "#ecfdf5",
    border: "1px solid #a7f3d0",
    fontSize: 11,
    fontWeight: 600,
    color: "#059669",
  },
  statusBadgeIdle: {
    display: "inline-flex",
    padding: "4px 10px",
    borderRadius: 12,
    background: "#f3f4f6",
    fontSize: 11,
    fontWeight: 600,
    color: "#6b7280",
  },
  runIdBadge: {
    fontSize: 9,
    fontFamily: "monospace",
    color: "#9ca3af",
    background: "#f3f4f6",
    padding: "2px 6px",
    borderRadius: 4,
  },
  viewToggle: {
    display: "flex",
    gap: 0,
    marginTop: 10,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
  },
  viewToggleBtn: {
    flex: 1,
    padding: "5px 10px",
    border: "none",
    background: "#f9fafb",
    fontSize: 10,
    fontWeight: 600,
    color: "#6b7280",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  viewToggleBtnActive: {
    background: "#f36f21",
    color: "#fff",
  },
  progressBar: {
    height: 3,
    background: "#f3f4f6",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #f36f21, #f59e0b)",
    transition: "width 0.4s ease",
  },
  historyList: {
    padding: "14px 18px",
    borderBottom: "1px solid #f3f4f6",
  },
  historyCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    borderRadius: 8,
    background: "#f9fafb",
    marginBottom: 6,
    cursor: "pointer",
    transition: "background 0.12s",
    border: "1px solid #e5e7eb",
  },
  historyCardLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  historyDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  historyRunId: {
    fontSize: 11,
    fontWeight: 600,
    color: "#374151",
    fontFamily: "monospace",
  },
  historyMeta: {
    fontSize: 10,
    color: "#9ca3af",
    marginTop: 1,
  },
  historyArrow: {
    fontSize: 14,
    color: "#9ca3af",
    flexShrink: 0,
  },
  historyBackRow: {
    padding: "8px 18px",
    borderBottom: "1px solid #f3f4f6",
  },
  historyBackBtn: {
    background: "none",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 600,
    color: "#6b7280",
    cursor: "pointer",
  },
  resultsSection: {
    padding: "14px 18px",
    borderBottom: "1px solid #f3f4f6",
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: 0.8,
    color: "#9ca3af",
    marginBottom: 10,
  },
  attrResultCard: {
    padding: "10px 12px",
    marginBottom: 8,
    borderRadius: 8,
    background: "#f9fafb",
    borderLeft: "4px solid #e5e7eb",
  },
  attrResultHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  attrResultLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  attrResultRef: {
    fontSize: 14,
    fontWeight: 800,
    flexShrink: 0,
  },
  attrResultName: {
    fontSize: 11,
    fontWeight: 500,
    color: "#374151",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  attrResultBadge: {
    color: "#fff",
    fontSize: 9,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 4,
    textTransform: "uppercase" as const,
    flexShrink: 0,
  },
  attrSampleBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  attrSampleText: {
    fontSize: 10,
    color: "#6b7280",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  attrSampleTrack: {
    flex: 1,
    height: 4,
    background: "#e5e7eb",
    borderRadius: 2,
    overflow: "hidden",
  },
  attrSampleFill: {
    height: "100%",
    borderRadius: 2,
    transition: "width 0.4s ease",
  },
  attrExceptions: {
    marginTop: 6,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  attrExceptionRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
  },
  attrExceptionDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "#ef4444",
    marginTop: 5,
    flexShrink: 0,
  },
  attrExceptionText: {
    fontSize: 10,
    color: "#dc2626",
    lineHeight: 1.4,
  },
  attrNarrative: {
    fontSize: 10,
    color: "#6b7280",
    marginTop: 4,
    lineHeight: 1.4,
    fontStyle: "italic" as const,
  },
  assessment: {
    marginTop: 10,
    padding: "6px 10px",
    borderRadius: 6,
    fontSize: 12,
    textAlign: "center" as const,
  },
  reportSection: {
    padding: "14px 18px",
    borderBottom: "1px solid #f3f4f6",
  },
  reportCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    background: "#ecfdf5",
    border: "1px solid #a7f3d0",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.15s",
  },
  reportIcon: {
    fontSize: 20,
    flexShrink: 0,
    marginTop: 1,
  },
  reportInfo: {
    flex: 1,
    minWidth: 0,
  },
  reportFilename: {
    fontSize: 12,
    fontWeight: 600,
    color: "#059669",
    wordBreak: "break-all" as const,
  },
  reportLink: {
    fontSize: 10,
    color: "#059669",
    marginTop: 4,
    fontWeight: 500,
  },
  workbookCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.15s",
  },
  workbookFilename: {
    fontSize: 12,
    fontWeight: 600,
    color: "#15803d",
    wordBreak: "break-all" as const,
  },
  workbookMeta: {
    fontSize: 10,
    color: "#6b7280",
    marginTop: 2,
  },
  reportUrlRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    padding: "6px 8px",
    background: "#f9fafb",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
  },
  reportUrlLink: {
    fontSize: 10,
    color: "#2563eb",
    wordBreak: "break-all" as const,
    lineHeight: 1.4,
    flex: 1,
    textDecoration: "none",
  },
  copyBtn: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 4px",
    borderRadius: 4,
    flexShrink: 0,
  },
  timelineSection: {
    padding: "14px 18px",
    flex: 1,
  },
  timeline: {
    display: "flex",
    flexDirection: "column" as const,
  },
  timelineItem: {
    position: "relative" as const,
  },
  connectorLine: {
    position: "absolute" as const,
    left: 10,
    top: -4,
    width: 2,
    height: 8,
    borderRadius: 1,
  },
  stepNode: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderRadius: 8,
    marginBottom: 2,
    transition: "all 0.15s",
  },
  stepNodeActive: {
    background: "#fff7ed",
    border: "1px solid #fed7aa",
  },
  stepNodeDone: {
    background: "#f9fafb",
  },
  stepNodeBatch: {
    background: "#eff6ff",
    borderLeft: "3px solid #3b82f6",
  },
  stepNodeLeft: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: "50%",
    background: "#e5e7eb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
    marginTop: 1,
  },
  stepDotDone: {
    background: "#10b981",
  },
  stepDotActive: {
    background: "#f36f21",
    animation: "pulse 1.5s infinite",
  },
  stepDotError: {
    background: "#ef4444",
  },
  stepInfo: {
    flex: 1,
    minWidth: 0,
  },
  stepToolRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  stepNumber: {
    fontSize: 9,
    fontWeight: 700,
    color: "#9ca3af",
    fontFamily: "monospace",
    minWidth: 18,
  },
  stepIcon: {
    fontSize: 14,
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
  },
  stepDescription: {
    fontSize: 10,
    color: "#6b7280",
    marginTop: 1,
    lineHeight: 1.3,
  },
  stepArgs: {
    fontSize: 10,
    color: "#9ca3af",
    marginTop: 2,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  stepInlineResult: {
    fontSize: 10,
    color: "#059669",
    marginTop: 3,
    lineHeight: 1.4,
    background: "#ecfdf5",
    padding: "2px 6px",
    borderRadius: 4,
    display: "inline-block",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  activeBar: {
    height: 2,
    background: "#fed7aa",
    borderRadius: 1,
    marginTop: 4,
    overflow: "hidden",
    width: "80%",
  },
  activeBarFill: {
    height: "100%",
    width: "40%",
    background: "#f36f21",
    borderRadius: 1,
    animation: "indeterminate 1.5s infinite ease-in-out",
  },
  stepRight: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    marginTop: 2,
  },
  resultBadge: {
    color: "#fff",
    fontSize: 8,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: 4,
    textTransform: "uppercase" as const,
    letterSpacing: 0.3,
  },
  stepDuration: {
    fontSize: 10,
    color: "#9ca3af",
    fontFamily: "monospace",
  },
  artifactBadge: {
    fontSize: 8,
    color: "#f36f21",
  },
  spinner: {
    width: 12,
    height: 12,
    border: "2px solid #fed7aa",
    borderTopColor: "#f36f21",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    display: "inline-block",
  },
  expandArrow: {
    fontSize: 10,
    color: "#9ca3af",
    marginLeft: 2,
  },
  batchSubItems: {
    marginLeft: 38,
    marginBottom: 6,
    paddingLeft: 8,
    borderLeft: "2px solid #dbeafe",
  },
  batchSubItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 0",
  },
  batchSubDot: {
    width: 4,
    height: 4,
    borderRadius: "50%",
    background: "#93c5fd",
    flexShrink: 0,
  },
  batchSubText: {
    fontSize: 10,
    color: "#6b7280",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  batchSubMore: {
    fontSize: 9,
    color: "#9ca3af",
    fontStyle: "italic" as const,
    paddingLeft: 10,
  },
  expandedOutput: {
    margin: "0 10px 8px 38px",
    padding: "8px 12px",
    background: "#f9fafb",
    borderRadius: 6,
    borderLeft: "3px solid #f36f21",
    maxHeight: 300,
    overflow: "auto",
  },
  outputHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  outputLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    color: "#9ca3af",
  },
  artifactLinkBar: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginBottom: 8,
    padding: "6px 8px",
    background: "#fff",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
  },
  artifactLink: {
    fontSize: 11,
    color: "#2563eb",
    fontWeight: 500,
    textDecoration: "none",
    wordBreak: "break-all" as const,
    lineHeight: 1.4,
  },
  artifactDownload: {
    fontSize: 11,
    color: "#059669",
    fontWeight: 500,
    textDecoration: "none",
    cursor: "pointer",
  },
  volumePath: {
    fontSize: 9,
    color: "#9ca3af",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
    lineHeight: 1.3,
    marginTop: 2,
  },
  outputText: {
    fontSize: 11,
    color: "#374151",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    margin: 0,
  },
  pendingStep: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px 6px 38px",
    fontSize: 11,
    color: "#9ca3af",
  },
  pendingText: {
    fontStyle: "italic",
  },
  evidenceSection: {
    padding: "14px 18px",
    borderBottom: "1px solid #f3f4f6",
  },
  evidenceBlock: {
    marginBottom: 10,
  },
  evidenceItemClickable: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.12s",
    background: "transparent",
    border: "none",
  },
  evidenceIcon: {
    fontSize: 18,
    flexShrink: 0,
  },
  evidenceItemInfo: {
    flex: 1,
    minWidth: 0,
  },
  evidenceItemName: {
    fontSize: 12,
    fontWeight: 500,
    color: "#374151",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  evidenceItemMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  typeBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: 4,
    letterSpacing: 0.3,
    textTransform: "uppercase" as const,
  },
  focusLabel: {
    fontSize: 10,
    color: "#9ca3af",
    textTransform: "capitalize" as const,
  },
  openArrow: {
    fontSize: 12,
    color: "#9ca3af",
    flexShrink: 0,
  },
  instructionsExpanded: {
    margin: "4px 0 8px 38px",
    padding: "10px 12px",
    background: "#f9fafb",
    borderRadius: 6,
    borderLeft: "3px solid #2563eb",
  },
  instructionsText: {
    fontSize: 12,
    color: "#374151",
    lineHeight: 1.7,
    margin: 0,
  },
  rulesBox: {
    marginTop: 10,
    padding: "8px 10px",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
  },
  rulesLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    color: "#9ca3af",
    marginBottom: 6,
  },
  ruleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "3px 0",
    fontSize: 11,
  },
  ruleKey: {
    color: "#6b7280",
    textTransform: "capitalize" as const,
  },
  ruleValue: {
    fontWeight: 600,
    color: "#111827",
    fontFamily: "monospace",
    fontSize: 11,
  },
  attrsBox: {
    marginTop: 10,
    padding: "8px 10px",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
  },
  attrRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "3px 0",
    fontSize: 11,
  },
  attrRef: {
    fontWeight: 700,
    color: "#f36f21",
    fontSize: 12,
    width: 16,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  attrName: {
    flex: 1,
    color: "#374151",
  },
  attrScope: {
    fontSize: 9,
    fontWeight: 600,
    color: "#9ca3af",
    background: "#f3f4f6",
    padding: "1px 5px",
    borderRadius: 3,
  },
  emailPreviewBox: {
    margin: "0 10px 8px 38px",
    background: "#f9fafb",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
    overflow: "hidden",
    maxHeight: 300,
    display: "flex",
    flexDirection: "column" as const,
  },
  emailPreviewHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 10px",
    background: "#eff6ff",
    borderBottom: "1px solid #dbeafe",
    flexShrink: 0,
  },
  emailPreviewTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#2563eb",
  },
  emailPreviewBody: {
    fontSize: 11,
    color: "#374151",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    margin: 0,
    padding: "10px 12px",
    overflow: "auto",
    flex: 1,
  },
  rerunBtn: {
    padding: "3px 8px",
    fontSize: 9,
    fontWeight: 600,
    color: "#7c3aed",
    background: "#f5f3ff",
    border: "1px solid #ddd6fe",
    borderRadius: 4,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    transition: "all 0.15s",
  },
};
