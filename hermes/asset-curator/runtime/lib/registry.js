import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const CATEGORIES = new Set(["2D", "3D", "Animation", "Audio", "Music", "Textures", "UI", "VFX", "Unknown"]);
const registry = loadRegistry();
export function sourceRegistry() {
    return registry;
}
export function sourceEntries() {
    return registry.sources;
}
export function sourceIds() {
    return registry.sources.map((source) => source.id);
}
export function directSourceIds() {
    return sourcesByMode("direct");
}
export function assistedSourceIds() {
    return sourcesByMode("assisted");
}
export function manualSourceIds() {
    return sourcesByMode("manual");
}
export function isGenerationSource(id) {
    return sourceEntry(id)?.generation === true;
}
export function sourceEntry(id) {
    return registry.sources.find((source) => source.id === id);
}
function sourcesByMode(mode) {
    return registry.sources.filter((source) => source.mode === mode).map((source) => source.id);
}
function loadRegistry() {
    const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "asset-grabber-sources.json");
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isRegistryEntry) : [];
    if (sources.length === 0)
        throw new Error("asset-grabber-sources.json has no valid sources");
    const priorityByCategory = {};
    for (const category of CATEGORIES) {
        const priority = parsed.priorityByCategory?.[category];
        priorityByCategory[category] = Array.isArray(priority) ? uniqueStrings(priority) : [];
    }
    return { sources, priorityByCategory };
}
function isRegistryEntry(value) {
    return Boolean(value &&
        typeof value.id === "string" &&
        /^[a-z0-9-]+$/.test(value.id) &&
        typeof value.title === "string" &&
        ["direct", "assisted", "manual"].includes(value.mode) &&
        CATEGORIES.has(value.category) &&
        typeof value.license === "string" &&
        Number.isFinite(value.licenseSafety) &&
        typeof value.notes === "string");
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}
//# sourceMappingURL=registry.js.map