import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  sendMessage, cancelTask, uploadFile, listProjects, listRuns, pollTask,
  AgentMessage, UploadResult, ProjectInfo, ToolStep, SendResult, RunInfo,
} from "./api";
import ChatMessage from "./components/ChatMessage";
import FileUpload from "./components/FileUpload";
import ExecutionPanel from "./components/ExecutionPanel";

const SESSION_KEY = "gsk_agent_state";

const INITIAL_MESSAGE: AgentMessage = {
  role: "assistant",
  content:
    "Welcome to the **GSK Controls Evidence Review Agent**.\n\n" +
    "Select a project from the sidebar to begin a control review, or type a question below.\n\n" +
    "I'll load the engagement instructions, parse the workbook, review all evidence, " +
    "execute each test attribute, and compile a full audit report.",
};

const DOMAIN_COLORS: Record<string, string> = {
  "Accounts Payable": "#2563eb",
  "IT General Controls": "#7c3aed",
  "Financial Reporting": "#059669",
  "HR / IT Controls": "#d97706",
  "Revenue / Financial Reporting": "#dc2626",
  "Environmental Health & Safety": "#0891b2",
};

const EVIDENCE_ICONS: Record<string, { icon: string; label: string; color: string }> = {
  pdf: { icon: "PDF", label: "PDF", color: "#dc3545" },
  screenshot: { icon: "SCR", label: "Screenshot", color: "#7c3aed" },
  email: { icon: "EML", label: "Email", color: "#2563eb" },
  photo: { icon: "IMG", label: "Photo", color: "#059669" },
  embedded_image: { icon: "EMB", label: "Embedded", color: "#0891b2" },
};

function getProjectEvidenceTypes(proj: ProjectInfo): string[] {
  const domainMap: Record<string, string[]> = {
    "Accounts Payable": ["pdf"],
    "IT General Controls": ["screenshot", "pdf"],
    "Financial Reporting": ["email", "pdf"],
    "HR / IT Controls": ["screenshot", "pdf"],
    "Revenue / Financial Reporting": ["photo", "pdf"],
    "Environmental Health & Safety": ["embedded_image", "pdf"],
  };
  return domainMap[proj.domain || ""] || ["pdf"];
}

interface PersistedState {
  messages: AgentMessage[];
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
  } catch { /* quota exceeded — ignore */ }
}

