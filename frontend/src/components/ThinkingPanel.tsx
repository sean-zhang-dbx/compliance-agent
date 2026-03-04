import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { ThinkingEntry, AgentPlan, PlanStep, ToolStep } from "../api";

export interface TimelineEntry {
  type: "user" | "thinking";
  content: string;
  timestamp: number;
}

interface ThinkingPanelProps {
  thinking: ThinkingEntry[];
  plan: AgentPlan | null;
  isRunning: boolean;
  isComplete: boolean;
  steps: ToolStep[];
  onSendMessage?: (text: string) => void;
  disabled?: boolean;
  userMessages?: TimelineEntry[];
}

function StatusIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "complete") {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 22, borderRadius: "50%",
        background: "#4caf50", color: "#fff", fontSize: 13, flexShrink: 0,
      }}>
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="plan-spinner" style={{
        display: "inline-block", width: 22, height: 22,
        border: "3px solid rgba(255,255,255,0.15)",
        borderTopColor: "#f59e0b",
        borderRadius: "50%", flexShrink: 0,
      }} />
    );
  }
  return (
    <span style={{
      display: "inline-block", width: 22, height: 22,
      border: "2px solid rgba(255,255,255,0.2)",
      borderRadius: "50%", flexShrink: 0,
    }} />
  );
}

function PlanChecklist({ plan, isRunning }: { plan: AgentPlan; isRunning: boolean }) {
  return (
    <div style={{ padding: "0 16px 12px" }}>
      <div style={{
        fontSize: 11, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.08em", color: "rgba(255,255,255,0.45)",
        marginBottom: 10,
      }}>
        Assessment Plan
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {plan.steps.map((step, i) => (
          <div key={step.id} style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "8px 10px", borderRadius: 8,
            background: step.status === "in_progress"
              ? "rgba(245,158,11,0.10)"
              : step.status === "complete"
                ? "rgba(76,175,80,0.08)"
                : "transparent",
            transition: "background 0.3s ease",
          }}>
            <div style={{ paddingTop: 1 }}>
              <StatusIcon status={step.status} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 500,
                color: step.status === "complete"
                  ? "rgba(255,255,255,0.55)"
                  : "rgba(255,255,255,0.9)",
                textDecoration: step.status === "complete" ? "line-through" : "none",
                transition: "color 0.3s ease, text-decoration 0.3s ease",
              }}>
                <span style={{ color: "rgba(255,255,255,0.35)", marginRight: 6, fontSize: 11 }}>
                  {i + 1}.
                </span>
                {step.label}
              </div>
              {step.detail && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                  {step.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {isRunning && plan.steps.every(s => s.status === "complete") && (
        <div style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 8,
          background: "rgba(76,175,80,0.12)", textAlign: "center",
          fontSize: 12, color: "#4caf50", fontWeight: 600,
        }}>
          All phases complete
        </div>
      )}
    </div>
  );
}

