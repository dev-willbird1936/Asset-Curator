#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { generateAsset, generatePixelRecipe, grabAsset, prepareExistingAsset } from "./prepare.js";
import { providerNames, searchAssetsWithDiagnostics } from "./providers.js";
import { sourceEntries } from "./registry.js";
import { generationInputSchema, listGeneratorPresets } from "./generation.js";
import { createGeneratorProject, generatorHelp, generatorProjectSchema, GENERATOR_IDS, listGeneratorRecipes } from "./generator-recipes.js";
import { isSourceEnabled, loadSettings, redactSettings, sourcePriorityBoost } from "./settings.js";
import { configurePreferences, configureClassifier, classifierSchema, preferencesSchema, runSetupCli, setupStatus, triggerKey, TRIGGER_GUIDANCE, TRIGGER_TAG } from "./setup.js";
import type { AssetCategory } from "./types.js";
import { runWithAccessPolicy } from "./access-policy.js";
import { queueManifest, listQueue, decideQueuedAsset, applyQueueSelections, type ReviewItem } from "./review-queue.js";
import { assertWithinSafeRoot, assetOutputRoot, isInsidePath, resolvePhysicalPath } from "./util.js";

// Public project owner marker: dev-willbird1936.
const categorySchema = z.enum(["2D", "3D", "Animation", "Audio", "Music", "Textures", "UI", "VFX", "Unknown"]);

// The user's saved trigger choice is stated in the server instructions and on every asset tool,
// because some hosts show the model only tool descriptions. Read once at start; get_setup is live.
const startupKey = await loadSettings().then(triggerKey, () => "unset" as const);
const startupTrigger = TRIGGER_GUIDANCE[startupKey];
const ENTRY_TOOLS = new Set(["search_assets", "generate_asset", "list_generators"]);
const OUTPUT_DIR_HELP = "Where to save. Relative paths use the user-selected output folder: project mode defaults to <workspace>/asset-curator; review mode stages in Downloads; no mode requires approval to download/use assets. Full and Hermes-managed modes have no additional plugin path boundary. get_setup reports accessMode; only the user can change access in plugin settings.";
function useInProject(ready: string): string {
  return `Prepared assets are saved at ${ready}. Load readyFiles from paths.ready and keep ASSET_SOURCE.txt and licence files with them. Filesystem access is controlled by the user's plugin settings, never configure_preferences.`;
}
const SETUP_TOOLS = new Set(["get_setup", "configure_preferences", "configure_classifier", "get_review_queue", "review_asset", "apply_review_queue"]);

const server = new McpServer({
  name: "asset-curator-mcp",
  version: "0.3.0"
}, {
  instructions: startupTrigger + " When you do use it: start with get_setup. If required, ask the user the setup questions once and call configure_preferences only with their answers; never infer consent. For existing assets use search_assets/grab_asset; for creation use list_generators then generate_asset, or get_generator_help and render_pixel_recipe. For advanced tools create_generator_project writes editable source only: adapt it, explicitly execute with an approved runtime, inspect the result, then prepare_existing_asset(origin=created) with actual rights. Never claim a starter is a rendered match for arbitrary intent. No automatic dependency/model installs. ready/ is prepared output. Respect saved acquisition mode, license policy, and browser consent. Use the credential route reported by get_setup; never put API keys in chat or read other applications' credential stores. Preserve manifests and attribution. No automatic login, payment, captcha solving, or accepting terms."
});

