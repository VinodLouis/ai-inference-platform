import type {
  InferenceComposerFormValues,
  InferenceJob,
  InferenceStatusResponse,
} from "../types";
import type { RawInferenceJob } from "../services/inferenceApi";

export function shortJobId(jobId: string): string {
  if (!jobId) return "-";
  if (jobId.length <= 4) return jobId;
  return `${jobId.slice(0, 4)}...`;
}

export function formatMultilineOutput(output: string): string {
  if (!output) return "";
  return String(output).replace(/\\n/g, "\n");
}

export function normalizeInferenceJob(
  job: RawInferenceJob,
  rackIdOverride?: string,
): InferenceJob {
  return {
    jobId: job.jobId || job.id || "",
    rackId: rackIdOverride || job.rackId || "",
    status: job.status || "unknown",
    modelId: job.modelId || "-",
    prompt: job.prompt || "",
    createdAt: job.createdAt || Date.now(),
    updatedAt: job.updatedAt || job.createdAt || Date.now(),
    output:
      job?.result?.output || job?.result?.text || job.output || job.text || "",
  };
}

export function mergeAndSortJobsByCreatedAt(
  jobs: InferenceJob[],
): InferenceJob[] {
  return jobs
    .filter((job) => job.jobId)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function buildOptimisticJob(
  response: { jobId: string; rackId?: string; status?: string },
  values: InferenceComposerFormValues,
): InferenceJob {
  const now = new Date().toISOString();

  return {
    jobId: response.jobId,
    rackId: response.rackId || "",
    status: response.status || "queued",
    modelId: values.modelId,
    prompt: values.prompt,
    createdAt: now,
    updatedAt: now,
    output: "",
  };
}

export function updateJobFromStatusResponse(
  job: InferenceJob,
  response: InferenceStatusResponse,
  updatedAt: number,
): InferenceJob {
  return {
    ...job,
    status: response.status || job.status,
    modelId: response.modelId || job.modelId,
    rackId: response.rackId || job.rackId,
    prompt: response.prompt || job.prompt,
    updatedAt,
    output: response?.result?.output || response?.output || job.output || "",
  };
}

export function getStatusTagColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  return "blue";
}
