import * as cheerio from "cheerio";
import { fetchText } from "./http.js";
import type { AssetCategory, AssetSearchOptions, AssetSearchResult } from "./types.js";
import { containsToken, slugify, tokenize } from "./util.js";

const BASE_URL = "https://kenney.nl";
const MAX_INDEX_PAGES = 20;

type IndexedAsset = Omit<AssetSearchResult, "license" | "score" | "reason" | "fileCount" | "downloadUrl">;

let cachedIndex: { createdAt: number; assets: IndexedAsset[] } | undefined;

export async function searchKenneyAssets(options: AssetSearchOptions): Promise<AssetSearchResult[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  const indexed = await getKenneyIndex();
  const requestTokens = tokenize(options.request);
  const category = options.category ?? inferCategory(options.request);

  const scored = indexed
    .filter((asset) => !category || category === "Unknown" || asset.category === category)
    .map((asset) => scoreAsset(asset, requestTokens, options.request))
    .filter((asset) => asset.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);

  const hydrated = await Promise.all(scored.map((asset) => hydrateAsset(asset)));
  return hydrated;
}

export async function getKenneyAssetByUrl(url: string): Promise<AssetSearchResult> {
  const id = slugify(url.split("/").filter(Boolean).pop() ?? url);
  const title = id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return hydrateAsset({
    source: "kenney",
    id,
    title,
    url: url.startsWith("http") ? url : `${BASE_URL}/assets/${id}`,
    category: "Unknown",
    tags: [],
    series: []
  });
}

async function getKenneyIndex(): Promise<IndexedAsset[]> {
  const now = Date.now();
  if (cachedIndex && now - cachedIndex.createdAt < 30 * 60_000) return cachedIndex.assets;

  const found = new Map<string, IndexedAsset>();
  for (let page = 1; page <= MAX_INDEX_PAGES; page += 1) {
    const pageUrl = page === 1 ? `${BASE_URL}/assets?sort=update` : `${BASE_URL}/assets/page:${page}?sort=update`;
    let html: string;
    try {
      html = await fetchText(pageUrl);
    } catch (error) {
      if (page > 1) break;
      throw error;
    }
    const pageAssets = parseKenneyIndexPage(html);
    if (pageAssets.length === 0) break;
    for (const asset of pageAssets) found.set(asset.id, asset);
  }

  const assets = [...found.values()];
  cachedIndex = { createdAt: now, assets };
  return assets;
}

export function parseKenneyIndexPage(html: string): IndexedAsset[] {
  const $ = cheerio.load(html);
  const assets: IndexedAsset[] = [];

  $(".asset").each((_index, element) => {
    const root = $(element);
    const link = root.find("h2 a[href*='/assets/']").first();
    const href = link.attr("href");
    const title = link.text().trim();
    if (!href || !title) return;

    const url = absoluteUrl(href);
    const id = slugify(url.split("/").filter(Boolean).pop() ?? title);
    const metaLinks = root.find(".text-muted a").toArray();
    const category = parseCategory($(metaLinks[0]).text().trim());
    const series = metaLinks
      .slice(1)
      .map((item) => $(item).text().trim())
      .filter(Boolean);
    const previewStyle = root.find(".cover").attr("style") ?? "";
    const previewUrl = previewStyle.match(/url\(["']?([^"')]+)["']?\)/)?.[1];

    assets.push({
      source: "kenney",
      id,
      title,
      url,
      category,
      tags: [],
      series,
      previewUrl
    });
  });

  return assets;
}

