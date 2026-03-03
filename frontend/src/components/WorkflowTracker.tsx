import React from "react";

export interface WorkflowStep {
  id: string;
  label: string;
  icon: string;
  status: "pending" | "active" | "complete" | "error";
  detail?: string;
}

const DEFAULT_STEPS: WorkflowStep[] = [
  { id: "discover", label: "Discover Projects", icon: "1", status: "pending" },
  { id: "engagement", label: "Load Engagement", icon: "2", status: "pending" },
  { id: "workbook", label: "Parse Workbook", icon: "3", status: "pending" },
  { id: "evidence", label: "Review Evidence", icon: "4", status: "pending" },
  { id: "tests", label: "Execute Tests", icon: "5", status: "pending" },
  { id: "compile", label: "Compile Report", icon: "6", status: "pending" },
  { id: "deliver", label: "Save & Deliver", icon: "7", status: "pending" },
];

interface Props {
  steps?: WorkflowStep[];
  compact?: boolean;
}

export default function WorkflowTracker({ steps, compact }: Props) {
  const workflow = steps || DEFAULT_STEPS;

  return (
    <div style={compact ? styles.containerCompact : styles.container}>
      {!compact && (
        <div style={styles.title}>Agent Workflow</div>
      )}
      <div style={compact ? styles.stepsRowCompact : styles.stepsRow}>
        {workflow.map((step, i) => (
          <React.Fragment key={step.id}>
            <div style={styles.stepItem}>
              <div
                style={{
                  ...styles.stepCircle,
                  ...(step.status === "complete" ? styles.stepComplete : {}),
                  ...(step.status === "active" ? styles.stepActive : {}),
                  ...(step.status === "error" ? styles.stepError : {}),
                }}
              >
                {step.status === "complete" ? (
                  <span style={styles.checkmark}>&#10003;</span>
                ) : step.status === "active" ? (
                  <span style={styles.pulse} />
                ) : step.status === "error" ? (
                  <span style={styles.errorX}>!</span>
                ) : (
                  <span style={styles.stepNumber}>{step.icon}</span>
                )}
              </div>
              <div style={styles.stepLabel}>{step.label}</div>
              {step.detail && (
                <div style={styles.stepDetail}>{step.detail}</div>
              )}
            </div>
            {i < workflow.length - 1 && (
              <div
                style={{
                  ...styles.connector,
                  ...(step.status === "complete"
                    ? styles.connectorDone
                    : step.status === "active"
                      ? styles.connectorActive
                      : {}),
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export { DEFAULT_STEPS };

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "16px 20px 12px",
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
  },
  containerCompact: {
    padding: "8px 20px",
    background: "rgba(255,255,255,0.95)",
  },
  title: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#888",
    marginBottom: 12,
  },
  stepsRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 0,
  },
  stepsRowCompact: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  },
  stepItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: 90,
    position: "relative",
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "#f0f0f0",
    border: "2px solid #ddd",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.3s",
    position: "relative",
  },
  stepComplete: {
    background: "#28a745",
    borderColor: "#28a745",
  },
  stepActive: {
    background: "#fff",
    borderColor: "#f36f21",
    boxShadow: "0 0 0 4px rgba(243,111,33,0.2)",
  },
  stepError: {
    background: "#dc3545",
    borderColor: "#dc3545",
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: 700,
    color: "#999",
  },
  checkmark: {
    color: "#fff",
    fontSize: 14,
    fontWeight: 700,
  },
  errorX: {
    color: "#fff",
    fontSize: 14,
    fontWeight: 700,
  },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#f36f21",
    animation: "pulse 1.2s infinite",
  },
  stepLabel: {
    fontSize: 10,
    fontWeight: 500,
    color: "#555",
    marginTop: 6,
    textAlign: "center",
    lineHeight: 1.2,
  },
  stepDetail: {
    fontSize: 9,
    color: "#999",
    marginTop: 2,
    textAlign: "center",
  },
  connector: {
    width: 30,
    height: 2,
    background: "#e0e0e0",
    marginTop: 16,
    flexShrink: 0,
    transition: "all 0.3s",
  },
  connectorDone: {
    background: "#28a745",
  },
  connectorActive: {
    background: "linear-gradient(90deg, #28a745, #f36f21)",
  },
};
