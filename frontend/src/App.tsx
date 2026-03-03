import React, { useState, useRef, useEffect, useCallback } from "react";
import { sendMessage, uploadFile, listProjects, AgentMessage, UploadResult, ProjectInfo } from "./api";
import ChatMessage from "./components/ChatMessage";
import FileUpload from "./components/FileUpload";
import TestResultsPanel from "./components/TestResultsPanel";
import WorkflowTracker, { WorkflowStep, DEFAULT_STEPS } from "./components/WorkflowTracker";

const INITIAL_MESSAGE: AgentMessage = {
  role: "assistant",
  content:
    "Welcome to the **GSK Controls Evidence Review Agent** (v3.1).\n\n" +
    "I can test **any control type** across 6 domains: Accounts Payable, IT General Controls, " +
    "Financial Reporting, HR Controls, Revenue Controls, and Environmental Health & Safety.\n\n" +
    "**How I work:**\n" +
    "1. Load the engagement instructions\n" +
    "2. Parse the workbook (including embedded images)\n" +
    "3. Review all evidence (PDFs, screenshots, emails)\n" +
    "4. Execute each testing attribute\n" +
    "5. Compile the final report\n" +
    "6. Save and optionally email the results\n\n" +
    "Select a project from the sidebar, or ask me to run all 6 controls.",
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

export default function App() {
  const [messages, setMessages] = useState<AgentMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>(
    DEFAULT_STEPS.map((s) => ({ ...s }))
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  const inferWorkflowStep = useCallback((text: string) => {
    setWorkflowSteps((prev) => {
      const next = prev.map((s) => ({ ...s }));
      const markComplete = (id: string) => {
        const s = next.find((x) => x.id === id);
        if (s && s.status !== "complete") s.status = "complete";
      };
      const markActive = (id: string, detail?: string) => {
        const s = next.find((x) => x.id === id);
        if (s && s.status !== "complete") {
          s.status = "active";
          if (detail) s.detail = detail;
        }
      };

      const lower = text.toLowerCase();

      if (lower.includes("project") && (lower.includes("found") || lower.includes("available"))) {
        markComplete("discover");
      }
      if (lower.includes("engagement") && (lower.includes("loaded") || lower.includes("control_id"))) {
        markComplete("discover");
        markComplete("engagement");
      }
      if (lower.includes("workbook") && (lower.includes("parsed") || lower.includes("tab_names") || lower.includes("population"))) {
        markComplete("discover");
        markComplete("engagement");
        markComplete("workbook");
      }
      if (lower.includes("embedded") && lower.includes("image")) {
        markComplete("workbook");
        markActive("evidence", "Embedded images");
      }
      if (lower.includes("review") && (lower.includes("pdf") || lower.includes("screenshot") || lower.includes("email") || lower.includes("document"))) {
        markComplete("workbook");
        markActive("evidence");
      }
      if (lower.includes("evidence") && lower.includes("reviewed")) {
        markComplete("evidence");
      }
      if (lower.includes("test") && (lower.includes("executing") || lower.includes("attribute"))) {
        markComplete("evidence");
        markActive("tests");
      }
      if (lower.includes("test") && lower.includes("complete")) {
        markComplete("tests");
      }
      if (lower.includes("report") && (lower.includes("compil") || lower.includes("generat"))) {
        markComplete("tests");
        markActive("compile");
      }
      if (lower.includes("executive summary") || lower.includes("overall control assessment")) {
        markComplete("compile");
      }
      if (lower.includes("saved") || lower.includes("report_") || lower.includes("email") && lower.includes("sent")) {
        markComplete("compile");
        markComplete("deliver");
      }

      return next;
    });
  }, []);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last !== INITIAL_MESSAGE) {
      inferWorkflowStep(last.content);
    }
  }, [messages, inferWorkflowStep]);

  const resetWorkflow = () => {
    setWorkflowSteps(DEFAULT_STEPS.map((s) => ({ ...s })));
  };

  const handleSend = async (overrideInput?: string) => {
    const text = overrideInput || input;
    if (!text.trim() || loading) return;

    const userMsg: AgentMessage = { role: "user", content: text };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setInput("");
    setLoading(true);

    try {
      const response = await sendMessage(
        allMessages.filter((m) => m !== INITIAL_MESSAGE)
      );
      setMessages((prev) => [...prev, response]);

      if (
        response.content.includes("## Results Summary") ||
        response.content.includes("## Executive Summary") ||
        response.content.includes("## 1. Executive Summary")
      ) {
        setShowResults(true);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}. Please check the backend is running.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
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

  const handleProjectSelect = (proj: ProjectInfo) => {
    setSelectedProject(proj.project_dir);
    resetWorkflow();
    handleSend(
      `Run the full controls evidence review for project "${proj.project_dir}" ` +
      `(Control ${proj.control_id}: ${proj.control_name}). ` +
      `Load the engagement, parse the workbook, review all evidence documents, ` +
      `execute all applicable tests, compile the results, save the report, ` +
      `and email the report if notification_emails is configured.`
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activeStepCount = workflowSteps.filter((s) => s.status === "complete").length;
  const workflowActive = activeStepCount > 0 && activeStepCount < 7;

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <span style={styles.logoText}>GSK</span>
          <span style={styles.logoSub}>FRMC</span>
        </div>

        <nav style={styles.nav}>
          <div style={{ ...styles.navItem, ...styles.navItemActive }}>
            Controls Testing
          </div>
          <div style={styles.navItem}>Control History</div>
          <div style={styles.navItem}>Policy Reference</div>
        </nav>

        <div style={styles.projectSection}>
          <h4 style={styles.sectionTitle}>
            Projects ({projects.length})
          </h4>
          {projects.length === 0 && (
            <div style={styles.emptyText}>Loading projects...</div>
          )}
          {projects.map((proj) => {
            const evidenceTypes = getProjectEvidenceTypes(proj);
            return (
              <div
                key={proj.project_dir}
                style={{
                  ...styles.projectCard,
                  ...(selectedProject === proj.project_dir
                    ? styles.projectCardActive
                    : {}),
                }}
                onClick={() => handleProjectSelect(proj)}
              >
                <div style={styles.projectHeader}>
                  <span
                    style={{
                      ...styles.controlBadge,
                      background:
                        DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
                    }}
                  >
                    {proj.control_id || proj.project_dir}
                  </span>
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
          <span style={{ fontSize: 11, opacity: 0.5 }}>
            v3.1 — Powered by Databricks
          </span>
        </div>
      </aside>

      {/* Main chat area */}
      <main style={styles.main}>
        <header style={styles.header}>
          <h1 style={styles.headerTitle}>Controls Evidence Review</h1>
          {selectedProject && (
            <div style={styles.headerBadge}>
              {projects.find((p) => p.project_dir === selectedProject)
                ?.control_id || selectedProject}
            </div>
          )}
          {!selectedProject && (
            <div style={{ ...styles.headerBadge, background: "#6b7280" }}>
              Multi-Control
            </div>
          )}
          <div style={{ flex: 1 }} />
          {showResults && (
            <button
              style={styles.resultsToggle}
              onClick={() => setShowResults(!showResults)}
            >
              {showResults ? "Hide" : "Show"} Results
            </button>
          )}
        </header>

        {/* Workflow tracker */}
        {(workflowActive || loading) && (
          <WorkflowTracker steps={workflowSteps} />
        )}

        <div style={styles.chatContainer}>
          <div style={styles.messagesArea}>
            {messages.map((msg, i) => (
              <ChatMessage key={i} message={msg} />
            ))}
            {loading && (
              <div style={styles.loadingIndicator}>
                <div style={styles.dot} />
                <div style={{ ...styles.dot, animationDelay: "0.2s" }} />
                <div style={{ ...styles.dot, animationDelay: "0.4s" }} />
                <span style={{ marginLeft: 8, color: "#888", fontSize: 13 }}>
                  Agent is processing...
                </span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {showResults && (
            <TestResultsPanel
              messages={messages}
              onClose={() => setShowResults(false)}
            />
          )}
        </div>

        <div style={styles.inputArea}>
          {messages.length <= 1 && !loading && (
            <div style={styles.quickActions}>
              <button
                style={styles.quickActionBtn}
                onClick={() => {
                  resetWorkflow();
                  handleSend(
                    "List all available projects and give me a summary of each control."
                  );
                }}
              >
                List Projects
              </button>
              <button
                style={styles.quickActionBtn}
                onClick={() => {
                  resetWorkflow();
                  handleSend(
                    "Run the full controls evidence review for ALL 6 projects. " +
                    "For each project: load the engagement, parse the workbook, " +
                    "review evidence (including any embedded images), execute tests, " +
                    "compile results, save the report, and email if configured."
                  );
                }}
              >
                Run All 6 Reviews
              </button>
              {projects.slice(0, 6).map((proj) => (
                <button
                  key={proj.project_dir}
                  style={{
                    ...styles.quickActionBtn,
                    ...styles.quickActionBtnSecondary,
                    borderColor:
                      DOMAIN_COLORS[proj.domain || ""] || "#6b7280",
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
            <button
              style={{
                ...styles.sendButton,
                opacity: loading || !input.trim() ? 0.5 : 1,
              }}
              onClick={() => handleSend()}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </main>
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
    width: 280,
    background: "#1a1a2e",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
  },
  logo: {
    padding: "20px 20px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
  },
  logoText: {
    fontSize: 28,
    fontWeight: 800,
    color: "#f36f21",
    letterSpacing: 2,
  },
  logoSub: {
    fontSize: 14,
    fontWeight: 400,
    opacity: 0.7,
  },
  nav: {
    padding: "16px 0",
  },
  navItem: {
    padding: "10px 20px",
    fontSize: 13,
    cursor: "pointer",
    opacity: 0.6,
    transition: "all 0.15s",
  },
  navItemActive: {
    opacity: 1,
    background: "rgba(243,111,33,0.15)",
    borderLeft: "3px solid #f36f21",
    fontWeight: 600,
  },
  projectSection: {
    padding: "12px 16px",
    flex: 1,
    overflow: "auto",
  },
  sectionTitle: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    opacity: 0.5,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 12,
    opacity: 0.4,
    fontStyle: "italic",
  },
  projectCard: {
    padding: "10px 12px",
    marginBottom: 8,
    borderRadius: 8,
    background: "rgba(255,255,255,0.05)",
    cursor: "pointer",
    transition: "all 0.15s",
    border: "1px solid transparent",
  },
  projectCardActive: {
    background: "rgba(243,111,33,0.15)",
    border: "1px solid rgba(243,111,33,0.4)",
  },
  projectHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  controlBadge: {
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: 0.5,
  },
  projectName: {
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1.3,
    marginBottom: 2,
  },
  projectDomain: {
    fontSize: 10,
    opacity: 0.5,
    marginBottom: 4,
  },
  evidenceRow: {
    display: "flex",
    gap: 4,
    marginTop: 4,
  },
  evidenceChip: {
    fontSize: 8,
    fontWeight: 700,
    padding: "1px 5px",
    borderRadius: 3,
    border: "1px solid",
    letterSpacing: 0.3,
  },
  uploadSection: {
    padding: "12px 16px",
    borderTop: "1px solid rgba(255,255,255,0.1)",
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 0",
    fontSize: 12,
    opacity: 0.8,
  },
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sidebarFooter: {
    padding: "12px 20px",
    borderTop: "1px solid rgba(255,255,255,0.1)",
    textAlign: "center" as const,
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "14px 24px",
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1a1a2e",
  },
  headerBadge: {
    background: "#f36f21",
    color: "#fff",
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
  },
  resultsToggle: {
    background: "none",
    border: "1px solid #ddd",
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
    color: "#555",
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
  loadingIndicator: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#f36f21",
    marginRight: 4,
    animation: "pulse 1.2s infinite",
  },
  inputArea: {
    padding: "12px 24px 16px",
    background: "#fff",
    borderTop: "1px solid #e0e0e0",
  },
  inputRow: {
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  textarea: {
    flex: 1,
    padding: "10px 14px",
    border: "1px solid #ddd",
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
  quickActions: {
    display: "flex",
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap" as const,
  },
  quickActionBtn: {
    padding: "8px 16px",
    background: "#f36f21",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  quickActionBtnSecondary: {
    background: "#fff",
    color: "#f36f21",
    border: "1px solid #f36f21",
  },
};
