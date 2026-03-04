import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  sendMessage, cancelTask, listProjects, listRuns, pollTask, fetchRunManifest,
  AgentMessage, ProjectInfo, ToolStep, SendResult, RunInfo,
  ThinkingEntry, AgentPlan,
} from "./api";
import ExecutionPanel from "./components/ExecutionPanel";
import ThinkingPanel, { type TimelineEntry } from "./components/ThinkingPanel";
import ProjectDashboard from "./components/ProjectDashboard";

type AppView = "welcome" | "project" | "run";

const SESSION_KEY = "gsk_agent_state";

const DOMAIN_COLORS: Record<string, string> = {
  "Accounts Payable": "#2563eb",
  "IT General Controls": "#7c3aed",
  "Financial Reporting": "#059669",
  "HR / IT Controls": "#d97706",
  "Revenue / Financial Reporting": "#dc2626",
  "Environmental Health & Safety": "#0891b2",
  "Inventory Management": "#7c3aed",
};

interface PersistedState {
  selectedProject: string | null;
  activeTaskId: string | null;
  currentRunId: string;
  currentProjectDir: string;
  liveSteps: ToolStep[];
  completedSteps: ToolStep[];
  runComplete: boolean;
  loading: boolean;
}

function loadPersistedState(): PersistedState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

function savePersistedState(state: PersistedState) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch { /* quota exceeded */ }
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function fireCompletionNotification(projectDir: string, assessment: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Assessment Complete", {
      body: `${projectDir}: ${assessment || "Completed"}`,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡️</text></svg>",
    });
  }
}

