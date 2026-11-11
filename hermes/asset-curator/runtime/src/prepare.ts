import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { materializeBrowserAsset } from "./browser.js";
import { repackGltf } from "./gltf.js";
import { inspectArtifactFacts } from "./artifact-facts.js";
import { isGenerationSource } from "./registry.js";
import { extractZip } from "./archive.js";
import { downloadFile } from "./http.js";
import { createGeneratedAsset, renderGeneratedAsset, type GenerationInput } from "./generation.js";
import { renderProceduralSfx } from "./procedural-sfx.js";
import { createPixelboltAsset, renderPixelboltAsset } from "./pixelbolt.js";
import { materializePixelAsset } from "./pixel-search.js";
import { searchAssetsWithDiagnostics } from "./providers.js";
import { assertAcquisitionAllowed, loadSettings } from "./settings.js";
import type { AssetGrabberSettings, AssetSearchResponse, AssetSearchResult, GrabAssetOptions, GrabbedAssetManifest, PrepareExistingAssetOptions } from "./types.js";
import { assertWithinSafeRoot, normalizeExtension, resolveOutputDir, resolvePhysicalPath, resolveAssetFile, renameWithRetry, slugify, tokenize, toPosixPath } from "./util.js";

const TEXTURE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "mtl"]);

export async function grabAsset(options: GrabAssetOptions): Promise<GrabbedAssetManifest> {
  const settings = await loadSettings();
  if (!settings.preferences.completed) assertAcquisitionAllowed(settings, "existing");
  // assetId ("source:id" from search_assets) pins the exact result the agent or user chose.
  const pinnedSource = options.assetId ? options.assetId.slice(0, options.assetId.lastIndexOf(":")) : undefined;
  if (options.assetId && (!pinnedSource || options.source && options.source !== pinnedSource)) throw new Error("assetId must be the 'source:id' of a search_assets result and agree with source");
  const searchResponse = await searchAssetsWithDiagnostics({ ...options, source: pinnedSource ?? options.source, includeManualResults: options.includeManualResults ?? settings.preferences.browserEnabled, limit: options.assetId ? 25 : Math.max(options.limit ?? 8, 3) });
  return prepareSearchResult(options, searchResponse, settings);
}

export async function generateAsset(options: GenerationInput & Pick<GrabAssetOptions, "outputDir" | "overwrite" | "engine" | "maxReadyFiles">): Promise<GrabbedAssetManifest> {
  const settings = await loadSettings();
  assertAcquisitionAllowed(settings, "create");
  const asset = createGeneratedAsset(options);
  return prepareSearchResult(options, {
    results: [asset], diagnostics: [{ source: "procedural", ok: true, count: 1 }],
    advisor: { provider: "none", used: false, originalRequest: options.request, request: options.request }
  }, settings);
}

export async function generatePixelRecipe(options: { request: string; recipe: Record<string, unknown> } & Pick<GrabAssetOptions, "outputDir" | "overwrite" | "engine" | "maxReadyFiles">): Promise<GrabbedAssetManifest> {
  const settings = await loadSettings();
  assertAcquisitionAllowed(settings, "create");
  const asset = createPixelboltAsset(options.recipe);
  return prepareSearchResult(options, { results: [asset], diagnostics: [{ source: "procedural", ok: true, count: 1 }], advisor: { provider: "none", used: false, originalRequest: options.request, request: options.request } }, settings);
}

