import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { slugify } from "./util.js";
import { defaultSynthParameters, defaultSynthSong, normalizeSynthParameters, renderSynthSong, renderSynthSound, SYNTH_LICENSE, synthParametersSchema, synthSongSchema, validateSynthSong } from "./synthesis.js";
export const GENERATOR_PRESETS = {
    "sprite-slime": { category: "2D", title: "Animated slime sprite", match: /\bslime\b/i },
    "sprite-coin": { category: "2D", title: "Spinning coin sprite", match: /\bcoin\b/i },
    "sprite-gem": { category: "2D", title: "Floating gem sprite", match: /\b(gem|crystal|diamond)\b/i },
    "sprite-heart": { category: "2D", title: "Pulsing heart sprite", match: /\bheart\b/i },
    "vfx-burst": { category: "VFX", title: "Pixel particle burst", match: /\b(burst|explosion|sparkle|impact)\b/i },
    "vfx-portal": { category: "VFX", title: "Looping magic portal", match: /\bportal\b/i },
    "vfx-fire": { category: "VFX", title: "Looping pixel fire", match: /\b(fire|flame|campfire)\b/i },
    "texture-stone": { category: "Textures", title: "Seamless stone brick PBR material", match: /\b(stone|brick|masonry)\b/i },
    "texture-wood": { category: "Textures", title: "Seamless wood PBR material", match: /\b(wood|timber|plank)\b/i },
    "texture-metal": { category: "Textures", title: "Seamless metal PBR material", match: /\b(metal|steel|iron)\b/i },
    "model-crate": { category: "3D", title: "Low-poly wooden crate GLB", match: /\b(crate|box)\b/i },
    "model-tree": { category: "3D", title: "Low-poly conifer tree GLB", match: /\b(tree|pine|conifer)\b/i },
    "model-rock": { category: "3D", title: "Low-poly rock GLB", match: /\b(rock|boulder|stone)\b/i },
    "model-barrel": { category: "3D", title: "Low-poly metal barrel GLB", match: /\b(barrel|drum|keg)\b/i },
    "music-arcade": { category: "Music", title: "Synthesized arcade music loop", match: /\b(arcade|chiptune|8.bit)\b/i },
    "music-ambient": { category: "Music", title: "Synthesized ambient music loop", match: /\b(ambient|calm|relax|meditative)\b/i },
    "zzfx-sfx": { category: "Audio", title: "Parameterized ZzFX sound effect", match: /\bzzfx\b/i },
    "zzfxm-music": { category: "Music", title: "Editable ZzFXM tracker composition", match: /\bzzfxm\b/i }
};
const presetNames = Object.keys(GENERATOR_PRESETS);
export const generationInputSchema = z.object({
    request: z.string().min(1).max(2000),
    preset: z.enum(presetNames).optional(),
    seed: z.number().int().min(0).max(0xffffffff).optional(),
    size: z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128), z.literal(256)]).optional(),
    frames: z.number().int().min(1).max(32).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    parameters: synthParametersSchema.optional().describe("ZzFX only, in this order (null keeps the default): volume 0-1, randomness 0-1, frequency Hz 0-16000, attack s 0-5, sustain s 0-5, release s 0-5, shape integer 0-5, shapeCurve 0-8, slide, deltaSlide, pitchJump, pitchJumpTime 0-5, repeatTime 0-5, noise, modulation, bitCrush 0-1, delay s 0-5, sustainVolume 0-1, decay s 0-5, tremolo 0-1, filter -20000 to 20000. attack+sustain+release+delay+decay must total 10 s or less."),
    song: synthSongSchema.optional().describe("ZzFXM only: instruments, equal-length tracker channels [instrument, pan, ...notes], pattern sequence and BPM; 30 seconds maximum.")
});
export function listGeneratorPresets() {
    return Object.entries(GENERATOR_PRESETS).map(([preset, { category, title }]) => ({ preset, category, title, formats: category === "3D" ? ["glb"] : category === "Music" || category === "Audio" ? ["wav", "json"] : ["png", "json"], runtime: "built-in; no external install", license: "Original procedural output; no third-party media", limits: "Named presets, not general text-to-image or arbitrary 3D modeling" }));
}
export function createGeneratedAsset(input) {
    input = generationInputSchema.parse(input);
    const preset = input.preset ?? inferPreset(input.request);
    if (!preset)
        throw new Error(`No native generator matches this request. Choose a supported preset with list_generators, or use an external generator recipe. Available: ${presetNames.join(", ")}`);
    const meta = GENERATOR_PRESETS[preset];
    const seed = input.seed ?? createHash("sha256").update(`${preset}:${input.request}`).digest().readUInt32LE(0);
    const size = input.size ?? (meta.category === "Textures" ? 128 : 32);
    const frames = meta.category === "VFX" || meta.category === "2D" ? input.frames ?? (meta.category === "VFX" ? 16 : 8) : 1;
    if (input.parameters && preset !== "zzfx-sfx")
        throw new Error("parameters are supported only by zzfx-sfx");
    if (input.song && preset !== "zzfxm-music")
        throw new Error("song is supported only by zzfxm-music");
    const parameters = preset === "zzfx-sfx" ? normalizeSynthParameters(input.parameters ?? defaultSynthParameters(input.request)) : undefined;
    const song = preset === "zzfxm-music" ? validateSynthSong(input.song ?? defaultSynthSong(seed)) : undefined;
    const key = createHash("sha256").update(JSON.stringify({ preset, seed, size, frames, color: input.color, parameters, song })).digest("hex").slice(0, 12);
    const id = `${preset}-${key}`;
    return {
        source: "procedural", id, title: meta.title, category: meta.category,
        url: "https://github.com/dev-willbird1936/Asset-Curator", tags: preset.split("-"), series: ["Native code generation"],
        license: "Original procedural output; no third-party media", licenseSafety: 10, attributionRequired: false,
        score: 8, reason: `Deterministic ${preset}; seed ${seed}. Limited to the named preset, not arbitrary prompt synthesis.`, downloadMode: "direct",
        generatedAsset: { kind: "procedural", preset, seed, size, frames, color: input.color, parameters, song, baseName: slugify(id) }
    };
}
export async function searchGeneratedAssets(options) {
    if (!/\bzzfxm?\b/i.test(options.request) && (options.category === "Audio" || /\b(sound|sfx|audio)\b/i.test(options.request)))
        return [];
    const preset = inferPreset(options.request, options.category);
    return preset ? [createGeneratedAsset({ request: options.request, preset })] : [];
}
function inferPreset(request, category) {
    if (/\bzzfxm\b/i.test(request))
        return "zzfxm-music";
    if (/\bzzfx\b/i.test(request))
        return "zzfx-sfx";
    let kind;
    if (category === "Music" || /\b(music|song|melody|chiptune)\b/i.test(request))
        kind = "music";
    else if (category === "Textures" || /\b(texture|material|pbr)\b/i.test(request))
        kind = "texture";
    else if (category === "VFX" || /\b(vfx|particle|burst|portal|flame|fire|explosion)\b/i.test(request))
        kind = "vfx";
    else if (category === "2D" || category === "UI" || /\b(sprite|pixel|2d|icon)\b/i.test(request))
        kind = "sprite";
    else if (category === "3D" || /\b(model|3d|low.poly|crate|tree|rock|boulder)\b/i.test(request))
        kind = "model";
    return presetNames.find((preset) => preset.startsWith(`${kind}-`) && GENERATOR_PRESETS[preset].match.test(request));
}
export function renderGeneratedAsset(asset) {
    // Validate even internal/manifest callers: generation must never allocate unbounded canvases.
    generationInputSchema.parse({ request: asset.baseName, preset: asset.preset, seed: asset.seed, size: asset.size, frames: asset.frames, color: asset.color, parameters: asset.parameters, song: asset.song });
    const files = asset.preset === "zzfx-sfx" ? [{ fileName: "sound.wav", content: renderSynthSound(asset.parameters ?? defaultSynthParameters(asset.baseName), asset.seed) }, { fileName: "LICENSE-ZzFX.txt", content: SYNTH_LICENSE }]
        : asset.preset === "zzfxm-music" ? [{ fileName: "music.wav", content: renderSynthSong(asset.song ?? defaultSynthSong(asset.seed), asset.seed) }, { fileName: "score.json", content: JSON.stringify(asset.song ?? defaultSynthSong(asset.seed), null, 2) }, { fileName: "LICENSE-ZzFX.txt", content: SYNTH_LICENSE }]
            : asset.preset.startsWith("model-") ? renderModel(asset)
                : asset.preset.startsWith("texture-") ? renderTexture(asset)
                    : asset.preset.startsWith("music-") ? renderMusic(asset) : renderSprites(asset);
    const recipe = { request: GENERATOR_PRESETS[asset.preset].title, preset: asset.preset, seed: asset.seed, size: asset.size, frames: asset.frames, color: asset.color, parameters: asset.parameters, song: asset.song };
    files.push({ fileName: "recipe.json", content: `${JSON.stringify(recipe, null, 2)}\n` });
    files.push({ fileName: "generate.mjs", content: `// Reproduce with the installed Asset Curator package. No network or AI required.\nimport { readFile, writeFile } from 'node:fs/promises';\nconst { renderGeneratedAsset, createGeneratedAsset } = await import('asset-grabber-mcp/generation').catch(() => import(${JSON.stringify(import.meta.url.endsWith('.ts') ? new URL('../dist/generation.js', import.meta.url).href : import.meta.url)}));\nconst recipe = JSON.parse(await readFile(new URL('./recipe.json', import.meta.url), 'utf8'));\nconst asset = createGeneratedAsset(recipe).generatedAsset;\nfor (const file of renderGeneratedAsset(asset)) await writeFile(new URL(file.fileName, import.meta.url), file.content);\nconsole.log('Regenerated', asset.preset);\n` });
    return files;
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
function tint(color, factor) { return color.map((value) => Math.round(Math.max(0, Math.min(255, value * factor)))); }
function canvas(width, height) { return { width, height, pixels: Buffer.alloc(width * height * 4) }; }
function put(c, x, y, color, alpha = 255) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height)
        return;
    const i = (y * c.width + x) * 4;
    c.pixels[i] = color[0];
    c.pixels[i + 1] = color[1];
    c.pixels[i + 2] = color[2];
    c.pixels[i + 3] = alpha;
}
function ellipse(c, cx, cy, rx, ry, color, alpha = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
            if (((x - cx) / Math.max(.3, rx)) ** 2 + ((y - cy) / Math.max(.3, ry)) ** 2 <= 1)
                put(c, x, y, color, alpha);
        }
}
function renderSprites(asset) {
    const { size, frames } = asset;
    const cols = Math.min(frames, 8), rows = Math.ceil(frames / cols);
    const sheet = canvas(size * cols, size * rows);
    const random = rng(asset.seed);
    const sparks = Array.from({ length: 36 }, () => ({ angle: random() * Math.PI * 2, speed: .5 + random() * .5, phase: random(), drift: random() * 2 - 1 }));
    const base = rgb(asset.color ?? (asset.preset.includes("fire") || asset.preset.includes("burst") ? "#ff9635" : asset.preset.includes("portal") ? "#9076ff" : asset.preset.includes("coin") ? "#f9c846" : asset.preset.includes("heart") ? "#ed547c" : "#53c8a2"));
    for (let f = 0; f < frames; f++) {
        const c = canvas(size, size), t = f / frames, s = size / 32, cx = size / 2, cy = size / 2;
        if (asset.preset === "sprite-slime") {
            const bounce = Math.sin(t * Math.PI * 2), top = cy + 3 * s - bounce * 2 * s;
            ellipse(c, cx, 27 * s, 11 * s, 2 * s, [24, 40, 43], 80);
            ellipse(c, cx, top, (11 + bounce) * s, (9 - bounce) * s, tint(base, .38));
            ellipse(c, cx, top - s, (10 + bounce) * s, (8 - bounce) * s, base);
            ellipse(c, cx - 4 * s, top - 4 * s, 3 * s, 2 * s, tint(base, 1.45));
            for (const x of [cx - 4 * s, cx + 4 * s]) {
                ellipse(c, x, top + s, s, 2 * s, [19, 37, 49]);
                put(c, x, top, [255, 255, 255]);
            }
            for (let x = -2; x <= 2; x++)
                put(c, cx + x * s, top + 4 * s, [27, 67, 63]);
        }
        else if (asset.preset === "sprite-coin") {
            const w = (2 + Math.abs(Math.cos(t * Math.PI * 2)) * 8) * s;
            ellipse(c, cx, cy, w, 12 * s, tint(base, .4));
            ellipse(c, cx, cy - s, Math.max(s, w - s), 10 * s, base);
            ellipse(c, cx, cy - s, Math.max(s, w - 3 * s), 7 * s, tint(base, .78));
            for (let y = -4; y <= 4; y++)
                put(c, cx, cy + y * s, tint(base, 1.6));
        }
        else if (asset.preset === "sprite-gem") {
            const bob = Math.sin(t * Math.PI * 2) * 2 * s;
            for (let y = -11; y <= 11; y++)
                for (let x = -9; x <= 9; x++)
                    if (Math.abs(x) / 9 + Math.abs(y) / 12 <= 1) {
                        const face = x < 0 ? y < 0 ? 1.5 : .9 : y < 0 ? 1 : .55;
                        put(c, cx + x * s, cy + y * s + bob, tint(base, face));
                        if (s > 1)
                            for (let yy = 0; yy < s; yy++)
                                for (let xx = 0; xx < s; xx++)
                                    put(c, cx + x * s + xx, cy + y * s + bob + yy, tint(base, face));
                    }
        }
        else if (asset.preset === "sprite-heart") {
            const scale = 1 + .08 * Math.sin(t * Math.PI * 2);
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++) {
                    const xx = (x - cx) / (10 * s * scale), yy = -(y - cy) / (10 * s * scale);
                    if ((xx * xx + yy * yy - 1) ** 3 - xx * xx * yy ** 3 <= 0)
                        put(c, x, y, tint(base, x < cx && y < cy ? 1.25 : y > cy + 3 * s ? .7 : 1));
                }
        }
        else if (asset.preset === "vfx-portal") {
            const r = 10 * s;
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++) {
                    const d = Math.hypot((x - cx) / .72, y - cy), angle = Math.atan2(y - cy, x - cx);
                    if (d < r + s && d > r - 2 * s)
                        put(c, x, y, tint(base, 1 + .45 * Math.sin(angle * 4 - t * Math.PI * 2)));
                    else if (d < r - 2 * s)
                        put(c, x, y, tint(base, .28), Math.round(30 + 35 * (.5 + .5 * Math.sin(angle * 3 + d / s - t * Math.PI * 2))));
                }
            for (const p of sparks.slice(0, 12)) {
                const a = p.angle + t * Math.PI * 2;
                ellipse(c, cx + Math.cos(a) * r * .72, cy + Math.sin(a) * r, s, s, tint(base, 1.8));
            }
        }
        else if (asset.preset === "vfx-fire") {
            for (const p of sparks) {
                const age = (t + p.phase) % 1, x = cx + p.drift * 5 * s * (1 - age) + Math.sin(age * 7 + p.angle) * 2 * s, y = 28 * s - age * 25 * s;
                ellipse(c, x, y, (4 * (1 - age) + .5) * s, (5 * (1 - age) + 1) * s, age < .25 ? tint(base, 1.6) : age < .65 ? base : tint(base, .6), Math.round(255 * (1 - age)));
            }
        }
        else {
            const progress = frames === 1 ? .4 : f / (frames - 1), radius = progress * 13 * s;
            for (const p of sparks) {
                const r = radius * p.speed, x = cx + Math.cos(p.angle) * r, y = cy + Math.sin(p.angle) * r + progress * progress * 3 * s;
                ellipse(c, x, y, Math.max(.5, (1 - progress) * 2) * s, Math.max(.5, (1 - progress) * 2) * s, tint(base, 1.6 - progress), Math.round(255 * (1 - progress)));
            }
            if (progress < .35)
                ellipse(c, cx, cy, (1 - progress / .35) * 7 * s, (1 - progress / .35) * 7 * s, [255, 245, 202]);
        }
        for (let y = 0; y < size; y++)
            c.pixels.copy(sheet.pixels, (((Math.floor(f / cols) * size + y) * sheet.width) + f % cols * size) * 4, y * size * 4, (y + 1) * size * 4);
    }
    const framesMeta = Object.fromEntries(Array.from({ length: frames }, (_, i) => [`frame-${i}`, { frame: { x: i % cols * size, y: Math.floor(i / cols) * size, w: size, h: size }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: size, h: size }, sourceSize: { w: size, h: size }, duration: 83 }]));
    return [{ fileName: "spritesheet.png", content: encodePng(sheet) }, { fileName: "spritesheet.json", content: JSON.stringify({ frames: framesMeta, meta: { app: "Asset Curator", image: "spritesheet.png", size: { w: sheet.width, h: sheet.height }, scale: "1", frameTags: [{ name: asset.preset, from: 0, to: frames - 1, direction: "forward" }], loop: asset.preset !== "vfx-burst" } }, null, 2) }];
}
function renderTexture(asset) {
    const n = asset.size, random = rng(asset.seed), phase = random() * Math.PI * 2;
    const base = rgb(asset.color ?? (asset.preset === "texture-wood" ? "#9f7047" : asset.preset === "texture-metal" ? "#8796a4" : "#9d9d94"));
    const maps = Object.fromEntries(["albedo", "height", "normal", "roughness", "metallic"].map((name) => [name, canvas(n, n)]));
    const heights = new Float64Array(n * n);
    for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
            const u = x / n, v = y / n, wave = Math.sin(u * Math.PI * 16 + phase + Math.sin(v * Math.PI * 4) * .5), grain = .5 + .5 * Math.sin(u * Math.PI * 64 + phase + Math.sin(v * Math.PI * 2));
            let h = .55 + .1 * Math.sin(u * Math.PI * 16 + phase) * Math.cos(v * Math.PI * 16 + phase);
            if (asset.preset === "texture-wood")
                h = .5 + wave * .16 + grain * .06;
            else if (asset.preset === "texture-stone") {
                const row = Math.floor(y / (n / 4)), xx = (x + row % 2 * n / 8) % (n / 4), yy = y % (n / 4);
                h = Math.min(xx, n / 4 - xx, yy, n / 4 - yy) < n / 64 + .5 ? .12 : h;
            }
            else
                h = .55 + .02 * grain;
            heights[y * n + x] = h;
            put(maps.albedo, x, y, tint(base, .55 + h * .75));
            put(maps.height, x, y, [h * 255, h * 255, h * 255]);
            const roughness = asset.preset === "texture-metal" ? 90 + 20 * grain : 195 + 20 * grain;
            put(maps.roughness, x, y, [roughness, roughness, roughness]);
            put(maps.metallic, x, y, asset.preset === "texture-metal" ? [255, 255, 255] : [0, 0, 0]);
        }
    const at = (x, y) => heights[((y + n) % n) * n + (x + n) % n];
    for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
            const dx = (at(x - 1, y) - at(x + 1, y)) * 2, dy = (at(x, y + 1) - at(x, y - 1)) * 2, len = Math.hypot(dx, dy, 1);
            put(maps.normal, x, y, [(dx / len * .5 + .5) * 255, (dy / len * .5 + .5) * 255, (1 / len * .5 + .5) * 255]);
        }
    return [...Object.entries(maps).map(([name, image]) => ({ fileName: `${name}.png`, content: encodePng(image) })), { fileName: "material.json", content: JSON.stringify({ type: "PBR metallic-roughness", albedo: "albedo.png", normal: "normal.png", normalConvention: "OpenGL +Y", roughness: "roughness.png", metallic: "metallic.png", height: "height.png", repeat: true, seed: asset.seed }, null, 2) }];
}
function renderModel(asset) {
    const positions = [], normals = [], colors = [];
    const random = rng(asset.seed);
    const triangle = (a, b, c, color) => {
        const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], len = Math.hypot(...normal) || 1;
        for (const point of [a, b, c]) {
            positions.push(...point);
            normals.push(...normal.map((v) => v / len));
            colors.push(...color.map((v) => v / 255), 1);
        }
    };
    const box = (x, y, z, w, h, d, color) => {
        const v = [[x - w / 2, y, z - d / 2], [x + w / 2, y, z - d / 2], [x + w / 2, y + h, z - d / 2], [x - w / 2, y + h, z - d / 2], [x - w / 2, y, z + d / 2], [x + w / 2, y, z + d / 2], [x + w / 2, y + h, z + d / 2], [x - w / 2, y + h, z + d / 2]];
        for (const [a, b, c, e] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]]) {
            triangle(v[a], v[b], v[c], color);
            triangle(v[a], v[c], v[e], color);
        }
    };
    if (asset.preset === "model-crate") {
        const base = rgb(asset.color ?? "#9f7047");
        box(0, 0, 0, 1, 1, 1, base);
        for (const y of [.02, .84]) {
            box(0, y, .52, 1.08, .14, .08, tint(base, .62));
            box(0, y, -.52, 1.08, .14, .08, tint(base, .62));
            box(.52, y, 0, .08, .14, 1, tint(base, .75));
            box(-.52, y, 0, .08, .14, 1, tint(base, .75));
        }
        for (const x of [-.35, 0, .35]) {
            box(x, .15, .506, .02, .69, .014, tint(base, .5));
            box(x, .15, -.506, .02, .69, .014, tint(base, .5));
        }
    }
    else if (asset.preset === "model-tree") {
        box(0, 0, 0, .3, 2, .3, [103, 73, 49]);
        const base = rgb(asset.color ?? "#4c9b6d");
        for (let tier = 0; tier < 3; tier++) {
            const y = 1 + tier * .7, r = 1 - tier * .23;
            for (let side = 0; side < 8; side++) {
                const a = side * Math.PI / 4, b = (side + 1) * Math.PI / 4;
                const p = [Math.cos(a) * r, y, Math.sin(a) * r], q = [Math.cos(b) * r, y, Math.sin(b) * r];
                triangle(p, [0, y + 1.4, 0], q, tint(base, .8 + random() * .35));
                triangle([0, y, 0], p, q, tint(base, .5));
            }
        }
    }
    else if (asset.preset === "model-barrel") {
        // 20-sided grounded drum: two raised ribs, rim lips, a hazard band, recessed lid and bung.
        const base = rgb(asset.color ?? "#b23a32"), sides = 20, dark = [42, 44, 48], warn = [226, 184, 62];
        const profile = [[0, .285, "rib"], [.03, .3, "body"], [.27, .3, "rib"], [.3, .325, "rib"], [.33, .3, "body"], [.4, .3, "band"], [.52, .3, "body"], [.59, .3, "rib"], [.62, .325, "rib"], [.65, .3, "body"], [.87, .3, "rib"], [.9, .285, "rib"]];
        const at = (i, y, r) => { const a = i * 2 * Math.PI / sides; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
        for (let ring = 0; ring < profile.length - 1; ring++) {
            const [y0, r0, kind] = profile[ring], [y1, r1] = profile[ring + 1];
            for (let i = 0; i < sides; i++) {
                const color = kind === "band" ? (i % 2 ? warn : dark) : kind === "rib" ? tint(base, .62) : tint(base, .86 + random() * .22);
                const p0 = at(i, y0, r0), p1 = at(i, y1, r1), q0 = at(i + 1, y0, r0), q1 = at(i + 1, y1, r1);
                triangle(p0, p1, q0, color);
                triangle(q0, p1, q1, color);
            }
        }
        for (let i = 0; i < sides; i++) {
            triangle(at(i, .9, .285), at(i, .875, .265), at(i + 1, .9, .285), tint(base, .55));
            triangle(at(i + 1, .9, .285), at(i, .875, .265), at(i + 1, .875, .265), tint(base, .55));
            triangle([0, .875, 0], at(i + 1, .875, .265), at(i, .875, .265), tint(base, .74));
            triangle([0, 0, 0], at(i, 0, .285), at(i + 1, 0, .285), tint(base, .4));
        }
        box(.13, .875, .09, .07, .02, .07, dark);
    }
    else {
        const base = rgb(asset.color ?? "#8d939c"), ring = Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4, r = .6 + random() * .2; return [Math.cos(a) * r, .25 + random() * .15, Math.sin(a) * r]; });
        for (let i = 0; i < 8; i++) {
            const a = ring[i], b = ring[(i + 1) % 8];
            triangle(a, [0, 1.1, 0], b, tint(base, .8 + random() * .3));
            triangle([0, 0, 0], a, b, tint(base, .6));
        }
    }
    const count = positions.length / 3, arrays = [positions, normals, colors], buffers = arrays.map((values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; }), bin = Buffer.concat(buffers);
    const min = [0, 1, 2].map(i => Math.min(...positions.filter((_, j) => j % 3 === i))), max = [0, 1, 2].map(i => Math.max(...positions.filter((_, j) => j % 3 === i)));
    let offset = 0;
    const gltf = { asset: { version: "2.0", generator: "Asset Curator native procedural model" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: asset.preset, mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .85 } }], buffers: [{ byteLength: bin.length }], bufferViews: buffers.map(b => { const view = { buffer: 0, byteOffset: offset, byteLength: b.length, target: 34962 }; offset += b.length; return view; }), accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3", min, max }, { bufferView: 1, componentType: 5126, count, type: "VEC3" }, { bufferView: 2, componentType: 5126, count, type: "VEC4" }], extras: { units: "metres", up: "+Y", ground: 0, seed: asset.seed } };
    const raw = Buffer.from(JSON.stringify(gltf)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
    raw.copy(json);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + json.length + bin.length, 8);
    const jhead = Buffer.alloc(8), bhead = Buffer.alloc(8);
    jhead.writeUInt32LE(json.length, 0);
    jhead.writeUInt32LE(0x4e4f534a, 4);
    bhead.writeUInt32LE(bin.length, 0);
    bhead.writeUInt32LE(0x004e4942, 4);
    return [{ fileName: "model.glb", content: Buffer.concat([header, jhead, json, bhead, bin]) }];
}
function renderMusic(asset) {
    const rate = 22050, bpm = asset.preset === "music-ambient" ? 80 : 120, beat = 60 / bpm, beats = 16, random = rng(asset.seed), root = asset.preset === "music-ambient" ? 57 : 60, scale = asset.preset === "music-ambient" ? [0, 3, 7, 10, 12] : [0, 4, 7, 9, 12];
    const notes = Array.from({ length: 32 }, (_, i) => ({ time: i * beat / 2, duration: beat * .44, midi: root + 12 + scale[Math.floor(random() * scale.length)] }));
    const samples = Math.round(beats * beat * rate), pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / rate, step = Math.min(31, Math.floor(t / (beat / 2))), note = notes[step], age = t - note.time, freq = 440 * 2 ** ((note.midi - 69) / 12);
        const envelope = age < note.duration ? Math.min(1, age / .008) * Math.min(1, (note.duration - age) / .03) : 0;
        const lead = asset.preset === "music-ambient" ? Math.sin(2 * Math.PI * freq * t) : 2 / Math.PI * Math.asin(Math.sin(2 * Math.PI * freq * t));
        const chord = [0, 5, 7, 3][Math.floor(t / (beat * 4)) % 4], bassFreq = 440 * 2 ** ((root - 12 + chord - 69) / 12), bassAge = t % beat;
        const value = (lead * envelope * .22 + Math.sin(2 * Math.PI * bassFreq * t) * Math.exp(-bassAge * 4) * .18) * Math.min(1, t / .02, (beats * beat - t) / .03);
        pcm.writeInt16LE(Math.round(Math.max(-.95, Math.min(.95, value)) * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return [{ fileName: "music.wav", content: Buffer.concat([header, pcm]) }, { fileName: "score.json", content: JSON.stringify({ bpm, beats, sampleRate: rate, notes, seed: asset.seed, loop: true }, null, 2) }];
}
export function encodePng(c) {
    const scan = Buffer.alloc((c.width * 4 + 1) * c.height);
    for (let y = 0; y < c.height; y++)
        c.pixels.copy(scan, y * (c.width * 4 + 1) + 1, y * c.width * 4, (y + 1) * c.width * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(c.width, 0);
    ihdr.writeUInt32BE(c.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); let value = 0xffffffff; for (const byte of Buffer.concat([name, data])) {
        value ^= byte;
        for (let i = 0; i < 8; i++)
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    } crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, data, crc]); };
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}
//# sourceMappingURL=generation.js.map