export default function App() {
  const persisted = useRef(loadPersistedState());
  const init = persisted.current;

  const [loading, setLoading] = useState(!!init?.activeTaskId);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(init?.selectedProject ?? null);

  const [liveSteps, setLiveSteps] = useState<ToolStep[]>(init?.liveSteps || []);
  const [liveCurrentStep, setLiveCurrentStep] = useState<string | null>(null);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<ToolStep[]>(init?.completedSteps || []);
  const [runComplete, setRunComplete] = useState(init?.runComplete ?? false);
  const [currentRunId, setCurrentRunId] = useState(init?.currentRunId ?? "");
  const [currentProjectDir, setCurrentProjectDir] = useState(init?.currentProjectDir ?? "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(init?.activeTaskId ?? null);
  const [cancelling, setCancelling] = useState(false);
  const [wasCancelled, setWasCancelled] = useState(false);
  const latestStepsRef = useRef<ToolStep[]>(init?.liveSteps || []);
  const abortRef = useRef<AbortController | null>(null);

  const [thinking, setThinking] = useState<ThinkingEntry[]>([]);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [userMessages, setUserMessages] = useState<TimelineEntry[]>([]);
  const [appView, setAppView] = useState<AppView>(
    init?.activeTaskId ? "run" : init?.selectedProject ? "project" : "welcome"
  );

  const [projectRunCounts, setProjectRunCounts] = useState<Record<string, { count: number; lastStatus: string }>>({});

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    savePersistedState({
      selectedProject,
      activeTaskId,
      currentRunId,
      currentProjectDir,
      liveSteps,
      completedSteps,
      runComplete,
      loading,
    });
  }, [selectedProject, activeTaskId, currentRunId, currentProjectDir, liveSteps, completedSteps, runComplete, loading]);

  useEffect(() => {
    listProjects().then((projs) => {
      setProjects(projs);
      projs.forEach((p) => {
        listRuns(p.project_dir).then((runs) => {
          if (runs.length > 0) {
            setProjectRunCounts((prev) => ({
              ...prev,
              [p.project_dir]: {
                count: runs.length,
                lastStatus: runs[0].status || "unknown",
              },
            }));
          }
        });
      });
    });
  }, []);

  useEffect(() => {
    const taskId = init?.activeTaskId;
    if (!taskId) return;
    const controller = new AbortController();
    abortRef.current = controller;

    pollTask(
      taskId,
      (steps, currentStep, elapsed) => {
        const snapshot = [...steps];
        setLiveSteps(snapshot);
        latestStepsRef.current = snapshot;
        setLiveCurrentStep(currentStep);
        setLiveElapsed(elapsed);
      },
      controller.signal,
    ).then((result) => {
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
      if (result.runId) setCurrentRunId(result.runId);
      if (result.projectDir) setCurrentProjectDir(result.projectDir);
    }).catch(() => {
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
    }).finally(() => {
      setLoading(false);
      setCancelling(false);
      setActiveTaskId(null);
      setLiveCurrentStep(null);
      abortRef.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    setAppView("run");
    setLoading(true);
    setCancelling(false);
    setActiveTaskId(null);
    setLiveSteps([]);
    setLiveCurrentStep(null);
    setLiveElapsed(0);
    setCompletedSteps([]);
    setRunComplete(false);
    setWasCancelled(false);
    setThinking([]);
    setPlan(null);
    setUserMessages([]);
    latestStepsRef.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    const msgs: AgentMessage[] = [{ role: "user", content: text }];

    try {
      const result: SendResult = await sendMessage(
        msgs,
        (steps, currentStep, elapsed) => {
          const snapshot = [...steps];
          setLiveSteps(snapshot);
          latestStepsRef.current = snapshot;
          setLiveCurrentStep(currentStep);
          setLiveElapsed(elapsed);
        },
        (taskId) => setActiveTaskId(taskId),
        controller.signal,
        (newThinking, newPlan) => {
          setThinking(newThinking);
          if (newPlan) setPlan(newPlan);
        },
      );
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
      if (result.runId) setCurrentRunId(result.runId);
      if (result.projectDir) setCurrentProjectDir(result.projectDir);
      fireCompletionNotification(result.projectDir || selectedProject || "", "Assessment complete");
    } catch {
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
    } finally {
      setLoading(false);
      setCancelling(false);
      setActiveTaskId(null);
      setLiveCurrentStep(null);
      abortRef.current = null;
    }
  }, [loading, selectedProject]);

  const handleStop = async () => {
    if (!activeTaskId) return;
    setCancelling(true);
    setWasCancelled(true);
    try { await cancelTask(activeTaskId); } catch { /* best effort */ }
    abortRef.current?.abort();
  };

  const handleStartOver = () => {
    if (loading) return;
    setSelectedProject(null);
    setLiveSteps([]);
    setLiveCurrentStep(null);
    setLiveElapsed(0);
    setCompletedSteps([]);
    setRunComplete(false);
    setWasCancelled(false);
    setCurrentRunId("");
    setCurrentProjectDir("");
    setActiveTaskId(null);
    setCancelling(false);
    setThinking([]);
    setPlan(null);
    setUserMessages([]);
    setAppView("welcome");
    abortRef.current = null;
    sessionStorage.removeItem(SESSION_KEY);
  };

  const handleProjectSelect = (proj: ProjectInfo) => {
    if (loading) return;
    setSelectedProject(proj.project_dir);
    setCompletedSteps([]);
    setRunComplete(false);
    setWasCancelled(false);
    setCurrentRunId("");
    setCurrentProjectDir(proj.project_dir);
    setThinking([]);
    setPlan(null);
    setUserMessages([]);
    setAppView("project");
  };

  const handleRunAssessment = useCallback(() => {
    const proj = projects.find((p) => p.project_dir === selectedProject);
    if (!proj || loading) return;
    handleSend(
      `Run the full controls evidence review for project "${proj.project_dir}" ` +
      `(Control ${proj.control_id}: ${proj.control_name}). ` +
      `Load the engagement, parse the workbook, review all evidence documents, ` +
      `execute all applicable tests, compile the results, save the report, ` +
      `and email the report if notification_emails is configured.`
    );
  }, [projects, selectedProject, loading, handleSend]);

  const handleViewHistoryRun = useCallback(async (run: RunInfo) => {
    const projDir = selectedProject || "";
    if (!projDir) return;
    const manifest = await fetchRunManifest(projDir, run.run_id);
    if (manifest) {
      setCompletedSteps(manifest.steps || []);
      setThinking(manifest.thinking || []);
      setPlan(manifest.plan || null);
      setCurrentRunId(manifest.run_id);
      setCurrentProjectDir(projDir);
      setRunComplete(true);
      setWasCancelled(manifest.status === "cancelled" || manifest.status === "stopped");
      setUserMessages([]);
      setAppView("run");
    }
  }, [selectedProject]);

  const handleContinueRun = useCallback(async (run: RunInfo) => {
    const projDir = selectedProject || "";
    if (!projDir || loading) return;
    const proj = projects.find((p) => p.project_dir === projDir);
    if (!proj) return;

    const manifest = await fetchRunManifest(projDir, run.run_id);
    let stepsSummary = "";
    if (manifest?.steps) {
      const completed = manifest.steps.filter((s: ToolStep) => s.status === "complete");
      stepsSummary = completed
        .map((s: ToolStep) => `- ${s.label}: ${(s.result_summary || "done").slice(0, 120)}`)
        .join("\n");
    }

    handleSend(
      `Continue the controls evidence review for project "${projDir}" ` +
      `(Control ${proj.control_id}: ${proj.control_name}). ` +
      `A previous run (${run.run_id}) was stopped after completing these steps:\n${stepsSummary}\n\n` +
      `Resume from where it left off. Load the engagement, then skip steps already completed above. ` +
      `Execute any remaining tests, compile results, save the report, and email if configured.`
    );
  }, [selectedProject, projects, loading, handleSend]);

  const handleContinueCurrentRun = useCallback(() => {
    const proj = projects.find((p) => p.project_dir === selectedProject);
    if (!proj || loading) return;

    const completed = completedSteps.filter((s) => s.status === "complete");
    const stepsSummary = completed
      .map((s) => `- ${s.label}: ${(s.result_summary || "done").slice(0, 120)}`)
      .join("\n");

    handleSend(
      `Continue the controls evidence review for project "${selectedProject}" ` +
      `(Control ${proj.control_id}: ${proj.control_name}). ` +
      `The previous run was stopped after completing these steps:\n${stepsSummary}\n\n` +
      `Resume from where it left off. Load the engagement, then skip steps already completed above. ` +
      `Execute any remaining tests, compile results, save the report, and email if configured.`
    );
  }, [selectedProject, projects, loading, completedSteps, handleSend]);

  const handleBackToProject = useCallback(() => {
    if (loading) return;
    setLiveSteps([]);
    setLiveCurrentStep(null);
    setLiveElapsed(0);
    setCompletedSteps([]);
    setRunComplete(false);
    setWasCancelled(false);
    setCurrentRunId("");
    setThinking([]);
    setPlan(null);
    setUserMessages([]);
    setAppView("project");
  }, [loading]);

  const handleRerunTest = (projDir: string, ref: string, attribute: string) => {
    if (loading) return;
    handleSend(
      `For project "${projDir}", re-run ONLY testing attribute ${ref} ("${attribute}"). ` +
      `Use the execute_test tool directly with the same control context and evidence from the previous run. ` +
      `Report the updated result.`
    );
  };

  const handleReviewEvidence = (projDir: string, filePath: string, fileType: string) => {
    if (loading) return;
    const toolName = fileType === "email" ? "analyze_email"
      : ["screenshot", "image", "photo"].includes(fileType) ? "review_screenshot"
      : "review_document";
    handleSend(
      `For project "${projDir}", re-review ONLY the evidence file "${filePath}" ` +
      `using the ${toolName} tool. Report what you find.`
    );
  };

  const handleThinkingPanelSend = useCallback((text: string) => {
    if (!text.trim()) return;
    setUserMessages((prev) => [...prev, { type: "user", content: text, timestamp: Date.now() / 1000 }]);
    handleSend(text);
  }, [handleSend]);

  const activeSteps = loading ? liveSteps : completedSteps;
  const selectedProjectInfo = projects.find((p) => p.project_dir === selectedProject) || null;

  return (
    <div style={styles.container}>
      {/* Left Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <span style={styles.logoText}>GSK</span>
          <span style={styles.logoSub}>FRMC Agent</span>
        </div>

        <div style={styles.projectSection}>
          <h4 style={styles.sectionTitle}>Projects ({projects.length})</h4>
          {projects.length === 0 && (
            <div style={styles.emptyText}>Loading projects...</div>
          )}
          {projects.map((proj) => {
            const isSelected = selectedProject === proj.project_dir;
            const runInfo = projectRunCounts[proj.project_dir];
            const isRunningNow = isSelected && loading;
            return (
              <div
                key={proj.project_dir}
                style={{
                  ...styles.projectCard,
                  ...(isSelected ? styles.projectCardActive : {}),
                }}
                onClick={() => handleProjectSelect(proj)}
              >
                <div style={styles.projectHeader}>
                  <span
                    style={{
                      ...styles.controlBadge,
                      background: DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
                    }}
                  >
                    {proj.control_id || proj.project_dir}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {isRunningNow && <span style={styles.projectSpinner} />}
                    {!isRunningNow && runInfo && (
                      <>
                        <span style={{
                          ...styles.statusDot,
                          background: runInfo.lastStatus === "complete" ? "#10b981"
                            : runInfo.lastStatus === "error" ? "#ef4444" : "#9ca3af",
                        }} />
                        <span style={styles.runCountBadge}>{runInfo.count}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={styles.projectName}>
                  {proj.control_name || proj.project_dir}
                </div>
                <div style={styles.projectDomain}>{proj.domain || ""}</div>
              </div>
            );
          })}
        </div>

        <div style={styles.sidebarFooter}>
          <span style={{ fontSize: 10, opacity: 0.4 }}>Powered by Databricks</span>
        </div>
      </aside>

      {/* Main Area */}
      <main style={styles.main}>
        {appView === "run" ? (
          <>
            {/* Back to project nav */}
            {!loading && selectedProjectInfo && (
              <div style={styles.backNav}>
                <button style={styles.backBtn} onClick={handleBackToProject}>
                  ← Back to {selectedProjectInfo.control_id || selectedProjectInfo.project_dir}
                </button>
                {currentRunId && (
                  <span style={styles.backRunId}>Run: {currentRunId}</span>
                )}
              </div>
            )}
            <div style={styles.splitContainer}>
              <div style={styles.thinkingPane}>
                <ThinkingPanel
                  thinking={thinking}
                  plan={plan}
                  isRunning={loading}
                  isComplete={runComplete}
                  steps={activeSteps}
                  onSendMessage={handleThinkingPanelSend}
                  disabled={loading}
                  userMessages={userMessages}
                />
              </div>
              <div style={styles.splitDivider} />
              <div style={styles.executionPane}>
                <ExecutionPanel
                  project={selectedProjectInfo}
                  steps={activeSteps}
                  currentStep={liveCurrentStep}
                  elapsed={liveElapsed}
                  isRunning={loading}
                  isComplete={runComplete}
                  runId={currentRunId}
                  projectDir={currentProjectDir || selectedProject || ""}
                  cancelling={cancelling}
                  onRerunTest={handleRerunTest}
                  onReviewEvidence={handleReviewEvidence}
                  onStop={handleStop}
                  onStartOver={handleStartOver}
                  onContinue={wasCancelled ? handleContinueCurrentRun : undefined}
                  wasCancelled={wasCancelled}
                />
              </div>
            </div>
          </>
        ) : appView === "project" && selectedProjectInfo ? (
          <ProjectDashboard
            project={selectedProjectInfo}
            onRunAssessment={handleRunAssessment}
            onViewRun={handleViewHistoryRun}
            onContinueRun={handleContinueRun}
          />
        ) : (
          /* Welcome state */
          <div style={styles.welcomeContainer}>
            <div style={styles.welcomeHero}>
              <div style={styles.welcomeIcon}>🛡️</div>
              <h1 style={styles.welcomeTitle}>Controls Evidence Review</h1>
              <p style={styles.welcomeSubtitle}>
                Select a project to view its run history or start a new automated control review.
              </p>
            </div>
            <div style={styles.welcomeGrid}>
              {projects.map((proj) => {
                const runInfo = projectRunCounts[proj.project_dir];
                return (
                  <div
                    key={proj.project_dir}
                    style={styles.welcomeCard}
                    onClick={() => handleProjectSelect(proj)}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = DOMAIN_COLORS[proj.domain || ""] || "#6b7280";
                      (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = "#e5e7eb";
                      (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
                    }}
                  >
                    <div style={styles.welcomeCardHeader}>
                      <span
                        style={{
                          ...styles.welcomeControlBadge,
                          background: DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
                        }}
                      >
                        {proj.control_id || proj.project_dir}
                      </span>
                      {runInfo && (
                        <span style={{
                          ...styles.welcomeRunBadge,
                          background: runInfo.lastStatus === "complete" ? "#ecfdf5" : "#f3f4f6",
                          color: runInfo.lastStatus === "complete" ? "#059669" : "#6b7280",
                        }}>
                          {runInfo.count} run{runInfo.count !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div style={styles.welcomeCardName}>{proj.control_name || proj.project_dir}</div>
                    <div style={styles.welcomeCardDomain}>{proj.domain || ""}</div>
                    <div style={styles.welcomeCardAction}>View Project →</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
    background: "#f3f4f6",
  },

  /* Sidebar */
  sidebar: {
    width: 270,
    background: "#1a1a2e",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
  },
  logo: {
    padding: "18px 18px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
  },
  logoText: {
    fontSize: 26,
    fontWeight: 800,
    color: "#f36f21",
    letterSpacing: 2,
  },
  logoSub: {
    fontSize: 12,
    fontWeight: 400,
    opacity: 0.6,
  },
  projectSection: {
    padding: "14px 14px",
    flex: 1,
    overflow: "auto",
  },
  sectionTitle: {
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    opacity: 0.4,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 12,
    opacity: 0.3,
    fontStyle: "italic",
  },
  projectCard: {
    padding: "10px 11px",
    marginBottom: 6,
    borderRadius: 8,
    background: "rgba(255,255,255,0.04)",
    cursor: "pointer",
    transition: "all 0.15s",
    border: "1px solid transparent",
  },
  projectCardActive: {
    background: "rgba(243,111,33,0.12)",
    border: "1px solid rgba(243,111,33,0.35)",
  },
  projectHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    marginBottom: 4,
  },
  controlBadge: {
    padding: "2px 7px",
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: 0.3,
  },
  projectSpinner: {
    width: 10,
    height: 10,
    border: "2px solid rgba(243,111,33,0.3)",
    borderTopColor: "#f36f21",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  runCountBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: "rgba(255,255,255,0.5)",
    background: "rgba(255,255,255,0.1)",
    padding: "1px 5px",
    borderRadius: 8,
    minWidth: 16,
    textAlign: "center" as const,
  },
  projectName: {
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.3,
    marginBottom: 2,
  },
  projectDomain: {
    fontSize: 10,
    opacity: 0.4,
  },
  sidebarFooter: {
    padding: "10px 18px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    textAlign: "center" as const,
  },

  /* Main area */
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: 0,
    position: "relative" as const,
  },

  /* Back navigation */
  backNav: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 16px",
    borderBottom: "1px solid #e5e7eb",
    background: "#fff",
    flexShrink: 0,
  },
  backBtn: {
    padding: "4px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    background: "#fff",
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  backRunId: {
    fontSize: 11,
    color: "#9ca3af",
    fontFamily: "monospace",
  },

  /* Split pane layout */
  splitContainer: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    minHeight: 0,
  },
  thinkingPane: {
    width: "33%",
    minWidth: 280,
    maxWidth: 420,
    flexShrink: 0,
    overflow: "hidden",
  },
  splitDivider: {
    width: 1,
    background: "#e5e7eb",
    flexShrink: 0,
  },
  executionPane: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },

  /* Welcome state */
  welcomeContainer: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "48px 32px",
  },
  welcomeHero: {
    textAlign: "center" as const,
    marginBottom: 40,
    maxWidth: 560,
  },
  welcomeIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  welcomeTitle: {
    fontSize: 28,
    fontWeight: 800,
    color: "#111827",
    marginBottom: 10,
  },
  welcomeSubtitle: {
    fontSize: 14,
    color: "#6b7280",
    lineHeight: 1.6,
  },
  welcomeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 16,
    width: "100%",
    maxWidth: 900,
  },
  welcomeCard: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "18px 20px",
    cursor: "pointer",
    transition: "all 0.2s",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  welcomeCardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  welcomeControlBadge: {
    padding: "3px 10px",
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: 0.3,
  },
  welcomeRunBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 8,
  },
  welcomeCardName: {
    fontSize: 14,
    fontWeight: 600,
    color: "#111827",
    lineHeight: 1.3,
    marginBottom: 4,
  },
  welcomeCardDomain: {
    fontSize: 12,
    color: "#6b7280",
    marginBottom: 12,
  },
  welcomeCardAction: {
    fontSize: 12,
    fontWeight: 600,
    color: "#f36f21",
  },
};
