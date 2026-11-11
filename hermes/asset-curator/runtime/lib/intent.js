import { containsToken, tokenize } from "./util.js";
// Words that describe the kind/format/style of asset, not its subject. A result
// must match a real subject; "character" or "sprite" alone proves nothing.
const GENERIC = new Set(("cartoon low poly lowpoly rigged idle walk run cycle animation animations animated stylized stylised photoreal photorealistic realistic " +
    "textured flat color colour normal roughness albedo metallic map maps pbr material materials texture textures tileable seamless tile " +
    "model models mesh prop props 3d 2d glb gltf fbx obj png jpg svg wav ogg mp3 exr hdr 1k 2k 4k 16x16 32x32 64x64 " +
    "sprite sprites spritesheet sheet frame frames pixel art icon icons ui hud vector outline line minimal simple " +
    "sound sounds sfx effect effects audio music song track loop looping loops " +
    "character characters game games asset pack kit style styled inspired looking " +
    "hand painted drawn painterly watercolor watercolour anime manga chibi illustration illustrated drawing image picture " +
    "transparent background small big large heavy tiny little old new nice cool good high quality quick " +
    "unity unreal godot roblox engine first person third side scroller scrolling top down rpg mobile pc console " +
    // Prompt filler and instructions to the agent are not subjects either.
    "you are expert director artist designer developer think step steps then find me my i we need want give get make create grab download search show pick choose " +
    "single best perfect great awesome amazing something anything whichever whatever exists exist output only just please thanks should must would could can will " +
    "item items object objects thing things enemy player hero level scene world project prototype demo free cc0 commercial cozy").split(" "));
const SYNONYMS = {
    drum: ["barrel"], keg: ["barrel"], barrel: ["drum", "keg"],
    mage: ["wizard", "sorcerer"], wizard: ["mage", "sorcerer"], sorcerer: ["mage", "wizard"],
    potion: ["flask", "vial"], crate: ["box"], boulder: ["rock"], rock: ["boulder", "stone"], stone: ["rock"],
    airship: ["zeppelin", "blimp", "dirigible"], spaceship: ["starship", "spacecraft"], spacecraft: ["spaceship"],
    sword: ["blade"], gem: ["crystal", "jewel"], crystal: ["gem"], tree: ["pine", "oak", "fir", "birch"],
    skybox: ["sky"], creak: ["squeak", "creaking"], coin: ["coins"]
};
export function synonymsOf(token) { return SYNONYMS[token] ?? []; }
/** "Exact Title" phrases the user quoted; a result carrying one outranks everything else. */
export function quotedPhrases(request) {
    return [...request.matchAll(/["“']([^"”']{3,60})["”']/g)].map((match) => match[1].trim().toLowerCase()).filter(Boolean);
}
const SOURCE_NAMES = [[/\bpoly\s?haven\b/i, "polyhaven"], [/\bambient\s?cg\b/i, "ambientcg"], [/\bkenney\b/i, "kenney"], [/\bkay\s?kit\b/i, "kaykit"],
    [/\bquaternius\b/i, "quaternius"], [/\bopenverse\b/i, "openverse"], [/\blucide\b/i, "lucide"], [/\btabler\b/i, "tabler"], [/\bgame-?icons\b/i, "game-icons"],
    [/\bgoogle fonts?\b/i, "google-fonts"], [/\bmixkit\b/i, "mixkit"], [/\bopen\s?clipart\b/i, "openclipart"]];
