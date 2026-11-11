import { fetchText } from "./http.js";
import { slugify, tokenize } from "./util.js";
const ICON_REPOS = {
    "game-icons": { repo: "game-icons/icons", branch: "master", pattern: /^([a-z0-9-]+)\/([a-z0-9-]+)\.svg$/, license: "CC BY 3.0", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", safety: 7 },
    lucide: { repo: "lucide-icons/lucide", branch: "main", pattern: /^icons\/([a-z0-9-]+)\.svg$/, license: "ISC", licenseUrl: "https://lucide.dev/license", safety: 8.5 },
    tabler: { repo: "tabler/tabler-icons", branch: "main", pattern: /^icons\/outline\/([a-z0-9-]+)\.svg$/, license: "MIT", licenseUrl: "https://github.com/tabler/tabler-icons/blob/main/LICENSE", safety: 8.5 }
};
export function parseIconTree(data, source) {
    const tree = data;
    if (!tree || tree.truncated !== false || !Array.isArray(tree.tree))
        throw new Error(`${source} catalog is missing or truncated; refusing incomplete index`);
    return tree.tree.flatMap((entry) => {
        if (entry.type !== "blob" || typeof entry.path !== "string")
            return [];
        const match = entry.path.match(ICON_REPOS[source].pattern);
        return match ? [{ name: match[source === "game-icons" ? 2 : 1], file: entry.path, author: source === "game-icons" ? match[1] : undefined }] : [];
    });
}
export function rankCatalog(entries, request, text, limit) {
    const generic = new Set(["icon", "icons", "svg", "ui", "font", "fonts", "typeface", "typography", "minimal", "simple", "outline", "game"]);
    const words = tokenize(request).filter((word) => !generic.has(word));
    const phrase = words.join(" ");
    return entries.map((entry) => {
        const label = text(entry).toLowerCase().replace(/[-_]+/g, " ");
        const terms = new Set(tokenize(label));
        const hits = words.filter((word) => terms.has(word)).length;
        return { entry, score: (phrase && label === phrase ? 100 : phrase && label.includes(phrase) ? 40 : 0) + hits * 5 };
    }).filter((item) => !words.length || item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.entry);
}
export async function searchIconCatalog(source, options) {
    if (options.category && !["Unknown", "UI", "2D", "VFX"].includes(options.category))
        return [];
    if (!options.source && options.category !== "UI" && !/\b(icon|icons|svg|ui|button|hud|interface)\b/i.test(options.request))
        return [];
    const meta = ICON_REPOS[source];
    const data = JSON.parse(await fetchText(`https://api.github.com/repos/${meta.repo}/git/trees/${meta.branch}?recursive=1`));
    const icons = rankCatalog(parseIconTree(data, source), options.request, (icon) => icon.name, Math.min(options.limit ?? 8, 12));
    return icons.map((icon, index) => {
        const raw = `https://raw.githubusercontent.com/${meta.repo}/${meta.branch}/${icon.file}`;
        const url = source === "game-icons" ? `https://game-icons.net/1x1/${icon.author}/${icon.name}.html` : source === "lucide" ? `https://lucide.dev/icons/${icon.name}` : `https://tabler.io/icons/icon/${icon.name}`;
        const title = `${source === "tabler" ? "Tabler" : source === "lucide" ? "Lucide" : "Game icon"} ${icon.name.replace(/-/g, " ")}`;
        return {
            source, id: icon.author ? `${icon.author}-${icon.name}` : icon.name, title, url, category: "UI", tags: icon.name.split("-"), series: [source],
            license: meta.license, licenseUrl: meta.licenseUrl, licenseSafety: meta.safety,
            attributionRequired: true, creator: icon.author ?? (source === "lucide" ? "Lucide contributors" : "Tabler contributors"),
            attribution: source === "game-icons" ? `${icon.name} by ${icon.author}, CC BY 3.0 (${meta.licenseUrl})` : `Preserve the included ${source}-LICENSE.txt copyright and permission notice.`,
            score: 14 - index * .1, reason: "Matched a complete cached upstream SVG catalog, not name guessing", downloadMode: "direct",
            downloadUrls: [
                { url: raw, fileName: `${icon.name}.svg` },
                ...(source === "game-icons" ? [] : [{ url: `https://raw.githubusercontent.com/${meta.repo}/${meta.branch}/LICENSE`, fileName: `${source}-LICENSE.txt` }])
            ]
        };
    });
}
export function parseFontCatalog(text) {
    const data = JSON.parse(text.replace(/^\)\]\}'\s*/, ""));
    if (!Array.isArray(data.familyMetadataList))
        throw new Error("Google Fonts catalog is missing family metadata");
    return data.familyMetadataList.filter((family) => typeof family.family === "string" && family.isOpenSource === true).sort((a, b) => (a.popularity ?? 99999) - (b.popularity ?? 99999));
}
export async function searchFontCatalog(options) {
    if (!/\b(font|fonts|typeface|typography|text)\b/i.test(options.request) && options.source !== "google-fonts")
        return [];
    const catalog = parseFontCatalog(await fetchText("https://fonts.google.com/metadata/fonts"));
    const families = rankCatalog(catalog, options.request, (family) => `${family.family} ${family.category ?? ""}`, Math.min(options.limit ?? 5, 8));
    const settled = await Promise.allSettled(families.map(async (family) => {
        const dir = slugify(family.family).replace(/-/g, "");
        let files;
        let license = "", licenseFile = "";
        for (const folder of ["ofl", "apache"]) {
            try {
                const data = JSON.parse(await fetchText(`https://api.github.com/repos/google/fonts/contents/${folder}/${dir}`));
                if (!Array.isArray(data))
                    continue;
                const expected = folder === "ofl" ? "OFL.txt" : "LICENSE.txt";
                if (!data.some((file) => file.name === expected))
                    continue;
                files = data;
                licenseFile = expected;
                license = folder === "ofl" ? "SIL Open Font License 1.1" : "Apache License 2.0";
                break;
            }
            catch { /* Try the other official license directory, never substitute a font. */ }
        }
        if (!files)
            throw new Error(`No verified license/files for ${family.family}`);
        const fonts = files.filter((file) => /\.(ttf|otf)$/i.test(file.name) && /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\//.test(file.download_url)).slice(0, 8);
        const notice = files.find((file) => file.name === licenseFile);
        if (!fonts.length || !notice.download_url)
            throw new Error(`No downloadable font files for ${family.family}`);
        return {
            source: "google-fonts", id: dir, title: family.family, url: `https://fonts.google.com/specimen/${encodeURIComponent(family.family)}`,
            category: "UI", tags: ["font", ...tokenize(family.family), ...tokenize(family.category ?? "")], series: ["Google Fonts"],
            license, licenseSafety: 8.5, licenseUrl: notice.download_url, attributionRequired: true, creator: "See bundled font license", attribution: `Preserve ${licenseFile} and comply with font-name/redistribution conditions.`,
            score: 15, reason: "Family matched from the full Google Fonts metadata catalog; official files and license bundled", downloadMode: "direct",
            downloadUrls: [...fonts, notice].map((file) => ({ url: file.download_url, fileName: file.name }))
        };
    }));
    const results = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    if (!results.length && families.length)
        throw new Error("Matched Google Fonts families could not be resolved to licensed downloads");
    return results;
}
//# sourceMappingURL=catalogs.js.map