const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SubProgress {
  completed: number;
  total: number;
  detail?: string;
}

export interface ImagePreview {
  data_uri: string;
  label: string;
}

export interface ToolStep {
  tool: string;
  label: string;
  args_summary: string;
  status: "running" | "complete" | "error";
  result_summary?: string;
  duration?: number;
  artifact?: string;
  artifact_volume_path?: string;
  workbook_artifact?: string;
  sub_progress?: SubProgress;
  image_previews?: ImagePreview[];
}

export interface ThinkingEntry {
  content: string;
  timestamp: number;
}

export interface PlanStep {
  id: string;
  label: string;
  detail?: string;
  status: "pending" | "in_progress" | "complete";
}

export interface AgentPlan {
  steps: PlanStep[];
}

export interface UploadResult {
  filename: string;
  size_bytes: number;
  local_path: string;
  volume_path: string | null;
  status: string;
}

export interface RunArtifact {
  filename: string;
  tool: string;
  location?: string;
}

export interface RunInfo {
  run_id: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  total_steps?: number;
  artifact_count?: number;
  artifacts?: RunArtifact[];
}

function extractText(data: Record<string, unknown>): string {
  let text = "";
  const output = data.output as Array<Record<string, unknown>> | undefined;
  if (output) {
    for (const item of output) {
      if (item.text) {
        text += item.text;
      } else if (item.content) {
        for (const block of item.content as Array<Record<string, unknown>>) {
          if (block.text) text += block.text;
        }
      }
    }
  }
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendResult {
  message: AgentMessage;
  runId: string;
  projectDir: string;
}

export async function cancelTask(taskId: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/tasks/${taskId}/cancel`, {
    method: "POST",
    credentials: "include",
  });
}

export async function sendMessage(
  messages: AgentMessage[],
  onStepsUpdate?: (steps: ToolStep[], currentStep: string | null, elapsed: number) => void,
  onTaskId?: (taskId: string) => void,
  signal?: AbortSignal,
  onThinkingUpdate?: (thinking: ThinkingEntry[], plan: AgentPlan | null) => void,
): Promise<SendResult> {
  const response = await fetch(`${BACKEND_URL}/invocations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errData = await response.json();
      detail = errData.detail || detail;
    } catch { /* ignore */ }
    throw new Error(`Agent error (${response.status}): ${detail}`);
  }

  const data = await response.json();

  if (data.task_id) {
    const taskId = data.task_id as string;
    onTaskId?.(taskId);
    const maxPollTime = 600_000;
    const start = Date.now();
    let pollInterval = 2000;
    let runId = (data.run_id as string) || "";
    let projectDir = "";

    while (Date.now() - start < maxPollTime) {
      await sleep(pollInterval);
      if (signal?.aborted) throw new Error("Cancelled");
      if (pollInterval < 4000) pollInterval += 500;

      const pollResp = await fetch(`${BACKEND_URL}/api/tasks/${taskId}`, {
        credentials: "include",
        signal,
      });
      if (!pollResp.ok) {
        throw new Error(`Poll error (${pollResp.status})`);
      }
      const pollData = await pollResp.json();
      runId = pollData.run_id || runId;
      projectDir = pollData.project_dir || projectDir;

      if (onStepsUpdate && pollData.steps) {
        onStepsUpdate(
          pollData.steps as ToolStep[],
          pollData.current_step || null,
          pollData.elapsed_seconds || 0,
        );
      }
      if (onThinkingUpdate) {
        onThinkingUpdate(
          (pollData.thinking || []) as ThinkingEntry[],
          (pollData.plan || null) as AgentPlan | null,
        );
      }

      if (pollData.status === "running" || pollData.status === "cancelling") continue;
      if (pollData.status === "cancelled") {
        if (onStepsUpdate && pollData.steps) {
          onStepsUpdate(pollData.steps as ToolStep[], null, 0);
        }
        throw new Error("Run cancelled by user.");
      }
      if (pollData.status === "error") {
        throw new Error(`Agent error: ${pollData.detail || "unknown"}`);
      }
      if (pollData.status === "complete") {
        if (onStepsUpdate && pollData.steps) {
          onStepsUpdate(pollData.steps as ToolStep[], null, pollData.elapsed_seconds || 0);
        }
        if (onThinkingUpdate) {
          onThinkingUpdate(
            (pollData.thinking || []) as ThinkingEntry[],
            (pollData.plan || null) as AgentPlan | null,
          );
        }
        return {
          message: { role: "assistant", content: extractText(pollData) || "Agent completed processing." },
          runId,
          projectDir,
        };
      }
    }
    throw new Error("Agent timed out after 10 minutes.");
  }

  return {
    message: { role: "assistant", content: extractText(data) || "Agent completed processing." },
    runId: "",
    projectDir: "",
  };
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

