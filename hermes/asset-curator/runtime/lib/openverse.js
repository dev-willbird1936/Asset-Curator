import { z } from "zod";
import path from "node:path";
import { fetchText } from "./http.js";
import { scoreText, subjectTokens } from "./intent.js";
import { loadSettings } from "./settings.js";
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
function publicHttps(value) {
    if (!value)
        return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname))
            return undefined;
        return url.href;
    }
    catch {
        return undefined;
    }
}
export function parseOpenverse(data, mode, anyLicense = false, request) {
    const response = data;
    if (!Array.isArray(response?.results))
        throw new Error("Openverse response is missing results");
    return response.results.flatMap((raw) => {
        const parsed = mediaSchema.safeParse(raw);
        if (!parsed.success)
            return [];
        const item = parsed.data, code = item.license.toLowerCase();
        if (item.mature || !anyLicense && !SAFE_LICENSES.has(code))
            return [];
        const download = publicHttps(item.url), url = publicHttps(item.foreign_landing_url);
        if (!download || !url)
            return [];
        // Jamendo reports its MP3 streams as "mp31"/"mp32".
        const extension = (item.filetype || path.extname(new URL(download).pathname).slice(1)).toLowerCase().replace(/^mp3[12]$/, "mp3");
        if (!(mode === "audio" ? AUDIO_FORMATS : IMAGE_FORMATS).has(extension))
            return [];
        const preview = /\/previews\//i.test(download);
        const title = item.title?.trim() || `Openverse ${mode === "audio" ? "audio" : "image"}`;
        // An index hit is not a match: the title or tags must name the requested subject.
        const score = request ? scoreText(request, `${title} ${(item.tags ?? []).map((tag) => tag.name).join(" ")}`, 7, title) : 11;
        if (score <= 0)
            return [];
        return [{
                source: "openverse", id: slugify(item.id), title, url, category: mode === "audio" ? "Audio" : "2D",
                tags: item.tags?.map((tag) => tag.name) ?? tokenize(title), series: ["Openverse", item.provider ?? "original source"],
                license: `${code === "cc0" ? "Creative Commons CC0" : code === "pdm" ? "Public Domain Mark" : `CC ${code.toUpperCase()}`} ${item.license_version ?? ""}`.trim(),
                licenseUrl: publicHttps(item.license_url), licenseSafety: code === "cc0" || code === "pdm" ? 10 : code === "by" ? 8 : code === "by-sa" ? 5 : 2,
                attributionRequired: !["cc0", "pdm"].includes(code), creator: item.creator ?? undefined, creatorUrl: publicHttps(item.creator_url),
                attribution: item.attribution ?? `${title} by ${item.creator || "creator at source"}; ${code} ${item.license_version || ""}. ${item.license_url || url}`,
                score, reason: `Openverse indexed ${mode === "audio" ? "audio" : "image"}; verify rights at the original source.${preview ? " Public preview encoding, not the full-quality original; original may require source authentication." : ""}`,
                previewUrl: publicHttps(item.thumbnail), downloadMode: "direct", downloadQuality: preview ? "preview" : "unknown",
                downloadUrl: download, downloadFileName: `${slugify(title).slice(0, 60)}-${slugify(item.id).slice(0, 12)}.${extension}`
            }];
    });
}
export async function searchOpenverse(options) {
    if (options.category && !["Unknown", "2D", "UI", "Audio", "Music"].includes(options.category))
        return [];
    const audio = options.category === "Audio" || options.category === "Music" || /\b(sound|sfx|audio|music|song|recording|foley)\b/i.test(options.request);
    if (!options.source && !audio && options.category !== "2D" && !/\b(photo|photograph|image|illustration|clipart|background)\b/i.test(options.request))
        return [];
    const settings = await loadSettings(), anyLicense = settings.preferences.completed && settings.preferences.licensePolicy === "any";
    const mode = audio ? "audio" : "images";
    // Openverse ANDs every word, so long prompts return nothing: search subjects (plus one
    // style word) first, then subjects alone.
    const subjects = subjectTokens(options.request).filter((word) => !/s$/.test(word) || !subjectTokens(options.request).includes(word.slice(0, -1))).slice(0, 4);
    const style = options.request.toLowerCase().match(/\b(water-?colou?r|hand[\s-]?painted|hand[\s-]?drawn|anime|pixel|vector|cartoon)\b/)?.[0];
    const fallback = [...new Set(options.request.toLowerCase().match(/[a-z0-9]+/g) ?? [])].slice(0, 6).join(" ") || options.request;
    const wantsMusic = options.category === "Music" || /\b(music|song|soundtrack|bgm|chiptune|melody)\b/i.test(options.request);
    // For music the genre or mood word is the useful last resort ("rock", "orchestral").
    const genre = subjects.find((word) => /^(rock|metal|orchestral|orchestra|ambient|jazz|electronic|techno|synthwave|chiptune|piano|guitar|epic|calm|battle|boss|horror|medieval|folk|lofi|funk|blues|classical|cinematic|upbeat|sad|happy|dark)$/.test(word));
    const queries = subjects.length ? [...new Set([[...subjects, ...(style ? [style] : [])].join(" "), subjects.join(" "), subjects.slice(0, 2).join(" "), ...(wantsMusic && genre ? [genre] : [])])] : [fallback];
    for (const query of queries) {
        const params = new URLSearchParams({ q: query, page_size: String(Math.min(Math.max(options.limit ?? 8, 8), 25)), mature: "false", format: "json" });
        if (!anyLicense)
            params.set("license", "cc0,pdm,by");
        // Field recordings are not music: use Openverse's own category when music was asked for.
        if (mode === "audio" && wantsMusic)
            params.set("category", "music");
        const data = JSON.parse(await fetchText(`https://api.openverse.org/v1/${mode}/?${params}`));
        const genreOnly = wantsMusic && query === genre && queries.length > 1;
        const wantsVocals = /\b(vocal|vocals|sung|singer|singing|lyrics|choir)\b/i.test(options.request);
        const results = parseOpenverse(data, mode, anyLicense, options.request).map((result) => {
            if (!wantsMusic || mode !== "audio")
                return result;
            const tags = result.tags.map((tag) => tag.toLowerCase());
            // Game music is normally instrumental; a sung track is a weaker match unless vocals were asked for.
            const fit = wantsVocals ? 0 : (tags.includes("instrumental") ? 4 : 0) - (tags.some((tag) => ["vocal", "male", "female"].includes(tag)) ? 8 : 0);
            return { ...result, category: "Music", score: Math.max(1, result.score + fit - (genreOnly ? 6 : 0)),
                reason: result.reason + (genreOnly ? " Genre-level match only: the scene or mood words were not found, so audition it before use." : "") };
        }).sort((a, b) => b.score - a.score).slice(0, Math.min(options.limit ?? 8, 25));
        if (results.length)
            return results;
    }
    return [];
}
//# sourceMappingURL=openverse.js.map