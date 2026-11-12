import { environmentCredentialsOnly } from "./runtime-profile.js";
import type { AiAssetAdvisorProvider, AssetGrabberSettings } from "./types.js";

// Configurable stable identifiers, not a claim that these are the newest models.
export const MODEL_PROVIDERS = {
  openai: { title: "OpenAI", model: "gpt-4.1-mini", env: "OPENAI_API_KEY", url: "https://api.openai.com/v1/chat/completions" },
  anthropic: { title: "Anthropic", model: "claude-haiku-4-5", env: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/messages" },
  gemini: { title: "Google Gemini", model: "gemini-2.5-flash", env: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/models" },
  deepseek: { title: "DeepSeek", model: "deepseek-flash", env: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/chat/completions" },
  openrouter: { title: "OpenRouter", model: "openai/gpt-4.1-mini", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1/chat/completions" },
  groq: { title: "Groq", model: "llama-3.3-70b-versatile", env: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/chat/completions" },
  parallel: { title: "Parallel Decisions (web-grounded)", model: "fast", env: "PARALLEL_API_KEY", url: "https://api.parallel.ai/v1/decisions" },
  nace: { title: "Nace / Drex Max v1.1 (direct)", model: "drex-max-v1.1", env: "NACE_API_KEY", url: "https://console.nace.ai/v1/systemone" }
} as const;

export const ADVISOR_PROVIDERS: AiAssetAdvisorProvider[] = ["none", ...Object.keys(MODEL_PROVIDERS) as (keyof typeof MODEL_PROVIDERS)[], "custom", "codex-cli", "claude-code-cli"];

export function usesTypedDecisions(settings: AssetGrabberSettings): boolean {
  return ["parallel", "nace"].includes(settings.assetAdvisor.provider) || settings.assetAdvisor.provider === "openrouter" &&
    /^(?:nace-ai\/drex(?:-|$)|~?typesafe\/jev-(?:latest|[0-9])|cloudflare\/clef(?:-|$))/.test(settings.assetAdvisor.model ?? "");
}

export async function callDecisionModel(settings: AssetGrabberSettings, prompt: string): Promise<string> {
  if (usesTypedDecisions(settings)) throw new Error("Typed decision models judge candidates; they do not generate intent text");
  const advisor = settings.assetAdvisor;
  const provider = advisor.provider;
  const preset = MODEL_PROVIDERS[provider as keyof typeof MODEL_PROVIDERS];
  let url = preset?.url as string | undefined;
  const envOnly = environmentCredentialsOnly();
  let key = (!envOnly && advisor.apiKey) || (preset ? process.env[preset.env] : process.env.ASSET_GRABBER_ADVISOR_API_KEY);
  let model: string | undefined = advisor.model || preset?.model;
  if (provider === "deepseek") {
    if (!envOnly && advisor.apiKey === undefined) key ||= advisor.deepseekApiKey;
    model = advisor.model || advisor.deepseekModel || preset?.model;
  }
  if (provider === "custom") {
    // In a Hermes profile the endpoint is only the user's plugin setting, never a saved or model-chosen value.
    url = envOnly ? process.env.ASSET_GRABBER_ADVISOR_URL || undefined : advisor.customProviderUrl;
    if (!envOnly && advisor.apiKey === undefined) key ||= advisor.customProviderApiKey;
    model = advisor.model || advisor.customProviderModel;
  }
  if (!url) throw new Error("Advisor endpoint is not configured");
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Advisor URL must not contain credentials, query parameters or a fragment");
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("Advisor URL must use HTTPS or a localhost endpoint");
  }
  if (!key && provider !== "custom") throw new Error(`No API key configured for ${provider}; use ${envOnly ? "Hermes approved profile secrets" : "local settings or " + preset?.env}`);
  if (!model) throw new Error("Advisor model identifier is not configured");
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: Record<string, unknown> = { model, max_tokens: 1600, messages: [{ role: "user", content: prompt }] };
  if (provider === "anthropic") {
    headers["x-api-key"] = key!;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "gemini") {
    headers["x-goog-api-key"] = key!;
    url = `${url}/${encodeURIComponent(model)}:generateContent`;
    body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1600, responseMimeType: "application/json" } };
  } else if (key) headers.authorization = `Bearer ${key}`;
  const data = await postModelJson(url, headers, body, provider);
  const text = provider === "anthropic" ? data.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    : provider === "gemini" ? data.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("\n")
    : data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Advisor returned no text");
  return text;
}

export async function postModelJson(url: string, headers: Record<string, string>, body: Record<string, unknown>, provider: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`Advisor ${provider} request failed or timed out`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Advisor ${provider} API failed (HTTP ${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Advisor returned an empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error("Advisor response exceeded 256 KiB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = Buffer.concat(chunks).toString("utf8");
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error("Advisor returned invalid API JSON"); }
  return data;
}
