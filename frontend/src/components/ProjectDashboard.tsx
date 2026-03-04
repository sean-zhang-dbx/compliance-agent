import { useState, useEffect } from "react";
import type { ProjectInfo, RunInfo, Engagement } from "../api";
import { listRuns, fetchEngagement } from "../api";

const DOMAIN_COLORS: Record<string, string> = {
  "Accounts Payable": "#2563eb",
  "IT General Controls": "#7c3aed",
  "Financial Reporting": "#059669",
  "HR / IT Controls": "#d97706",
  "Revenue / Financial Reporting": "#dc2626",
  "Environmental Health & Safety": "#0891b2",
  "Inventory Management": "#7c3aed",
};

interface Props {
  project: ProjectInfo;
  onRunAssessment: () => void;
  onViewRun: (run: RunInfo) => void;
  onContinueRun: (run: RunInfo) => void;
}

export default function ProjectDashboard({ project, onRunAssessment, onViewRun, onContinueRun }: Props) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);

  useEffect(() => {
    setLoadingRuns(true);
    setRuns([]);
    setEngagement(null);
    listRuns(project.project_dir).then((r) => {
      setRuns(r);
      setLoadingRuns(false);
    });
    fetchEngagement(project.project_dir).then((e) => e && setEngagement(e));
  }, [project.project_dir]);

  const domainColor = DOMAIN_COLORS[project.domain || ""] || "#6b7280";
  const evidenceCount = engagement?.evidence_files?.length ?? 0;
  const attrCount = engagement?.testing_attributes?.length ?? 0;

  return (
    <div style={S.container}>
      <div style={S.inner}>
        {/* Header */}
        <div style={S.header}>
          <span style={{ ...S.badge, background: domainColor }}>
            {project.control_id || project.project_dir}
          </span>
          <div style={S.headerRight}>
            <span style={S.domainLabel}>{project.domain}</span>
          </div>
        </div>

        <h1 style={S.title}>{project.control_name || project.project_dir}</h1>

        {engagement && (
          <div style={S.metaRow}>
            {engagement.number && (
              <span style={S.metaChip}>Engagement: {engagement.number}</span>
            )}
            {evidenceCount > 0 && (
              <span style={S.metaChip}>{evidenceCount} evidence file{evidenceCount !== 1 ? "s" : ""}</span>
            )}
            {attrCount > 0 && (
              <span style={S.metaChip}>{attrCount} testing attribute{attrCount !== 1 ? "s" : ""}</span>
            )}
          </div>
        )}

        {/* Run New Assessment CTA */}
        <button style={S.runBtn} onClick={onRunAssessment}>
          Run New Assessment
        </button>

        {/* Past Runs */}
        <div style={S.section}>
          <h3 style={S.sectionTitle}>
            Run History {!loadingRuns && `(${runs.length})`}
          </h3>

          {loadingRuns && (
            <div style={S.emptyText}>Loading run history...</div>
          )}

          {!loadingRuns && runs.length === 0 && (
            <div style={S.emptyState}>
              <div style={S.emptyIcon}>📋</div>
              <div style={S.emptyHeading}>No runs yet</div>
              <div style={S.emptyDetail}>
                Click "Run New Assessment" to start the first automated review for this project.
              </div>
            </div>
          )}

          {runs.map((run) => {
            const d = run.started_at ? new Date(run.started_at) : null;
            const statusColor =
              run.status === "completed" ? "#059669"
              : run.status === "error" ? "#dc2626"
              : run.status === "cancelled" ? "#d97706"
              : "#6b7280";
            return (
              <div
                key={run.run_id}
                style={S.runCard}
                onClick={() => onViewRun(run)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = "#d1d5db";
                  (e.currentTarget as HTMLDivElement).style.background = "#fafafa";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = "#e5e7eb";
                  (e.currentTarget as HTMLDivElement).style.background = "#fff";
                }}
              >
                <div style={S.runCardTop}>
                  <div style={S.runIdRow}>
                    <span style={{ ...S.runStatusDot, background: statusColor }} />
                    <span style={S.runId}>{run.run_id}</span>
                  </div>
                  <span style={{ ...S.runStatusBadge, color: statusColor, background: statusColor + "14" }}>
                    {run.status || "unknown"}
                  </span>
                </div>
                <div style={S.runCardBottom}>
                  {d && (
                    <span style={S.runDate}>
                      {d.toLocaleDateString()} {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                  {run.total_steps != null && (
                    <span style={S.runSteps}>{run.total_steps} steps</span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                    {(run.status === "cancelled" || run.status === "stopped") && (
                      <button
                        style={S.continueBtn}
                        onClick={(e) => { e.stopPropagation(); onContinueRun(run); }}
                      >
                        Continue ▶
                      </button>
                    )}
                    <span style={S.viewLink}>View details →</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: "auto",
    background: "#f3f4f6",
  },
  inner: {
    maxWidth: 720,
    margin: "0 auto",
    padding: "40px 32px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  badge: {
    padding: "4px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: 0.5,
  },
  domainLabel: {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: 500,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: "#111827",
    margin: "0 0 12px 0",
    lineHeight: 1.3,
  },
  metaRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
    marginBottom: 24,
  },
  metaChip: {
    fontSize: 11,
    fontWeight: 500,
    color: "#374151",
    background: "#e5e7eb",
    padding: "3px 10px",
    borderRadius: 12,
  },
  runBtn: {
    padding: "12px 28px",
    background: "#f36f21",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: 0.3,
    boxShadow: "0 2px 8px rgba(243,111,33,0.25)",
    marginBottom: 32,
    transition: "transform 0.15s",
  },
  section: {},
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 0.8,
  },
  emptyText: {
    fontSize: 13,
    color: "#9ca3af",
    fontStyle: "italic",
  },
  emptyState: {
    textAlign: "center" as const,
    padding: "32px 16px",
    background: "#fff",
    borderRadius: 12,
    border: "1px dashed #d1d5db",
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  emptyHeading: {
    fontSize: 15,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 4,
  },
  emptyDetail: {
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 1.5,
  },
  runCard: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "14px 18px",
    marginBottom: 8,
    cursor: "pointer",
    transition: "all 0.15s",
  },
  runCardTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  runIdRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  runStatusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  runId: {
    fontSize: 13,
    fontWeight: 600,
    color: "#111827",
    fontFamily: "monospace",
  },
  runStatusBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 10px",
    borderRadius: 10,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  runCardBottom: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  runDate: {
    fontSize: 12,
    color: "#6b7280",
  },
  runSteps: {
    fontSize: 12,
    color: "#6b7280",
  },
  continueBtn: {
    padding: "4px 14px",
    background: "#f36f21",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    transition: "opacity 0.15s",
  },
  viewLink: {
    fontSize: 12,
    fontWeight: 600,
    color: "#f36f21",
  },
};