const approvalRequestContext = new AsyncLocalStorage<AbortSignal>();
async function requestHostApproval(message: string): Promise<boolean> {
  const signal = approvalRequestContext.getStore();
  if (signal?.aborted) return false;
  if (!server.server.getClientCapabilities()?.elicitation?.form) return false;
  try {
    const result = await server.server.elicitInput({ mode: "form", message, requestedSchema: { type: "object", properties: {} } }, { timeout: 120_000, signal });
    return result.action === "accept" && !signal?.aborted;
  } catch { return false; }
}
const registerTool = server.registerTool.bind(server) as (...args: any[]) => unknown;
(server as any).registerTool = (name: string, config: { description?: string }, handler: (input: any, extra: any) => Promise<any>) =>
  registerTool(name, SETUP_TOOLS.has(name) ? (name === "get_setup" && startupKey === "auto" ? { ...config, description: "[" + TRIGGER_TAG.auto + " Call this first.] " + (config.description ?? "") } : config) : { ...config, description: "[" + (ENTRY_TOOLS.has(name) ? startupTrigger : TRIGGER_TAG[startupKey]) + "] " + (config.description ?? "") }, async (input: any, extra: any) => {
    try {
      return await approvalRequestContext.run(extra.signal, () => runWithAccessPolicy(name, input, requestHostApproval, async safe => {
        const result = await handler(safe, extra);
        const settings = await loadSettings();
        if (settings.preferences.accessMode === "review" && !result?.isError && ["grab_asset", "prepare_existing_asset", "generate_asset", "render_pixel_recipe"].includes(name)) {
          const data = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : undefined);
          if (data?.paths?.root && isInsidePath(assetOutputRoot(), resolvePhysicalPath(data.paths.root))) {
            if (!settings.preferences.projectsFolder) throw new Error("Choose the review project workspace yourself in plugin settings before queuing assets");
            const persisted = JSON.parse(await readFile(data.paths.manifest, "utf8"));
            const item = await queueManifest(persisted, settings.preferences.projectsFolder);
            const queue = await listQueue();
            return toolJson({ review: publicReviewItem(item), pending: queue.pending, reviewUrl: queue.url, note: "Preview only: do not use this asset in project code until approved. Open the Asset Review Queue, select Yes/No, then ask Hermes to apply selections and confirm its prompt." });
          }
        }
        return result;
      }));
    }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  });

function publicReviewItem(item: ReviewItem) {
  return { id: item.id, title: item.title, status: item.status, destination: item.destination,
    manifestPath: item.status === "approved" ? path.join(item.destination, item.manifestName) : undefined };
}
server.registerTool("get_review_queue", {
  title: "Asset Review Queue", description: "Show preview-only queued assets, pending count and local HTML review page. Yes/No buttons select intentions only; apply_review_queue asks real host confirmation before moving or discarding staged copies. Original downloads are kept.",
  annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: z.object({}).strict()
}, async () => { const queue = await listQueue(); return toolJson({ pending: queue.pending, selected: queue.selected, reviewUrl: queue.url, items: queue.items.map(publicReviewItem) }); });
server.registerTool("review_asset", {
  title: "Confirm One Queued Asset", description: "Request genuine host approval to import a specific reviewed asset into the bound project, or discard its staged queue copy. A model-supplied decision is an intention, never approval. Original downloads remain intact.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: z.object({ id: z.string().uuid(), decision: z.enum(["approve", "reject"]) }).strict()
}, async ({ id, decision }) => toolJson(publicReviewItem(await decideQueuedAsset(id, decision, requestHostApproval))));
server.registerTool("apply_review_queue", {
  title: "Apply Review Selections", description: "Apply Yes/No intentions selected in the HTML queue, asking the host to confirm each exact asset and destination. No browser click alone authorizes filesystem changes.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: z.object({}).strict()
}, async () => { const results = await applyQueueSelections(requestHostApproval), queue = await listQueue(); return toolJson({ results, remainingSelected: queue.selected, pending: queue.pending, items: queue.items.map(publicReviewItem) }); });

server.registerTool("get_setup", {
  title: "First-use Setup",
  description: "Read saved first-use preferences (including whether to trigger automatically or only on request) and the one-time user questions. No network calls or secrets. Ask only when required is true.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: z.object({})
}, async () => toolJson(setupStatus(await loadSettings())));

