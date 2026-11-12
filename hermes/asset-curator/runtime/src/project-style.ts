// Read-only, bounded look at the project an agent is adding assets to. Evidence comes from file
// types and sizes, rendering code and the project's own docs. Nothing judges pixels or taste.
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertWithinSafeRoot } from "./util.js";
import type { StyleGroup } from "./intent.js";

export type ProjectStyle = {
  root: string;
  dimension: "2D" | "3D" | "mixed" | "unknown";
  /** Styles backed by rendering code or asset files; used to rank results when the request names no style. */
  styles: StyleGroup[];
  /** Style words found only in the project's docs; reported, not used for ranking. */
  docStyles: StyleGroup[];
  codeGeneratedArt: boolean;
  palette: string[];
  typicalSpriteSize?: number;
  evidence: string[];
  basis: "project-files-code-and-docs-not-visual";
  note: string;
};

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".cache", "assets-grabbed", "__pycache__", ".venv", "venv", "captures", "attempts", "verify", "tests", "test"]);
const CODE = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".gd", ".cs", ".lua", ".py", ".yaml", ".yml", ".json", ".tscn"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MODEL = new Set([".glb", ".gltf", ".fbx", ".obj", ".vox", ".blend"]);
const DOC = /^(readme|design|brief|spec|style|art|gdd)[\w.-]*\.md$/i;
const MAX_FILES = 4000, MAX_CODE_FILES = 300, MAX_CODE_BYTES = 512 * 1024, MAX_DEPTH = 8;

