import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertAcquisitionAllowed, loadSettings } from "./settings.js";
import { assertWithinSafeRoot, resolveAssetFile, resolveOutputDir, renameWithRetry } from "./util.js";
import { defaultSynthParameters, defaultSynthSong } from "./synthesis.js";
import { pixelboltHelp } from "./pixelbolt.js";
export const GENERATOR_IDS = ["pixelfx", "pixelbolt", "spritekiln", "sand3d", "material-maker", "zzfx", "zzfxm", "remotion"];
export const generatorProjectSchema = z.object({
    generator: z.enum(GENERATOR_IDS), request: z.string().min(1).max(2000),
    outputDir: z.string().optional(), seed: z.number().int().min(0).max(0xffffffff).optional()
});
const templateRoot = new URL("../generator-templates/", import.meta.url);
const moduleUrl = (name) => new URL(import.meta.url.endsWith(".ts") ? `../dist/${name}.js` : `./${name}.js`, import.meta.url).href;
export const GENERATOR_RECIPES = {
    pixelfx: { title: "PixelFX transparent torch effect starter", source: "https://github.com/patch-gg/pixelfx", version: "0.3.1", pin: "044e12a45dc9cc312cec50ee606dfc98afe5adc2", templateLicense: "MIT", runtime: "Optional reviewed PixelFX checkout + Node >=18; set PIXELFX_DIR", command: "node render.mjs", guide: "Edit effect.json: effect is category/id (default fire/torch), seed, fps and options. The script calls tools/render.mjs with --sheet --no-actor and normal transparent PNG/atlas export. No actor/showcase media, FFmpeg, browser or automatic checkout. Clone the exact reviewed commit yourself; inspect source before executing. Generated files go under output/<effect>." },
    pixelbolt: { title: "Pixelbolt self-contained two-frame sprite starter", source: "https://github.com/skulitom/Pixelbolt", version: "0.15.0", templateLicense: "MIT", runtime: "Bundled; also use render_pixel_recipe directly", command: "node render.mjs", guide: "Edit recipe.json, then render and inspect every frame at native size. Shapes/grids/palettes/animation are declarative; no external $ref or arbitrary JavaScript. Output includes PNG sheet, APNG, atlas and Godot SpriteFrames. get_generator_help provides the full installed guide/schema." },
    spritekiln: { title: "SpriteKiln CC0 humanoid idle animation starter", source: "https://github.com/LucasJRamos/spritekiln", version: "0.3.0", templateLicense: "CC0-1.0 humanoid template; MIT renderer", runtime: "Optional Python >=3.10 + spritekiln==0.3.0; NumPy/Pillow/PyYAML; no Blender/encoder weights", command: "python render.py", guide: "Edit model.yaml: SDF primitives, materials, bones and animation channels. The supplied 32px humanoid is a CC0 upstream template, NOT a generated match for arbitrary intent. render.py renders six idle frames south using the CPU numpy backend, producing real atlas/JSON/previews. Use --anims idle,walk,attack and --dirs all for more. --draft creates previews only, NOT final atlas output. No init command or global agent/MCP config mutation. Showcase assets are excluded and all-rights-reserved." },
    sand3d: { title: "sand3d parametric bracket GLB starter", source: "https://github.com/Sandflow-ai/sand3d", version: "1.6.3", templateLicense: "Apache-2.0 adapted example", runtime: "Optional Python 3.11 or 3.13 + sand3d==1.6.3; LARGE bpy dependency; Python 3.12 unsupported", command: "python render.py", guide: "Edit render.py to author the requested geometry. Example uses s3d.rect, extrude, hole(grid), fillet and export(..., bracket.glb). Units default to millimetres. This is a bracket starter, not arbitrary text-to-3D. Native model presets remain available without Blender. Install only in a deliberately chosen compatible environment; inspect geometry, units and grounding before importing." },
    "material-maker": { title: "Material Maker metal-pattern PBR node graph starter", source: "https://github.com/RodZill4/material-maker", version: "official .ptex graph/CLI", templateLicense: "MIT upstream graph", runtime: "Optional installed Material Maker (Godot-based app); set MATERIAL_MAKER_EXECUTABLE", command: "node render.mjs", guide: "Open/edit material.ptex in Material Maker, or edit its serialized nodes/connections. Included MIT metal-pattern example connects pattern, colorize, transform, blend, normal_map and Material nodes. render.mjs uses official --export-material --target Godot -o output material.ptex. It does not install Godot/the app. Exporter/runtime availability is not implied by JSON validation; inspect real maps and tangent-normal conventions." },
    zzfx: { title: "ZzFX parameterized sound starter", source: "https://github.com/KilledByAPixel/ZzFX", version: "1.4.0", pin: "ac5a4727a44e5506a12f7340087e0b889cfd69dc", templateLicense: "MIT synth; own parameterized output", runtime: "Bundled; also generate_asset preset zzfx-sfx", command: "node render.mjs", guide: "Edit recipe.json parameters in this order: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo, filter. null uses upstream default. Shape 0–5, envelope <=10s. Local seeded RNG, mono PCM WAV 44100Hz, no Web Audio requirement, 3ms edge fade and peak limiting." },
    zzfxm: { title: "ZzFXM editable tracker music starter", source: "https://github.com/keithclark/ZzFXM", version: "2.0.3", pin: "cb07fa9ca36aefd67a0c8c656d2958b62f8ed9fe", templateLicense: "MIT tracker/synth; own composition", runtime: "Bundled; also generate_asset preset zzfxm-music", command: "node render.mjs", guide: "Edit recipe.json song: instruments are ZzFX parameter arrays; patterns contain channels [instrumentIndex, pan(-1..1), ...notes]; sequence lists pattern indexes; bpm 40–240. Note 12 uses instrument base frequency; semitones transpose it, 0 holds, -1 stops, fractional parts attenuate. Equal step counts per pattern, <=4 instruments/channels and <=30s. Stereo 44100Hz WAV, no samples/models/network. Check composition rights when supplying existing melodies." },
    remotion: { title: "Remotion original motion-card React starter", source: "https://github.com/remotion-dev/remotion", version: "4.0.542", templateLicense: "MIT original starter; Remotion runtime has separate Free/Company License", runtime: "Optional pinned Node dependencies + installed Chrome; eligibility/license confirmation required", command: "node render.mjs", guide: "Edit src/index.tsx: React + AbsoluteFill/useCurrentFrame/interpolate/Composition/registerRoot. 1280x720, 30fps, 120 frames (4s), no fonts/media/network sources. Review package.json then install dependencies explicitly. Set REMOTION_BROWSER_EXECUTABLE to installed Chrome; automatic browser downloads are refused by this starter. Read LICENSE-Remotion.md, then set REMOTION_LICENSE_ELIGIBLE=1 only if eligible (individual, <=3-employee for-profit, nonprofit, evaluation) or properly licensed. For-profit larger organizations need a Company License. No license purchase or render is performed by project creation." }
};
export function listGeneratorRecipes() {
    return GENERATOR_IDS.map(id => ({ id, ...GENERATOR_RECIPES[id], projectTool: "create_generator_project", execution: ["pixelbolt", "zzfx", "zzfxm"].includes(id) ? "direct built-in rendering and editable project" : "optional external runtime; authoring project only until explicitly rendered", automaticInstall: false }));
}
async function templateFiles(id, seed) {
    const files = {};
    if (["pixelbolt", "zzfx", "zzfxm"].includes(id)) {
        const pixel = id === "pixelbolt";
        files["recipe.json"] = JSON.stringify(pixel ? {
            version: 1, name: "marker", width: 16, height: 16, palette: { g: "#53c8a2", k: "#183438" },
            frames: [{ name: "rest", duration: 160, ops: [{ op: "ellipse", x: 3, y: 4, w: 10, h: 11, color: "g" }, { op: "pixel", x: 7, y: 8, color: "k" }] }, { name: "up", duration: 160, from: "rest", translate: [0, -2] }],
            animations: { idle: { frames: ["rest", "up"] } }, sheet: { padding: 0, columns: 2 }
        } : { request: GENERATOR_RECIPES[id].title, preset: id === "zzfx" ? "zzfx-sfx" : "zzfxm-music", seed, ...(id === "zzfx" ? { parameters: defaultSynthParameters("laser") } : { song: defaultSynthSong(seed) }) }, null, 2) + "\n";
        files["render.mjs"] = `import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url)), out = path.join(root, "output");
const recipe = JSON.parse(await readFile(path.join(root, "recipe.json"), "utf8"));
const module = await import(${JSON.stringify(pixel ? "asset-grabber-mcp/pixelbolt" : "asset-grabber-mcp/generation")}).catch(() => import(${JSON.stringify(moduleUrl(pixel ? "pixelbolt" : "generation"))}));
const files = ${pixel ? 'await module.renderPixelboltAsset({ kind: "pixelbolt", recipe })' : 'module.renderGeneratedAsset(module.createGeneratedAsset(recipe).generatedAsset)'};
for (const f of files) {
  const target = path.resolve(out, f.fileName), relative = path.relative(out, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe output path");
  await mkdir(path.dirname(target), {recursive:true}); await writeFile(target, f.content);
}
console.log("Rendered to", out);
`;
    }
    else {
        const folder = new URL(`${id}/`, templateRoot);
        const walk = async (relative = "") => {
            for (const entry of await readdir(new URL(relative, folder), { withFileTypes: true })) {
                const name = relative + entry.name;
                if (entry.isDirectory())
                    await walk(name + "/");
                else if (entry.isFile())
                    files[name] = await readFile(new URL(name, folder), "utf8");
            }
        };
        await walk();
        if (id === "pixelfx")
            files["effect.json"] = JSON.stringify({ effect: "fire/torch", seed, fps: 12, options: {} }, null, 2) + "\n";
    }
    files["LICENSE-Asset-Grabber.txt"] = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
    files["render.bat"] = `@echo off\r\n${files["render.py"] ? "python" : "node"} "%~dp0${files["render.py"] ? "render.py" : "render.mjs"}"\r\n`;
    files["AUTHORING.md"] = `# ${GENERATOR_RECIPES[id].title}\n\nThis is editable SOURCE, not a rendered match for arbitrary user intent. Adapt it to the actual request before rendering.\n\n${GENERATOR_RECIPES[id].guide}\n\nRuntime: ${GENERATOR_RECIPES[id].runtime}\nRun from this project: \`${GENERATOR_RECIPES[id].command}\` (Windows: render.bat). This explicitly executes local code and may replace generated output/ files; preserve hand edits elsewhere. Review code and optional dependencies first. No package, model, browser, account or license installation/purchase occurs automatically. Do not adopt signed-in browser profiles, accept terms, solve CAPTCHAs or fetch other credentials.\n\nAfter rendering: inspect actual images/frames/models/audio; don't confuse a successful process or schema validation with artistic correctness. Then use prepare_existing_asset with sourcePath pointing to the rendered output, origin=created, and the ACTUAL license/ownership and source URL. Keep all upstream notices, attribution and input rights; safe is not legal clearance. No submission/publication is performed.\n\nTool source: ${GENERATOR_RECIPES[id].source}\nTemplate/input terms: ${GENERATOR_RECIPES[id].templateLicense}. Runtime terms may differ.\n`;
    return files;
}
export async function createGeneratorProject(raw) {
    const input = generatorProjectSchema.parse(raw), settings = await loadSettings();
    assertAcquisitionAllowed(settings, "create");
    const files = await templateFiles(input.generator, input.seed ?? 42);
    const id = input.generator + "-" + createHash("sha256").update(JSON.stringify({ request: input.request, files })).digest("hex").slice(0, 16);
    const parent = path.join(resolveOutputDir(input.outputDir || settings.search.defaultOutputDir), "generator-projects");
    const root = path.join(parent, id);
    assertWithinSafeRoot(root, "generator project");
    if (existsSync(root)) {
        let previous;
        try {
            previous = JSON.parse(await readFile(path.join(root, "asset-generator-project.json"), "utf8"));
        }
        catch {
            throw new Error("Refusing existing unowned generator project; choose another outputDir");
        }
        if (previous.id !== id || previous.generator !== input.generator)
            throw new Error("Generator project ownership mismatch");
        return { ...previous, root, output: path.join(root, "output"), reused: true, note: "Existing source preserved; edits were NOT overwritten" };
    }
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(path.join(parent, ".project-staging-"));
    const manifest = { id, generator: input.generator, intent: input.request, template: GENERATOR_RECIPES[input.generator].title, source: GENERATOR_RECIPES[input.generator].source, version: GENERATOR_RECIPES[input.generator].version, templateLicense: GENERATOR_RECIPES[input.generator].templateLicense, runtime: GENERATOR_RECIPES[input.generator].runtime, command: GENERATOR_RECIPES[input.generator].command, status: "authoring-project; no render or installation performed", createdAt: new Date().toISOString(), files: Object.keys(files) };
    try {
        for (const [name, content] of Object.entries(files)) {
            const target = resolveAssetFile(staging, name);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content, "utf8");
        }
        await writeFile(path.join(staging, "asset-generator-project.json"), JSON.stringify(manifest, null, 2) + "\n");
        await renameWithRetry(staging, root);
        return { ...manifest, root, output: path.join(root, "output"), reused: false };
    }
    finally {
        await rm(staging, { recursive: true, force: true });
    }
}
export async function generatorHelp(generator = "pixelbolt", topic, section) {
    if (generator === "pixelbolt")
        return pixelboltHelp(topic, section);
    return { generator, ...GENERATOR_RECIPES[generator], tool: "create_generator_project", note: "Writes full editable source/recipe files, not static links. No render/install by this call. Bundled zzfx/zzfxm also render directly using generate_asset." };
}
//# sourceMappingURL=generator-recipes.js.map