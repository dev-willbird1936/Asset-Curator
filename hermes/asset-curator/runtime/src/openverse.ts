import { z } from "zod";
import path from "node:path";
import { fetchText } from "./http.js";
import { loadSettings } from "./settings.js";
import type { AssetSearchOptions, AssetSearchResult } from "./types.js";
import { slugify, tokenize } from "./util.js";

const mediaSchema = z.object({
  id: z.string().min(1), title: z.string().nullish(), url: z.string(), foreign_landing_url: z.string(),
  creator: z.string().nullish(), creator_url: z.string().nullish(), license: z.string(), license_version: z.string().nullish(),
  license_url: z.string().nullish(), attribution: z.string().nullish(), provider: z.string().nullish(),
  filetype: z.string().nullish(), thumbnail: z.string().nullish(), mature: z.boolean().optional(),
  tags: z.array(z.object({ name: z.string() })).optional()
});
const SAFE_LICENSES = new Set(["cc0", "pdm", "by"]);
const IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "svg", "webp", "gif", "avif"]);
const AUDIO_FORMATS = new Set(["wav", "ogg", "mp3", "flac", "m4a", "aac"]);

function publicHttps(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function parseOpenverse(data: unknown, mode: "images" | "audio", anyLicense = false): AssetSearchResult[] {
  const response = data as { results?: unknown[] };
  if (!Array.isArray(response?.results)) throw new Error("Openverse response is missing results");
  return response.results.flatMap((raw) => {
    const parsed = mediaSchema.safeParse(raw);
    if (!parsed.success) return [];
    const item = parsed.data, code = item.license.toLowerCase();
    if (item.mature || !anyLicense && !SAFE_LICENSES.has(code)) return [];
    const download = publicHttps(item.url), url = publicHttps(item.foreign_landing_url);
    if (!download || !url) return [];
    const extension = (item.filetype || path.extname(new URL(download).pathname).slice(1)).toLowerCase();
    if (!(mode === "audio" ? AUDIO_FORMATS : IMAGE_FORMATS).has(extension)) return [];
    const preview = /\/previews\//i.test(download);
    const title = item.title?.trim() || `Openverse ${mode === "audio" ? "audio" : "image"}`;
    return [{
      source: "openverse", id: slugify(item.id), title, url, category: mode === "audio" ? "Audio" : "2D",
      tags: item.tags?.map((tag) => tag.name) ?? tokenize(title), series: ["Openverse", item.provider ?? "original source"],
      license: `${code === "cc0" ? "Creative Commons CC0" : code === "pdm" ? "Public Domain Mark" : `CC ${code.toUpperCase()}`} ${item.license_version ?? ""}`.trim(),
      licenseUrl: publicHttps(item.license_url), licenseSafety: code === "cc0" || code === "pdm" ? 10 : code === "by" ? 8 : code === "by-sa" ? 5 : 2,
      attributionRequired: !["cc0", "pdm"].includes(code), creator: item.creator ?? undefined, creatorUrl: publicHttps(item.creator_url),
      attribution: item.attribution ?? `${title} by ${item.creator || "creator at source"}; ${code} ${item.license_version || ""}. ${item.license_url || url}`,
      score: 11, reason: `Openverse indexed ${mode === "audio" ? "audio" : "image"}; verify rights at the original source.${preview ? " Public preview encoding, not the full-quality original; original may require source authentication." : ""}`,
      previewUrl: publicHttps(item.thumbnail), downloadMode: "direct", downloadQuality: preview ? "preview" : "unknown",
      downloadUrl: download, downloadFileName: `${slugify(title).slice(0, 60)}-${slugify(item.id).slice(0, 12)}.${extension}`
    } satisfies AssetSearchResult];
  });
}

export async function searchOpenverse(options: AssetSearchOptions): Promise<AssetSearchResult[]> {
  if (options.category && !["Unknown", "2D", "UI", "Audio", "Music"].includes(options.category)) return [];
  const audio = options.category === "Audio" || options.category === "Music" || /\b(sound|sfx|audio|music|song|recording|foley)\b/i.test(options.request);
  if (!options.source && !audio && options.category !== "2D" && !/\b(photo|photograph|image|illustration|clipart|background)\b/i.test(options.request)) return [];
  const settings = await loadSettings(), anyLicense = settings.preferences.completed && settings.preferences.licensePolicy === "any";
  const mode = audio ? "audio" : "images";
  const drop = new Set(["asset", "assets", "image", "photo", "photograph", "audio", "sound", "sfx", "free"]);
  const query = [...new Set(options.request.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((word) => !drop.has(word)).slice(0, 8).join(" ") || options.request;
  const params = new URLSearchParams({ q: query, page_size: String(Math.min(options.limit ?? 8, 25)), mature: "false", format: "json" });
  if (!anyLicense) params.set("license", "cc0,pdm,by");
  const data = JSON.parse(await fetchText(`https://api.openverse.org/v1/${mode}/?${params}`));
  return parseOpenverse(data, mode, anyLicense);
}