export default function App() {
  const persisted = useRef(loadPersistedState());
  const init = persisted.current;

  const [messages, setMessages] = useState<AgentMessage[]>(init?.messages || [INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(!!init?.activeTaskId);
  const [uploadedFiles, setUploadedFiles] = useState<UploadResult[]>([]);
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
  const latestStepsRef = useRef<ToolStep[]>(init?.liveSteps || []);
  const abortRef = useRef<AbortController | null>(null);

  const [projectRunCounts, setProjectRunCounts] = useState<Record<string, { count: number; lastStatus: string }>>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Persist state on every meaningful update
  useEffect(() => {
    savePersistedState({
      messages,
      selectedProject,
      activeTaskId,
      currentRunId,
      currentProjectDir,
      liveSteps,
      completedSteps,
      runComplete,
      loading,
    });
  }, [messages, selectedProject, activeTaskId, currentRunId, currentProjectDir, liveSteps, completedSteps, runComplete, loading]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    listProjects().then((projs) => {
      setProjects(projs);
      // Fetch run counts for sidebar indicators
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

  // Resume polling if page was refreshed while a task was in-flight
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
      setMessages((prev) => [...prev, result.message]);
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
      if (result.runId) setCurrentRunId(result.runId);
      if (result.projectDir) setCurrentProjectDir(result.projectDir);
    }).catch((error) => {
      const msg = error instanceof Error ? error.message : "Unknown error";
      const isCancelled = msg === "Cancelled" || msg.includes("cancelled") || msg.includes("abort");
      if (!isCancelled) {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg}` }]);
      }
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

  const handleSend = async (overrideInput?: string) => {
    const text = overrideInput || input;
    if (!text.trim() || loading) return;

    const userMsg: AgentMessage = { role: "user", content: text };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setInput("");
    setLoading(true);
    setCancelling(false);
    setActiveTaskId(null);
    setLiveSteps([]);
    setLiveCurrentStep(null);
    setLiveElapsed(0);
    setCompletedSteps([]);
    setRunComplete(false);
    latestStepsRef.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result: SendResult = await sendMessage(
        allMessages.filter((m) => m !== INITIAL_MESSAGE),
        (steps, currentStep, elapsed) => {
          const snapshot = [...steps];
          setLiveSteps(snapshot);
          latestStepsRef.current = snapshot;
          setLiveCurrentStep(currentStep);
          setLiveElapsed(elapsed);
        },
        (taskId) => setActiveTaskId(taskId),
        controller.signal,
      );
      setMessages((prev) => [...prev, result.message]);
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
      if (result.runId) setCurrentRunId(result.runId);
      if (result.projectDir) setCurrentProjectDir(result.projectDir);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      const isCancelled = msg === "Cancelled" || msg.includes("cancelled") || msg.includes("abort");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: isCancelled
            ? "Run stopped by user."
            : `Error: ${msg}. Please check the backend is running.`,
        },
      ]);
      setCompletedSteps(latestStepsRef.current);
      setRunComplete(true);
    } finally {
      setLoading(false);
      setCancelling(false);
      setActiveTaskId(null);
      setLiveCurrentStep(null);
      abortRef.current = null;
    }
  };

  const handleStop = async () => {
    if (!activeTaskId) return;
    setCancelling(true);
    try {
      await cancelTask(activeTaskId);
    } catch { /* best effort */ }
    abortRef.current?.abort();
  };

  const handleFileUpload = async (files: File[]) => {
    for (const file of files) {
      try {
        const result = await uploadFile(file);
        setUploadedFiles((prev) => [...prev, result]);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Uploaded **${result.filename}** (${(result.size_bytes / 1024).toFixed(1)} KB)${result.volume_path ? ` to UC Volume: \`${result.volume_path}\`` : " to local staging"}`,
          },
        ]);
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Failed to upload ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ]);
      }
    }
  };

  const handleStartOver = () => {
    if (loading) return;
    setMessages([INITIAL_MESSAGE]);
    setInput("");
    setSelectedProject(null);
    setLiveSteps([]);
    setLiveCurrentStep(null);
    setLiveElapsed(0);
    setCompletedSteps([]);
    setRunComplete(false);
    setCurrentRunId("");
    setCurrentProjectDir("");
    setActiveTaskId(null);
    setCancelling(false);
    setUploadedFiles([]);
    abortRef.current = null;
    sessionStorage.removeItem(SESSION_KEY);
  };

  const handleProjectSelect = (proj: ProjectInfo) => {
    setSelectedProject(proj.project_dir);
    setCompletedSteps([]);
    setRunComplete(false);
    handleSend(
      `Run the full controls evidence review for project "${proj.project_dir}" ` +
      `(Control ${proj.control_id}: ${proj.control_name}). ` +
      `Load the engagement, parse the workbook, review all evidence documents, ` +
      `execute all applicable tests, compile the results, save the report, ` +
      `and email the report if notification_emails is configured.`
    );
  };

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activeSteps = loading ? liveSteps : completedSteps;
  const showPanel = activeSteps.length > 0 || selectedProject !== null;
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
          <h4 style={styles.sectionTitle}>
            Projects ({projects.length})
          </h4>
          {projects.length === 0 && (
            <div style={styles.emptyText}>Loading projects...</div>
          )}
          {projects.map((proj) => {
            const evidenceTypes = getProjectEvidenceTypes(proj);
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
                onClick={() => !loading && handleProjectSelect(proj)}
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
                          ...styles.statusIndicator,
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
                <div style={styles.evidenceRow}>
                  {evidenceTypes.map((t) => {
                    const info = EVIDENCE_ICONS[t];
                    if (!info) return null;
                    return (
                      <span
                        key={t}
                        style={{ ...styles.evidenceChip, borderColor: info.color, color: info.color }}
                        title={info.label}
                      >
                        {info.icon}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {uploadedFiles.length > 0 && (
          <div style={styles.uploadSection}>
            <h4 style={styles.sectionTitle}>Uploaded Files</h4>
            {uploadedFiles.map((f, i) => (
              <div key={i} style={styles.fileItem}>
                <span style={styles.fileName}>{f.filename}</span>
              </div>
            ))}
          </div>
        )}

        <div style={styles.sidebarFooter}>
          <span style={{ fontSize: 10, opacity: 0.4 }}>
            Powered by Databricks
          </span>
        </div>
      </aside>

      {/* Center: Chat */}
      <main style={styles.main}>
        <header style={styles.header}>
          <h1 style={styles.headerTitle}>Controls Evidence Review</h1>
          {selectedProject && (
            <div style={styles.headerBadge}>
              {projects.find((p) => p.project_dir === selectedProject)?.control_id || selectedProject}
            </div>
          )}
          <div style={{ flex: 1 }} />
          {loading && (
            <div style={styles.headerRunning}>
              <span style={styles.headerDot} />
              {cancelling ? "Stopping..." : "Agent working..."}
              {loading && !cancelling && (
                <button style={styles.stopButtonSmall} onClick={handleStop} title="Stop agent">
                  Stop
                </button>
              )}
            </div>
          )}
          {!loading && messages.length > 1 && (
            <button style={styles.startOverButton} onClick={handleStartOver} title="Start a new review">
              Start Over
            </button>
          )}
        </header>

        <div style={styles.chatContainer}>
          <div style={styles.messagesArea}>
            {messages.map((msg, i) => (
              <ChatMessage key={i} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div style={styles.inputArea}>
          {messages.length <= 1 && !loading && (
            <div style={styles.quickActions}>
              <button
                style={styles.quickActionBtn}
                onClick={() => {
                  handleSend("List all available projects and give me a summary of each control.");
                }}
              >
                List Projects
              </button>
              <button
                style={styles.quickActionBtn}
                onClick={() => {
                  handleSend(
                    "Run the full controls evidence review for ALL 6 projects. " +
                    "For each project: load the engagement, parse the workbook, " +
                    "review evidence (including any embedded images), execute tests, " +
                    "compile results, save the report, and email if configured."
                  );
                }}
              >
                Run All Reviews
              </button>
              {projects.slice(0, 6).map((proj) => (
                <button
                  key={proj.project_dir}
                  style={{
                    ...styles.quickActionBtnSecondary,
                    borderColor: DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
                    color: DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
                  }}
                  onClick={() => handleProjectSelect(proj)}
                >
                  {proj.control_id || proj.project_dir}
                </button>
              ))}
            </div>
          )}
          <FileUpload onUpload={handleFileUpload} />
          <div style={styles.inputRow}>
            <textarea
              style={styles.textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent to review controls, execute tests, or generate a report..."
              rows={1}
              disabled={loading}
            />
            {loading ? (
              <button
                style={styles.stopButton}
                onClick={handleStop}
                disabled={cancelling}
              >
                {cancelling ? "Stopping..." : "Stop"}
              </button>
            ) : (
              <button
                style={{
                  ...styles.sendButton,
                  opacity: !input.trim() ? 0.5 : 1,
                }}
                onClick={() => handleSend()}
                disabled={!input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </main>

      {/* Right Panel: Execution Trace */}
      {showPanel && (
        <ExecutionPanel
          project={selectedProjectInfo}
          steps={activeSteps}
          currentStep={liveCurrentStep}
          elapsed={liveElapsed}
          isRunning={loading}
          isComplete={runComplete}
          runId={currentRunId}
          projectDir={currentProjectDir || selectedProject || ""}
          onRerunTest={handleRerunTest}
          onReviewEvidence={handleReviewEvidence}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    height: "100vh",
    overflow: "hidden",
  },
  sidebar: {
    width: 260,
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
  statusIndicator: {
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
    marginBottom: 3,
  },
  evidenceRow: {
    display: "flex",
    gap: 4,
    marginTop: 3,
  },
  evidenceChip: {
    fontSize: 7,
    fontWeight: 700,
    padding: "1px 4px",
    borderRadius: 3,
    border: "1px solid",
    letterSpacing: 0.3,
  },
  uploadSection: {
    padding: "10px 14px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 0",
    fontSize: 11,
    opacity: 0.7,
  },
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sidebarFooter: {
    padding: "10px 18px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    textAlign: "center" as const,
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: 0,
  },
  header: {
    padding: "12px 24px",
    background: "#fff",
    borderBottom: "1px solid #e5e7eb",
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#111827",
  },
  headerBadge: {
    background: "#f36f21",
    color: "#fff",
    padding: "2px 10px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 700,
  },
  headerRunning: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#ea580c",
    fontWeight: 500,
  },
  headerDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#f36f21",
    animation: "pulse 1.5s infinite",
  },
  chatContainer: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
  },
  messagesArea: {
    flex: 1,
    overflow: "auto",
    padding: "20px 24px",
  },
  inputArea: {
    padding: "10px 24px 14px",
    background: "#fff",
    borderTop: "1px solid #e5e7eb",
    flexShrink: 0,
  },
  inputRow: {
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  textarea: {
    flex: 1,
    padding: "10px 14px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 14,
    resize: "none" as const,
    fontFamily: "inherit",
    outline: "none",
    minHeight: 42,
    maxHeight: 120,
  },
  sendButton: {
    padding: "10px 20px",
    background: "#f36f21",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  stopButton: {
    padding: "10px 20px",
    background: "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  stopButtonSmall: {
    padding: "2px 10px",
    marginLeft: 8,
    background: "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  startOverButton: {
    padding: "6px 14px",
    background: "#fff",
    color: "#6b7280",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.15s",
  },
  quickActions: {
    display: "flex",
    gap: 6,
    marginBottom: 10,
    flexWrap: "wrap" as const,
  },
  quickActionBtn: {
    padding: "7px 14px",
    background: "#f36f21",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  quickActionBtnSecondary: {
    padding: "6px 12px",
    background: "#fff",
    border: "1px solid",
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
};
