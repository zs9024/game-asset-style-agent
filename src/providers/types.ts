export type Aspect = "square" | "landscape" | "portrait";

export interface ImageInput {
  data: Buffer;
  mime: string;
  /** Actual source when an explicitly configured fallback supplied the image. */
  providerId?: string;
  handoffId?: string;
}

export interface ImageHandoff {
  id: string; projectId: string; jobId: string; name: string; createdAt: string; expiresAt: string;
  status: "waiting" | "submitted" | "cancelled" | "expired" | "imported";
  prompt: string; aspect: Aspect; transparent: boolean; frames?: number; referenceCount: number; assetId?: string;
}

export interface GenerateRequest {
  prompt: string;
  references: ImageInput[];
  aspect: Aspect;
  transparent: boolean;
  /** sprite sheets: number of frames laid out in one row */
  frames?: number;
  /** told before each retry of a rate-limited or failed request */
  onRetry?: (info: import("./retry.js").RetryInfo) => void;
  /** Provider-specific adjustments worth showing in the job log, e.g. reference limits. */
  onNotice?: (message: string) => void;
  context?: { projectId: string; jobId: string; input: import("../agent/schemas.js").GenerateInput };
  onHandoff?: (handoff: ImageHandoff) => void;
}

export interface ImageProvider {
  id: string;
  label: string;
  available: () => boolean;
  generate: (req: GenerateRequest, signal?: AbortSignal) => Promise<ImageInput>;
}

export async function failOnHttpError(res: Response, who: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`${who} HTTP ${res.status}: ${body.slice(0, 500)}`);
}