function buildTimeline(
  thinkingEntries: ThinkingEntry[],
  userMessages: TimelineEntry[],
): TimelineEntry[] {
  const items: TimelineEntry[] = [
    ...thinkingEntries.map((e) => ({ type: "thinking" as const, content: e.content, timestamp: e.timestamp })),
    ...userMessages,
  ];
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function buildSuggestions(steps: ToolStep[]): string[] {
  const suggestions: string[] = [];
  const failedRefs: string[] = [];
  const partialRefs: string[] = [];
  for (const s of steps) {
    if (s.tool === "execute_test" || s.tool === "batch_execute_tests") {
      const summary = s.result_summary || "";
      const refMatch = summary.match(/\[([A-Z]+)\]/);
      if (/^Fail/i.test(summary) && refMatch) failedRefs.push(refMatch[1]);
      if (/^Partial|^N\/A/i.test(summary) && refMatch) partialRefs.push(refMatch[1]);
    }
  }
  if (failedRefs.length > 0) {
    suggestions.push(`Re-run failed test attribute ${failedRefs[0]}`);
  }
  if (partialRefs.length > 0) {
    suggestions.push(`Explain why attribute ${partialRefs[0]} was marked Partial`);
  }
  const hasReport = steps.some(s => s.tool === "compile_results" && s.status === "complete");
  const hasEmail = steps.some(s => s.tool === "send_email" && s.status === "complete");
  if (hasReport && !hasEmail) {
    suggestions.push("Email the report to the team");
  }
  if (suggestions.length === 0 && hasReport) {
    suggestions.push("Summarize the key findings");
  }
  return suggestions.slice(0, 3);
}

function ConversationLog({
  thinkingEntries,
  userMessages,
  isRunning,
  isComplete,
  steps,
  onSendMessage,
  disabled,
}: {
  thinkingEntries: ThinkingEntry[];
  userMessages: TimelineEntry[];
  isRunning: boolean;
  isComplete: boolean;
  steps: ToolStep[];
  onSendMessage?: (text: string) => void;
  disabled?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const timeline = buildTimeline(thinkingEntries, userMessages);
  const suggestions = isComplete && !isRunning ? buildSuggestions(steps) : [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  const handleSubmit = () => {
    if (!input.trim() || disabled) return;
    onSendMessage?.(input);
    setInput("");
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{
        flex: 1, overflowY: "auto", padding: "0 16px 16px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, textTransform: "uppercase",
          letterSpacing: "0.08em", color: "rgba(255,255,255,0.45)",
          marginBottom: 4, position: "sticky", top: 0, zIndex: 1,
          background: "#1a1a2e", paddingTop: 8, paddingBottom: 4,
        }}>
          Conversation
        </div>
        {timeline.length === 0 && !isRunning && (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>
            Start a run or ask the agent a question.
          </div>
        )}
        {timeline.map((entry, i) => {
          const d = new Date(entry.timestamp * 1000);
          const ts = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

          if (entry.type === "user") {
            return (
              <div key={`u-${i}`} style={{
                display: "flex", justifyContent: "flex-end",
                animation: "fadeSlideIn 0.3s ease",
              }}>
                <div style={{
                  maxWidth: "85%", padding: "8px 12px", borderRadius: "12px 12px 4px 12px",
                  background: "rgba(243,111,33,0.2)", border: "1px solid rgba(243,111,33,0.3)",
                }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 3, textAlign: "right" as const }}>
                    You · {ts}
                  </div>
                  <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.9)", lineHeight: 1.5 }}>
                    {entry.content.length > 200 ? entry.content.slice(0, 200) + "..." : entry.content}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={`t-${i}`} className="thinking-entry" style={{
              padding: "8px 10px", borderRadius: 8,
              background: "rgba(255,255,255,0.04)",
              borderLeft: "3px solid rgba(99,102,241,0.5)",
              animation: "fadeSlideIn 0.3s ease",
            }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 3 }}>
                {ts}
              </div>
              <div className="thinking-md" style={{ fontSize: 12.5, color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
                <ReactMarkdown>{entry.content}</ReactMarkdown>
              </div>
            </div>
          );
        })}
        {isRunning && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 10px", fontSize: 12, color: "rgba(255,255,255,0.4)",
          }}>
            <span className="typing-dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
            Thinking...
          </div>
        )}
        {suggestions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Suggestions
            </div>
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => { if (onSendMessage && !disabled) onSendMessage(s); }}
                style={{
                  padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(99,102,241,0.3)",
                  background: "rgba(99,102,241,0.08)", color: "rgba(255,255,255,0.75)",
                  fontSize: 12, cursor: disabled ? "default" : "pointer", textAlign: "left" as const,
                  opacity: disabled ? 0.5 : 1, transition: "background 0.15s",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {onSendMessage && (
        <div style={{
          padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex", gap: 8, flexShrink: 0,
        }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            placeholder="Ask the agent..."
            disabled={disabled}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)",
              color: "#fff", fontSize: 12.5, fontFamily: "inherit", outline: "none",
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || disabled}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: !input.trim() || disabled ? "rgba(243,111,33,0.3)" : "#f36f21",
              color: "#fff", fontSize: 12, fontWeight: 600, cursor: !input.trim() || disabled ? "default" : "pointer",
              whiteSpace: "nowrap" as const,
            }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

export default function ThinkingPanel({
  thinking, plan, isRunning, isComplete, steps,
  onSendMessage, disabled, userMessages,
}: ThinkingPanelProps) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "#1a1a2e", color: "#fff", overflow: "hidden",
      borderRight: "1px solid rgba(255,255,255,0.08)",
    }}>
      <div style={{
        padding: "16px 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <span style={{ fontSize: 18 }}>🧠</span>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.02em" }}>
          Agent Thinking
        </span>
        {isRunning && (
          <span style={{
            marginLeft: "auto", fontSize: 10, padding: "2px 8px",
            borderRadius: 10, background: "rgba(245,158,11,0.2)",
            color: "#f59e0b", fontWeight: 600,
          }}>
            LIVE
          </span>
        )}
      </div>

      {plan && (
        <>
          <PlanChecklist plan={plan} isRunning={isRunning} />
          <div style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }} />
        </>
      )}

      <ConversationLog
        thinkingEntries={thinking}
        userMessages={userMessages || []}
        isRunning={isRunning}
        isComplete={isComplete}
        steps={steps}
        onSendMessage={onSendMessage}
        disabled={disabled}
      />

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .plan-spinner {
          animation: spin 0.8s linear infinite;
        }
        .typing-dots {
          display: inline-flex; gap: 3px; align-items: center;
        }
        .typing-dots .dot {
          width: 4px; height: 4px; border-radius: 50%;
          background: rgba(255,255,255,0.4);
          animation: dotPulse 1.4s ease-in-out infinite;
        }
        .typing-dots .dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dots .dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes dotPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
        .thinking-md p { margin: 0 0 4px 0; }
        .thinking-md p:last-child { margin-bottom: 0; }
        .thinking-md h1, .thinking-md h2, .thinking-md h3 {
          margin: 6px 0 4px; font-size: 13px; font-weight: 700;
          color: rgba(255,255,255,0.9);
        }
        .thinking-md h1 { font-size: 14px; }
        .thinking-md strong { color: rgba(255,255,255,0.95); }
        .thinking-md em { color: rgba(255,255,255,0.7); }
        .thinking-md ul, .thinking-md ol {
          margin: 4px 0; padding-left: 18px;
        }
        .thinking-md li { margin-bottom: 2px; }
        .thinking-md code {
          background: rgba(255,255,255,0.1); padding: 1px 4px;
          border-radius: 3px; font-size: 11px; font-family: 'SF Mono', 'Fira Code', monospace;
        }
        .thinking-md pre {
          background: rgba(255,255,255,0.06); padding: 8px;
          border-radius: 6px; overflow-x: auto; margin: 4px 0;
        }
        .thinking-md pre code { background: transparent; padding: 0; }
        .thinking-md table {
          border-collapse: collapse; width: 100%; margin: 6px 0;
          font-size: 11px;
        }
        .thinking-md th, .thinking-md td {
          border: 1px solid rgba(255,255,255,0.15); padding: 4px 8px;
          text-align: left;
        }
        .thinking-md th {
          background: rgba(255,255,255,0.08); font-weight: 600;
          color: rgba(255,255,255,0.9);
        }
        .thinking-md hr {
          border: none; border-top: 1px solid rgba(255,255,255,0.1);
          margin: 8px 0;
        }
        .thinking-md a { color: #818cf8; text-decoration: underline; }
        .thinking-md blockquote {
          border-left: 3px solid rgba(255,255,255,0.2);
          margin: 4px 0; padding: 2px 10px;
          color: rgba(255,255,255,0.6);
        }
      `}</style>
    </div>
  );
}
