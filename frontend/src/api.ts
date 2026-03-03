const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UploadResult {
  filename: string;
  size_bytes: number;
  local_path: string;
  volume_path: string | null;
  status: string;
}

export async function sendMessage(
  messages: AgentMessage[]
): Promise<AgentMessage> {
  const response = await fetch(`${BACKEND_URL}/invocations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errData = await response.json();
      detail = errData.detail || detail;
    } catch { /* ignore parse errors */ }
    throw new Error(`Agent error (${response.status}): ${detail}`);
  }

  const data = await response.json();
  let text = "";

  if (data.output) {
    for (const item of data.output) {
      if (item.text) {
        text += item.text;
      } else if (item.content) {
        for (const block of item.content) {
          if (block.text) text += block.text;
        }
      }
    }
  }

  return { role: "assistant", content: text || "Agent completed processing." };
}

export async function uploadFile(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${BACKEND_URL}/api/upload`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload error: ${response.status}`);
  }

  return response.json();
}

export async function getConfig(): Promise<Record<string, unknown>> {
  const response = await fetch(`${BACKEND_URL}/api/config`, { credentials: "include" });
  if (!response.ok) return {};
  return response.json();
}

export interface ProjectInfo {
  project_dir: string;
  source: string;
  engagement_number?: string;
  engagement_name?: string;
  control_id?: string;
  control_name?: string;
  domain?: string;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const response = await fetch(`${BACKEND_URL}/api/projects`, { credentials: "include" });
  if (!response.ok) return [];
  const data = await response.json();
  return data.projects || [];
}
