import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { rename } from "node:fs/promises";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "asset",
  "assets",
  "commercial",
  "use",
  "license",
  "licenses",
  "licensed",
  "licensing",
  "for",
  "from",
  "game",
  "grab",
  "i",
  "import",
  "in",
  "into",
  "make",
  "me",
  "my",
  "need",
  "needs",
  "of",
  "pack",
  "please",
  "roblox",
  "some",
  "the",
  "to",
  "want",
  "with",
  "2d",
  "3d",
  "fbx",
  "glb",
  "gltf",
  "obj",
  "png",
  "svg",
  "unity",
  "unreal",
  "godot"
]);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

export function tokenize(value: string): string[] {
  const raw = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokens = new Set<string>();
  for (const token of raw) {
    if (STOP_WORDS.has(token) || token.length < 2) continue;
    tokens.add(token);
    if (token.endsWith("ies") && token.length > 4) tokens.add(`${token.slice(0, -3)}y`);
    if (token.endsWith("s") && token.length > 3) tokens.add(token.slice(0, -1));
  }
  return [...tokens];
}

export function resolveOutputDir(outputDir: string | undefined): string {
  const resolved = path.resolve(outputDir ?? process.env.ASSET_GRABBER_OUTPUT_DIR ?? "assets-grabbed");
  assertWithinSafeRoot(resolved, "output directory");
  return resolved;
}

export function normalizeExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./, "");
}

export function containsToken(haystack: string, token: string): boolean {
  const lowerHaystack = haystack.toLowerCase();
  const lowerToken = token.toLowerCase();
  if (lowerToken.length <= 3) {
    const escaped = lowerToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lowerHaystack);
  }
  return lowerHaystack.includes(lowerToken);
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

// Windows scanners/indexers can briefly retain handles after a completed write.
// Retry only transient lock/permission errors; never force permissions or delete targets.
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

export function resolveAssetFile(root: string, relative: string): string {
  const parts = relative.replace(/\\/g, "/").split("/");
  if (!relative || parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error("Unsafe asset relative path: " + relative);
  const target = path.resolve(root, ...parts);
  assertWithinSafeRoot(target, "asset output");
  const inside = path.relative(root, target);
  if (path.isAbsolute(inside) || inside.startsWith(".." + path.sep) || inside === "..") throw new Error("Asset path escapes output");
  return target;
}

export function hasAncestorTraversal(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").some((part) => part === "..");
}

export function assertWithinSafeRoot(targetPath: string, label: string): void {
  if (process.env.ASSET_GRABBER_ALLOW_UNSAFE_PATHS === "1") return;
  const root = resolvePhysicalPath(process.env.ASSET_GRABBER_SAFE_ROOT ?? process.cwd());
  const target = resolvePhysicalPath(targetPath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} is outside safe root (${root}): ${target}`);
}

// Resolve existing ancestors too: a not-yet-created output under a junction must
// not bypass the safe root. An unresolved symlink is never a writable ancestor.
export function resolvePhysicalPath(targetPath: string): string {
  let ancestor = path.resolve(targetPath);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(realpathSync.native(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Unresolved symbolic link in asset path");
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") throw entryError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
