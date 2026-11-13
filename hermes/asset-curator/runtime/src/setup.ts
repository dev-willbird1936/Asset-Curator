import { environmentCredentialsOnly } from "./runtime-profile.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { z } from "zod";
import { ADVISOR_PROVIDERS, MODEL_PROVIDERS } from "./models.js";
import { loadSettings, redactSettings, resolveSettingsPath, saveSettings, validateProjectsFolder } from "./settings.js";
import type { AssetGrabberSettings } from "./types.js";

export const preferencesSchema = z.object({
  licensePolicy: z.enum(["safe", "any"]).describe("safe = known project-usable licenses; any = include restrictive/unknown licenses, still record provenance. Never bypasses access controls."),
  browserEnabled: z.boolean().describe("Explicit user consent to browser-assisted retrieval if ordinary downloads fail. Does not authorize login, captcha solving, payment or accepting terms."),
  acquisitionMode: z.enum(["existing", "create", "both"]).describe("Existing assets, deterministic code generation, or both (recommended)."),
  triggerMode: z.enum(["auto", "on-request"]).optional().describe("auto = use the plugin whenever the agent judges a task needs asset files (recommended); on-request = only when the user names Asset Curator or directly asks for an asset. Omit to keep the saved choice.")
}).strict();

export const TRIGGER_GUIDANCE = {
  auto: "AUTO MODE IS ON (the user's saved choice; they already said yes, so do not ask or offer first). Writing a game, 3D scene, website, app screen, video or presentation is NOT a code-only task: before you write its code, use Asset Curator to get the real media it needs (at least the main character or prop models and key sounds for a game; icons, fonts or images for a site), then load them by the returned file paths. Do this even when the user only asks for the code and even if you cannot save files yourself. Also use it for any request for a model, sprite, texture, icon, font, sound or music. 'It works without assets' is not a reason to skip; do not settle for placeholder shapes, emoji or 'you can add assets later'. Skip only when the task involves no media at all (bug fixes, explanations, documents, planning, refactors) or the user says not to use assets or plugins.",
  "on-request": "Trigger mode ON-REQUEST (the user's saved choice): do NOT call any Asset Curator tool on your own initiative. Use it only when the user names Asset Curator or this plugin, or directly asks you to find, download, grab or generate an asset file. When a larger task (such as building a game) would merely benefit from assets, do the task without these tools and mention once, in one sentence, that Asset Curator can supply assets if they ask.",
  unset: "Setup is not finished. The first time a task needs an asset file, call get_setup, ask the user its questions once, then configure_preferences. Do not call it for work that needs no media file."
} as const;
/** Short reminder for tools that are not an entry point, to keep tool listings small. */
export const TRIGGER_TAG = { auto: "AUTO MODE IS ON: when you start building a game, 3D scene, website, video or anything seen or heard, get its assets with search_assets or generate_asset before writing code, without being asked.", "on-request": "Trigger mode ON-REQUEST: only when the user named this plugin or directly asked for an asset.", unset: "Setup not finished: call get_setup first." } as const;
export function triggerKey(settings: AssetGrabberSettings): keyof typeof TRIGGER_GUIDANCE {
  return settings.preferences.completed ? settings.preferences.triggerMode : "unset";
}
export function triggerGuidance(settings: AssetGrabberSettings): string {
  return settings.preferences.completed ? TRIGGER_GUIDANCE[settings.preferences.triggerMode] : TRIGGER_GUIDANCE.unset;
}

export function setupStatus(settings: AssetGrabberSettings) {
  return {
    required: !settings.preferences.completed,
    credentialMode: environmentCredentialsOnly() ? "Hermes profile environment only" : "standalone local settings/environment",
    settingsPath: resolveSettingsPath(),
    projectsFolderRoute: PROJECTS_FOLDER_ROUTE,
    userOnlyFilesystemSetup: { firstChoice: ["hermes", "separate"], separateChoices: ["full", "project", "review", "no"], recommendedSeparateChoice: "project", currentMode: settings.preferences.accessMode, note: "Set this yourself in plugin settings or standalone CLI. Do not send access settings to configure_preferences. Until chosen, no mode applies." },
    preferences: settings.preferences,
    triggerGuidance: triggerGuidance(settings),
    instructions: settings.preferences.completed
      ? "Preferences are saved. Do not ask again unless the user requests a change."
      : environmentCredentialsOnly() ? "Ask the policy choices ONCE per active Hermes profile, then configure_preferences. Do not infer consent. Choose the optional provider with configure_classifier. Classifier keys come only through Hermes approved profile/secret settings, never chat, local key files or CLI subscription stores." : "Ask the user these choices ONCE, then call configure_preferences with their answers. Do not choose on their behalf. Optional API keys should be entered in the local settings UI or environment, not chat. CLI alternative: asset-grabber-mcp --setup.",
    questions: [
      { field: "licensePolicy", question: "Only known project-usable licenses (safe, recommended), or include assets regardless of license (any)?", choices: ["safe", "any"], note: "Safe is a filter, not a legal guarantee; attribution and third-party rights still apply." },
      { field: "browserEnabled", question: "Permit browser-assisted retrieval when a normal download is unavailable?", choices: [false, true], note: "No login, payment, captcha solving or accepting terms automatically." },
      { field: "acquisitionMode", question: "Grab existing assets, create assets through code, or both (recommended)?", choices: ["existing", "create", "both"] },
      { field: "triggerMode", question: "Should the agent use Asset Curator automatically whenever it judges a task needs assets (auto, recommended), or only when you name it or directly ask for an asset (on-request)?", choices: ["auto", "on-request"], note: "Auto never changes your license, browser or acquisition choices. A change applies to tool descriptions from the next session." },
      { field: "assetAdvisor", question: environmentCredentialsOnly() ? "Optionally connect a classifier through Hermes profile settings? Default is none; use ASSET_GRABBER_ADVISOR_PROVIDER plus its approved API-key secret, not chat or local files. A custom endpoint URL is set only in the plugin's Hermes settings, never in chat." : "Optionally connect a decision/classifier model? Choose none or configure a provider and key in the local settings UI.", optional: true }
    ]
  };
}

