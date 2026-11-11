import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetCategory, AssetDownloadMode } from "./types.js";

export type SourceRegistryEntry = {
  id: string;
  title: string;
  mode: AssetDownloadMode;
  category: AssetCategory;
  license: string;
  licenseSafety: number;
  notes: string;
  generation?: boolean;
};

export type SourceRegistry = {
  sources: SourceRegistryEntry[];
  priorityByCategory: Record<AssetCategory, string[]>;
};

const CATEGORIES = new Set<AssetCategory>(["2D", "3D", "Animation", "Audio", "Music", "Textures", "UI", "VFX", "Unknown"]);
const registry = loadRegistry();

export function sourceRegistry(): SourceRegistry {
  return registry;
}

export function sourceEntries(): SourceRegistryEntry[] {
  return registry.sources;
}

export function sourceIds(): string[] {
  return registry.sources.map((source) => source.id);
}

export function directSourceIds(): string[] {
  return sourcesByMode("direct");
}

export function assistedSourceIds(): string[] {
  return sourcesByMode("assisted");
}

export function manualSourceIds(): string[] {
  return sourcesByMode("manual");
}

export function isGenerationSource(id: string): boolean {
  return sourceEntry(id)?.generation === true;
}

export function sourceEntry(id: string): SourceRegistryEntry | undefined {
  return registry.sources.find((source) => source.id === id);
}

function sourcesByMode(mode: AssetDownloadMode): string[] {
  return registry.sources.filter((source) => source.mode === mode).map((source) => source.id);
}

function loadRegistry(): SourceRegistry {
  const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "asset-grabber-sources.json");
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as Partial<SourceRegistry>;
  const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isRegistryEntry) : [];
  if (sources.length === 0) throw new Error("asset-grabber-sources.json has no valid sources");
  const priorityByCategory = {} as Record<AssetCategory, string[]>;
  for (const category of CATEGORIES) {
    const priority = parsed.priorityByCategory?.[category];
    priorityByCategory[category] = Array.isArray(priority) ? uniqueStrings(priority) : [];
  }
  return { sources, priorityByCategory };
}

function isRegistryEntry(value: SourceRegistryEntry): value is SourceRegistryEntry {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      /^[a-z0-9-]+$/.test(value.id) &&
      typeof value.title === "string" &&
      ["direct", "assisted", "manual"].includes(value.mode) &&
      CATEGORIES.has(value.category) &&
      typeof value.license === "string" &&
      Number.isFinite(value.licenseSafety) &&
      typeof value.notes === "string"
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}