server.registerTool("configure_preferences", {
  title: "Save User Preferences",
  description: "Persist the user's explicit license, browser, acquisition and trigger choices. Ask the user first; do not auto-consent. Optional classifier credentials use the get_setup route (Hermes profile secrets or standalone local UI/environment), never chat.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: preferencesSchema
}, async (input) => toolJson(await configurePreferences(input)));

server.registerTool("configure_classifier", {
  title: "Choose Optional Classifier",
  description: "Save explicit nonsecret provider/model choices WITHOUT accepting an API key or calling a model. Does not accept an endpoint URL: the user sets the custom classifier URL in plugin settings. Ask the user first. Keys use get_setup's credential route (Hermes approved profile secrets or standalone UI/environment). Provider changes clear stored standalone keys, never transfer credentials. Does not change license/browser/acquisition consent. CLI subscription routes disabled in Hermes profile.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: classifierSchema
}, async input => toolJson(await configureClassifier(input)));

server.registerTool("list_generators", {
  title: "Code Asset Generators",
  description: "Discover built-in deterministic generators and supported presets/formats. No network, AI, extra install or consent change.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: z.object({})
}, async () => toolJson({ generators: listGeneratorPresets(), authoringProjects: listGeneratorRecipes(), pixelbolt: { tool: "render_pixel_recipe", help: "get_generator_help", runtime: "bundled Pixelbolt 0.15.0, no additional install", supports: "Self-contained programmable sprites, tiles, UI, shapes, grids, per-frame palettes and animations" }, sfx: { source: "jsfxr", tool: "grab_asset", presets: ["coin", "laser", "explosion", "power-up", "hit", "jump", "click", "horror"], formats: ["wav", "json"] }, note: "Use generate_asset for 17 named presets (including parameterized ZzFX and composed ZzFXM), render_pixel_recipe for programmable custom pixel art, or authoring projects for eight libraries. External runtimes are optional and not installed/executed by project creation. Source recipes remain in pack/." }));

server.registerTool("get_generator_help", {
  title: "Generator Authoring Help",
  description: "Read code-generation contracts for all eight tools; default Pixelbolt returns the installed full authoring guide or JSON Schema. No network/install/execute. Narrow schema with dot-separated section keys. Optional runtimes are labeled honestly.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: z.object({ generator: z.enum(GENERATOR_IDS).optional(), topic: z.enum(["quickstart", "schema"]).optional(), section: z.string().max(200).optional() })
}, async ({ generator, topic, section }) => toolJson(await generatorHelp(generator, topic, section)));

server.registerTool("create_generator_project", {
  title: "Create Editable Generator Project",
  description: "Write complete runnable source/recipe starter projects for PixelFX, Pixelbolt, SpriteKiln, sand3d, Material Maker, ZzFX, ZzFXM or Remotion, with contracts/licenses and a Windows launcher. Does not render, install, run code, buy licenses or change consent. A starter is not a generated match for arbitrary intent: edit, explicitly run with an approved runtime, inspect, then prepare_existing_asset(origin=created) using real rights. Existing project edits are preserved.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: generatorProjectSchema
}, async (input) => { const gate = await setupGate(); return gate ?? toolJson(await createGeneratorProject(input)); });

server.registerTool("render_pixel_recipe", {
  title: "Render Editable Pixel Art",
  description: "Render a user/agent-authored Pixelbolt JSON recipe into a transparent PNG sheet, atlas, individual frames, APNG, Godot SpriteFrames and editable source, with manifest/notice. No extra install, network or image model. Pure declarative shapes/pixels, not arbitrary code or external file references. Inspect the rendered art; valid JSON is not proof of visual quality.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: z.object({
    request: z.string().min(1).max(2000), recipe: z.record(z.string(), z.unknown()),
    outputDir: z.string().optional().describe(OUTPUT_DIR_HELP), overwrite: z.boolean().optional(), engine: z.string().optional(),
    maxReadyFiles: z.number().int().min(1).max(5000).optional()
  })
}, async (input) => {
  const gate = await setupGate(); if (gate) return gate;
  const manifest = await generatePixelRecipe(input);
  return toolJson({ request: manifest.request, asset: manifest.asset.title, paths: manifest.paths, readyFiles: manifest.readyFiles, license: manifest.license, engineReadiness: manifest.engineReadiness, cacheHit: manifest.cacheHit, useInProject: useInProject(manifest.paths.ready) });
});

