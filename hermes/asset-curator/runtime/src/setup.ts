import { environmentCredentialsOnly } from "./runtime-profile.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { z } from "zod";
import { ADVISOR_PROVIDERS, MODEL_PROVIDERS } from "./models.js";
import { loadSettings, redactSettings, resolveSettingsPath, saveSettings } from "./settings.js";
import type { AssetGrabberSettings } from "./types.js";

export const preferencesSchema = z.object({
  licensePolicy: z.enum(["safe", "any"]).describe("safe = known project-usable licenses; any = include restrictive/unknown licenses, still record provenance. Never bypasses access controls."),
  browserEnabled: z.boolean().describe("Explicit user consent to browser-assisted retrieval if ordinary downloads fail. Does not authorize login, captcha solving, payment or accepting terms."),
  acquisitionMode: z.enum(["existing", "create", "both"]).describe("Existing assets, deterministic code generation, or both (recommended).")
}).strict();

export function setupStatus(settings: AssetGrabberSettings) {
  return {
    required: !settings.preferences.completed,
    credentialMode: environmentCredentialsOnly() ? "Hermes profile environment only" : "standalone local settings/environment",
    settingsPath: resolveSettingsPath(),
    preferences: settings.preferences,
    instructions: settings.preferences.completed
      ? "Preferences are saved. Do not ask again unless the user requests a change."
      : environmentCredentialsOnly() ? "Ask the policy choices ONCE per active Hermes profile, then configure_preferences. Do not infer consent. Choose the optional provider with configure_classifier. Classifier keys come only through Hermes approved profile/secret settings, never chat, local key files or CLI subscription stores." : "Ask the user these choices ONCE, then call configure_preferences with their answers. Do not choose on their behalf. Optional API keys should be entered in the local settings UI or environment, not chat. CLI alternative: asset-grabber-mcp --setup.",
    questions: [
      { field: "licensePolicy", question: "Only known project-usable licenses (safe, recommended), or include assets regardless of license (any)?", choices: ["safe", "any"], note: "Safe is a filter, not a legal guarantee; attribution and third-party rights still apply." },
      { field: "browserEnabled", question: "Permit browser-assisted retrieval when a normal download is unavailable?", choices: [false, true], note: "No login, payment, captcha solving or accepting terms automatically." },
      { field: "acquisitionMode", question: "Grab existing assets, create assets through code, or both (recommended)?", choices: ["existing", "create", "both"] },
      { field: "assetAdvisor", question: environmentCredentialsOnly() ? "Optionally connect a classifier through Hermes profile settings? Default is none; use ASSET_GRABBER_ADVISOR_PROVIDER plus its approved API-key secret, not chat or local files." : "Optionally connect a decision/classifier model? Choose none or configure a provider and key in the local settings UI.", optional: true }
    ]
  };
}

export async function configurePreferences(input: z.input<typeof preferencesSchema>) {
  const preferences = preferencesSchema.parse(input);
  const settings = await loadSettings();
  const saved = await saveSettings({ ...settings, preferences: { ...preferences, completed: true } });
  return { ...setupStatus(saved), settings: redactSettings(saved) };
}

export const classifierSchema = z.object({
  provider: z.enum(["none", "openai", "anthropic", "gemini", "deepseek", "openrouter", "groq", "parallel", "nace", "custom", "codex-cli", "claude-code-cli"]),
  model: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2000).optional()
}).strict();