async function prepareSearchResult(options: GrabAssetOptions, searchResponse: AssetSearchResponse, settings: AssetGrabberSettings): Promise<GrabbedAssetManifest> {
  const outputRoot = resolveOutputDir(options.outputDir || settings.search.defaultOutputDir);
  const results = searchResponse.results;
  const asset = options.assetId ? results.find((item) => `${item.source}:${item.id}` === options.assetId) : results.find(isDirectMaterialized) ?? results[0];
  if (options.assetId && !asset) throw new Error(`assetId ${options.assetId} is not among the current results for this request. Repeat the request text used in search_assets; nothing else was downloaded in its place.`);
  if (!asset) {
    const failed = searchResponse.diagnostics.filter((item) => !item.ok);
    throw new Error("No asset results for request: " + options.request + (failed.length ? ". Provider failures: " + failed.map((item) => item.source + ": " + item.error).join("; ") : ""));
  }
  const browserAllowed = settings.preferences.browserEnabled && !isGenerationSource(asset.source) && !asset.generatedAsset && !asset.derivedAsset;
  assertAcquisitionAllowed(settings, asset.generatedAsset ? "create" : "existing");
  const safety = asset.licenseSafety ?? (asset.license.toLowerCase().includes("cc0") ? 10 : 0);
  if (settings.preferences.licensePolicy === "safe" && (safety < Math.max(6, settings.search.minLicenseSafety) || /verify|unknown|per.item|license varies/i.test(asset.license))) throw new Error("Refusing unconfirmed license: " + asset.license);
  const cacheKey = cacheKeyFor(options, asset, settings.preferences.licensePolicy);
  const cachedOutput = await resolveCachedOutput(outputRoot, asset, cacheKey, Boolean(options.overwrite));
  if (cachedOutput.cached) return { ...cachedOutput.cached, cacheHit: true };
  if (!isDirectMaterialized(asset) && !browserAllowed) throw new Error(asset.source + ":" + asset.title + " is not a direct download. Browser assistance needs explicit saved consent; use search_assets for source/license details.");
  const root = cachedOutput.root;
  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(root), ".ag-"));
  const packDir = path.join(staging, "pack"), readyDir = path.join(staging, "ready"), archivePath = path.join(staging, "source.zip");
  try {
    const limits = { maxDownloadBytes: settings.search.maxDownloadBytes, maxExtractedBytes: settings.search.maxExtractedBytes, maxExtractedFiles: settings.search.maxExtractedFiles };
    let materialized: { files: string[]; archiveWritten: boolean; browser?: import("./browser.js").BrowserTrace };
    if (!isDirectMaterialized(asset)) materialized = await materializeBrowserAsset(asset, archivePath, packDir, settings);
    else {
      try { materialized = await materializeAsset(asset, archivePath, packDir, limits); }
      catch (error) {
        if (!browserAllowed) throw error;
        await rm(packDir, { recursive: true, force: true });
        await rm(archivePath, { force: true });
        materialized = await materializeBrowserAsset(asset, archivePath, packDir, settings);
      }
    }
    if (!materialized.files.length) throw new Error("Asset contained no supported materialized files");
    await mkdir(readyDir, { recursive: true });
    const selectedFiles = await includeReadyDependencies(selectReadyFiles(materialized.files, options, asset), materialized.files, packDir);
    // "as a GLB" in the request means one portable file: embed a glTF's sidecars instead of shipping loose files.
    const repack = options.formats ?? (/\bglb\b/i.test(options.request) && !/\bgltf\b/i.test(options.request) ? ["glb"] : undefined);
    // An explicit formats list is a requirement; a format mentioned in prose is a preference that may fall back.
    const prepared = await prepareReadyFiles(selectedFiles, packDir, readyDir, repack, limits.maxExtractedBytes, !options.formats);
    const readyFiles = prepared.files;
    await writeLicensePointer(readyDir, asset);
    const keepArchive = (options.includeSourceArchive ?? settings.search.keepSourceArchives) && materialized.archiveWritten;
    if (!keepArchive) await rm(archivePath, { force: true });
    const manifest: GrabbedAssetManifest = {
      request: options.request, generatedAt: new Date().toISOString(), source: asset.source, asset,
      paths: { root, pack: path.join(root, "pack"), ready: path.join(root, "ready"), archive: keepArchive ? path.join(root, "source.zip") : undefined, manifest: path.join(root, "asset-grabber-manifest.json") },
      selectedFiles: selectedFiles.map((file) => toPosixPath(path.relative(packDir, file))),
      readyFiles: readyFiles.map((file) => toPosixPath(path.relative(readyDir, file))),
      allExtractedFileCount: materialized.files.length, conversions: prepared.conversions, conversionWarnings: prepared.warnings.length ? prepared.warnings : undefined, artifactFacts: await inspectArtifactFacts(readyFiles, readyDir), cacheKey, advisor: searchResponse.advisor, relevance: searchResponse.relevance, diagnostics: searchResponse.diagnostics, browser: materialized.browser,
      license: { name: asset.license, url: asset.licenseUrl, attributionRequired: asset.attributionRequired ?? false, shipSafe: isShipSafe(asset) && (!materialized.browser || materialized.browser.licenseConfirmed) },
      engineReadiness: getEngineReadiness(options, asset, readyFiles), importNotes: getImportNotes(options, asset), alternatives: results.filter((item) => item !== asset)
    };
    await writeFile(path.join(staging, "asset-grabber-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await commitStaging(staging, root, asset, Boolean(options.overwrite));
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function resolveCachedOutput(outputRoot: string, asset: AssetSearchResult, key: string, overwrite: boolean): Promise<{ root: string; cached?: GrabbedAssetManifest }> {
  const base = path.join(outputRoot, slugify(asset.source), slugify(asset.id));
  let root = base;
  assertOutputContained(outputRoot, root);
  let cached = await ownedManifest(root, asset);
  if (!overwrite && cached?.cacheKey === key && await exists(path.join(root, "ready"))) return { root, cached };
  if (await exists(root)) {
    if (overwrite && !cached) throw new Error("Refusing to overwrite output without a matching Asset Curator manifest");
    if (!overwrite) {
      root = base + "-" + createHash("sha256").update(key).digest("hex").slice(0, 12);
      assertOutputContained(outputRoot, root);
      cached = await ownedManifest(root, asset);
      if (cached?.cacheKey === key && await exists(path.join(root, "ready"))) return { root, cached };
      if (await exists(root)) throw new Error("Output variant exists without a matching reusable manifest; choose a different outputDir");
    }
  }
  return { root };
}

async function commitStaging(staging: string, root: string, asset: AssetSearchResult, overwrite: boolean): Promise<void> {
  let previous: string | undefined;
  if (await exists(root)) {
    if (!overwrite || !await ownedManifest(root, asset)) throw new Error("Output changed during preparation; refusing implicit overwrite");
    previous = root + ".previous-" + randomUUID();
    await renameWithRetry(root, previous);
  }
  try { await renameWithRetry(staging, root); }
  catch (error) { if (previous) await renameWithRetry(previous, root); throw error; }
  if (previous) await rm(previous, { recursive: true, force: true });
}

async function ownedManifest(root: string, asset: AssetSearchResult): Promise<GrabbedAssetManifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "asset-grabber-manifest.json"), "utf8")) as GrabbedAssetManifest;
    return manifest.source === asset.source && manifest.asset?.id === asset.id && manifest.paths?.root === root ? manifest : undefined;
  } catch { return undefined; }
}