server.registerTool("generate_asset", {
  title: "Generate Code-based Asset",
  description: "Generate a deterministic sprite, animated VFX, seamless PBR texture set, low-poly GLB prop or synthesized music from a supported preset. Writes actual files, an editable recipe, regeneration code and a provenance manifest. Requires saved create/both preference. No arbitrary code execution or model calls.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: generationInputSchema.extend({ outputDir: z.string().optional().describe(OUTPUT_DIR_HELP), overwrite: z.boolean().optional(), engine: z.string().optional(), maxReadyFiles: z.number().int().min(1).max(500).optional() })
}, async (input) => {
  try { const manifest = await generateAsset(input); return toolJson({ ...manifest, useInProject: useInProject(manifest.paths.ready) }); }
  catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
});

server.registerTool(
  "list_sources",
  {
    title: "List Asset Sources",
    description: "List registered asset sources with license, mode, enabled status and category-based priority boosts; no live health check.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      category: categorySchema.optional().describe("Optional category for priority boosts.")
    })
  },
  async ({ category }) => {
    const settings = await loadSettings();
    const response = {
      sources: sourceEntries().map((source) => ({
        ...source,
        enabled: isSourceEnabled(settings, source.id),
        priorityBoost: sourcePriorityBoost(settings, category as AssetCategory | undefined, source.id)
      }))
    };
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    };
  }
);

server.registerTool(
  "get_settings",
  {
    title: "Get Asset Curator Settings",
    description: "Read active settings with advisor API keys fully redacted; never returns any credential characters.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({})
  },
  async () => {
    const settings = await loadSettings();
    const response = redactSettings(settings);
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    };
  }
);

server.registerTool(
  "provider_status",
  {
    title: "Provider Status",
    description: "List provider settings and optionally probe enabled providers. Probes contact external services and may invoke the configured advisor CLI or API; diagnostics are per source.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: z.object({
      probe: z.boolean().optional().describe("Run a small live search probe against each enabled provider."),
      request: z.string().optional().describe("Probe request. Defaults to 'tree icon sound texture'.")
    })
  },
  async ({ probe, request }) => {
    const gate = probe ? await setupGate() : undefined;
    if (gate) return gate;
    const settings = await loadSettings();
    const sources = sourceEntries().map((source) => ({
      ...source,
      enabled: isSourceEnabled(settings, source.id)
    }));
    const diagnostics = probe
      ? (
          await Promise.allSettled(
            sources
              .filter((source) => source.enabled)
              .map(async (source) => {
                const response = await searchAssetsWithDiagnostics({
                  request: request || "tree icon sound texture",
                  source: source.id,
                  includeManualResults: true,
                  useAdvisor: false,
                  limit: 1
                });
                return response.diagnostics[0] ?? { source: source.id, ok: true, count: response.results.length };
              })
          )
        ).map((result, index) =>
          result.status === "fulfilled"
            ? result.value
            : {
                source: sources.filter((source) => source.enabled)[index]?.id ?? "unknown",
                ok: false,
                count: 0,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason)
              }
        )
      : undefined;
    const response = { sources, diagnostics };
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    };
  }
);