export async function configureClassifier(raw: z.input<typeof classifierSchema>) {
  const input = classifierSchema.parse(raw), settings = await loadSettings();
  if (environmentCredentialsOnly() && input.provider.endsWith("-cli")) throw new Error("CLI subscription credentials are unavailable in this Hermes profile; choose an approved API route");
  if (environmentCredentialsOnly() && process.env.ASSET_GRABBER_ADVISOR_PROVIDER && process.env.ASSET_GRABBER_ADVISOR_PROVIDER !== input.provider) throw new Error("Classifier provider is pinned by the host profile; change it through Hermes profile settings");
  if (input.url && input.provider !== "custom") throw new Error("An endpoint URL is only accepted for the custom provider");
  if (input.url) {
    const endpoint = new URL(input.url);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("Use a clean HTTPS or loopback classifier endpoint, never URL credentials/query/fragment");
  }
  const changed = input.provider !== settings.assetAdvisor.provider;
  const advisor = { ...settings.assetAdvisor, provider: input.provider, allowNetworkAiRanking: input.provider !== "none",
    model: input.model ?? (changed ? undefined : settings.assetAdvisor.model),
    customProviderUrl: input.url ?? settings.assetAdvisor.customProviderUrl };
  if (changed) { advisor.apiKey = undefined; advisor.deepseekApiKey = undefined; advisor.customProviderApiKey = undefined; }
  const saved = await saveSettings({ ...settings, assetAdvisor: advisor });
  return { provider: saved.assetAdvisor.provider, model: saved.assetAdvisor.model, credentialMode: environmentCredentialsOnly() ? "Hermes profile secrets only" : "standalone local settings/environment", credentialsAccepted: false, note: "No API key accepted or model call performed. Enter the selected provider key through the approved credential route, never chat. Existing license/browser/acquisition choices are unchanged." };
}

export async function runSetupCli(): Promise<void> {
  if (environmentCredentialsOnly()) throw new Error("Use MCP preference setup and Hermes profile/secret settings; standalone key-entry CLI is disabled in this profile");
  if (!process.stdin.isTTY) throw new Error("Interactive setup requires a terminal. Agents should use get_setup and configure_preferences.");
  // Never echo an API key; no secrets are written to stdout, logs or MCP content.
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const choose = async (question: string, choices: string[], fallback: string) => {
    for (;;) {
      const value = (await rl.question(`${question} [${choices.join("/")}] (${fallback}): `)).trim().toLowerCase() || fallback;
      if (choices.includes(value)) return value;
      console.log(`Choose ${choices.join(", ")}.`);
    }
  };
  try {
    const settings = await loadSettings();
    if (settings.preferences.completed && await choose("Preferences already saved. Change them?", ["y", "n"], "n") === "n") return;
    console.log("Asset Curator — one-time setup. Choices can be changed later.\nSafe licenses still require attribution/rights checks; browser consent never permits bypassing access controls.");
    const licensePolicy = await choose("License policy", ["safe", "any"], "safe") as "safe" | "any";
    const browserEnabled = await choose("Allow browser-assisted retrieval?", ["y", "n"], "n") === "y";
    const acquisitionMode = await choose("Asset acquisition", ["existing", "create", "both"], "both") as "existing" | "create" | "both";
    const provider = await choose("Optional classifier provider", ADVISOR_PROVIDERS, "none") as AssetGrabberSettings["assetAdvisor"]["provider"];
    const advisor = { ...settings.assetAdvisor, provider, allowNetworkAiRanking: provider !== "none" };
    if (provider !== settings.assetAdvisor.provider) {
      advisor.apiKey = undefined;
      advisor.model = undefined;
      advisor.deepseekApiKey = undefined;
      advisor.customProviderApiKey = undefined;
    }
    if (provider === "custom") {
      advisor.customProviderUrl = (await rl.question("OpenAI-compatible chat/completions URL: ")).trim();
      advisor.model = (await rl.question("Model identifier: ")).trim();
      if (!/^https:\/\//.test(advisor.customProviderUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(advisor.customProviderUrl)) throw new Error("Use HTTPS or a localhost model endpoint.");
    }
    const preset = MODEL_PROVIDERS[provider as keyof typeof MODEL_PROVIDERS];
    if (preset) advisor.model = (await rl.question(`Model identifier (${preset.model}): `)).trim() || preset.model;
    if (preset || provider === "custom") {
      process.stdout.write("API key (hidden; leave blank to retain current key): ");
      hidden = true;
      let key: string;
      try { key = (await rl.question("")).trim(); } finally { hidden = false; process.stdout.write("\n"); }
      if (key) {
        advisor.apiKey = key;
      }
    }
    await saveSettings({ ...settings, preferences: { licensePolicy, browserEnabled, acquisitionMode, completed: true }, assetAdvisor: advisor });
    console.log(`Saved ${resolveSettingsPath()}. Ready for agent use.`);
  } finally {
    rl.close();
  }
}