export async function prepareExistingAsset(options: PrepareExistingAssetOptions): Promise<GrabbedAssetManifest> {
  const settings = await loadSettings();
  assertAcquisitionAllowed(settings, options.origin === "created" ? "create" : "existing");
  if (settings.preferences.licensePolicy === "safe" && (!options.licenseName?.trim() || /verify|unknown|per.item/i.test(options.licenseName))) throw new Error("Safe license policy requires known licenseName for local assets. Record the actual license or ownership; do not invent it.");
  const sourcePath = path.resolve(options.sourcePath);
  assertWithinSafeRoot(sourcePath, "source asset path");
  const outputRoot = resolveOutputDir(options.outputDir || settings.search.defaultOutputDir);
  const request = options.request || path.basename(sourcePath), id = slugify(request);
  const asset: AssetSearchResult = {
    source: "local", id, title: request, url: options.sourceUrl || sourcePath, category: "Unknown", tags: tokenize(request), series: ["Local"],
    license: options.licenseName || "Local asset; verify license before shipping", licenseUrl: options.licenseUrl, attributionRequired: options.attributionRequired ?? true,
    licenseSafety: options.licenseName ? 6 : 0, score: 1, reason: options.origin === "created" ? "Prepared from caller-identified code-created local files" : "Prepared from local files", downloadMode: "direct"
  };
  const base = path.join(outputRoot, "local", id), physicalSource = resolvePhysicalPath(sourcePath);
  assertOutputContained(outputRoot, base);
  if (containsPath(physicalSource, resolvePhysicalPath(base)) || containsPath(resolvePhysicalPath(base), physicalSource)) throw new Error("Source and prepared output must not overlap; choose a separate output directory.");
  const info = await stat(sourcePath), sourceFiles = info.isFile() ? [sourcePath] : info.isDirectory() ? await listFiles(sourcePath, settings.search.maxExtractedFiles) : [];
  if (!sourceFiles.length || sourceFiles.length > settings.search.maxExtractedFiles) throw new Error("Local source is empty, unsupported or exceeds the configured file cap");
  const fileStats = await Promise.all(sourceFiles.map(async (file) => { const item = await stat(file); return [path.relative(sourcePath, file), item.size, item.mtimeMs] as const; }));
  if (fileStats.reduce((bytes, item) => bytes + item[1], 0) > settings.search.maxExtractedBytes) throw new Error("Local source exceeds configured byte cap");
  const cacheKey = createHash("sha256").update(cacheKeyFor({ ...options, request }, asset, settings.preferences.licensePolicy)).update(JSON.stringify({ sourcePath, origin: options.origin ?? "existing", files: fileStats })).digest("hex");
  const cachedOutput = await resolveCachedOutput(outputRoot, asset, cacheKey, Boolean(options.overwrite));
  if (cachedOutput.cached) return cachedOutput.cached;
  const root = cachedOutput.root;
  if (containsPath(physicalSource, resolvePhysicalPath(root)) || containsPath(resolvePhysicalPath(root), physicalSource)) throw new Error("Source and prepared output must not overlap");
  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(root), ".ag-"));
  const packDir = path.join(staging, "pack"), readyDir = path.join(staging, "ready"), archivePath = path.join(staging, "source.zip");
  try {
    await mkdir(packDir, { recursive: true });
    const zip = info.isFile() && normalizeExtension(sourcePath) === "zip";
    let copied: string[];
    if (zip) { await copyFile(sourcePath, archivePath); copied = await extractZip(archivePath, packDir, { maxBytes: settings.search.maxExtractedBytes, maxFiles: settings.search.maxExtractedFiles }); }
    else copied = await copyLocalAsset(sourcePath, packDir, settings.search.maxExtractedFiles);
    if ((await Promise.all(copied.map((file) => stat(file)))).reduce((bytes, item) => bytes + item.size, 0) > settings.search.maxExtractedBytes) throw new Error("Copied local source exceeds configured byte cap");
    await mkdir(readyDir, { recursive: true });
    const selected = await includeReadyDependencies(selectReadyFiles(copied, { ...options, request }, asset), copied, packDir);
    const prepared = await prepareReadyFiles(selected, packDir, readyDir, options.formats, settings.search.maxExtractedBytes), ready = prepared.files;
    await writeLicensePointer(readyDir, asset);
    const keepArchive = zip && settings.search.keepSourceArchives;
    if (!keepArchive) await rm(archivePath, { force: true });
    const manifest: GrabbedAssetManifest = {
      request, generatedAt: new Date().toISOString(), source: "local", asset, cacheKey,
      paths: { root, pack: path.join(root, "pack"), ready: path.join(root, "ready"), archive: keepArchive ? path.join(root, "source.zip") : undefined, manifest: path.join(root, "asset-grabber-manifest.json") },
      selectedFiles: selected.map((file) => toPosixPath(path.relative(packDir, file))), readyFiles: ready.map((file) => toPosixPath(path.relative(readyDir, file))), allExtractedFileCount: copied.length, conversions: prepared.conversions, artifactFacts: await inspectArtifactFacts(ready, readyDir),
      license: { name: asset.license, url: asset.licenseUrl, attributionRequired: asset.attributionRequired ?? false, shipSafe: isShipSafe(asset) },
      engineReadiness: getEngineReadiness({ ...options, request }, asset, ready), importNotes: getImportNotes({ ...options, request }, asset), alternatives: []
    };
    await writeFile(path.join(staging, "asset-grabber-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await commitStaging(staging, root, asset, Boolean(options.overwrite));
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function selectReadyFiles(files: string[], options: GrabAssetOptions, asset: AssetSearchResult): string[] {
  if (options.fullPack) return files;

  const maxFiles = Math.max(1, Math.min(options.maxReadyFiles ?? 80, 500));
  const requestTokens = expandFileTokens(tokenize(options.request), options.request);
  const desiredExtensions = new Set(inferFormats(options, asset));
  const families = [["glb", "gltf", "fbx", "obj", "blend", "dae", "bvh"], ["png", "jpg", "jpeg", "webp", "svg", "apng", "gif"], ["wav", "ogg", "mp3", "flac"], ["ttf", "otf", "woff", "woff2"]];
  const compatible = new Set([...desiredExtensions, ...families.filter(group => group.some(ext => desiredExtensions.has(ext))).flat()]);
  const scored = files
    .map((file) => ({
      file,
      score: scoreFile(file, requestTokens, desiredExtensions)
    }))
    .filter((item) => item.score > 0 && (!options.formats?.length || compatible.has(normalizeExtension(item.file))))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const selected = new Set(scored.slice(0, maxFiles).map((item) => item.file));
  includeNearbyTextures(files, selected);

  if (selected.size === 0) {
    for (const file of files) {
      if (desiredExtensions.has(normalizeExtension(file))) selected.add(file);
      if (selected.size >= maxFiles) break;
    }
  }

  if (selected.size === 0) {
    for (const file of files.slice(0, maxFiles)) selected.add(file);
  }

  const notices = files.filter((file) => /^(?:license(?:[-_.].*)?|copying(?:\..*)?|ofl(?:\..*)?|notice(?:\..*)?|copyright(?:\..*)?)$/i.test(path.basename(file)) || /-LICENSE\.txt$/i.test(path.basename(file)));
  // Permission/copyright notices and a generated sprite's engine sidecars are
  // required metadata, not optional asset slots. Keep the referenced sheet too.
  const sidecars: string[] = [];
  if (asset.generatedAsset?.kind === "pixelbolt") {
    const name = String(asset.generatedAsset.recipe.name), atlas = files.find(file => path.basename(file) === name + ".atlas.json");
    if (atlas) for (const file of files) if (path.dirname(file) === path.dirname(atlas) && [name + ".png", name + ".atlas.json", name + ".tres", name + ".tileset.tres", name + ".tsx"].includes(path.basename(file))) sidecars.push(file);
  }
  return [...new Set([...selected].slice(0, maxFiles).concat(notices, sidecars))];
}

function expandFileTokens(tokens: string[], request: string): string[] {
  const expanded = new Set(tokens);
  const lower = request.toLowerCase();

  if (/\b(car|vehicle|auto|automobile)\b/.test(lower)) {
    for (const token of ["sedan", "hatchback", "suv", "race", "sports", "van"]) expanded.add(token);
  }
  if (/\bred\b/.test(lower)) {
    for (const token of ["firetruck", "race", "sports"]) expanded.add(token);
  }

  return [...expanded];
}

function inferFormats(options: GrabAssetOptions, asset: AssetSearchResult): string[] {
  if (options.formats?.length) return options.formats.map((format) => format.toLowerCase().replace(/^\./, ""));

  const lower = `${options.request} ${options.engine ?? ""}`.toLowerCase();
  if (/\b(hdri|hdr|exr|environment[ -]?map|skybox|panorama)\b/.test(lower)) return ["hdr", "exr", "jpg", "png"];
  if (/\b(font|fonts|typeface|typography)\b/.test(lower)) return ["ttf", "otf", "woff", "woff2"];
  if (asset.category === "3D" || asset.category === "Unknown" && /\b(3d|roblox|unity|unreal|model|mesh)\b/.test(lower)) {
    return ["glb", "gltf", "fbx", "obj", "blend", "mtl", "png", "jpg", "jpeg"];
  }
  if (asset.category === "Audio" || asset.category === "Music" || /\b(audio|sound|sfx|music)\b/.test(lower)) {
    return ["wav", "ogg", "mp3", "json"];
  }
  if (asset.category === "Animation" || /\b(animation|mocap|rig)\b/.test(lower)) return ["fbx", "bvh", "dae", "glb", "gltf"];
  if (asset.category === "VFX" || /\b(vfx|visual effect|particle|particles)\b/.test(lower)) {
    return ["png", "jpg", "jpeg", "webp", "json", "unitypackage", "uasset"];
  }
  if (asset.category === "Textures" || /\b(texture|material)\b/.test(lower)) return ["png", "jpg", "jpeg", "webp"];
  return ["png", "svg", "json", "xml", "tsx", "tmx"];
}

async function materializeAsset(
  asset: AssetSearchResult,
  archivePath: string,
  packDir: string,
  limits: { maxDownloadBytes: number; maxExtractedBytes: number; maxExtractedFiles: number }
): Promise<{ files: string[]; archiveWritten: boolean }> {
  await mkdir(packDir, { recursive: true });

  if (asset.generatedAsset || asset.derivedAsset) {
    const descriptor = asset.generatedAsset;
    const generatedFiles = asset.derivedAsset ? await materializePixelAsset(asset.derivedAsset)
      : descriptor?.kind === "procedural-sfx" ? renderProceduralSfx(descriptor)
      : descriptor?.kind === "pixelbolt" ? await renderPixelboltAsset(descriptor) : renderGeneratedAsset(descriptor!);
    if (generatedFiles.length > limits.maxExtractedFiles || generatedFiles.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > limits.maxExtractedBytes) throw new Error("Generated output exceeds configured extraction limits");
    const files: string[] = [];
    for (const generated of generatedFiles) {
      const target = resolveAssetFile(packDir, generated.fileName);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, generated.content);
      files.push(target);
    }
    return { files, archiveWritten: false };
  }

  if (asset.downloadUrl) {
    const fileName = asset.downloadFileName ? sanitizeFileName(asset.downloadFileName) : fileNameFromUrl(asset.downloadUrl, `${asset.id}`);
    const extension = normalizeExtension(fileName);
    if (extension === "zip") {
      await downloadFile(asset.downloadUrl, archivePath, { maxBytes: limits.maxDownloadBytes });
      return {
        files: await extractZip(archivePath, packDir, {
          maxBytes: limits.maxExtractedBytes,
          maxFiles: limits.maxExtractedFiles
        }),
        archiveWritten: true
      };
    }
    const target = path.join(packDir, fileName);
    await downloadFile(asset.downloadUrl, target, { maxBytes: Math.min(limits.maxDownloadBytes, limits.maxExtractedBytes) });
    return { files: [target], archiveWritten: false };
  }

  const files: string[] = [];
  if ((asset.downloadUrls?.length ?? 0) > limits.maxExtractedFiles) throw new Error("Download set exceeds configured file cap");
  let bytes = 0;
  for (const download of asset.downloadUrls ?? []) {
    const fileName = download.fileName ?? fileNameFromUrl(download.url, asset.id);
    const target = resolveAssetFile(packDir, fileName);
    if (files.some(file => file.toLowerCase() === target.toLowerCase())) throw new Error("Duplicate download output path");
    await mkdir(path.dirname(target), { recursive: true });
    const remaining = limits.maxExtractedBytes - bytes;
    if (remaining <= 0) throw new Error("Download set exceeds configured byte cap");
    await downloadFile(download.url, target, { maxBytes: Math.min(limits.maxDownloadBytes, remaining) });
    bytes += (await stat(target)).size;
    files.push(target);
  }
  return { files, archiveWritten: false };
}

function cacheKeyFor(options: GrabAssetOptions, asset: AssetSearchResult, licensePolicy: "safe" | "any"): string {
  return JSON.stringify({
    cacheSchema: 6,
    request: options.request,
    licensePolicy,
    category: options.category,
    source: options.source,
    engine: options.engine,
    formats: options.formats?.map((format) => format.toLowerCase().replace(/^\./, "")).sort(),
    fullPack: Boolean(options.fullPack),
    maxReadyFiles: options.maxReadyFiles ?? 80,
    asset: {
      source: asset.source,
      id: asset.id,
      url: asset.url,
      downloadUrl: asset.downloadUrl,
      downloadUrls: asset.downloadUrls,
      derivedAsset: asset.derivedAsset,
      license: asset.license, licenseUrl: asset.licenseUrl, licenseSafety: asset.licenseSafety,
      attribution: asset.attribution, attributionRequired: asset.attributionRequired, creator: asset.creator
    }
  });
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const name = path.basename(new URL(url).pathname);
    if (!path.extname(name) && path.extname(fallback)) return sanitizeFileName(fallback);
    return sanitizeFileName(decodeURIComponent(name || fallback));
  } catch {
    return sanitizeFileName(fallback);
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 160) || "asset";
}

function scoreFile(file: string, requestTokens: string[], desiredExtensions: Set<string>): number {
  const ext = normalizeExtension(file);
  const normalized = toPosixPath(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  let score = desiredExtensions.has(ext) ? 10 : 0;
  if (ext === "glb") score += 6;
  else if (ext === "gltf") score += desiredExtensions.has("glb") ? 9 : 5;
  else if (ext === "fbx") score += 5;
  else if (ext === "obj") score += 4;
  else if (ext === "wav") score += 4;
  else if (ext === "ogg" || ext === "mp3") score += 3;
  else if (ext === "png") score += 2;
  if (["ttf", "otf", "woff", "woff2"].includes(ext)) {
    const italic = /italic|oblique/.test(base), wantsItalic = requestTokens.includes("italic") || requestTokens.includes("oblique");
    if (italic) score += wantsItalic ? 12 : -8;
  }

  for (const token of requestTokens) {
    if (base.includes(token)) score += 8;
    else if (normalized.includes(token)) score += 4;
  }

  if (/\/(preview|sample|screenshots?)\//.test(normalized) || /preview|sample/.test(base)) score -= 8;
  if (/\/models?\//.test(normalized)) score += 3;
  if (/\/textures?\//.test(normalized)) score += 2;
  return score;
}

function includeNearbyTextures(files: string[], selected: Set<string>): void {
  const selectedDirs = new Set([...selected].map((file) => path.dirname(file)));
  for (const file of files) {
    const ext = normalizeExtension(file);
    if (!TEXTURE_EXTENSIONS.has(ext)) continue;
    const dir = path.dirname(file);
    const normalized = toPosixPath(file).toLowerCase();
    if (selectedDirs.has(dir) || /\/textures?\//.test(normalized)) selected.add(file);
  }
}

async function includeReadyDependencies(selected: string[], files: string[], packDir: string): Promise<string[]> {
  const result = new Set(selected), available = new Map(files.map(file => [process.platform === "win32" ? file.toLowerCase() : file, file]));
  for (const file of selected) {
    if (normalizeExtension(file) !== "gltf") continue;
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error("glTF metadata exceeds 8 MiB cap; use a bounded model or GLB");
    let model: { asset?: { version?: string }; buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] };
    try { model = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new Error("Invalid glTF JSON; refusing an incomplete ready model"); }
    if (model.asset?.version !== "2.0") throw new Error("Unsupported glTF metadata version");
    for (const item of [...(model.buffers ?? []), ...(model.images ?? [])]) {
      if (item.uri === undefined) continue;
      if (typeof item.uri !== "string") throw new Error("Invalid glTF dependency URI");
      if (item.uri.startsWith("data:")) continue;
      let uri: string;
      try { uri = decodeURIComponent(item.uri.split(/[?#]/)[0]); }
      catch { throw new Error("Invalid glTF dependency URI encoding"); }
      if (!uri || /^[a-z][a-z0-9+.-]*:/i.test(uri) || /^[\\/]/.test(uri) || /[\x00-\x1f]/.test(uri)) throw new Error("Remote/absolute glTF dependency refused; package dependencies locally");
      const target = path.resolve(path.dirname(file), uri);
      if (!containsPath(packDir, target)) throw new Error("glTF dependency escapes its source pack");
      const dependency = available.get(process.platform === "win32" ? target.toLowerCase() : target);
      if (!dependency) throw new Error("Missing glTF dependency: " + uri);
      result.add(dependency);
    }
  }
  // Buffers/textures are required parts, not optional media slots.
  return [...result];
}

async function prepareReadyFiles(files: string[], packDir: string, readyDir: string, formats: string[] | undefined, maxBytes: number, lenient = false) {
  // CDN suffixes and Content-Type are not proof of the actual encoding. Reject
  // JPEG/HTML disguised as PNG instead of shipping a misleading ready/ manifest.
  // This is a bounded header check, not decoding, alpha or appearance validation.
  for (const file of files) {
    if (!["png", "apng"].includes(normalizeExtension(file))) continue;
    const handle = await open(file, "r");
    try {
      const header = Buffer.alloc(33), { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead < 33 || !header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR" || !header.readUInt32BE(16) || !header.readUInt32BE(20)) throw new Error("PNG signature/IHDR mismatch: " + path.basename(file) + "; source did not supply a valid PNG header. No format conversion or transparency is inferred.");
    } finally { await handle.close(); }
  }
  const ready = await copyReadyFiles(files, packDir, readyDir);
  const conversions: NonNullable<GrabbedAssetManifest["conversions"]> = [];
  let producedBytes = 0;
  const embedded = new Set<number>(), warnings: string[] = [];
  if (formats?.some(format => format.toLowerCase().replace(/^\./, "") === "glb")) {
    for (let index = 0; index < ready.length; index++) {
      if (normalizeExtension(ready[index]) !== "gltf") continue;
      const output = ready[index].slice(0, -5) + ".glb";
      try { await repackGltf(files[index], packDir, output); }
      catch (error) {
        if (!lenient) throw error;
        // Deliver the working glTF with its sidecars rather than nothing, and say why.
        await rm(output, { force: true });
        warnings.push(`${path.basename(files[index])} was not repacked into a single GLB (${error instanceof Error ? error.message : String(error)}); the glTF and its referenced files are delivered instead.`);
        continue;
      }
      producedBytes += (await stat(output)).size;
      if (producedBytes > maxBytes) throw new Error("GLB repack set exceeds configured byte cap");
      conversions.push({ source: toPosixPath(path.relative(packDir, files[index])), output: toPosixPath(path.relative(readyDir, output)), operation: "embed-gltf-resources" });
      await unlink(ready[index]); // Only our fresh staging copy; source pack stays intact.
      ready[index] = output;
      embedded.add(index);
    }
    // Every glTF is now a self-contained GLB, so its loose buffers/textures in ready/ are duplicates.
    // pack/ keeps the originals; licence and notice files are never removed.
    const keep: string[] = [];
    const allEmbedded = !warnings.length;
    for (let index = 0; index < ready.length; index++) {
      if (!embedded.has(index) && embedded.size && allEmbedded && ["bin", "png", "jpg", "jpeg", "webp", "ktx2"].includes(normalizeExtension(ready[index]))) await unlink(ready[index]);
      else keep.push(ready[index]);
    }
    return { files: keep, conversions, warnings };
  }
  return { files: ready, conversions, warnings };
}

async function copyReadyFiles(files: string[], packDir: string, readyDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const file of files) {
    const relative = path.relative(packDir, file);
    const target = path.join(readyDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
    copied.push(target);
  }
  return copied;
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertOutputContained(outputRoot: string, root: string): void {
  assertWithinSafeRoot(root, "asset output path");
  if (!containsPath(resolvePhysicalPath(outputRoot), resolvePhysicalPath(root))) throw new Error("Asset output resolves outside its output directory");
}

async function copyLocalAsset(sourcePath: string, packDir: string, maxFiles: number): Promise<string[]> {
  const info = await stat(sourcePath);
  if (info.isFile()) {
    const target = path.join(packDir, sanitizeFileName(path.basename(sourcePath)));
    await copyFile(sourcePath, target);
    return [target];
  }
  if (!info.isDirectory()) throw new Error(`sourcePath is not a file or directory: ${sourcePath}`);
  const files = await listFiles(sourcePath, maxFiles);
  const copied: string[] = [];
  for (const file of files) {
    const relative = path.relative(sourcePath, file);
    if (relative.split(path.sep).some((part) => part === "node_modules" || part === ".git")) continue;
    const target = path.join(packDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
    copied.push(target);
  }
  return copied;
}

async function listFiles(root: string, maxFiles = 10_000, files: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await listFiles(fullPath, maxFiles, files);
    else if (entry.isFile()) files.push(fullPath);
    if (files.length > maxFiles) throw new Error("Local source exceeds configured file cap");
  }
  return files;
}

async function writeLicensePointer(readyDir: string, asset: AssetSearchResult): Promise<void> {
  const text = [
    `Asset: ${asset.title}`,
    `Source: ${asset.url}`,
    `License: ${asset.license}`,
    `License URL: ${asset.licenseUrl ?? "not provided"}`,
    `Creator: ${asset.creator ?? "see source"}`,
    `Creator URL: ${asset.creatorUrl ?? "see source"}`,
    `Attribution / notice: ${asset.attribution ?? "see license terms"}`,
    `Attribution required: ${asset.attributionRequired ? "yes" : "no"}`
  ].join("\n");
  await writeFile(path.join(readyDir, "ASSET_SOURCE.txt"), `${text}\n`, "utf8");
}

function getEngineReadiness(options: GrabAssetOptions, asset: AssetSearchResult, selectedFiles: string[]) {
  const recommendedFormats = inferFormats(options, asset);
  const selectedFormats = [...new Set(selectedFiles.map(normalizeExtension).filter(Boolean))].sort();
  const selectedSet = new Set(selectedFormats);
  const warnings: string[] = [];
  const lower = `${options.request} ${options.engine ?? ""}`.toLowerCase();
  if (/\broblox\b/.test(lower) && asset.category === "3D" && !["glb", "fbx", "obj"].some((format) => selectedSet.has(format))) {
    warnings.push("No Roblox-friendly mesh format selected; prefer GLB, FBX, or OBJ.");
  }
  if ((asset.category === "3D" || /\b(3d|model|mesh)\b/.test(lower)) && !["glb", "gltf", "fbx", "obj", "blend"].some((format) => selectedSet.has(format))) {
    warnings.push("No common 3D model format selected.");
  }
  if ((asset.category === "Audio" || asset.category === "Music") && !["wav", "ogg", "mp3"].some((format) => selectedSet.has(format))) {
    warnings.push("No common audio format selected.");
  }
  if (/\broblox\b/.test(lower) && selectedSet.has("svg")) warnings.push("Roblox image upload does not import SVG directly; rasterize to PNG before upload. No automatic conversion has been performed.");
  if (/\broblox\b/.test(lower) && (selectedSet.has("hdr") || selectedSet.has("exr"))) warnings.push("Roblox does not directly import HDR/EXR environments; convert to supported skybox images externally.");
  if (options.formats?.length && !options.formats.some(format => selectedSet.has(format.toLowerCase().replace(/^\./, "")))) warnings.push("None of the requested formats were available; no automatic conversion was performed.");
  if (asset.attributionRequired) warnings.push("Attribution required; preserve ASSET_SOURCE.txt in project credits.");
  return {
    basis: "format-and-metadata-only-no-engine-import" as const,
    engine: options.engine,
    recommendedFormats,
    selectedFormats,
    warnings,
    notes: getImportNotes(options, asset)
  };
}

function isShipSafe(asset: AssetSearchResult): boolean {
  const licenseSafety = asset.licenseSafety ?? (asset.license.toLowerCase().includes("cc0") ? 10 : 0);
  return licenseSafety >= 6 && !/verify|unknown/i.test(asset.license);
}

function getImportNotes(options: GrabAssetOptions, asset: AssetSearchResult): string[] {
  const lower = `${options.request} ${options.engine ?? ""}`.toLowerCase();
  if (lower.includes("roblox") && (asset.category === "Audio" || asset.category === "Music")) return ["Upload the licensed audio through Roblox asset tools, then use the resulting asset id in Sound.SoundId. Ownership, permissions and moderation still apply."];
  if (lower.includes("roblox") && ["2D", "UI", "VFX"].includes(asset.category)) return ["Use supported PNG/JPG images with Roblox ImageLabel/ImageButton or particle textures. Rasterize SVG before upload; use spritesheet JSON to set ImageRectOffset/ImageRectSize. No upload or conversion is performed automatically."];
  if (lower.includes("roblox") && asset.category === "Textures") return ["Use compatible PNG/JPG PBR maps with SurfaceAppearance after upload. HDR/EXR environments and height maps require external conversion or engine-specific setup."];
  if (lower.includes("roblox")) {
    return [
      "Roblox supports OBJ, FBX, and GLB; prefer GLB when present.",
      "Use Studio Home > Import 3D, then select the ready model file.",
      "If colors/textures are missing, import matching texture files from ready/Textures or pack/Textures."
    ];
  }
  if (asset.category === "3D") {
    return ["Prefer GLB/FBX when present; keep texture folders beside model files."];
  }
  if (asset.category === "2D" || asset.category === "UI") {
    return ["Use PNG/SVG files from ready/; spritesheets may need matching XML/JSON metadata."];
  }
  if (asset.category === "Audio" || asset.category === "Music") {
    return ["Use WAV/OGG/MP3 files from ready/; keep source params/manifests beside procedural sounds."];
  }
  if (asset.category === "Animation") {
    return ["Use FBX/BVH/GLB animation files from ready/; retarget clips inside the target engine when needed."];
  }
  if (asset.category === "VFX") {
    return ["Use spritesheets, flipbooks, particle textures, or engine package links from ready/ or source page."];
  }
  return ["Use files from ready/ first; full extracted pack remains in pack/."];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function hasMaterialization(asset: AssetSearchResult): boolean {
  return Boolean(asset.downloadUrl || asset.downloadUrls?.length || asset.generatedAsset || asset.derivedAsset);
}

function isDirectMaterialized(asset: AssetSearchResult): boolean {
  return asset.downloadMode === "direct" && hasMaterialization(asset);
}
