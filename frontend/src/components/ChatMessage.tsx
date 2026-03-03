import React from "react";
import ReactMarkdown from "react-markdown";
import type { AgentMessage } from "../api";

interface Props {
  message: AgentMessage;
}

export default function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 14,
      }}
    >
      {!isUser && (
        <div style={styles.avatar}>
          <span style={styles.avatarIcon}>🤖</span>
        </div>
      )}
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.userBubble : styles.assistantBubble),
        }}
      >
        <ReactMarkdown
          components={{
            h2: ({ children }) => (
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: "12px 0 6px", color: "#1a1a2e" }}>
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "10px 0 4px", color: "#333" }}>
                {children}
              </h3>
            ),
            p: ({ children }) => (
              <p style={{ margin: "4px 0", lineHeight: 1.6 }}>{children}</p>
            ),
            ul: ({ children }) => (
              <ul style={{ paddingLeft: 20, margin: "4px 0" }}>{children}</ul>
            ),
            ol: ({ children }) => (
              <ol style={{ paddingLeft: 20, margin: "4px 0" }}>{children}</ol>
            ),
            li: ({ children }) => (
              <li style={{ margin: "2px 0", lineHeight: 1.5 }}>{children}</li>
            ),
            code: ({ children, className }) => {
              const isBlock = className?.includes("language-");
              if (isBlock) {
                return (
                  <pre
                    style={{
                      background: "#f5f5f5",
                      padding: 12,
                      borderRadius: 6,
                      overflow: "auto",
                      fontSize: 12,
                      margin: "8px 0",
                    }}
                  >
                    <code>{children}</code>
                  </pre>
                );
              }
              return (
                <code
                  style={{
                    background: "#f0f0f0",
                    padding: "1px 4px",
                    borderRadius: 3,
                    fontSize: "0.9em",
                  }}
                >
                  {children}
                </code>
              );
            },
            table: ({ children }) => (
              <table
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  margin: "8px 0",
                  fontSize: 13,
                }}
              >
                {children}
              </table>
            ),
            th: ({ children }) => (
              <th
                style={{
                  background: "#f36f21",
                  color: "#fff",
                  padding: "6px 10px",
                  textAlign: "left",
                  fontWeight: 600,
                  fontSize: 12,
                }}
              >
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td
                style={{
                  border: "1px solid #e0e0e0",
                  padding: "5px 10px",
                  fontSize: 12,
                }}
              >
                {children}
              </td>
            ),
            strong: ({ children }) => {
              const text = String(children);
              if (text === "Pass" || text === "PASS") {
                return <strong style={{ color: "#28a745" }}>{children}</strong>;
              }
              if (text === "Fail" || text === "FAIL") {
                return <strong style={{ color: "#dc3545" }}>{children}</strong>;
              }
              if (text === "Partial" || text === "WARN") {
                return <strong style={{ color: "#e69500" }}>{children}</strong>;
              }
              return <strong>{children}</strong>;
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
      {isUser && (
        <div style={{ ...styles.avatar, background: "#1a1a2e" }}>
          <span style={styles.avatarIcon}>👤</span>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  avatar: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "#f36f21",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    margin: "0 10px",
  },
  avatarIcon: {
    fontSize: 16,
  },
  bubble: {
    maxWidth: "75%",
    padding: "10px 16px",
    borderRadius: 12,
    fontSize: 14,
    lineHeight: 1.5,
  },
  userBubble: {
    background: "#f36f21",
    color: "#fff",
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderBottomLeftRadius: 4,
  },
};
