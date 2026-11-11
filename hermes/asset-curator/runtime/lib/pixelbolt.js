import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createBundle } from "pixelbolt";
export const PIXELBOLT_VERSION = "0.15.0";
const root = new URL("../", pathToFileURL(createRequire(import.meta.url).resolve("pixelbolt")));
export function validatePixelRecipe(recipe) {
    const text = JSON.stringify(recipe);
    if (Buffer.byteLength(text) > 512 * 1024)
        throw new Error("Pixelbolt recipe exceeds 512 KiB cap");
    const clean = JSON.parse(text);
    const inspect = (value, depth) => {
        if (depth > 32)
            throw new Error("Pixelbolt recipe exceeds nesting cap");
        if (value && typeof value === "object")
            for (const [key, v] of Object.entries(value)) {
                if (["$ref", "__proto__", "prototype", "constructor"].includes(key))
                    throw new Error("Pixelbolt recipes must be self-contained; external/prototype references are not allowed");
                inspect(v, depth + 1);
            }
    };
    inspect(clean, 0);
    const width = Number(clean.width), height = Number(clean.height), frames = clean.frames;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || !Array.isArray(frames) || frames.length < 1 || frames.length > 64 || width * height * frames.length > 16_777_216)
        throw new Error("Pixelbolt requires valid dimensions, 1–64 frames and at most 16M frame pixels; upstream animated canvases also cap at 256 per side");
    const scale = Number(clean.sheet?.scale ?? 1);
    if (!Number.isInteger(scale) || scale < 1 || scale > 4 || width * height * frames.length * scale * scale > 16_777_216)
        throw new Error("Pixelbolt sheet scale/output exceeds 16M pixel cap");
    return clean;
}
export function createPixelboltAsset(recipe) {
    recipe = validatePixelRecipe(recipe);
    const id = "pixelbolt-" + createHash("sha256").update(PIXELBOLT_VERSION + JSON.stringify(recipe)).digest("hex").slice(0, 16);
    return {
        source: "procedural", id, title: "Pixelbolt recipe: " + String(recipe.name ?? "unnamed"), category: "2D",
        url: "https://github.com/skulitom/Pixelbolt", tags: ["pixelbolt", "code-generation", "editable"], series: ["Code generation"],
        license: "User-authored procedural recipe; Pixelbolt runtime MIT", licenseSafety: 10, attributionRequired: false,
        score: 10, reason: "Rendered from supplied declarative pixels/shapes/animation; no image model, sampled media or external file references",
        downloadMode: "direct", generatedAsset: { kind: "pixelbolt", recipe }
    };
}
export async function renderPixelboltAsset(asset) {
    const recipe = validatePixelRecipe(asset.recipe);
    const bundle = await createBundle(recipe);
    const files = [...bundle.files].map(([fileName, content]) => ({ fileName, content: content }));
    files.push({ fileName: "recipe.json", content: JSON.stringify(recipe, null, 2) + "\n" });
    files.push({ fileName: "LICENSE-Pixelbolt.txt", content: await readFile(new URL("LICENSE", root), "utf8") });
    files.push({ fileName: "GENERATION.json", content: JSON.stringify({ tool: "Pixelbolt", version: PIXELBOLT_VERSION, source: "https://github.com/skulitom/Pixelbolt", warnings: bundle.project.warnings, notes: bundle.notes, thirdPartyMedia: false }, null, 2) });
    files.push({ fileName: "generate.mjs", content: `// Reproduce with Asset Curator and its pinned Pixelbolt dependency. No network.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { renderPixelboltAsset } = await import("asset-grabber-mcp/pixelbolt").catch(() => import(${JSON.stringify(import.meta.url.endsWith(".ts") ? new URL("../dist/pixelbolt.js", import.meta.url).href : import.meta.url)}));
for (const f of await renderPixelboltAsset({ kind: "pixelbolt", recipe: JSON.parse(await readFile(new URL("./recipe.json", import.meta.url), "utf8")) })) {
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), f.fileName);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, f.content);
}
` });
    return files;
}
export async function pixelboltHelp(topic = "quickstart", section) {
    if (topic === "quickstart")
        return { tool: "Pixelbolt", version: PIXELBOLT_VERSION, text: await readFile(new URL("docs/agent-quick-start.md", root), "utf8"), note: "Use Asset Curator render_pixel_recipe for self-contained recipes; upstream CLI/MCP commands are optional, not required." };
    let value = JSON.parse(await readFile(new URL("schema.json", root), "utf8"));
    for (const key of section?.split(".") ?? []) {
        if (!/^[a-zA-Z0-9_$-]+$/.test(key) || !value || !Object.hasOwn(value, key))
            throw new Error("Schema section not found; use dot-separated JSON object keys");
        value = value[key];
    }
    const text = JSON.stringify(value, null, 2);
    return { tool: "Pixelbolt", version: PIXELBOLT_VERSION, section, text: text.slice(0, 24000), truncated: text.length > 24000, totalCharacters: text.length, note: "Narrow section (e.g. properties.frames) when truncated." };
}
//# sourceMappingURL=pixelbolt.js.map