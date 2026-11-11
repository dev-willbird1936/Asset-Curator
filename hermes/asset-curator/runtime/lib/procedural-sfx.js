import { slugify } from "./util.js";
export function chooseProceduralSfxPreset(request) {
    const lower = request.toLowerCase();
    if (/\b(horror|scary|terror|jumpscare|creepy|haunt)\b/.test(lower))
        return "horrorSting";
    if (/\b(explosion|explode|boom|blast|bomb|crash)\b/.test(lower))
        return "explosion";
    if (/\b(laser|shoot|shot|zap|ray|gun)\b/.test(lower))
        return "laserShoot";
    if (/\b(power.?up|level.?up|buff|upgrade)\b/.test(lower))
        return "powerUp";
    if (/\b(hit|hurt|damage|impact|punch|slash)\b/.test(lower))
        return "hitHurt";
    if (/\b(jump|hop|bounce)\b/.test(lower))
        return "jump";
    if (/\b(click|select|blip|button|ui|menu|beep)\b/.test(lower))
        return "blipSelect";
    return "pickupCoin";
}
export function createProceduralSfxDescriptor(request) {
    const preset = chooseProceduralSfxPreset(request);
    return {
        kind: "procedural-sfx",
        preset,
        seed: hashString(`${preset}:${request}`),
        baseName: slugify(`${request}-${preset}`)
    };
}
export function renderProceduralSfx(asset) {
    const wav = synthesizeWav(asset.preset, asset.seed);
    const params = {
        generator: "asset-grabber procedural sfxr-style",
        preset: asset.preset,
        seed: asset.seed,
        sampleRate: 44100,
        license: "Generated locally; no third-party media"
    };
    return [
        { fileName: `${asset.baseName}.wav`, content: wav },
        { fileName: `${asset.baseName}.params.json`, content: `${JSON.stringify(params, null, 2)}\n` }
    ];
}
function synthesizeWav(preset, seed) {
    const sampleRate = 44100;
    const profile = profileForPreset(preset);
    const samples = Math.floor(profile.duration * sampleRate);
    const pcm = Buffer.alloc(samples * 2);
    const random = mulberry32(seed);
    let phase = 0;
    for (let i = 0; i < samples; i += 1) {
        const t = i / sampleRate;
        const progress = i / Math.max(1, samples - 1);
        const envelope = getEnvelope(progress, profile.attack, profile.decay);
        const freq = profile.startHz + (profile.endHz - profile.startHz) * profile.curve(progress);
        phase += (2 * Math.PI * freq) / sampleRate;
        const raw = wave(profile.wave, phase, random);
        const tremolo = profile.tremoloHz > 0 ? 0.72 + 0.28 * Math.sin(2 * Math.PI * profile.tremoloHz * t) : 1;
        const sample = clamp(raw * envelope * profile.gain * tremolo, -0.95, 0.95);
        pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    return wavContainer(pcm, sampleRate);
}
function profileForPreset(preset) {
    switch (preset) {
        case "laserShoot":
            return curveProfile(0.42, 1180, 160, 0.005, 2.8, 0.42, 0, "square", easeOut);
        case "explosion":
            return curveProfile(1.1, 120, 38, 0, 4.2, 0.7, 0, "noise", easeOut);
        case "powerUp":
            return curveProfile(0.72, 260, 1100, 0.01, 1.7, 0.34, 9, "square", easeIn);
        case "hitHurt":
            return curveProfile(0.32, 210, 90, 0, 6, 0.62, 0, "noise", easeOut);
        case "jump":
            return curveProfile(0.36, 260, 720, 0.005, 2, 0.35, 0, "square", easeIn);
        case "blipSelect":
            return curveProfile(0.12, 760, 980, 0.002, 5, 0.28, 0, "sine", linear);
        case "horrorSting":
            return curveProfile(1.45, 58, 92, 0.04, 1.15, 0.48, 6, "saw", easeInOut);
        case "pickupCoin":
        default:
            return curveProfile(0.45, 660, 1320, 0.003, 2.5, 0.34, 12, "square", easeOut);
    }
}
function curveProfile(duration, startHz, endHz, attack, decay, gain, tremoloHz, wave, curve) {
    return { duration, startHz, endHz, attack, decay, gain, tremoloHz, wave, curve };
}
function getEnvelope(progress, attack, decay) {
    if (attack > 0 && progress < attack)
        return progress / attack;
    return Math.exp(-progress * decay);
}
function wave(kind, phase, random) {
    if (kind === "square")
        return Math.sin(phase) >= 0 ? 1 : -1;
    if (kind === "saw")
        return 2 * (phase / (2 * Math.PI) - Math.floor(0.5 + phase / (2 * Math.PI)));
    if (kind === "noise")
        return random() * 2 - 1;
    return Math.sin(phase);
}
function wavContainer(pcm, sampleRate) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function mulberry32(seed) {
    return () => {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function linear(progress) {
    return progress;
}
function easeIn(progress) {
    return progress * progress;
}
function easeOut(progress) {
    return 1 - (1 - progress) * (1 - progress);
}
function easeInOut(progress) {
    return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
//# sourceMappingURL=procedural-sfx.js.map