/** Sources the user named in prose ("from Poly Haven"). A preference, not a filter. */
export function namedSources(request) {
    return SOURCE_NAMES.filter(([pattern]) => pattern.test(request)).map(([, id]) => id);
}
export function parseIntent(request) {
    const negatives = new Set();
    const positive = request.replace(/\b(?:not|no|non|without|excluding|except|avoid)(?:[\s-]+(?:a|an|any|the|made|of|from))*[\s-]+([a-z][a-z]+)/gi, (_all, word) => {
        const w = word.toLowerCase();
        if (w.length < 3 || ["matter", "need", "problem", "more", "longer", "only", "just"].includes(w))
            return _all;
        negatives.add(w);
        if (w.endsWith("en") && w.length > 5)
            negatives.add(w.slice(0, -2));
        if (w.endsWith("s") && w.length > 4)
            negatives.add(w.slice(0, -1));
        return " ";
    }).replace(/\s+/g, " ").trim();
    return { positive: positive || request, negatives: [...negatives], subjects: subjectTokens(positive || request), styles: requestedStyles(request) };
}
export function subjectTokens(request) {
    const names = new Set(namedSources(request).flatMap((id) => [id, ...id.split("-")]).concat(["poly", "haven", "kay", "kit", "google"]));
    const named = namedSources(request).length > 0;
    return tokenize(request).filter((token) => !GENERIC.has(token) && !/^\d+$/.test(token) && !(named && names.has(token)));
}
export function violatesNegatives(result, negatives) {
    if (!negatives.length)
        return undefined;
    const text = `${result.title} ${(result.tags ?? []).join(" ")}`.toLowerCase();
    return negatives.find((word) => containsToken(text, word));
}
const STYLE_WORDS = {
    photoreal: /\b(photo-?real(?:istic)?|realistic|photo-?scanned|scanned)\b/i,
    "low-poly": /\b(low[\s-]?poly|cartoon|stylized|stylised|toon)\b/i,
    pixel: /\b(pixel(?:[\s-]?art)?|8[\s-]?bit|16[\s-]?bit|retro)\b/i,
    vector: /\b(vector|flat|outline|line[\s-]?art|monochrome|minimal(?:ist)?)\b/i,
    painterly: /\b(water-?colou?r|hand[\s-]?painted|painterly|oil[\s-]?paint(?:ing|ed)?|hand[\s-]?drawn|sketch(?:ed|y)?|ink)\b/i,
    anime: /\b(anime|manga|chibi|cel[\s-]?shaded)\b/i
};
// Sources whose whole catalogue has one look. Mixed catalogues are absent on purpose.
const SOURCE_STYLE = {
    polyhaven: "photoreal", ambientcg: "photoreal", kaykit: "low-poly", quaternius: "low-poly",
    "pixel-search": "pixel", lucide: "vector", tabler: "vector", "game-icons": "vector"
};
export function requestedStyles(request) {
    return Object.keys(STYLE_WORDS).filter((style) => STYLE_WORDS[style].test(request));
}
/** Metadata evidence only. "confirmed" means the source or its tags declare the style, never that pixels were inspected. */
export function styleEvidence(result, requested) {
    if (!requested.length || ["Audio", "Music"].includes(result.category))
        return undefined;
    const text = `${result.title} ${(result.tags ?? []).join(" ")} ${(result.series ?? []).join(" ")}`;
    const generated = result.generatedAsset;
    const declared = generated?.kind === "procedural" ? (generated.preset?.startsWith("model-") ? "low-poly" : generated.preset?.startsWith("texture-") ? undefined : "pixel")
        : generated?.kind === "pixelbolt" ? "pixel" : SOURCE_STYLE[result.source];
    const confirmed = requested.filter((style) => declared === style || STYLE_WORDS[style].test(text));
    const unconfirmed = requested.filter((style) => !confirmed.includes(style));
    const conflicting = declared && unconfirmed.length && !requested.includes(declared) ? declared : undefined;
    const note = conflicting ? `Requested ${unconfirmed.join(", ")} but this source is ${conflicting}; treat as a style mismatch unless a preview proves otherwise.`
        : unconfirmed.length ? `Requested style (${unconfirmed.join(", ")}) is not confirmed by metadata; inspect the preview before delivering it as a match.`
            : `Style (${confirmed.join(", ")}) declared by source or tags; not visually verified.`;
    return { requested, confirmed, unconfirmed, conflicting, basis: "metadata-only-not-visual", note };
}
export function styleScore(evidence) {
    if (!evidence)
        return 0;
    return evidence.confirmed.length * 5 - evidence.unconfirmed.length * 2 - (evidence.conflicting ? 10 : 0);
}
export function inferCategory(request) {
    const lower = request.toLowerCase();
    const has = (pattern) => pattern.test(lower);
    const music = has(/\b(music|song|songs|soundtrack|bgm|chiptune|melody|jingle|score)\b/);
    const audio = has(/\b(audio|sound|sounds|sfx|foley|wav|ogg|mp3|voice|voiceover)\b/);
    const flat = has(/\b(2d|sprite|sprites|spritesheet|sprite sheet|pixel|pixel-art|png|gif|flipbook|tileset|tilemap|illustration)\b/);
    const solid = has(/\b(3d|model|models|mesh|fbx|glb|gltf|obj|low[\s-]?poly|lowpoly|rigged|skeleton|skinned)\b/);
    if (music)
        return "Music";
    if (audio)
        return "Audio";
    if (has(/\b(icon|icons|font|fonts|typeface|typography)\b/))
        return "UI";
    if (has(/\b(hdri|hdr|exr|skybox|environment[\s-]?map|panorama)\b/))
        return "Textures";
    if (has(/\b(vfx|visual effects?|particle|particles|spell effects?|flipbook)\b/))
        return "VFX";
    if (flat && !solid && has(/\b(animation|animated|looping|loop)\b/) && has(/\b(fire|flame|smoke|explosion|portal|magic|spark|sparkle|lightning|burst|glow)\b/))
        return "VFX";
    if (!flat && has(/\b(animation|animations|animated|mocap|motion capture|rig|rigged|walk cycle|run cycle|bvh)\b/))
        return "Animation";
    if (solid)
        return "3D";
    if (has(/\b(tileset|tilemap)\b/))
        return "2D";
    if (has(/\b(texture|textures|material|materials|pbr|tileable|normal map)\b/))
        return "Textures";
    if (has(/\b(ui|button|buttons|interface|hud|menu)\b/))
        return "UI";
    if (flat || has(/\b(drawing|painting|water-?colou?r|clipart|clip art|portrait|logo|vector)\b/))
        return "2D";
    if (has(/\b(loop|loops|theme)\b/))
        return "Music";
    // Engine compatibility is not the requested media type.
    if (has(/\b(roblox|unity|unreal|godot)\b/))
        return "3D";
    return "Unknown";
}
export function scoreText(request, haystack, base, title = "") {
    const tokens = expandedTokens(request);
    const lower = haystack.toLowerCase();
    // A style, format or engine word cannot stand in for the requested subject.
    const subjects = subjectTokens(request);
    // A request with no subject at all ("something cool for my game") matches nothing.
    if (!subjects.length)
        return 0;
    if (subjects.length && !subjects.some((token) => containsToken(lower, token) || synonymsOf(token).some((alias) => containsToken(lower, alias))))
        return 0;
    let score = base;
    let hits = 0;
    for (const token of tokens) {
        if (containsToken(lower, token)) {
            hits += 1;
            score += token.length > 5 ? 3.5 : 2.5;
            // Named subject/style evidence beats incidental words in a long tag list.
            if (title && containsToken(title, token))
                score += 5;
        }
    }
    if (tokens.length > 0) {
        const coverage = hits / tokens.length;
        const phrase = tokenize(request).join(" ");
        score += coverage * 6;
        // Source quality must never make an unrelated object a positive match.
        if (hits === 0)
            return 0;
        if (phrase && lower.includes(phrase))
            score += 4;
    }
    return Math.max(0, score);
}
export function expandedRequest(request) {
    const lower = request.toLowerCase();
    const aliases = [];
    if (/\b(horror|scary|terror|creepy|haunt)\b/.test(lower))
        aliases.push("scary", "halloween", "dark", "suspense", "terror");
    if (/\b(car|vehicle|auto)\b/.test(lower))
        aliases.push("engine", "race car", "transport");
    if (/\b(ui|button|menu|select)\b/.test(lower))
        aliases.push("click", "interface", "alert");
    if (/\b(spell|magic|wizard)\b/.test(lower))
        aliases.push("magic", "spell", "particle");
    if (/\b(explosion|boom|blast)\b/.test(lower))
        aliases.push("impact", "cinematic", "warfare");
    return aliases.length > 0 ? `${request} ${aliases.join(" ")}` : request;
}
function expandedTokens(request) {
    const tokens = new Set(tokenize(expandedRequest(request)));
    const aliases = {
        car: ["vehicle", "auto", "transport"],
        vehicle: ["car", "transport"],
        tree: ["forest", "foliage", "plant", "nature"],
        coin: ["pickup", "collect", "reward"],
        button: ["ui", "interface", "click"],
        sword: ["weapon", "blade", "attack"],
        shield: ["armor", "defense", "guard"],
        magic: ["spell", "wizard", "particle"],
        explosion: ["blast", "boom", "impact"],
        horror: ["scary", "dark", "terror"]
    };
    for (const token of [...tokens]) {
        for (const alias of [...(aliases[token] ?? []), ...synonymsOf(token)])
            tokens.add(alias);
    }
    return [...tokens];
}
//# sourceMappingURL=intent.js.map