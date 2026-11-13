import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
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
  const resolved = path.resolve(assetOutputRoot(), outputDir ?? "assets-grabbed");
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

// Access is configured only by the user's settings route, never by a model tool.
let projectsRoot: string | undefined;
export type AccessMode = "hermes" | "full" | "project" | "review" | "no";
let accessMode: AccessMode = "no";
const operationAccess = new AsyncLocalStorage<{ writeRoots: string[]; readRoots: string[] }>();
export function withOperationAccess<T>(writeRoots: string[], readRoots: string[], run: () => Promise<T>): Promise<T> {
  return operationAccess.run({ writeRoots: writeRoots.map(resolvePhysicalPath), readRoots: readRoots.map(resolvePhysicalPath) }, run);
}
export function setProjectsRoot(folder: string | undefined, mode: AccessMode = "no"): void {
  projectsRoot = folder ? resolvePhysicalPath(folder) : undefined;
  accessMode = mode;
}
export function projectsRootFolder(): string | undefined { return accessMode === "project" || accessMode === "review" ? projectsRoot : undefined; }
export function assetOutputRoot(): string {
  if (accessMode === "project") {
    if (!projectsRoot) throw new Error("Project access requires a user-selected project workspace in plugin settings");
    const target = resolvePhysicalPath(path.join(projectsRoot, "asset-curator"));
    if (target !== path.join(projectsRoot, "asset-curator")) throw new Error("Project assets folder must not link outside its fixed output location");
    return target;
  }
  if (accessMode === "review") return resolvePhysicalPath(path.join(os.homedir(), "Downloads", "asset-curator-review"));
  return resolvePhysicalPath(path.join(os.homedir(), "Downloads"));
}
export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function assertWithinSafeRoot(targetPath: string, label: string, readOnly = false, importFromDownloads = false): void {
  if (accessMode === "full" || accessMode === "hermes") return;
  const target = resolvePhysicalPath(targetPath);
  const granted = operationAccess.getStore();
  if (granted?.writeRoots.some(root => isInsidePath(root, target)) || (readOnly && granted?.readRoots.some(root => isInsidePath(root, target)))) return;
  if (accessMode === "project" && projectsRoot && isInsidePath(projectsRoot, target)) return;
  const output = assetOutputRoot();
  if (isInsidePath(output, target)) return;
  if (readOnly) {
    const downloads = resolvePhysicalPath(path.join(os.homedir(), "Downloads"));
    if (importFromDownloads && (accessMode === "project" || accessMode === "review") && isInsidePath(downloads, target)) return;
    const internal = resolvePhysicalPath(process.env.ASSET_GRABBER_SAFE_ROOT ?? process.cwd());
    if (isInsidePath(internal, target) || ((accessMode === "project" || accessMode === "review") && projectsRoot && isInsidePath(projectsRoot, target))) return;
  }
  throw new Error(`${label} is outside the user-selected ${accessMode} access boundary: ${target}`);
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
