import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "./util.js";
import { environmentCredentialsOnly } from "./runtime-profile.js";
import os from "node:os";
import path from "node:path";
import { sourceIds, sourceRegistry } from "./registry.js";
import { ADVISOR_PROVIDERS, MODEL_PROVIDERS } from "./models.js";
import type { AssetCategory, AssetGrabberSettings, AssetSearchResult, CustomAssetSourceSetting } from "./types.js";

const CATEGORIES: AssetCategory[] = ["2D", "3D", "Animation", "Audio", "Music", "Textures", "UI", "VFX", "Unknown"];

const REGISTRY = sourceRegistry();

export const DEFAULT_SETTINGS: AssetGrabberSettings = {
  preferences: { completed: false, licensePolicy: "safe", browserEnabled: false, acquisitionMode: "both", triggerMode: "auto" },
  assetAdvisor: {
    provider: "none",
    customProviderModel: "",
    deepseekModel: "deepseek-flash",
    allowNetworkAiRanking: false
  },
  search: {
    allowManualResults: false,
    allowUnknownLicense: false,
    minLicenseSafety: 6,
    keepSourceArchives: true,
    maxResultsDefault: 8,
    maxDownloadBytes: 750 * 1024 * 1024,
    maxExtractedBytes: 2 * 1024 * 1024 * 1024,
    maxExtractedFiles: 10_000
  },
  sources: Object.fromEntries(sourceIds().map((source) => [source, { enabled: true }])),
  priorityByCategory: REGISTRY.priorityByCategory,
  customSources: []
};

export async function loadSettings(): Promise<AssetGrabberSettings> {
  const target = resolveSettingsPath();
  try {
    const input = JSON.parse(stripBom(await readFile(target, "utf8")));
    if (environmentCredentialsOnly() && input.credentialMode !== "environment") throw new Error("Expected nonsecret profile preferences");
    return normalizeSettings(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Cannot read Asset Curator settings; repair the file or use --setup with another settings path.");
    }
    return normalizeSettings({});
  }
}

// Retained for API compatibility. Settings are reloaded so an open agent sees UI updates.
export function resetSettingsCache(): void {}

export function resolveSettingsPath(): string {
  if (environmentCredentialsOnly() && !process.env.ASSET_GRABBER_SETTINGS_PATH) throw new Error("Environment-only mode requires an explicit plugin-owned nonsecret settings path");
  if (process.env.ASSET_GRABBER_SETTINGS_PATH) return path.resolve(process.env.ASSET_GRABBER_SETTINGS_PATH);
  const legacy = path.resolve("asset-grabber-settings.json");
  if (existsSync(legacy)) return legacy;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "asset-grabber", "settings.json");
}