export interface EvidenceFile {
  path: string;
  type: string;
  focus?: string;
}

export interface Engagement {
  number?: string;
  name?: string;
  instructions?: string;
  control_objective?: {
    control_id?: string;
    control_name?: string;
    domain?: string;
    policy_reference?: string;
    rules?: Record<string, unknown>;
  };
  testing_attributes?: Array<{ ref: string; name: string; applies_to?: string }>;
  evidence_files?: EvidenceFile[];
  notification_emails?: Record<string, string>;
  [key: string]: unknown;
}

export async function fetchEngagement(projectDir: string): Promise<Engagement | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/projects/${projectDir}/engagement`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export function getEvidenceUrl(projectDir: string, filepath: string): string {
  return `${BACKEND_URL}/api/projects/${projectDir}/evidence/${filepath}`;
}

export async function listRuns(projectDir: string): Promise<RunInfo[]> {
  const response = await fetch(`${BACKEND_URL}/api/runs/${projectDir}`, { credentials: "include" });
  if (!response.ok) return [];
  const data = await response.json();
  return data.runs || [];
}

export interface RunManifest {
  run_id: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  steps?: ToolStep[];
  total_steps?: number;
  thinking?: ThinkingEntry[];
  plan?: AgentPlan | null;
  [key: string]: unknown;
}

export async function fetchRunManifest(projectDir: string, runId: string): Promise<RunManifest | null> {
  try {
    const text = await fetchArtifact(projectDir, runId, "run_manifest.json");
    return JSON.parse(text) as RunManifest;
  } catch {
    return null;
  }
}

export async function pollTask(
  taskId: string,
  onStepsUpdate?: (steps: ToolStep[], currentStep: string | null, elapsed: number) => void,
  signal?: AbortSignal,
): Promise<SendResult> {
  const maxPollTime = 600_000;
  const start = Date.now();
  let pollInterval = 2000;
  let runId = "";
  let projectDir = "";

  while (Date.now() - start < maxPollTime) {
    await sleep(pollInterval);
    if (signal?.aborted) throw new Error("Cancelled");
    if (pollInterval < 4000) pollInterval += 500;

    const pollResp = await fetch(`${BACKEND_URL}/api/tasks/${taskId}`, {
      credentials: "include",
      signal,
    });
    if (!pollResp.ok) throw new Error(`Poll error (${pollResp.status})`);
    const pollData = await pollResp.json();
    runId = pollData.run_id || runId;
    projectDir = pollData.project_dir || projectDir;

    if (onStepsUpdate && pollData.steps) {
      onStepsUpdate(pollData.steps as ToolStep[], pollData.current_step || null, pollData.elapsed_seconds || 0);
    }

    if (pollData.status === "running" || pollData.status === "cancelling") continue;
    if (pollData.status === "cancelled") {
      if (onStepsUpdate && pollData.steps) onStepsUpdate(pollData.steps as ToolStep[], null, 0);
      throw new Error("Run cancelled by user.");
    }
    if (pollData.status === "error") throw new Error(`Agent error: ${pollData.detail || "unknown"}`);
    if (pollData.status === "complete") {
      if (onStepsUpdate && pollData.steps) onStepsUpdate(pollData.steps as ToolStep[], null, pollData.elapsed_seconds || 0);
      return {
        message: { role: "assistant", content: extractText(pollData) || "Agent completed processing." },
        runId,
        projectDir,
      };
    }
  }
  throw new Error("Agent timed out after 10 minutes.");
}

export async function fetchArtifact(projectDir: string, runId: string, filename: string): Promise<string> {
  const response = await fetch(
    `${BACKEND_URL}/api/artifacts/${projectDir}/${runId}/${filename}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Artifact not found (${response.status})`);
  return response.text();
}

export async function downloadBinaryArtifact(
  projectDir: string,
  runId: string,
  filename: string,
): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/artifacts/${projectDir}/${runId}/${filename}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
