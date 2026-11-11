// Client for the platform's ingest API (docs/BYO-AGENT.md). Every request body is logged exactly as
// sent, so the IP scan can check what actually left the agent.

export interface SessionInfo {
  session_id: string;
  issuer_key_id?: string;
  issuer_public_key_pem?: string;
  log_public_key_pem?: string;
  policy_hash?: string;
}

export interface RecordReceipt {
  receipt_id: string;
  seq: number;
  receipt_hash: string;
}

export interface SentRequest {
  method: string;
  path: string;
  body: string;
  status: number;
  response: unknown;
}

export interface Platform {
  /** Every request sent so far, in order. */
  readonly sent: SentRequest[];
  openSession(body: Record<string, unknown>): Promise<SessionInfo>;
  /** Returns the receipt, or null when the platform refused the record (see `sent` for why). */
  postRecord(sessionId: string, record: Record<string, unknown>): Promise<RecordReceipt | null>;
  close(sessionId: string): Promise<Record<string, unknown>>;
}

export class PlatformError extends Error {
  constructor(message: string, readonly status: number, readonly response: unknown) {
    super(message);
  }
}

export class HttpPlatform implements Platform {
  readonly sent: SentRequest[] = [];
  constructor(private base: string, private key: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private async call(method: string, path: string, payload: unknown): Promise<{ status: number; json: unknown }> {
    const body = JSON.stringify(payload);
    let status = 0;
    let json: unknown = null;
    try {
      const r = await fetch(this.base + path, {
        method,
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body,
      });
      status = r.status;
      const text = await r.text();
      try { json = JSON.parse(text); } catch { json = text; }
    } catch (e) {
      json = { error: String((e as Error).cause ?? e) };
    }
    this.sent.push({ method, path, body, status, response: json });
    return { status, json };
  }

  async openSession(body: Record<string, unknown>): Promise<SessionInfo> {
    const r = await this.call("POST", "/v1/sessions", body);
    const j = r.json as Partial<SessionInfo>;
    if (r.status !== 201 || typeof j?.session_id !== "string") {
      throw new PlatformError(`POST /v1/sessions → ${r.status} ${JSON.stringify(r.json)}`, r.status, r.json);
    }
    return j as SessionInfo;
  }

  async postRecord(sessionId: string, record: Record<string, unknown>): Promise<RecordReceipt | null> {
    const r = await this.call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/records`, record);
    const j = r.json as Partial<RecordReceipt>;
    return r.status === 201 && typeof j?.receipt_id === "string" ? (j as RecordReceipt) : null;
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    const r = await this.call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/close`, {});
    if (r.status !== 200 || !r.json || typeof r.json !== "object") {
      throw new PlatformError(`POST close → ${r.status} ${JSON.stringify(r.json)}`, r.status, r.json);
    }
    return r.json as Record<string, unknown>;
  }
}
