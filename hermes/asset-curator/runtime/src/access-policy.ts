import path from "node:path";
import { createHash } from "node:crypto";
import { loadSettings } from "./settings.js";
import { assertWithinSafeRoot, assetOutputRoot, resolvePhysicalPath, withOperationAccess, isInsidePath } from "./util.js";

export type HostApproval = (message: string) => Promise<boolean>;
const WRITERS = new Set(["grab_asset", "prepare_existing_asset", "generate_asset", "render_pixel_recipe", "create_generator_project"]);
/** A host response authorizes only this immutable invocation, never a saved permission. */
export async function runWithAccessPolicy<T>(name: string, raw: Record<string, unknown>, approve: HostApproval, run: (input: Record<string, unknown>) => Promise<T>): Promise<T> {
  const input = structuredClone(raw);
  const settings = await loadSettings(), mode = settings.preferences.accessMode ?? "no";
  if (mode === "hermes" || mode === "full") return run(input);
  const writes = WRITERS.has(name);
  if (mode === "review" && writes && !settings.preferences.projectsFolder) throw new Error("Review mode needs a user-selected project workspace before staging assets");
  if (mode === "review" && name === "get_asset_manifest" && typeof input.manifestPath === "string" && isInsidePath(assetOutputRoot(), resolvePhysicalPath(input.manifestPath))) throw new Error("Pending assets are preview-only. Use get_review_queue and approve the asset before reading its delivered manifest.");
  const reads = [input.sourcePath, input.projectPath, input.manifestPath].filter((p): p is string => typeof p === "string");
  const readPaths = reads.map(p => resolvePhysicalPath(path.resolve(p)));
  let output: string | undefined;
  if (writes) {
    // Freeze the destination before consent; downstream code receives this absolute path.
    output = resolvePhysicalPath(path.resolve(assetOutputRoot(), typeof input.outputDir === "string" ? input.outputDir : "assets-grabbed"));
    input.outputDir = output;
  }
  let needsApproval = (mode === "no" && writes) || (mode === "review" && name === "create_generator_project");
  const reasons: string[] = needsApproval ? [mode === "no" ? "Downloads-only mode suggests assets; this materialization needs your approval." : "An editable generator project is not a reviewed final asset; creating it needs your approval."] : [];
  try {
    if (output) assertWithinSafeRoot(output, "output directory");
    for (const item of readPaths) assertWithinSafeRoot(item, "input path", true, name === "prepare_existing_asset");
  } catch {
    needsApproval = true;
    reasons.push("This one action exceeds your saved access boundary.");
  }
  if (!needsApproval) return run(input);
  const serialized = JSON.stringify(input), digest = createHash("sha256").update(serialized).digest("hex");
  const message = `Asset Curator: approve ONE action?\n${reasons.join(" ")}\nTool: ${name}\nRead: ${readPaths.join(", ") || "no local source"}\nWrite: ${output ?? "none"}\nSelected asset: ${String(input.assetId ?? "best matching result for the request").slice(0, 500)}\nProvider: ${String(input.source ?? "configured providers").slice(0, 200)}\nRequest: ${String(input.request ?? "").slice(0, 1000)}\nLicense: ${String(input.licenseName ?? "existing saved licence policy")}\nOverwrite: ${input.overwrite === true ? "yes, matching owned output only" : "no"}\nArguments SHA-256: ${digest}\nThe saved mode stays ${mode}. Decline or cancel makes no change. This does not bypass OS permissions or licensing/access controls.`;
  if (!await approve(message)) throw new Error("User approval was declined or unavailable; no asset action was performed. Saved permissions are unchanged.");
  // A symlink/destination changed during the prompt must not broaden the approved roots.
  if (output && resolvePhysicalPath(output) !== output) throw new Error("Destination changed during approval; request approval again");
  for (let i = 0; i < reads.length; i++) if (resolvePhysicalPath(path.resolve(reads[i])) !== readPaths[i]) throw new Error("Input changed during approval; request approval again");
  return withOperationAccess(output ? [output] : [], readPaths, () => run(input));
}