const SIGNALS: { re: RegExp; style?: StyleGroup; dim?: "2D" | "3D"; codeArt?: boolean; label: string }[] = [
  { re: /imageSmoothingEnabled\s*=\s*false|image-rendering\s*:\s*(?:pixelated|crisp-edges)|pixelArt\s*:\s*true|NearestFilter|TEXTURE_FILTER_NEAREST|filter\s*=\s*["']?nearest/i, style: "pixel", label: "nearest-neighbour pixel scaling in code" },
  { re: /\b(?:spritekiln|pixelbolt|pixelfx|aseprite)\b/i, style: "pixel", codeArt: true, label: "pixel-art sprite tooling referenced" },
  { re: /getContext\(\s*["']2d["']|new\s+Phaser\.|PIXI\.|love\.graphics|Sprite2D|SpriteRenderer/, dim: "2D", label: "2D renderer" },
  { re: /from\s+["']three["']|WebGLRenderer|GLTFLoader|BABYLON\.|new\s+pc\.Application|MeshInstance3D|Camera3D/, dim: "3D", label: "3D renderer" },
  { re: /MeshToonMaterial|flatShading\s*:\s*true|low[\s-]?poly/i, style: "low-poly", label: "flat or toon shading in code" },
  { re: /MeshPhysicalMaterial|RGBELoader|HDRLoader|normalMap\s*[:=]/, style: "photoreal", label: "physically based materials in code" }
];
const DOC_WORDS: Record<StyleGroup, RegExp> = {
  pixel: /\bpixel(?:[\s-]?art)?\b|\b(?:8|16)[\s-]?bit\b/gi,
  "low-poly": /\blow[\s-]?poly\b|\bvoxel\b/gi,
  photoreal: /\bphoto-?real(?:istic)?\b|\brealistic\b/gi,
  vector: /\bvector\b|\bflat design\b/gi,
  painterly: /\bhand[\s-]?painted\b|\bpainterly\b|\bwater-?colou?r\b/gi,
  anime: /\banime\b|\bmanga\b|\bcel[\s-]?shaded\b/gi
};

async function pngSize(file: string): Promise<[number, number] | undefined> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(24); const { bytesRead } = await handle.read(head, 0, 24, 0);
    if (bytesRead < 24 || head.toString("latin1", 1, 4) !== "PNG" || head.toString("latin1", 12, 16) !== "IHDR") return undefined;
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } finally { await handle.close(); }
}

export async function analyzeProjectStyle(projectPath: string): Promise<ProjectStyle> {
  if (!path.isAbsolute(projectPath)) throw new Error("projectPath must be an absolute path to the project folder");
  assertWithinSafeRoot(projectPath, "project path");
  if (!(await stat(projectPath)).isDirectory()) throw new Error("projectPath must be a folder");
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === "asset-grabber-manifest.json")) return; // this plugin's own downloads are not the project's style
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith(".") && !/^dist[-_]/i.test(entry.name)) await walk(full, depth + 1); }
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(projectPath, 0);
  const ext = (f: string) => path.extname(f).toLowerCase();
  const images = files.filter((f) => IMAGE.has(ext(f))), models = files.filter((f) => MODEL.has(ext(f)));
  const code = files.filter((f) => CODE.has(ext(f)) && !/package-lock\.json$|\.min\.js$/i.test(f)).slice(0, MAX_CODE_FILES);
  const docs = files.filter((f) => DOC.test(path.basename(f))).slice(0, 20);
  const evidence: string[] = [], styleVotes = new Map<StyleGroup, number>(), dims = new Set<"2D" | "3D">(), colours = new Map<string, number>();
  let codeArt = false;
  const vote = (style: StyleGroup, n = 1) => styleVotes.set(style, (styleVotes.get(style) ?? 0) + n);
  const seen = new Set<string>();
  for (const file of code) {
    const info = await stat(file).catch(() => undefined);
    if (!info || info.size > MAX_CODE_BYTES) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    for (const signal of SIGNALS) {
      if (!signal.re.test(text)) continue;
      if (signal.style) vote(signal.style, 2);
      if (signal.dim) dims.add(signal.dim);
      if (signal.codeArt) codeArt = true;
      if (!seen.has(signal.label)) { seen.add(signal.label); evidence.push(`${signal.label} (${path.relative(projectPath, file).replaceAll("\\", "/")})`); }
    }
    for (const match of text.matchAll(/#([0-9a-fA-F]{6})\b|0x([0-9a-fA-F]{6})\b/g)) {
      const hex = "#" + (match[1] ?? match[2]).toLowerCase(); colours.set(hex, (colours.get(hex) ?? 0) + 1);
    }
  }
  const sizes: number[] = [];
  for (const file of images.filter((f) => ext(f) === ".png").slice(0, 200)) {
    const size = await pngSize(file).catch(() => undefined); if (size) sizes.push(Math.max(...size));
  }
  sizes.sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : undefined;
  if (sizes.length >= 5 && median !== undefined && median <= 128) { vote("pixel", 2); dims.add("2D"); evidence.push(`${sizes.length} PNG files, median ${median}px: small sprites`); }
  if (models.length) { dims.add("3D"); evidence.push(`${models.length} 3D model files`); }
  if (!images.length && !models.length && codeArt) evidence.push("ships no image or model files; art is generated in code");
  const docVotes = new Map<StyleGroup, number>();
  for (const file of docs) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const [style, re] of Object.entries(DOC_WORDS) as [StyleGroup, RegExp][]) {
      const n = text.match(re)?.length ?? 0; if (n) docVotes.set(style, (docVotes.get(style) ?? 0) + n);
    }
  }
  const styles = [...styleVotes.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 2);
  const docStyles = [...docVotes.entries()].filter(([s, n]) => n >= 1 && !styles.includes(s)).sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 3);
  if (docStyles.length) evidence.push(`docs mention: ${docStyles.join(", ")}`);
  const dimension = dims.size === 2 ? "mixed" : dims.has("3D") ? "3D" : dims.has("2D") ? "2D" : "unknown";
  const palette = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex]) => hex);
  const note = styles.length
    ? `Project looks ${dimension} ${styles.join(" + ")}. Results are ranked for that style when the request names none. This reads files, code and docs; it does not look at pictures.`
    : "No clear art style found in the project's files or code; results are not style-ranked.";
  return { root: projectPath, dimension, styles, docStyles, codeGeneratedArt: codeArt, palette, ...(median !== undefined && median <= 128 && sizes.length >= 5 ? { typicalSpriteSize: median } : {}), evidence: evidence.slice(0, 12), basis: "project-files-code-and-docs-not-visual", note };
}
