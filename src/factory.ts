import { ValidationError } from "@chat-adapter/shared";
import { ADAPTER_NAME } from "./api";
import { HibiraAdapter } from "./adapter";
import type { HibiraAdapterConfig } from "./types";

function env(name: string): string | undefined {
  const v = typeof process === "undefined" ? undefined : process.env[name];
  return v === "" ? undefined : v;
}

/**
 * Creates the Hibira Live Chat adapter. Every setting falls back to an
 * environment variable: `HIBIRA_LIVECHAT_API_KEY`,
 * `HIBIRA_LIVECHAT_WEBHOOK_SECRET`, `HIBIRA_LIVECHAT_AGENT_ID` and
 * `HIBIRA_LIVECHAT_API_URL`.
 */
export function createHibiraAdapter(config: HibiraAdapterConfig = {}): HibiraAdapter {
  const apiKey = config.apiKey ?? env("HIBIRA_LIVECHAT_API_KEY");
  const webhookSecret = config.webhookSecret ?? env("HIBIRA_LIVECHAT_WEBHOOK_SECRET");
  if (!apiKey) {
    throw new ValidationError(
      ADAPTER_NAME,
      "A Live Chat API key is required. Pass apiKey or set HIBIRA_LIVECHAT_API_KEY (Settings › API & webhooks on chat.hibira.io).",
    );
  }
  if (!webhookSecret) {
    throw new ValidationError(
      ADAPTER_NAME,
      "A webhook signing secret is required. Pass webhookSecret or set HIBIRA_LIVECHAT_WEBHOOK_SECRET.",
    );
  }
  const agentId = config.agentId ?? env("HIBIRA_LIVECHAT_AGENT_ID");
  if (config.dispatchAgentMessages && !agentId) {
    throw new ValidationError(
      ADAPTER_NAME,
      "dispatchAgentMessages needs agentId (or HIBIRA_LIVECHAT_AGENT_ID), so that the bot can tell its own replies from your agents' messages.",
    );
  }
  return new HibiraAdapter({
    ...config,
    apiKey,
    webhookSecret,
    agentId,
    apiUrl: config.apiUrl ?? env("HIBIRA_LIVECHAT_API_URL"),
  });
}
