import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import type { Credential } from "./types";

export const ADAPTER_NAME = "hibira";
export const DEFAULT_API_URL = "https://chat.hibira.io/v1";

/** Resolves a credential on every call, so rotated keys are picked up. */
export async function resolveCredential(c: Credential): Promise<string> {
  const v = typeof c === "function" ? await c() : c;
  if (typeof v !== "string" || v === "") {
    throw new AuthenticationError(ADAPTER_NAME, "the credential resolver returned an empty value");
  }
  return v;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
}

/** A small client for the Live Chat REST API. */
export class HibiraApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Credential,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const key = await resolveCredential(this.apiKey);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new NetworkError(
        ADAPTER_NAME,
        `request to Live Chat failed: ${method} ${path}`,
        err instanceof Error ? err : undefined,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw apiError(res, path, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function apiError(res: Response, path: string, text: string): Error {
  let body: ApiErrorBody = {};
  try {
    body = JSON.parse(text) as ApiErrorBody;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  const message = body.error || `HTTP ${res.status}`;
  switch (res.status) {
    case 400:
      return new ValidationError(ADAPTER_NAME, message);
    case 401:
      return new AuthenticationError(ADAPTER_NAME, message);
    case 402:
      return new PermissionError(ADAPTER_NAME, `${message} (the REST API is on the Team and Business plans)`);
    case 403:
      return new PermissionError(ADAPTER_NAME, message, body.code === "read_only_key" ? "write" : undefined);
    case 404:
      return new ResourceNotFoundError(ADAPTER_NAME, "conversation", path);
    case 429: {
      const retry = Number(res.headers.get("retry-after"));
      return new AdapterRateLimitError(ADAPTER_NAME, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    default:
      return new AdapterError(`Live Chat answered ${res.status}: ${message}`, ADAPTER_NAME, body.code);
  }
}