export const PROJECTS_FOLDER_ROUTE = "Filesystem setup is user-controlled outside chat. Use Hermes-managed approvals (ASSET_GRABBER_ACCESS_MODE=hermes), or configure separately: full (no plugin path limit; OS/Hermes still apply), project (recommended; one workspace, default output asset-curator/), review (Asset Review Queue; stage in Downloads, host-approved promotion to project), or no (suggest only; downloads/use require a real host approval). Set ASSET_GRABBER_PROJECTS_FOLDER for project/review. Model tools cannot change either setting. A one-off host-confirmed action never changes the saved mode.";

export async function configurePreferences(input: z.input<typeof preferencesSchema>) {
  if (input && typeof input === "object" && ("projectsFolder" in input || "accessMode" in input)) throw new Error(PROJECTS_FOLDER_ROUTE);
  const preferences = preferencesSchema.parse(input);
  const settings = await loadSettings();
  const projectsFolder = settings.preferences.projectsFolder;
  const saved = await saveSettings({ ...settings, preferences: { ...preferences, triggerMode: preferences.triggerMode ?? settings.preferences.triggerMode, projectsFolder, accessMode: settings.preferences.accessMode, completed: true } });
  return { ...setupStatus(saved), settings: redactSettings(saved) };
}

export const classifierSchema = z.object({
  provider: z.enum(["none", "openai", "anthropic", "gemini", "deepseek", "openrouter", "groq", "parallel", "nace", "custom", "codex-cli", "claude-code-cli"]),
  model: z.string().min(1).max(200).optional()
}).strict();

/** The custom endpoint receives a credential, so only the user sets it: Hermes plugin settings (custom_url ->
 *  ASSET_GRABBER_ADVISOR_URL), the standalone settings page/CLI, or the environment. Never a model tool. */
export const CUSTOM_URL_ROUTE = "The custom classifier URL is not set by this tool. The user sets it outside the chat: in Hermes, the plugin's Custom classifier URL setting (ASSET_GRABBER_ADVISOR_URL); standalone, the local settings page or that environment variable.";

export async function configureClassifier(raw: z.input<typeof classifierSchema>) {
  if (raw && typeof raw === "object" && "url" in raw) throw new Error(CUSTOM_URL_ROUTE);
  const input = classifierSchema.parse(raw), settings = await loadSettings();
  if (environmentCredentialsOnly() && input.provider.endsWith("-cli")) throw new Error("CLI subscription credentials are unavailable in this Hermes profile; choose an approved API route");
  if (environmentCredentialsOnly() && process.env.ASSET_GRABBER_ADVISOR_PROVIDER && process.env.ASSET_GRABBER_ADVISOR_PROVIDER !== input.provider) throw new Error("Classifier provider is pinned by the host profile; change it through Hermes profile settings");
  const changed = input.provider !== settings.assetAdvisor.provider;
  const advisor = { ...settings.assetAdvisor, provider: input.provider, allowNetworkAiRanking: input.provider !== "none",
    model: input.model ?? (changed ? undefined : settings.assetAdvisor.model),
    customProviderUrl: settings.assetAdvisor.customProviderUrl };
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
    const triggerMode = await choose("Use automatically when a task needs assets, or only on request?", ["auto", "on-request"], "auto") as "auto" | "on-request";
    const control = await choose("Filesystem permissions: use Hermes approvals, or set up separately?", ["hermes", "separate"], "hermes");
    const accessMode = control === "hermes" ? "hermes" : await choose("Separate access: project (recommended), full (no plugin path limits), review (Asset Review Queue), no (suggest only; downloads need approval)", ["project", "full", "review", "no"], "project") as "project" | "full" | "review" | "no";
    if (accessMode === "full" && await choose("Full access can overwrite or expose sensitive files. Enable it?", ["y", "n"], "n") !== "y") throw new Error("Full access was not enabled");
    const projectsFolder = accessMode === "project" || accessMode === "review" ? validateProjectsFolder((await rl.question("Project workspace (absolute path; assets default to its asset-curator folder): ")).trim()) : undefined;
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
    await saveSettings({ ...settings, preferences: { licensePolicy, browserEnabled, acquisitionMode, triggerMode, projectsFolder, accessMode, completed: true }, assetAdvisor: advisor });
    console.log(`Saved ${resolveSettingsPath()}. Ready for agent use.`);
  } finally {
    rl.close();
  }
}