export async function saveSettings(input: Partial<AssetGrabberSettings>): Promise<AssetGrabberSettings> {
  const envOnly = environmentCredentialsOnly();
  if (envOnly && [input.assetAdvisor?.apiKey, input.assetAdvisor?.deepseekApiKey, input.assetAdvisor?.customProviderApiKey].some(Boolean)) throw new Error("Environment-only mode does not accept stored API keys; use Hermes approved secret/profile settings");
  const settings = normalizeSettings(input);
  if (envOnly && settings.assetAdvisor.customProviderUrl && (credentialUrl(settings.assetAdvisor.customProviderUrl) || new URL(settings.assetAdvisor.customProviderUrl).search || new URL(settings.assetAdvisor.customProviderUrl).hash)) throw new Error("Environment-only classifier URLs must not contain credentials, query or fragment");
  const stored = envOnly ? { credentialMode: "environment", assetAdvisor: { provider: settings.assetAdvisor.provider, model: settings.assetAdvisor.model, customProviderUrl: settings.assetAdvisor.customProviderUrl, allowNetworkAiRanking: settings.assetAdvisor.allowNetworkAiRanking }, preferences: settings.preferences, search: settings.search, sources: settings.sources, priorityByCategory: settings.priorityByCategory, customSources: settings.customSources } : settings;
  const target = resolveSettingsPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await renameWithRetry(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return settings;
}

export function redactSettings(settings: AssetGrabberSettings): AssetGrabberSettings {
  const redacted = structuredClone(settings);
  for (const key of ["apiKey", "deepseekApiKey", "customProviderApiKey"] as const) {
    redacted.assetAdvisor[key] = settings.assetAdvisor[key] ? "[configured]" : undefined;
  }
  redacted.assetAdvisor.customProviderUrl = redactUrl(redacted.assetAdvisor.customProviderUrl, true);
  redacted.customSources = redacted.customSources.map(source => ({ ...source, url: redactUrl(source.url) ?? "" }));
  return redacted;
}

export function assertAcquisitionAllowed(settings: AssetGrabberSettings, kind: "existing" | "create"): void {
  if (!settings.preferences.completed) throw new Error("SETUP_REQUIRED: ask the user the get_setup questions, then configure_preferences; or run asset-grabber-mcp --setup.");
  if (settings.preferences.acquisitionMode !== "both" && settings.preferences.acquisitionMode !== kind) {
    throw new Error(`Acquisition mode is ${settings.preferences.acquisitionMode}; ${kind} assets are disabled. Change preferences only on user request.`);
  }
}

export function normalizeSettings(input: Partial<AssetGrabberSettings>): AssetGrabberSettings {
  input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preferences = input.preferences;
  const validPreferences = preferences && ["safe", "any"].includes(preferences.licensePolicy) &&
    ["existing", "create", "both"].includes(preferences.acquisitionMode) && typeof preferences.browserEnabled === "boolean";
  const merged: AssetGrabberSettings = {
    preferences: {
      completed: validPreferences ? preferences.completed === true : false,
      licensePolicy: preferences?.licensePolicy === "any" ? "any" : "safe",
      browserEnabled: preferences?.browserEnabled === true,
      acquisitionMode: ["existing", "create", "both"].includes(preferences?.acquisitionMode ?? "") ? preferences!.acquisitionMode : "both",
      // Settings saved before 0.2.2 have no trigger choice; they keep the previous agent-decides behaviour.
      triggerMode: preferences?.triggerMode === "on-request" ? "on-request" : "auto"
    },
    assetAdvisor: {
      ...DEFAULT_SETTINGS.assetAdvisor,
      ...(environmentCredentialsOnly() ? environmentAdvisor(input.assetAdvisor) : input.assetAdvisor ?? {})
    },
    search: {
      ...DEFAULT_SETTINGS.search,
      ...(input.search ?? {})
    },
    sources: {
      ...DEFAULT_SETTINGS.sources,
      ...(input.sources ?? {})
    },
    priorityByCategory: {
      ...DEFAULT_SETTINGS.priorityByCategory,
      ...(input.priorityByCategory ?? {})
    },
    customSources: Array.isArray(input.customSources) ? input.customSources.filter(isValidCustomSource) : []
  };
  if (!ADVISOR_PROVIDERS.includes(merged.assetAdvisor.provider)) {
    merged.assetAdvisor.provider = DEFAULT_SETTINGS.assetAdvisor.provider;
  }
  merged.assetAdvisor.apiKey = cleanOptionalString(merged.assetAdvisor.apiKey);
  merged.assetAdvisor.model = cleanOptionalString(merged.assetAdvisor.model);
  const preset = MODEL_PROVIDERS[merged.assetAdvisor.provider as keyof typeof MODEL_PROVIDERS];
  if (merged.assetAdvisor.model === undefined) {
    merged.assetAdvisor.model = merged.assetAdvisor.provider === "custom" ? cleanOptionalString(merged.assetAdvisor.customProviderModel)
      : merged.assetAdvisor.provider === "deepseek" ? cleanOptionalString(merged.assetAdvisor.deepseekModel) : preset?.model;
  }
  if (merged.assetAdvisor.apiKey === undefined) {
    if (merged.assetAdvisor.provider === "deepseek") merged.assetAdvisor.apiKey = cleanOptionalString(merged.assetAdvisor.deepseekApiKey);
    if (merged.assetAdvisor.provider === "custom") merged.assetAdvisor.apiKey = cleanOptionalString(merged.assetAdvisor.customProviderApiKey);
  }
  merged.assetAdvisor.customProviderUrl = cleanOptionalString(merged.assetAdvisor.customProviderUrl);
  merged.assetAdvisor.deepseekApiKey = cleanOptionalString(merged.assetAdvisor.deepseekApiKey);
  merged.assetAdvisor.customProviderApiKey = cleanOptionalString(merged.assetAdvisor.customProviderApiKey);
  merged.assetAdvisor.customProviderModel = cleanOptionalString(merged.assetAdvisor.customProviderModel);
  merged.assetAdvisor.deepseekModel = cleanOptionalString(merged.assetAdvisor.deepseekModel) || DEFAULT_SETTINGS.assetAdvisor.deepseekModel;

  for (const key of ["allowManualResults", "allowUnknownLicense", "keepSourceArchives"] as const) {
    merged.search[key] = typeof merged.search[key] === "boolean" ? merged.search[key] : DEFAULT_SETTINGS.search[key];
  }
  merged.assetAdvisor.allowNetworkAiRanking = merged.assetAdvisor.allowNetworkAiRanking === true;
  merged.search.minLicenseSafety = clampNumber(merged.search.minLicenseSafety, 0, 10, DEFAULT_SETTINGS.search.minLicenseSafety);
  merged.search.maxResultsDefault = Math.round(clampNumber(merged.search.maxResultsDefault, 1, 25, DEFAULT_SETTINGS.search.maxResultsDefault));
  merged.search.maxDownloadBytes = Math.round(clampNumber(merged.search.maxDownloadBytes, 1_000_000, 10_000_000_000, DEFAULT_SETTINGS.search.maxDownloadBytes));
  merged.search.maxExtractedBytes = Math.round(clampNumber(merged.search.maxExtractedBytes, 1_000_000, 20_000_000_000, DEFAULT_SETTINGS.search.maxExtractedBytes));
  merged.search.maxExtractedFiles = Math.round(clampNumber(merged.search.maxExtractedFiles, 1, 100_000, DEFAULT_SETTINGS.search.maxExtractedFiles));

  for (const category of CATEGORIES) {
    const priority = merged.priorityByCategory[category];
    merged.priorityByCategory[category] = Array.isArray(priority) ? uniqueStrings(priority) : DEFAULT_SETTINGS.priorityByCategory[category];
  }

  return merged;
}

export function isSourceEnabled(settings: AssetGrabberSettings, source: string): boolean {
  if (source.startsWith("custom:")) {
    return settings.customSources.some((customSource) => customSource.enabled && `custom:${customSource.id}` === source);
  }
  return settings.sources[source]?.enabled ?? true;
}

export function sourcePriorityBoost(settings: AssetGrabberSettings, category: AssetCategory | undefined, source: string): number {
  const priority = settings.priorityByCategory[category ?? "Unknown"] ?? settings.priorityByCategory.Unknown;
  const index = priority.indexOf(source);
  return index === -1 ? 0 : (priority.length - index) * 1.5;
}

export function passesLicenseSettings(
  settings: AssetGrabberSettings,
  result: AssetSearchResult,
  options: { includeManualResults?: boolean } = {}
): boolean {
  if (!options.includeManualResults && result.manualDownload) return false;
  if (settings.preferences.licensePolicy === "any" && settings.preferences.completed) return true;
  const licenseSafety = result.licenseSafety ?? (result.license.toLowerCase().includes("cc0") ? 10 : 0);
  return !/verify|unknown|per.item|license varies/i.test(result.license) && licenseSafety >= Math.max(6, settings.search.minLicenseSafety);
}

export function customSourceResults(settings: AssetGrabberSettings, requestCategory: AssetCategory | undefined): AssetSearchResult[] {
  return settings.customSources
    .filter((source) => source.enabled)
    .filter((source) => !requestCategory || requestCategory === "Unknown" || source.category === requestCategory || source.category === "Unknown")
    .map((source) => customSourceToResult(source));
}

function customSourceToResult(source: CustomAssetSourceSetting): AssetSearchResult {
  const id = `custom:${source.id}`;
  return {
    source: id,
    id: source.id,
    title: source.title,
    url: source.url,
    category: source.category,
    tags: source.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    series: ["Custom"],
    license: source.license || "Custom source; verify license before shipping",
    licenseSafety: /^(?:creative commons )?cc0(?: 1\.0)?$|^public domain$/i.test(source.license?.trim() ?? "") ? 10 : 0,
    downloadMode: "manual",
    assistInstructions: [
      "Open source URL in browser.",
      "Verify license and download terms before using asset.",
      "Download manually, then preserve source URL and license metadata beside imported files."
    ],
    manualDownload: true,
    score: 7,
    reason: source.reason || "User-configured custom provider link"
  };
}

function isValidCustomSource(source: CustomAssetSourceSetting): boolean {
  if (source && typeof source.url === "string" && credentialUrl(source.url)) return false;
  return Boolean(
    source &&
      typeof source.id === "string" &&
      /^[a-z0-9-]+$/.test(source.id) &&
      typeof source.title === "string" &&
      typeof source.url === "string" &&
      /^https?:\/\//i.test(source.url) &&
      CATEGORIES.includes(source.category)
  );
}

function environmentAdvisor(saved: Partial<AssetGrabberSettings["assetAdvisor"]> = {}): Partial<AssetGrabberSettings["assetAdvisor"]> {
  const requested = process.env.ASSET_GRABBER_ADVISOR_PROVIDER ?? saved.provider ?? "none";
  const provider = requested === "custom" || Object.hasOwn(MODEL_PROVIDERS, requested) ? requested as AssetGrabberSettings["assetAdvisor"]["provider"] : "none";
  return { provider, model: process.env.ASSET_GRABBER_ADVISOR_MODEL ?? saved.model, customProviderUrl: process.env.ASSET_GRABBER_ADVISOR_URL ?? saved.customProviderUrl, allowNetworkAiRanking: provider !== "none" };
}

const SECRET_QUERY = /^(?:api[-_]?key|key|access[-_]?token|refresh[-_]?token|token|auth(?:orization)?|password|passwd|secret|signature|sig|credential|session(?:id)?|x-amz-.*|x-goog-.*)$/i;

function credentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some(key => SECRET_QUERY.test(key)) || url.hash.includes("=") && [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => SECRET_QUERY.test(key)));
  } catch { return true; }
}

function redactUrl(value: string | undefined, model = false): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = ""; url.password = "";
    if (model) { url.search = ""; url.hash = ""; }
    else {
      for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) url.searchParams.set(key, "[redacted]");
      if (url.hash.includes("=") && [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => SECRET_QUERY.test(key))) url.hash = "";
    }
    return url.href;
  } catch { return "[invalid URL]"; }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
