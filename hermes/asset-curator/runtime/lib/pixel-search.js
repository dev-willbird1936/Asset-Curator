import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { encodePng } from "./generation.js";
import { fetchBinary, fetchText } from "./http.js";
import { loadSettings } from "./settings.js";
import { slugify, tokenize } from "./util.js";
const SPACE = "cfahlgren1/pixel-search";
const SPACE_URL = `https://huggingface.co/spaces/${SPACE}`;
const DATASET_URL = "https://huggingface.co/datasets/Angais/pixel-art-atlas-1.4m";
const CAUTION = "Synthetic sprites: approximate captions may disagree with pixels. CC0 is limited to rights Angais can waive; third-party rights and Krea terms are not waived. Review before shipping.";
const manifestSchema = z.object({
    subjects: z.number().int().min(1).max(10000), dims: z.number().int().min(1).max(256),
    catalog_sprites: z.number().int().min(1).max(2_000_000), page_sprites: z.number().int().min(1).max(512),
    pages: z.number().int().min(1).max(10000), caption_tokens: z.number().int().min(1).max(15_000_000),
    files: z.record(z.string(), z.number().int().min(1).max(12 * 1024 * 1024))
});
let indexPromise;
export function decodeSubjectStarts(bytes, subjects, sprites) {
    if (bytes.length !== (subjects + 1) * 4)
        throw new Error("Invalid Pixel Search subject index length");
    const starts = new Uint32Array(subjects + 1);
    for (let i = 0; i <= subjects; i++) {
        starts[i] = bytes.readUInt32LE(i * 4);
        if (starts[i] > sprites || i > 0 && starts[i] < starts[i - 1])
            throw new Error("Invalid Pixel Search subject ranges");
    }
    if (starts[0] !== 0 || starts[subjects] !== sprites)
        throw new Error("Pixel Search catalog count mismatch");
    return starts;
}
async function compressed(base, file, maxInflated, maxBytes = 2 * 1024 * 1024) {
    const bytes = await fetchBinary(`${base}/${file}`, maxBytes);
    return gunzipSync(bytes, { maxOutputLength: maxInflated });
}
async function loadIndex() {
    const meta = JSON.parse(await fetchText(`https://huggingface.co/api/spaces/${SPACE}`));
    if (!/^[a-f0-9]{40}$/.test(meta.sha))
        throw new Error("Pixel Search revision is unavailable");
    const revision = meta.sha;
    const base = `${SPACE_URL}/resolve/${revision}/static/data`;
    const manifest = manifestSchema.parse(JSON.parse(await fetchText(`${base}/manifest.json`)));
    if (manifest.pages !== Math.ceil(manifest.catalog_sprites / manifest.page_sprites))
        throw new Error("Inconsistent Pixel Search page count");
    const [names, starts, terms, vectors, subjectVectors] = await Promise.all([
        compressed(base, "subjects.txt.z", 2 * 1024 * 1024),
        compressed(base, "catalog-subjects.bin.z", (manifest.subjects + 1) * 4),
        compressed(base, "terms-a.txt.z", 2 * 1024 * 1024),
        fetchBinary(`${base}/vec-a.bin`, 4 * 1024 * 1024),
        fetchBinary(`${base}/vec-s.bin`, 4 * 1024 * 1024)
    ]);
    const subjects = names.toString("utf8").split("\n"), vocabulary = terms.toString("utf8").split("\n");
    if (subjects.length !== manifest.subjects || vectors.length !== vocabulary.length * manifest.dims || subjectVectors.length !== subjects.length * manifest.dims)
        throw new Error("Pixel Search vector/index dimensions disagree");
    return { revision, base, manifest, subjects, starts: decodeSubjectStarts(starts, subjects.length, manifest.catalog_sprites), terms: vocabulary, termIndex: new Map(vocabulary.map((word, i) => [word, i])), vectors: new Int8Array(vectors.buffer, vectors.byteOffset, vectors.length), subjectVectors: new Int8Array(subjectVectors.buffer, subjectVectors.byteOffset, subjectVectors.length) };
}
function index() {
    if (!indexPromise)
        indexPromise = loadIndex().catch((error) => { indexPromise = undefined; throw error; });
    return indexPromise;
}
export function decodeCaptions(bytes, sprites, tokens) {
    if (bytes.length !== sprites + tokens * 2)
        throw new Error("Invalid Pixel Search caption stream length");
    const starts = new Uint32Array(sprites + 1);
    for (let i = 0; i < sprites; i++)
        starts[i + 1] = starts[i] + bytes[i];
    if (starts[sprites] !== tokens)
        throw new Error("Pixel Search caption token count mismatch");
    return { bytes, starts, tokens };
}
async function captions(data) {
    if (!data.captions) {
        const { catalog_sprites, caption_tokens } = data.manifest;
        data.captions = compressed(data.base, "catalog-captions.bin.z", catalog_sprites + caption_tokens * 2, 10 * 1024 * 1024)
            .then((bytes) => decodeCaptions(bytes, catalog_sprites, caption_tokens)).catch((error) => { data.captions = undefined; throw error; });
    }
    return data.captions;
}
function captionWords(stream, data, sprite) {
    const low = data.manifest.catalog_sprites, high = low + stream.tokens;
    const words = [];
    for (let i = stream.starts[sprite]; i < stream.starts[sprite + 1]; i++) {
        const token = stream.bytes[low + i] | stream.bytes[high + i] << 8;
        if (token >= data.terms.length)
            throw new Error("Invalid Pixel Search caption token");
        words.push(data.terms[token]);
    }
    return words;
}
async function queryVector(words, data) {
    const missing = words.filter((word) => !data.termIndex.has(word));
    if (missing.length && !data.general)
        data.general = Promise.all([
            compressed(data.base, "terms-b.txt.z", 2 * 1024 * 1024), fetchBinary(`${data.base}/vec-b.bin`, 4 * 1024 * 1024)
        ]).then(([text, bytes]) => {
            const terms = text.toString("utf8").split("\n");
            if (bytes.length !== terms.length * data.manifest.dims)
                throw new Error("Invalid Pixel Search general vocabulary");
            return { terms: new Map(terms.map((word, i) => [word, i])), vectors: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) };
        }).catch((error) => { data.general = undefined; throw error; });
    const general = missing.length ? await data.general : undefined;
    const vector = new Float64Array(data.manifest.dims);
    for (const word of words) {
        const a = data.termIndex.get(word), b = general?.terms.get(word);
        const source = a !== undefined ? data.vectors : b !== undefined ? general.vectors : undefined;
        if (!source)
            continue;
        const offset = (a ?? b) * vector.length;
        let norm = 0;
        for (let i = 0; i < vector.length; i++)
            norm += source[offset + i] ** 2;
        if (!norm)
            continue;
        for (let i = 0; i < vector.length; i++)
            vector[i] += source[offset + i] / Math.sqrt(norm);
    }
    return vector;
}
const COLOR_HUES = { red: [345, 15], orange: [15, 45], yellow: [45, 75], green: [75, 165], cyan: [165, 200], blue: [200, 265], purple: [265, 300], pink: [300, 345] };
export function pixelColorFraction(pixels, color) {
    const range = COLOR_HUES[color];
    if (!range)
        return 0;
    let visible = 0, matches = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (!pixels[i + 3])
            continue;
        const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        visible++;
        if (max < .16 || delta / max < .25)
            continue; // Neutral body pixels still count against a colored accessory.
        let hue = max === r ? 60 * ((g - b) / delta % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
        hue = (hue + 360) % 360;
        if (range[0] > range[1] ? hue >= range[0] || hue < range[1] : hue >= range[0] && hue < range[1])
            matches++;
    }
    return visible ? matches / visible : 0;
}
export async function searchPixelAssets(options) {
    if (options.category && !["Unknown", "2D", "UI"].includes(options.category))
        return [];
    if (!options.source && !/\b(pixel|sprite|16x16)\b/i.test(options.request))
        return [];
    const settings = await loadSettings();
    if (settings.preferences.licensePolicy !== "any" || !settings.preferences.completed)
        throw new Error("Pixel Search is excluded by safe-license policy because its synthetic CC0 sprites retain Krea/third-party caveats. Only the user can choose any-license mode after reviewing rights.");
    const drop = new Set(["pixel", "art", "sprite", "sprites", "transparent", "png", "16x16", "character"]);
    const words = [...new Set(tokenize(options.request).filter((word) => !drop.has(word)))].slice(0, 12);
    if (!words.length)
        return [];
    const requestedColor = words.length > 1 && COLOR_HUES[words[0]] ? words[0] : undefined;
    const data = await index(), vector = await queryVector(words, data);
    const norm = Math.hypot(...vector), phrase = words.join(" ");
    const subjects = data.subjects.map((subject, id) => {
        let dot = 0, length = 0;
        for (let i = 0; i < vector.length; i++) {
            const v = data.subjectVectors[id * vector.length + i];
            dot += v * vector[i];
            length += v * v;
        }
        const label = subject.toLowerCase(), terms = new Set(tokenize(label));
        const hits = words.filter((word) => terms.has(word)).length;
        return { id, subject, score: (norm && length ? dot / (norm * Math.sqrt(length)) : 0) + hits * .06 + (label === phrase ? .25 : 0) };
    }).filter((item) => item.score > .28 && (!requestedColor || tokenize(item.subject).includes(words[1]))).sort((a, b) => b.score - a.score).slice(0, 6);
    if (!subjects.length)
        return [];
    const stream = words.length > 1 ? await captions(data) : undefined;
    const candidates = [];
    for (const subject of subjects) {
        const start = data.starts[subject.id], count = data.starts[subject.id + 1] - start, samples = Math.min(4096, count);
        for (let i = 0; i < samples; i++) {
            const catalogId = start + Math.floor(i * Math.max(0, count - 1) / Math.max(1, samples - 1));
            const caption = stream ? captionWords(stream, data, catalogId) : tokenize(subject.subject);
            const coverage = words.filter((word) => caption.includes(word)).length / words.length;
            candidates.push({ catalogId, subject: subject.subject, caption: caption.join(" "), score: subject.score + coverage * .35 });
        }
    }
    const colors = new Map();
    if (requestedColor) {
        const palette = await compressed(data.base, "palette.bin.z", 65536 * 3);
        const pages = new Map();
        const pageIds = [...new Set(candidates.map((candidate) => Math.floor(candidate.catalogId / data.manifest.page_sprites)))];
        for (let i = 0; i < pageIds.length; i += 8)
            await Promise.all(pageIds.slice(i, i + 8).map(async (pageId) => {
                pages.set(pageId, await compressed(data.base, `pages/${pageId}.bin.z`, 512 * (256 + 511), 1024 * 1024));
            }));
        for (const candidate of candidates) {
            const pageId = Math.floor(candidate.catalogId / data.manifest.page_sprites), count = Math.min(data.manifest.page_sprites, data.manifest.catalog_sprites - pageId * data.manifest.page_sprites);
            colors.set(candidate.catalogId, pixelColorFraction(decodePixelSprite(pages.get(pageId), count, candidate.catalogId % data.manifest.page_sprites, palette), requestedColor));
        }
    }
    return candidates.filter((candidate) => !requestedColor || colors.get(candidate.catalogId) >= .4)
        .sort((a, b) => (b.score + (colors.get(b.catalogId) ?? 0) * .2) - (a.score + (colors.get(a.catalogId) ?? 0) * .2) || a.catalogId - b.catalogId).slice(0, Math.min(options.limit ?? 8, 25)).map((sprite) => ({
        source: "pixel-search", id: `catalog-${sprite.catalogId}-${data.revision.slice(0, 10)}`, title: sprite.caption || sprite.subject,
        url: SPACE_URL, category: "2D", tags: [sprite.subject, "pixel-art", "synthetic", "16x16"], series: ["Angais Pixel Art Atlas", "Pixel Search"],
        license: "CC0 dedication with Krea/third-party caveats; verify before shipping", licenseUrl: `${DATASET_URL}/blob/main/README.md`, licenseSafety: 5,
        creator: "Angais (sprites), cfahlgren1 (search/index)", attributionRequired: false, attribution: `Source: ${DATASET_URL}; retrieval index: ${SPACE_URL}/tree/${data.revision}. ${CAUTION}`,
        score: 12 + sprite.score * 5,
        verification: requestedColor ? { basis: "pixel-color-and-subject-metadata", color: requestedColor, visibleColorFraction: colors.get(sprite.catalogId), note: "At least 40% of visible pixels match the requested hue; this is color coverage, not object segmentation or proof that every body part has that color." } : undefined,
        reason: `Locally ranked Pixel Search subject vectors${stream ? " and caption attributes" : ""}${requestedColor ? `; actual ${requestedColor} hue coverage is at least 40% of visible pixels` : ""}; labels are approximate, not object-shape proof. ${CAUTION}`,
        downloadMode: "direct", derivedAsset: { kind: "pixel-search", revision: data.revision, catalogId: sprite.catalogId, subject: sprite.subject, caption: sprite.caption }
    }));
}
export function decodePixelSprite(page, count, offset, palette) {
    if (!Number.isInteger(count) || count < 1 || count > 512 || !Number.isInteger(offset) || offset < 0 || offset >= count || palette.length < 3 || palette.length % 3)
        throw new Error("Invalid Pixel Search page parameters");
    if (page.length < count)
        throw new Error("Truncated Pixel Search page");
    let colors = count, selectedColors = count;
    for (let i = 0; i < count; i++) {
        if (!page[i])
            throw new Error("Invalid Pixel Search local palette size");
        if (i === offset)
            selectedColors = colors;
        colors += page[i] * 2;
    }
    if (page.length !== colors + count * 256)
        throw new Error("Invalid Pixel Search page length");
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 256; i++) {
        const local = page[colors + offset * 256 + i];
        if (local >= page[offset])
            throw new Error("Invalid Pixel Search local color index");
        const token = page.readUInt16LE(selectedColors + local * 2);
        if (token * 3 + 2 >= palette.length)
            throw new Error("Invalid Pixel Search global color index");
        if (!token)
            continue;
        palette.copy(pixels, i * 4, token * 3, token * 3 + 3);
        pixels[i * 4 + 3] = 255;
    }
    return pixels;
}
export async function materializePixelAsset(asset) {
    if (!/^[a-f0-9]{40}$/.test(asset.revision) || !Number.isInteger(asset.catalogId) || asset.catalogId < 0 || asset.catalogId >= 2_000_000)
        throw new Error("Invalid Pixel Search asset reference");
    const base = `${SPACE_URL}/resolve/${asset.revision}/static/data`;
    const manifest = manifestSchema.parse(JSON.parse(await fetchText(`${base}/manifest.json`)));
    if (asset.catalogId >= manifest.catalog_sprites)
        throw new Error("Pixel Search sprite is outside catalog");
    const pageId = Math.floor(asset.catalogId / manifest.page_sprites), count = Math.min(manifest.page_sprites, manifest.catalog_sprites - pageId * manifest.page_sprites);
    const [page, palette] = await Promise.all([
        compressed(base, `pages/${pageId}.bin.z`, 512 * (256 + 511), 1024 * 1024),
        compressed(base, "palette.bin.z", 65536 * 3)
    ]);
    const pixels = decodePixelSprite(page, count, asset.catalogId % manifest.page_sprites, palette);
    return [
        { fileName: `${slugify(asset.subject)}-${asset.catalogId}.png`, content: encodePng({ width: 16, height: 16, pixels }) },
        { fileName: "PIXEL_SEARCH_PROVENANCE.json", content: JSON.stringify({ dataset: DATASET_URL, index: SPACE_URL, revision: asset.revision, catalogId: asset.catalogId, catalogIdIsOriginalDatasetRow: false, subject: asset.subject, approximateCaption: asset.caption, caution: CAUTION }, null, 2) }
    ];
}
//# sourceMappingURL=pixel-search.js.map