async function hydrateAsset(asset: AssetSearchResult | IndexedAsset): Promise<AssetSearchResult> {
  const html = await fetchText(asset.url);
  const $ = cheerio.load(html);
  const pageText = $("body").text().replace(/\s+/g, " ");
  const tags = $("a[href*='/assets/tag:']")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(Boolean);
  const categoryLink = $("a[href*='/assets/category:']").first().text().trim();
  const series = $("a[href*='/assets/series:']")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(Boolean);
  const downloadUrl = $("a[href$='.zip']").first().attr("href");
  const fileCountText = pageText.match(/Files\s+([0-9,]+)\s*[x×]/i)?.[1];
  const fileCount = fileCountText ? Number(fileCountText.replace(/,/g, "")) : undefined;
  const previewUrl =
    $("meta[property='og:image']").attr("content") ??
    $("a.screenshot[href]").first().attr("href") ??
    asset.previewUrl;

  return {
    ...asset,
    category: parseCategory(categoryLink) === "Unknown" ? asset.category : parseCategory(categoryLink),
    tags: [...new Set([...(asset.tags ?? []), ...tags])],
    series: [...new Set([...(asset.series ?? []), ...series])],
    license: pageText.includes("Creative Commons CC0") ? "Creative Commons CC0" : "Unknown",
    score: "score" in asset ? asset.score : 1,
    reason: "reason" in asset ? asset.reason : "Direct asset URL",
    previewUrl,
    fileCount,
    downloadUrl: downloadUrl ? absoluteUrl(downloadUrl) : undefined
  };
}

function scoreAsset(asset: IndexedAsset, tokens: string[], request: string): AssetSearchResult {
  const haystack = `${asset.title} ${asset.id} ${asset.category} ${asset.tags.join(" ")} ${asset.series.join(" ")}`.toLowerCase();
  let score = 0;
  const matches: string[] = [];

  for (const token of tokens) {
    if (containsToken(haystack, token)) {
      score += containsToken(asset.title.toLowerCase(), token) ? 8 : 4;
      matches.push(token);
    }
  }

  const inferredCategory = inferCategory(request);
  if (inferredCategory !== "Unknown" && asset.category === inferredCategory) score += 5;

  const requestLower = request.toLowerCase();
  if (requestLower.includes("tree") || requestLower.includes("forest") || requestLower.includes("nature")) {
    for (const hint of ["nature", "forest", "foliage", "tree", "plant", "environment"]) {
      if (haystack.includes(hint)) score += 3;
    }
  }
  if (requestLower.includes("ui") && (haystack.includes("ui") || haystack.includes("interface"))) score += 6;
  if (requestLower.includes("vehicle") || requestLower.includes("car")) {
    if (haystack.includes("transport") || haystack.includes("car")) score += 6;
  }
  if (score === 0 && tokens.length === 0) score = 1;

  return {
    ...asset,
    license: "Creative Commons CC0",
    score,
    reason: matches.length > 0 ? `Matched: ${matches.join(", ")}` : "Matched inferred category/source hints"
  };
}

export function inferCategory(request: string): AssetCategory {
  const lower = request.toLowerCase();
  if (/\b(animation|animations|mocap|motion|rig|rigged|walk cycle|run cycle|fbx animation|bvh)\b/.test(lower)) return "Animation";
  if (/\b(vfx|visual effect|particle|particles|spell effect|flipbook)\b/.test(lower)) return "VFX";
  if (/\b(music|song|soundtrack|bgm|loop|loops|theme|chiptune)\b/.test(lower)) return "Music";
  if (/\b(3d|model|mesh|fbx|glb|gltf|obj)\b/.test(lower)) return "3D";
  if (/\b(audio|sound|sfx|wav|ogg)\b/.test(lower)) return "Audio";
  if (/\b(texture|textures|material|materials|pbr|tileable)\b/.test(lower)) return "Textures";
  if (/\b(ui|button|interface|hud|menu)\b/.test(lower)) return "UI";
  if (/\b(2d|sprite|spritesheet|png|pixel|tilemap)\b/.test(lower)) return "2D";
  // Engine compatibility is not the requested media type.
  if (/\b(roblox|unity|unreal|godot)\b/.test(lower)) return "3D";
  return "Unknown";
}

function parseCategory(value: string): AssetCategory {
  if (value === "2D") return "2D";
  if (value === "3D") return "3D";
  if (value === "Audio") return "Audio";
  if (value === "Music") return "Music";
  if (value === "Textures") return "Textures";
  if (value === "UI") return "UI";
  return "Unknown";
}

function absoluteUrl(href: string): string {
  return href.startsWith("http") ? href : new URL(href, BASE_URL).toString();
}