server.registerTool(
  "search_assets",
  {
    title: "Search Free Assets",
    description: "Search asset providers and return ranked results with diagnostics. Pass projectPath when working in a project so results match its art style. Read `interpretation` (inferred media type, excluded 'not X' terms, requested styles and whether they came from the request or the project), `projectStyle`, `offStyle`, each result's `style` (metadata-only: 'unconfirmed' or 'conflicting' means do not present it as a style match), `withheld` (matches that need browser consent) and `nextSteps` (what to do when nothing fits). Pass a result's source:id to grab_asset as assetId to fetch exactly that one. May contact external services or the configured classifier; verify licenses before use.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: z.object({
      request: z.string().min(1).describe("Natural language asset request, e.g. 'tree asset for Roblox'."),
      category: categorySchema.optional().describe("Optional category filter."),
      source: z.string().optional().describe(`Optional source filter. Known: ${providerNames().join(", ")}.`),
      includeManualResults: z
        .boolean()
        .optional()
        .describe("Include assisted/manual leads requiring user action. Settings or an explicit source can also enable them."),
      useAdvisor: z
        .boolean()
        .optional()
        .describe("Allow configured asset advisor CLI/API to rewrite vague requests before provider search. Defaults to settings."),
      limit: z.number().int().min(1).max(25).optional().describe("Maximum results to return."),
      projectPath: z.string().max(1000).optional().describe("Absolute path of the game or project you are adding this asset to. Pass it whenever you work inside a project: its existing art style (read from its files, rendering code and docs) ranks results and flags mismatches when the request names no style. Must be inside the plugin's folder or the user's chosen projects folder.")
    })
  },
  async ({ request, category, source, includeManualResults, useAdvisor, limit, projectPath }) => {
    const gate = await setupGate();
    if (gate) return gate;
    const response = await searchAssetsWithDiagnostics({
      request,
      category: category as AssetCategory | undefined,
      source,
      includeManualResults,
      useAdvisor,
      projectPath,
      limit
    });
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    };
  }
);

server.registerTool(
  "compare_results",
  {
    title: "Compare Asset Results",
    description: "Compare ranked results and per-source failures across selected or all sources. Defaults to including manual leads; may contact providers and invoke the configured advisor CLI/API.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: z.object({
      request: z.string().min(1).describe("Natural language asset request."),
      category: categorySchema.optional().describe("Optional category filter."),
      sources: z.array(z.string()).optional().describe("Optional source IDs to compare."),
      includeManualResults: z.boolean().optional().describe("Include assisted/manual leads; defaults true. Explicit source selection or settings can also enable them."),
      limitPerSource: z.number().int().min(1).max(10).optional().describe("Results per source.")
    })
  },
  async ({ request, category, sources, includeManualResults, limitPerSource }) => {
    const gate = await setupGate();
    if (gate) return gate;
    const sourceList = sources?.length ? sources : providerNames();
    const settled = await Promise.allSettled(
      sourceList.map(async (source) => ({
        source,
        response: await searchAssetsWithDiagnostics({
          request,
          category: category as AssetCategory | undefined,
          source,
          includeManualResults: includeManualResults ?? true,
          useAdvisor: false,
          limit: limitPerSource ?? 3
        })
      }))
    );
    const response = {
      request,
      sources: settled.map((result, index) =>
        result.status === "fulfilled"
          ? {
              source: result.value.source,
              results: result.value.response.results,
              diagnostics: result.value.response.diagnostics
            }
          : {
              source: sourceList[index],
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              results: []
            }
      )
    };
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    };
  }
);

