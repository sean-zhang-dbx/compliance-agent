import React from "react";
import type { AgentMessage } from "../api";

interface Props {
  messages: AgentMessage[];
  onClose: () => void;
}

interface TestResult {
  ref: string;
  attribute: string;
  result: "Pass" | "Fail" | "Partial" | "N/A" | "Pending";
  severity: string;
}

function extractResults(messages: AgentMessage[]): {
  results: TestResult[];
  controlId: string;
  controlName: string;
  assessment: string;
} {
  const allText = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n");

  const results: TestResult[] = [];
  const seen = new Set<string>();

  const patterns = [
    /\|\s*([A-Z])\s*\|[^|]*\|\s*\*{0,2}(Pass|Fail|Partial|N\/A)\*{0,2}\s*\|/gi,
    /Attribute\s+([A-Z])[\s:]*.*?(Pass|Fail|Partial)/gi,
    /\b([A-Z])\b[:\s]+.{5,60}?(Pass|Fail|Partial)/gi,
  ];

  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(allText)) !== null) {
      const ref = match[1].toUpperCase();
      if (!seen.has(ref)) {
        seen.add(ref);
        const resultStr = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
        results.push({
          ref,
          attribute: "",
          result: resultStr as TestResult["result"],
          severity: "-",
        });
      }
    }
  }

  const sevPatterns = [
    /\|\s*([A-Z])\s*\|[^|]*\|[^|]*\|\s*(Critical|High|Medium|Low)\s*\|/gi,
    /([A-Z])[^a-z\n]{0,80}(Critical|High|Medium|Low)/gi,
  ];
  for (const pat of sevPatterns) {
    let match;
    while ((match = pat.exec(allText)) !== null) {
      const ref = match[1].toUpperCase();
      const r = results.find((r) => r.ref === ref);
      if (r) r.severity = match[2];
    }
  }

  results.sort((a, b) => a.ref.localeCompare(b.ref));

  const ctrlMatch = allText.match(/([A-Z]+-\d+)\s*[-–]\s*(.+?)(?:\n|$)/);
  const controlId = ctrlMatch ? ctrlMatch[1] : "";
  const controlName = ctrlMatch ? ctrlMatch[2].trim() : "";

  let assessment = "";
  const assessMatch = allText.match(
    /\*\*(Effective|Effective with Exceptions|Ineffective)\*\*/i
  );
  if (assessMatch) assessment = assessMatch[1];

  return { results, controlId, controlName, assessment };
}

export default function TestResultsPanel({ messages, onClose }: Props) {
  const { results, controlId, assessment } = extractResults(messages);
  const passCount = results.filter((r) => r.result === "Pass").length;
  const failCount = results.filter((r) => r.result === "Fail").length;
  const partialCount = results.filter(
    (r) => r.result === "Partial" || r.result === "N/A"
  ).length;

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>
        <div>
          <h3 style={styles.panelTitle}>Test Results</h3>
          {controlId && (
            <span style={styles.controlBadge}>{controlId}</span>
          )}
        </div>
        <button style={styles.closeBtn} onClick={onClose}>
          &times;
        </button>
      </div>

      {assessment && (
        <div
          style={{
            ...styles.assessment,
            background: assessment.includes("Ineffective")
              ? "#fce4ec"
              : assessment.includes("Exception")
                ? "#fff8e1"
                : "#e8f5e9",
            color: assessment.includes("Ineffective")
              ? "#dc3545"
              : assessment.includes("Exception")
                ? "#b8860b"
                : "#28a745",
          }}
        >
          {assessment}
        </div>
      )}

      <div style={styles.summary}>
        <div style={{ ...styles.summaryItem, background: "#e8f5e9" }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: "#28a745" }}>
            {passCount}
          </span>
          <span style={{ fontSize: 11, color: "#28a745" }}>Pass</span>
        </div>
        <div style={{ ...styles.summaryItem, background: "#fce4ec" }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: "#dc3545" }}>
            {failCount}
          </span>
          <span style={{ fontSize: 11, color: "#dc3545" }}>Fail</span>
        </div>
        <div style={{ ...styles.summaryItem, background: "#fff8e1" }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: "#e69500" }}>
            {partialCount}
          </span>
          <span style={{ fontSize: 11, color: "#e69500" }}>Other</span>
        </div>
      </div>

      {results.length > 0 ? (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Ref</th>
              <th style={styles.th}>Result</th>
              <th style={styles.th}>Severity</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.ref}>
                <td style={styles.td}>
                  <strong>{r.ref}</strong>
                </td>
                <td style={styles.td}>
                  <span
                    style={{
                      ...styles.badge,
                      background:
                        r.result === "Pass"
                          ? "#28a745"
                          : r.result === "Fail"
                            ? "#dc3545"
                            : r.result === "Partial"
                              ? "#e69500"
                              : "#aaa",
                    }}
                  >
                    {r.result}
                  </span>
                </td>
                <td style={{ ...styles.td, fontSize: 11 }}>{r.severity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={styles.emptyState}>
          Results will appear here as the agent completes testing.
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 280,
    background: "#fff",
    borderLeft: "1px solid #e0e0e0",
    overflow: "auto",
    flexShrink: 0,
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
  },
  panelTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1a1a2e",
    marginBottom: 2,
  },
  controlBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: "#f36f21",
  },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 20,
    cursor: "pointer",
    color: "#888",
    lineHeight: 1,
  },
  assessment: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 700,
    textAlign: "center",
  },
  summary: {
    display: "flex",
    gap: 8,
    padding: "12px 16px",
  },
  summaryItem: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "8px 4px",
    borderRadius: 8,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: {
    background: "#f5f5f5",
    padding: "6px 10px",
    textAlign: "left",
    fontWeight: 600,
    fontSize: 11,
    borderBottom: "1px solid #e0e0e0",
  },
  td: {
    padding: "6px 10px",
    borderBottom: "1px solid #f0f0f0",
  },
  badge: {
    color: "#fff",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 700,
    display: "inline-block",
  },
  emptyState: {
    padding: "24px 16px",
    textAlign: "center",
    fontSize: 12,
    color: "#999",
    fontStyle: "italic",
  },
};
