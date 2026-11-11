import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText } from "./http.js";
import { scoreText } from "./intent.js";
import { slugify, tokenize } from "./util.js";
// KayKit (Kay Lousberg) publishes its free CC0 packs in the creator's own GitHub
// account. kaykit-index.json lists every model at a pinned commit, so a search
// costs no API calls and a download can never move to an unreviewed revision.
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
let cached;
export function kayKitIndex() {
    if (cached)
        return cached;
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "kaykit-index.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[A-Za-z0-9-]+$/.test(data.owner) || !Array.isArray(data.packs))
        throw new Error("kaykit-index.json is invalid");
    const safe = (value) => /^[A-Za-z0-9._() /-]+$/.test(value) && !value.split("/").some((part) => part === ".." || part === "." || !part);
    const models = [], files = new Map();
    for (const pack of data.packs) {
        if (!/^[A-Za-z0-9._-]+$/.test(pack.repo) || !/^[0-9a-f]{40}$/.test(pack.commit) || ![pack.license, ...pack.models, ...pack.sidecars].every(safe))
            throw new Error("kaykit-index.json has an invalid pack: " + pack.repo);
        files.set(pack.repo, new Set([...pack.models, ...pack.sidecars]));
        const glb = new Set(pack.models.filter((item) => /\.glb$/i.test(item)).map((item) => path.posix.basename(item, ".glb").toLowerCase()));
        // Where a model ships as both, keep the self-contained GLB.
        for (const item of pack.models)
            if (/\.glb$/i.test(item) || !glb.has(path.posix.basename(item, ".gltf").toLowerCase()))
                models.push({
                    repo: pack.repo, pack: pack.pack, commit: pack.commit, file: item, license: pack.license, rigged: /(^|\/)characters\//i.test(item),
                    name: path.posix.basename(item).replace(/\.(glb|gltf)$/i, "").replace(/\.gltf$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim()
                });
    }
    return cached = { owner: data.owner, models, files };
}
const raw = (owner, model, file) => `https://raw.githubusercontent.com/${owner}/${model.repo}/${model.commit}/${file.split("/").map(encodeURIComponent).join("/")}`;
/** Sidecars named by the glTF itself; anything outside the model's folder or not in the tree rejects the candidate. */
export function kayKitSidecars(gltf, model, files) {
    const doc = gltf;
    const dir = path.posix.dirname(model.file), found = [];
    for (const item of [...(doc.buffers ?? []), ...(doc.images ?? [])]) {
        if (typeof item.uri !== "string" || item.uri.startsWith("data:"))
            continue;
        let name;
        try {
            name = decodeURIComponent(item.uri);
        }
        catch {
            throw new Error("Invalid glTF resource URI");
        }
        const target = path.posix.normalize(`${dir}/${name}`);
        if (name.includes("\\") || path.posix.isAbsolute(name) || !target.startsWith(dir + "/") || !files.has(target))
            throw new Error("glTF resource is outside the model folder or missing from the repository");
        found.push(target);
    }
    if (found.length > 16)
        throw new Error("Too many glTF resources");
    return [...new Set(found)];
}
export async function searchKayKit(options) {
    if (options.category && !["3D", "Animation", "Unknown"].includes(options.category))
        return [];
    const { owner, models, files } = kayKitIndex();
    const wantsRig = /\b(rig|rigged|skeleton|skinned|animation|animations|animated|idle|walk|run)\b/i.test(options.request);
    const scored = models.map((model) => {
        const base = scoreText(options.request, `${model.name} ${model.pack}${model.rigged ? " character rigged animated skeleton" : ""}`, 9, model.name);
        // A static prop cannot satisfy a request for a rig or animations.
        return { model, score: base > 0 && wantsRig ? (model.rigged ? base + 6 : 0) : base };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.model.name.length - b.model.name.length).slice(0, Math.max(1, Math.min(options.limit ?? 5, 8)));
    const results = await Promise.allSettled(scored.map(async ({ model, score }) => {
        const sidecars = /\.gltf$/i.test(model.file) ? kayKitSidecars(JSON.parse(await fetchText(raw(owner, model, model.file), 30_000, 2 * 1024 * 1024)), model, files.get(model.repo)) : [];
        const dir = path.posix.dirname(model.file);
        return {
            source: "kaykit", id: slugify(`${model.repo.replace(/^KayKit-|-1\.0$/g, "")}-${model.name}`), title: `KayKit ${model.name}`, url: `https://github.com/${owner}/${model.repo}/tree/${model.commit}`,
            category: "3D", tags: [...tokenize(model.name), "low-poly", "stylized", ...(model.rigged ? ["character", "rigged", "animated"] : [])], series: ["KayKit", model.pack],
            license: "Creative Commons CC0", licenseUrl: CC0_URL, licenseSafety: 10, attributionRequired: false, creator: "Kay Lousberg (kaylousberg.com)",
            attribution: "KayKit by Kay Lousberg, CC0. Credit is appreciated but not required.",
            score, downloadMode: "direct",
            reason: `KayKit ${model.pack} from the creator's GitHub repository${model.rigged ? "; character GLB that ships with a skeleton and animation clips (check artifact facts for the clip names)" : ""}`,
            downloadUrls: [
                { url: raw(owner, model, model.file), fileName: path.posix.basename(model.file) },
                ...sidecars.map((file) => ({ url: raw(owner, model, file), fileName: file.slice(dir.length + 1) })),
                { url: raw(owner, model, model.license), fileName: "KayKit-LICENSE.txt" }
            ]
        };
    }));
    return results.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
}
//# sourceMappingURL=kaykit.js.map