server.registerTool(
  "grab_asset",
  {
    title: "Grab Asset",
    description:
      "Search, download, extract and prepare an asset pack with provenance. Uses an isolated installed Chrome/Edge session only when saved browser consent permits assisted retrieval or a direct download fails; stops at access/terms/payment gates. New output is staged; overwrite only replaces owned cached output after success. May invoke the configured advisor. Verify license terms.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: z.object({
      request: z.string().min(1).describe("Natural language asset request."),
      assetId: z.string().max(200).regex(/^[a-z0-9:-]+:[A-Za-z0-9._-]+$/).optional().describe("Exact 'source:id' of a search_assets result (same request text). Grabs that result or fails; never falls back to another asset."),
      outputDir: z.string().optional().describe(OUTPUT_DIR_HELP),
      category: categorySchema.optional().describe("Optional category filter."),
      source: z.string().optional().describe(`Optional source filter. Known: ${providerNames().join(", ")}.`),
      engine: z.string().optional().describe("Target engine, e.g. roblox, unity, godot."),
      fullPack: z.boolean().optional().describe("Return the full extracted pack as the ready path instead of a focused ready subset."),
      includeSourceArchive: z.boolean().optional().describe("Keep source.zip beside extracted files. Defaults true."),
      overwrite: z.boolean().optional().describe("Overwrite cached output for selected asset."),
      formats: z.array(z.string()).optional().describe("Preferred file extensions, e.g. ['glb','fbx','png']."),
      useAdvisor: z
        .boolean()
        .optional()
        .describe("Allow configured asset advisor CLI/API to rewrite vague requests before provider search. Defaults to settings."),
      maxReadyFiles: z.number().int().min(1).max(500).optional().describe("Maximum files copied into ready/."),
      limit: z.number().int().min(1).max(25).optional().describe("Candidate search size before selecting best match.")
    })
  },
  async (input) => {
    try {
      const grabbed = await grabAsset(input), manifest = { ...grabbed, useInProject: useInProject(grabbed.paths.ready) };
      return {
        content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
        structuredContent: manifest
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "prepare_existing_asset",
  {
    title: "Prepare Existing Asset",
    description: "Copy and prepare a local asset into pack/ready output with a manifest and engine readiness notes. Writes files; overwrite can replace existing output.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: z.object({
      sourcePath: z.string().min(1).describe("Local file or folder to copy and prepare; project mode can also import from Downloads without changing or deleting the source."),
      origin: z.enum(["existing", "created"]).optional().describe("Existing downloaded/local asset, or code-created by an external generator. Must match saved acquisition policy; defaults existing."),
      outputDir: z.string().optional().describe(OUTPUT_DIR_HELP),
      request: z.string().optional().describe("Asset intent/name used for selection and manifest."),
      engine: z.string().optional().describe("Target engine, e.g. roblox, unity, godot."),
      formats: z.array(z.string()).optional().describe("Preferred file extensions."),
      maxReadyFiles: z.number().int().min(1).max(500).optional().describe("Maximum files copied into ready/."),
      overwrite: z.boolean().optional().describe("Overwrite existing prepared local output."),
      licenseName: z.string().optional().describe("Known asset license name."),
      licenseUrl: z.string().optional().describe("License URL."),
      sourceUrl: z.string().optional().describe("Original source URL."),
      attributionRequired: z.boolean().optional().describe("Whether attribution is required.")
    })
  },
  async (input) => {
    try {
      const prepared = await prepareExistingAsset(input), manifest = { ...prepared, useInProject: useInProject(prepared.paths.ready) };
      return {
        content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
        structuredContent: manifest
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "get_asset_manifest",
  {
    title: "Read Asset Manifest",
    description: "Read a local asset-grabber-manifest.json produced by grab_asset or prepare_existing_asset, subject to the configured safe root.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      manifestPath: z.string().min(1).describe("Path to asset-grabber-manifest.json.")
    })
  },
  async ({ manifestPath }) => {
    const resolvedManifestPath = path.resolve(manifestPath);
    if (path.basename(resolvedManifestPath) !== "asset-grabber-manifest.json") {
      throw new Error("manifestPath must point to asset-grabber-manifest.json");
    }
    assertWithinSafeRoot(resolvedManifestPath, "manifest path", true);
    const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
    return {
      content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
      structuredContent: manifest
    };
  }
);

async function main(): Promise<void> {
  if (process.argv.includes("--setup")) return runSetupCli();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

function toolJson<T extends Record<string, unknown>>(response: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }], structuredContent: response };
}

async function setupGate() {
  const setup = setupStatus(await loadSettings());
  return setup.required ? { ...toolJson({ code: "SETUP_REQUIRED", ...setup }), isError: true } : undefined;
}
