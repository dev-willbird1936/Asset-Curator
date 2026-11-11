import * as cheerio from "cheerio";
import path from "node:path";
import { applyAssetAdvisor, assessAssetRelevance } from "./advisor.js";
import { fetchText } from "./http.js";
import { searchFontCatalog, searchIconCatalog } from "./catalogs.js";
import { searchGeneratedAssets } from "./generation.js";
import { searchPixelAssets } from "./pixel-search.js";
import { searchOpenverse } from "./openverse.js";
import { searchKenneyAssets } from "./kenney.js";
import { expandedRequest, inferCategory, namedSources, parseIntent, quotedPhrases, scoreText, styleEvidence, styleScore, violatesNegatives } from "./intent.js";
import { searchKayKit } from "./kaykit.js";
import { createProceduralSfxDescriptor, matchProceduralSfxPreset } from "./procedural-sfx.js";
import { assistedSourceIds, isGenerationSource, manualSourceIds } from "./registry.js";
import { customSourceResults, isSourceEnabled, loadSettings, passesLicenseSettings, sourcePriorityBoost } from "./settings.js";
import { slugify, tokenize } from "./util.js";
// Real catalogue searches whose packs need the browser route. They always run, so a
// search can say "Kenney has this, but browser assistance is off" instead of nothing.
const REPORT_WHEN_HIDDEN = new Set(["kenney", "quaternius"]);
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
const ASSISTED_SOURCES = new Set(assistedSourceIds());
const MANUAL_ONLY_SOURCES = new Set(manualSourceIds());
export const PROVIDERS = [
    { source: "kenney", search: searchKenneyAssets },
    { source: "ambientcg", search: searchAmbientCg },
    { source: "polyhaven", search: searchPolyHaven },
    { source: "openclipart", search: searchOpenClipart },
    { source: "openverse", search: searchOpenverse },
    { source: "pixel-search", search: searchPixelAssets },
    { source: "game-icons", search: (options) => searchIconCatalog("game-icons", options) },
    { source: "lucide", search: (options) => searchIconCatalog("lucide", options) },
    { source: "tabler", search: (options) => searchIconCatalog("tabler", options) },
    { source: "google-fonts", search: searchFontCatalog },
    { source: "jsfxr", search: searchProceduralSfx },
    { source: "procedural", search: searchGeneratedAssets },
    { source: "mixkit", search: searchMixkit },
    { source: "99sounds", search: search99Sounds },
    { source: "itch-vfx", search: searchItchVfx },
    { source: "pixabay-audio", search: searchPixabayAudio },
    { source: "quaternius", search: searchQuaternius },
    { source: "kaykit", search: searchKayKit },
    staticSource("sharetextures", "ShareTextures", "https://www.sharetextures.com/", "Textures", 9.1, "Custom CC0. Site has redirect/human browsing; direct API not wired."),
    staticSource("devassets", "DevAssets", "https://devassets.com/", "2D", 8.9, "Free commercial use, no raw resale. Direct catalog API not wired."),
    staticSource("pixel-frog", "Pixel Frog", "https://pixelfrog-assets.itch.io/", "2D", 8.7, "Pixel art packs; verify per-pack license/download flow."),
    staticSource("sonniss-gdc", "Sonniss GDC", "https://sonniss.com/gameaudiogdc/", "Audio", 8.7, "Free game-audio bundles; site blocks simple automated direct download.", "Sonniss GDC free bundle license"),
    staticSource("bfxr", "Bfxr", "https://www.bfxr.net/", "Audio", 8.6, "Open-source browser SFX generator; manual WAV export.", "Generated output from open-source SFX tool"),
    staticSource("chiptone", "ChipTone", "https://sfbgames.itch.io/chiptone", "Audio", 8.8, "Free SFX generator; generated sounds are CC0.", "Creative Commons CC0"),
    staticSource("beepbox", "BeepBox", "https://www.beepbox.co/", "Music", 8.3, "Free browser music sketch tool; save song data in URL and export manually.", "User-created music; tool is free to use"),
    staticSource("boscaceoil-blue", "Bosca Ceoil Blue", "https://github.com/YuriSizov/boscaceoil-blue", "Music", 8.2, "Free/open-source music loop tool; best for human-in-loop export.", "User-created music; tool is open-source/free"),
    staticSource("mixamo", "Mixamo", "https://www.mixamo.com/", "Animation", 8.4, "Free humanoid character animation library with Adobe ID; manual FBX download.", "Adobe Mixamo royalty-free use terms"),
    staticSource("unity-vfx-graph", "Unity VFX Graph Samples", "https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@12.0/manual/sample-content.html", "VFX", 8.2, "Official Unity VFX Graph sample content; import through Package Manager.", "Unity sample/package terms; sample textures documented as CC0"),
    staticSource("unreal-niagara", "Unreal Niagara Examples", "https://www.unrealengine.com/news/discover-over-50-free-niagara-systems-ready-to-use-in-unreal-engine-5-7", "VFX", 8.1, "Official free Niagara examples pack on Fab; Epic/Fab account flow required.", "Epic/Fab content license, engine-specific")
];
export function providerNames() {
    return PROVIDERS.map((provider) => provider.source);
}
export async function searchAssets(options) {
    return (await searchAssetsWithDiagnostics(options)).results;
}
export async function searchAssetsWithDiagnostics(options) {
    const settings = await loadSettings();
    const mode = settings.preferences.acquisitionMode;
    const permitted = (source) => mode === "both" || (mode === "create" ? isGenerationSource(source) : !isGenerationSource(source));
    if (options.source && !permitted(options.source))
        throw new Error(`Source ${options.source} is disabled by ${mode} acquisition preferences.`);
    const advised = await applyAssetAdvisor(options, settings, providerNames().filter(permitted));
    const searchOptions = advised.options;
    if (searchOptions.source && !permitted(searchOptions.source))
        throw new Error(`Source ${searchOptions.source} is disabled by ${mode} acquisition preferences.`);
    // One interpretation for every provider: negated words are removed from the query,
    // and an inferred media type stops e.g. rock textures answering a rock-music request.
    const intent = parseIntent(searchOptions.request), quoted = quotedPhrases(searchOptions.request), preferred = namedSources(searchOptions.request);
    const explicitCategory = searchOptions.category && searchOptions.category !== "Unknown" ? searchOptions.category : undefined;
    const category = explicitCategory ?? inferCategory(intent.positive);
    const providerOptions = { ...searchOptions, request: intent.positive, category: category === "Unknown" ? undefined : category };
    const interpretation = {
        category, categoryBasis: explicitCategory ? "explicit" : category === "Unknown" ? "not inferred; all media types searched" : "inferred from wording; pass category to override",
        excludedTerms: intent.negatives, requestedStyles: intent.styles
    };
    const effectiveLimit = Math.max(1, Math.min(searchOptions.limit ?? settings.search.maxResultsDefault, 50));
    const includeManualResults = Boolean(searchOptions.includeManualResults || settings.search.allowManualResults || searchOptions.source);
    if (searchOptions.source?.startsWith("custom:")) {
        const results = customSourceResults(settings, searchOptions.category)
            .filter((result) => result.source === searchOptions.source)
            .filter((result) => matchesCategory(result, searchOptions.category))
            .map(normalizeAssetResult)
            .filter((result) => passesLicenseSettings(settings, result, { includeManualResults }))
            .map((result) => ({
            ...result,
            score: result.score + sourcePriorityBoost(settings, searchOptions.category ?? result.category, result.source)
        }))
            .slice(0, effectiveLimit);
        const relevance = await assessAssetRelevance(options.request, results, settings, options.useAdvisor ?? settings.assetAdvisor.allowNetworkAiRanking);
        return {
            results: relevance.results,
            diagnostics: [{ source: searchOptions.source, ok: true, count: results.length }],
            advisor: advised.trace,
            relevance: relevance.trace,
            interpretation
        };
    }
    const providers = searchOptions.source
        ? PROVIDERS.filter((provider) => provider.source === searchOptions.source && isSourceEnabled(settings, provider.source) && permitted(provider.source))
        : PROVIDERS.filter((provider) => isSourceEnabled(settings, provider.source) && permitted(provider.source) && (includeManualResults || !isManualProviderSource(provider.source) || REPORT_WHEN_HIDDEN.has(provider.source)));
    if (providers.length === 0)
        throw new Error(`Unknown source: ${searchOptions.source}`);
    const { results: providerResults, diagnostics } = await runProviderSearches(providers, providerOptions);
    if (searchOptions.source) {
        const failed = diagnostics.find((diagnostic) => !diagnostic.ok);
        if (failed)
            throw new Error(`Provider ${failed.source} failed: ${failed.error}`);
    }
    const results = [
        ...providerResults,
        ...(searchOptions.source || mode === "create" ? [] : customSourceResults(settings, providerOptions.category))
    ];
    const relevant = results
        .filter((result) => matchesCategory(result, providerOptions.category))
        .map(normalizeAssetResult)
        .filter((result) => isSourceEnabled(settings, result.source))
        // Source reputation or priority must never turn an unrelated item into a match.
        .filter((result) => result.score > 0 && !violatesNegatives(result, intent.negatives))
        .map((result) => {
        const style = styleEvidence(result, intent.styles);
        // A quoted exact title or a source named in prose is a stated preference.
        const title = result.title.toLowerCase().replace(/[_-]+/g, " ");
        const bonus = (quoted.some((phrase) => title.includes(phrase.replace(/[_-]+/g, " "))) ? 40 : 0) + (preferred.includes(result.source) ? 10 : 0);
        return { ...result, ...(style ? { style } : {}), score: result.score + styleScore(style) + bonus };
    })
        .filter((result) => result.score > 0);
    // Leads that exist but need the browser route or a manual step are counted, not silently dropped.
    const hidden = includeManualResults ? [] : relevant.filter((result) => result.manualDownload && passesLicenseSettings(settings, result, { includeManualResults: true }));
    const withheld = hidden.length ? {
        count: hidden.length, sources: [...new Set(hidden.map((result) => result.source))],
        note: "These sources matched but need browser-assisted or manual retrieval. Ask the user to enable browser assistance, or repeat with includeManualResults to see them."
    } : undefined;
    const rankedResults = relevant
        .filter((result) => passesLicenseSettings(settings, result, { includeManualResults }))
        .map((result) => ({
        ...result,
        score: result.score + sourcePriorityBoost(settings, providerOptions.category ?? result.category, result.source)
    }))
        .sort((a, b) => effectiveScore(b) - effectiveScore(a) || Number(Boolean(a.manualDownload)) - Number(Boolean(b.manualDownload)))
        .slice(0, effectiveLimit);
    const relevance = await assessAssetRelevance(options.request, rankedResults, settings, options.useAdvisor ?? settings.assetAdvisor.allowNetworkAiRanking);
    return {
        results: relevance.results,
        diagnostics,
        advisor: advised.trace,
        relevance: relevance.trace,
        interpretation,
        withheld,
        nextSteps: nextSteps(relevance.results, category, intent.styles, Boolean(withheld), mode)
    };
}
/** Honest routes when a search is empty or its style is unproven. Suggestions only: nothing here is a match. */
function nextSteps(results, category, styles, withheld, mode) {
    const steps = [];
    const unproven = results.length > 0 && results.every((result) => result.style && (result.style.unconfirmed.length || result.style.conflicting));
    if (results.length && !unproven)
        return undefined;
    if (unproven)
        steps.push(`No result's metadata confirms the requested style (${styles.join(", ")}). Look at each result's previewUrl or source page before presenting it as a match, or tell the user no style match was found.`);
    if (!results.length)
        steps.push("No licensed match was found. Say so rather than substituting a different asset. Try simpler English subject words, or pass category explicitly if the inferred one is wrong.");
    if (withheld)
        steps.push("Matching packs exist on browser-assisted sources (see withheld). They need the user's saved browser consent.");
    if (mode !== "existing") {
        if (category === "Music")
            steps.push("Create instead: generate_asset with preset zzfxm-music and your own song data gives an editable tracker composition (read get_generator_help zzfxm first). It is synthesized chiptune, not a recording.");
        else if (category === "Audio")
            steps.push("Create instead: generate_asset with preset zzfx-sfx and explicit synth parameters (see get_generator_help zzfx).");
        else if (["2D", "UI", "VFX", "Unknown"].includes(category))
            steps.push("Create instead: render_pixel_recipe draws custom pixel art from a recipe you write (see get_generator_help pixelbolt). It cannot produce painterly, anime or photographic styles.");
        else if (category === "3D" || category === "Textures")
            steps.push("Create instead: list_generators shows the built-in low-poly models and procedural PBR textures; they are simple stylised presets, not arbitrary shapes.");
    }
    return steps;
}
async function runProviderSearches(providers, options) {
    const settled = await Promise.allSettled(providers.map(async (provider) => {
        const started = Date.now();
        const results = await provider.search(options);
        return { results, durationMs: Date.now() - started };
    }));
    const results = [];
    const diagnostics = [];
    settled.forEach((result, index) => {
        const source = providers[index].source;
        if (result.status === "fulfilled") {
            results.push(...result.value.results);
            diagnostics.push({ source, ok: true, count: result.value.results.length, durationMs: result.value.durationMs });
        }
        else {
            diagnostics.push({
                source,
                ok: false,
                count: 0,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason)
            });
        }
    });
    return { results, diagnostics };
}
function matchesCategory(result, requested) {
    if (!requested || requested === "Unknown" || result.category === requested)
        return true;
    // These categories share file families; animation/music still need semantic checks.
    const families = [["2D", "UI"], ["3D", "Animation"], ["Audio", "Music"]];
    return families.some(family => family.includes(requested) && family.includes(result.category));
}
function effectiveScore(result) {
    return result.score - (result.downloadMode === "direct" ? 0 : 4);
}
function isManualProviderSource(source) {
    return ASSISTED_SOURCES.has(source) || MANUAL_ONLY_SOURCES.has(source);
}
function normalizeAssetResult(result) {
    const downloadMode = inferDownloadMode(result);
    return {
        ...result,
        downloadMode,
        manualDownload: result.manualDownload || downloadMode !== "direct",
        assistInstructions: result.assistInstructions ?? (downloadMode === "direct" ? undefined : defaultAssistInstructions(result, downloadMode))
    };
}
function inferDownloadMode(result) {
    if (result.downloadMode)
        return result.downloadMode;
    if (result.manualDownload)
        return MANUAL_ONLY_SOURCES.has(result.source) ? "manual" : "assisted";
    return hasMaterialization(result) ? "direct" : "manual";
}
function hasMaterialization(result) {
    return Boolean(result.downloadUrl || result.downloadUrls?.length || result.generatedAsset || result.derivedAsset);
}
function defaultAssistInstructions(result, downloadMode) {
    const instructions = ["Open source URL in browser.", "Verify license and download terms before saving files."];
    if (downloadMode === "assisted") {
        instructions.push("Use browser automation only until login, payment, captcha, or unclear terms require user review.");
    }
    else {
        instructions.push("Use source page or tool manually, then export or download chosen files.");
    }
    instructions.push(`Preserve source URL (${result.url}), license, and asset metadata beside imported files.`);
    return instructions;
}
async function searchAmbientCg(options) {
    if (!isTextureLike(options))
        return [];
    const limit = Math.max(1, Math.min(options.limit ?? 5, 10));
    const query = focusedQuery(options.request, ["texture", "textures", "material", "materials", "pbr", "asset", "assets"]);
    const url = `https://ambientcg.com/api/v2/full_json?limit=${limit}&q=${encodeURIComponent(query)}&include=downloadData`;
    const data = JSON.parse(await fetchText(url));
    return (data.foundAssets ?? []).map((asset) => {
        const zip = pickAmbientZip(asset);
        return {
            source: "ambientcg",
            id: asset.assetId,
            title: asset.displayName || asset.assetId,
            url: asset.shortLink ?? `https://ambientcg.com/a/${asset.assetId}`,
            category: "Textures",
            tags: asset.tags ?? [],
            series: [],
            license: "Creative Commons CC0",
            licenseUrl: CC0_URL,
            attributionRequired: false,
            licenseSafety: 10,
            score: scoreText(options.request, `${asset.displayName} ${asset.assetId} ${(asset.tags ?? []).join(" ")}`, 9.5, asset.displayName),
            reason: "ambientCG CC0 material result",
            previewUrl: asset.previewImage?.["512-JPG-FFFFFF"] ?? asset.previewImage?.["512-PNG"],
            downloadUrl: zip?.downloadLink,
            downloadFileName: zip?.fileName
        };
    });
}
async function searchPolyHaven(options) {
    const hdri = /\b(hdri|hdr|exr|environment[ -]?map|skybox|panorama)\b/i.test(options.request);
    const category = options.category && options.category !== "Unknown" ? options.category : inferCategory(options.request);
    if (options.category && !["Textures", "3D", "Animation", "Unknown"].includes(options.category))
        return [];
    // With no stated media type a subject can be a model or a material ("rock"): search both.
    if (!hdri && !options.category && category !== "3D" && category !== "Textures") {
        const both = await Promise.all(["3D", "Textures"].map((kind) => searchPolyHaven({ ...options, category: kind })));
        return both.flat().sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(options.limit ?? 5, 8)));
    }
    if (!hdri && category !== "Textures" && category !== "3D" && category !== "Animation" && !isTextureLike(options))
        return [];
    const type = hdri ? "hdris" : category === "3D" || category === "Animation" ? "models" : "textures";
    const data = JSON.parse(await fetchText(`https://api.polyhaven.com/assets?t=${type}`));
    const tokens = tokenize(options.request);
    const scored = Object.entries(data)
        .map(([id, asset]) => ({
        id,
        asset,
        score: scoreText(options.request, `${asset.name} ${id} ${(asset.tags ?? []).join(" ")} ${(asset.categories ?? []).join(" ")}`, type === "models" ? 4.5 : 9.2, asset.name)
    }))
        .filter((item) => item.score > 0 || tokens.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(options.limit ?? 5, 8)));
    return Promise.all(scored.map(async ({ id, asset, score }) => ({
        source: "polyhaven",
        id,
        title: asset.name,
        url: `https://polyhaven.com/a/${id}`,
        category: type === "models" ? "3D" : "Textures",
        tags: asset.tags ?? [],
        series: asset.categories ?? [],
        license: "Creative Commons CC0",
        licenseUrl: CC0_URL,
        attributionRequired: false,
        licenseSafety: 10,
        score,
        reason: `Poly Haven CC0 ${type.slice(0, -1)} result`,
        previewUrl: `https://cdn.polyhaven.com/asset_img/primary/${id}.png?height=512`,
        downloadUrls: await polyHavenDownloads(id, type)
    })));
}
async function searchOpenClipart(options) {
    if (!is2dLike(options))
        return [];
    const query = focusedQuery(options.request, ["svg", "clipart", "icon", "icons", "ui", "asset", "assets", "2d"]);
    const html = await fetchText(`https://openclipart.org/search/?query=${encodeURIComponent(query)}`);
    return parseOpenClipartSearch(html, options);
}
export function parseOpenClipartSearch(html, options) {
    const $ = cheerio.load(html);
    const results = [];
    $(".artwork a[href^='/detail/']").slice(0, Math.max(1, Math.min(options.limit ?? 5, 10))).each((_index, element) => {
        const href = $(element).attr("href");
        const img = $(element).find("img").first();
        const title = img.attr("alt")?.trim() || "OpenClipart asset";
        const id = href?.match(/\/detail\/(\d+)/)?.[1];
        if (!href || !id)
            return;
        results.push({
            source: "openclipart",
            id,
            title,
            url: `https://openclipart.org${href}`,
            category: "2D",
            tags: tokenize(title),
            series: [],
            license: "Creative Commons CC0",
            licenseUrl: CC0_URL,
            attributionRequired: false,
            licenseSafety: 10,
            score: scoreText(options.request, title, 8.8),
            reason: "OpenClipart public-domain SVG result",
            previewUrl: `https://openclipart.org/image/800px/${id}`,
            downloadUrls: [{ url: `https://openclipart.org/download/${id}`, fileName: `${slugify(title)}.svg` }]
        });
    });
    return results;
}
function focusedQuery(request, drop) {
    const dropped = new Set(drop);
    const tokens = tokenize(request).filter((token) => !dropped.has(token));
    return tokens.slice(0, 3).join(" ") || request;
}
async function searchProceduralSfx(options) {
    if (options.category && !["Audio", "Unknown"].includes(options.category))
        return [];
    if (!isSfxLike(options) || isMusicLike(options))
        return [];
    // Without a matching preset the generator would answer every request with a coin blip.
    if (!options.source && !matchProceduralSfxPreset(options.request))
        return [];
    const descriptor = createProceduralSfxDescriptor(options.request);
    const presetTitle = descriptor.preset.replace(/([a-z])([A-Z])/g, "$1 $2");
    return [
        {
            source: "jsfxr",
            id: descriptor.baseName,
            title: `Procedural ${presetTitle} SFX`,
            url: "https://sfxr.me/",
            category: "Audio",
            tags: ["procedural", "sfx", descriptor.preset, ...tokenize(options.request)],
            series: ["sfxr-style"],
            license: "Generated locally; no third-party media",
            attributionRequired: false,
            licenseSafety: 10,
            // The preset matcher above is the relevance gate; rank below a real recording of the same thing.
            score: 12,
            reason: "Local deterministic jsfxr-style WAV generated from request",
            generatedAsset: descriptor
        }
    ];
}
async function searchMixkit(options) {
    if (!isAudioLike(options) && !isMusicLike(options))
        return [];
    const modes = isMusicLike(options) && !isSfxLike(options) ? ["music"] : isMusicLike(options) ? ["sfx", "music"] : ["sfx"];
    const candidates = [];
    for (const mode of modes) {
        for (const tag of mixkitTagCandidates(options.request, mode).slice(0, 4)) {
            try {
                candidates.push(...(await parseMixkitPage(mode, tag)));
            }
            catch {
                // Unknown tag pages are normal during broad natural-language searches.
            }
        }
    }
    const seen = new Set();
    const scored = candidates
        .filter((candidate) => {
        const key = `${candidate.mode}:${candidate.id}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    })
        .map((candidate) => ({
        candidate,
        score: scoreText(expandedRequest(options.request), `${candidate.title} ${candidate.tags.join(" ")} ${candidate.mode}`, candidate.mode === "music" ? 8.3 : 8.8)
    }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(options.limit ?? 5, 10)));
    const hydrated = await Promise.all(scored.map(({ candidate, score }) => hydrateMixkitResult(candidate, score)));
    return hydrated.filter(Boolean);
}
async function parseMixkitPage(mode, tag) {
    const pathPrefix = mode === "music" ? "free-stock-music" : "free-sound-effects";
    const html = await fetchText(`https://mixkit.co/${pathPrefix}/${tag}/`);
    return parseMixkitListing(html, mode, tag);
}
export function parseMixkitListing(html, mode, tag) {
    const $ = cheerio.load(html);
    const assets = [];
    $(".item-grid__item").each((_index, element) => {
        const root = $(element);
        const player = root.find("[data-test-id='audio-player']").first();
        const id = player.attr("data-audio-player-item-id-value");
        const title = root.find(".item-grid-card__title").first().text().replace(/\s+/g, " ").trim();
        const modalPath = root.find("[data-download--button-modal-url-value]").first().attr("data-download--button-modal-url-value");
        if (!id || !title || !modalPath)
            return;
        assets.push({
            mode,
            id,
            title,
            tag,
            modalUrl: new URL(modalPath, "https://mixkit.co").toString(),
            previewUrl: player.attr("data-audio-player-preview-url-value"),
            tags: root
                .find(".meta-links__link")
                .toArray()
                .map((item) => $(item).text().replace(/\s+/g, " ").trim())
                .filter(Boolean)
        });
    });
    return assets;
}
export async function hydrateMixkitResult(candidate, score) {
    try {
        const html = await fetchText(candidate.modalUrl);
        const $ = cheerio.load(html);
        const downloadUrl = $("[data-download--modal-url-value]").first().attr("data-download--modal-url-value");
        if (!downloadUrl)
            return undefined;
        const extension = path.extname(new URL(downloadUrl).pathname) || (candidate.mode === "music" ? ".mp3" : ".wav");
        const license = candidate.mode === "music" ? "Mixkit Stock Music Free License — video games prohibited" : "Mixkit Sound Effects Free License";
        return {
            source: "mixkit",
            id: `${candidate.mode}-${candidate.id}`,
            title: candidate.title,
            url: `https://mixkit.co/${candidate.mode === "music" ? "free-stock-music" : "free-sound-effects"}/${candidate.tag}/`,
            category: candidate.mode === "music" ? "Music" : "Audio",
            tags: candidate.tags,
            series: ["Mixkit"],
            license,
            licenseUrl: "https://mixkit.co/license/",
            attributionRequired: false,
            licenseSafety: candidate.mode === "music" ? 2 : 8.2,
            score,
            assistInstructions: candidate.mode === "music" ? ["Mixkit Stock Music Free License explicitly prohibits video-game use. Any-license inclusion is not permission to use it in a game."] : undefined,
            reason: `Mixkit direct ${candidate.mode === "music" ? "music" : "SFX"} download`,
            previewUrl: candidate.previewUrl,
            downloadUrl,
            downloadFileName: `${slugify(candidate.title)}${extension}`
        };
    }
    catch {
        return undefined;
    }
}
async function search99Sounds(options) {
    if (!isAudioLike(options) && !isMusicLike(options))
        return [];
    const html = await fetchText("https://99sounds.org/sounds/");
    return parse99SoundsListing(html, options);
}
export function parse99SoundsListing(html, options) {
    const $ = cheerio.load(html);
    const results = [];
    $("article").each((_index, element) => {
        const root = $(element);
        const link = root.find("h2 a[href]").first();
        const href = link.attr("href");
        const title = link.text().replace(/\s+/g, " ").trim();
        if (!href || !title)
            return;
        const excerpt = root.find(".excerpt").text().replace(/\s+/g, " ").trim();
        const previewStyle = root.find("[data-bgsrc]").first().attr("data-bgsrc");
        results.push({
            source: "99sounds",
            id: slugify(title),
            title,
            url: href,
            category: isMusicLike({ ...options, request: `${options.request} ${title} ${excerpt}` }) ? "Music" : "Audio",
            tags: tokenize(`${title} ${excerpt}`),
            series: ["99Sounds"],
            license: "99Sounds royalty-free license",
            licenseUrl: "https://99sounds.org/license/",
            attributionRequired: false,
            licenseSafety: 8.5,
            manualDownload: true,
            score: scoreText(expandedRequest(options.request), `${title} ${excerpt}`, 8.6),
            reason: "99Sounds royalty-free pack; download page may route through Gumroad",
            previewUrl: previewStyle
        });
    });
    return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(options.limit ?? 5, 10)));
}
async function searchItchVfx(options) {
    if (!isVfxLike(options))
        return [];
    const html = await fetchText("https://itch.io/game-assets/free/tag-vfx");
    const $ = cheerio.load(html);
    const results = [];
    $(".game_cell").each((_index, element) => {
        const root = $(element);
        const title = root.find(".title").first().text().replace(/\s+/g, " ").trim();
        const href = root.find("a.title").attr("href") ?? root.find("a[href]").first().attr("href");
        if (!title || !href)
            return;
        const description = root.find(".game_text").text().replace(/\s+/g, " ").trim();
        const previewUrl = root.find("img").attr("data-lazy_src") ?? root.find("img").attr("src");
        results.push({
            source: "itch-vfx",
            id: slugify(title),
            title,
            url: href,
            category: "VFX",
            tags: tokenize(`${title} ${description}`),
            series: ["itch.io free VFX"],
            license: "Free itch.io asset; verify per-item license",
            licenseSafety: 6.5,
            manualDownload: true,
            score: scoreText(expandedRequest(options.request), `${title} ${description}`, 8.3),
            reason: "itch.io free VFX result; license/download flow varies by item",
            previewUrl
        });
    });
    return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(options.limit ?? 5, 10)));
}
async function searchPixabayAudio(options) {
    if (!isAudioLike(options) && !isMusicLike(options))
        return [];
    const query = focusedQuery(options.request, ["audio", "sound", "sounds", "sfx", "effect", "effects", "music", "free", "asset", "assets"]);
    const music = isMusicLike(options);
    const url = music
        ? `https://pixabay.com/music/search/${encodeURIComponent(query)}/`
        : `https://pixabay.com/sound-effects/search/${encodeURIComponent(query)}/`;
    return [
        {
            source: "pixabay-audio",
            id: slugify(`${music ? "music" : "sound-effects"}-${query}`),
            title: `Pixabay ${music ? "music" : "sound effects"} search: ${query}`,
            url,
            category: music ? "Music" : "Audio",
            tags: tokenize(query),
            series: ["Pixabay"],
            license: "Pixabay Content License",
            licenseUrl: "https://pixabay.com/service/license-summary/",
            attributionRequired: false,
            licenseSafety: 7.8,
            manualDownload: true,
            score: scoreText(expandedRequest(options.request), `${query} pixabay ${music ? "music" : "sound effects"}`, 8.2),
            reason: "Pixabay audio search page; direct scrape is guarded by Cloudflare, use browser/download page"
        }
    ];
}
async function searchQuaternius(options) {
    if (options.category !== "3D" && inferCategory(options.request) !== "3D" && !/\b(animation|character|low.?poly|model|kit)\b/i.test(options.request))
        return [];
    const html = await fetchText("https://quaternius.com/");
    return parseQuaterniusListing(html, options);
}
export function parseQuaterniusListing(html, options) {
    const $ = cheerio.load(html);
    const assets = [];
    $(".pack").each((_index, element) => {
        const root = $(element);
        const href = root.find("a[href*='/packs/']").first().attr("href");
        const title = root.find(".PackText").first().text().replace(/\s+/g, " ").trim();
        const preview = root.find("img.gallery-img").attr("src");
        if (!href || !title)
            return;
        const url = new URL(href, "https://quaternius.com").toString();
        assets.push({
            source: "quaternius",
            id: slugify(title),
            title,
            url,
            category: "3D",
            tags: tokenize(title),
            series: [],
            license: "Creative Commons CC0",
            licenseUrl: CC0_URL,
            attributionRequired: false,
            licenseSafety: 10,
            manualDownload: true,
            score: scoreText(options.request, title, 8.4),
            reason: "Quaternius CC0 pack; download uses Google Drive folder flow",
            previewUrl: preview ? new URL(preview, "https://quaternius.com").toString() : undefined
        });
    });
    return assets.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(options.limit ?? 5, 10)));
}
function staticSource(source, title, url, category, baseScore, reason, license) {
    return {
        source,
        async search(options) {
            const categoryMatch = !options.category || options.category === "Unknown" || options.category === category || category === "2D";
            const score = scoreText(options.request, `${title} ${category} ${reason} ${license ?? ""}`, baseScore);
            if (!categoryMatch && score < baseScore + 2)
                return [];
            return [
                {
                    source,
                    id: slugify(title),
                    title,
                    url,
                    category,
                    tags: tokenize(title),
                    series: [],
                    license: license ?? (reason.includes("CC0") ? "Creative Commons CC0" : "Permissive/free, verify exact item"),
                    licenseSafety: baseScore >= 9 ? 9 : 8,
                    manualDownload: true,
                    score: Math.max(1, score - 2),
                    reason
                }
            ];
        }
    };
}
async function polyHavenDownloads(id, type) {
    const files = JSON.parse(await fetchText(`https://api.polyhaven.com/files/${id}`));
    return parsePolyHavenDownloads(files, type);
}
export function parsePolyHavenDownloads(files, type) {
    const downloads = [];
    if (type === "hdris") {
        const hdris = files.hdri;
        for (const resolution of ["1k", "2k", "4k"]) {
            const file = hdris?.[resolution]?.hdr ?? hdris?.[resolution]?.exr;
            if (file?.url && /^https:\/\//.test(file.url))
                return [{ url: file.url, fileName: path.basename(new URL(file.url).pathname) }];
        }
        return [];
    }
    if (type === "models") {
        // One portable low-resolution model, with every referenced sidecar. Never
        // flatten texture paths or silently truncate a dependency bundle.
        for (const format of ["glb", "gltf", "blend", "fbx"])
            for (const resolution of ["1k", "2k"]) {
                const node = files[format]?.[resolution]?.[format];
                if (!node?.url)
                    continue;
                const entries = [{ url: node.url, fileName: path.basename(new URL(node.url).pathname) },
                    ...Object.entries(node.include ?? {}).map(([fileName, file]) => ({ url: file.url ?? "", fileName }))];
                if (entries.length > 128 || entries.some(file => !/^https:\/\//.test(file.url)))
                    throw new Error("Invalid or oversized Poly Haven model dependency bundle");
                return entries;
            }
        return [];
    }
    const wanted = ["Diffuse", "nor_gl", "Rough", "Displacement"];
    for (const key of wanted) {
        const node = files[key];
        const found = findUrlByPreference(node, ["1k", "2k"], ["jpg", "png", "blend", "gltf", "glb"]);
        if (found)
            downloads.push({ url: found, fileName: path.basename(new URL(found).pathname) });
    }
    return uniqueDownloads(downloads).slice(0, 12);
}
function findUrlByPreference(node, resolutions, formats) {
    if (!node || typeof node !== "object")
        return undefined;
    const record = node;
    for (const resolution of resolutions) {
        const byResolution = record[resolution];
        if (byResolution && typeof byResolution === "object") {
            for (const format of formats) {
                const maybe = byResolution[format]?.url;
                if (maybe)
                    return maybe;
            }
        }
    }
    for (const value of Object.values(record)) {
        const nested = findUrlByPreference(value, resolutions, formats);
        if (nested)
            return nested;
    }
    return undefined;
}
function uniqueDownloads(downloads) {
    const seen = new Set();
    return downloads.filter((download) => {
        if (seen.has(download.url))
            return false;
        seen.add(download.url);
        return true;
    });
}
function pickAmbientZip(asset) {
    const downloads = asset.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? [];
    return (downloads.find((download) => download.attribute === "1K-JPG") ??
        downloads.find((download) => download.attribute?.includes("1K")) ??
        downloads[0]);
}
function isAudioLike(options) {
    const lower = options.request.toLowerCase();
    return options.category === "Audio" || options.category === "Music" || /\b(audio|sound|sounds|sfx|wav|ogg|mp3|foley)\b/.test(lower) || isMusicLike(options);
}
function isSfxLike(options) {
    const lower = options.request.toLowerCase();
    return options.category === "Audio" || /\b(sound|sounds|sfx|effect|effects|foley|hit|hurt|coin|laser|jump|explosion|click|beep)\b/.test(lower);
}
function isMusicLike(options) {
    const lower = options.request.toLowerCase();
    return options.category === "Music" || /\b(music|song|soundtrack|bgm|loop|loops|theme|chiptune|beat|track)\b/.test(lower);
}
function isVfxLike(options) {
    const lower = options.request.toLowerCase();
    return (options.category === "VFX" ||
        /\b(vfx|visual effect|visual effects|particle|particles|spell effect|spell effects|flipbook|slash effect|impact effect)\b/.test(lower));
}
function isTextureLike(options) {
    const lower = options.request.toLowerCase();
    return options.category === "Textures" || /\b(texture|textures|material|pbr|wood|stone|rock|metal|fabric|hdri|hdr)\b/.test(lower);
}
function is2dLike(options) {
    const lower = options.request.toLowerCase();
    return options.category === "2D" || options.category === "UI" || options.category === "VFX" || /\b(2d|sprite|svg|clipart|icon|ui|image|button|tile)\b/.test(lower);
}
function mixkitTagCandidates(request, mode) {
    const lower = request.toLowerCase();
    const tags = new Set();
    if (mode === "music") {
        if (/\b(horror|scary|terror|creepy)\b/.test(lower))
            tags.add("horror");
        if (/\b(game|arcade|pixel|chiptune)\b/.test(lower))
            tags.add("game");
        if (/\b(cinematic|trailer|epic)\b/.test(lower))
            tags.add("cinematic");
        if (/\b(ambient|ambience|background)\b/.test(lower))
            tags.add("ambient");
        if (/\b(upbeat|happy|fun)\b/.test(lower))
            tags.add("upbeat");
    }
    else {
        if (/\b(horror|scary|terror|creepy)\b/.test(lower))
            tags.add("horror");
        if (/\b(game|arcade|player|level)\b/.test(lower))
            tags.add("game");
        if (/\b(car|vehicle|engine)\b/.test(lower))
            tags.add("car");
        if (/\b(race)\b/.test(lower))
            tags.add("race-car");
        if (/\b(coin|pickup|collect)\b/.test(lower))
            tags.add("coin");
        if (/\b(laser|sci.?fi|space)\b/.test(lower))
            tags.add("laser");
        if (/\b(explosion|boom|bomb)\b/.test(lower))
            tags.add("explosion");
        if (/\b(click|ui|button|select|menu)\b/.test(lower))
            tags.add("click");
        if (/\b(magic|spell)\b/.test(lower))
            tags.add("magic");
    }
    for (const token of tokenize(request).slice(0, 3))
        tags.add(slugify(token));
    tags.add(mode === "music" ? "game" : "game");
    return [...tags].filter(Boolean);
}
//# sourceMappingURL=providers.js.map