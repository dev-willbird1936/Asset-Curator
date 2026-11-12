import { z } from "zod";
import { synthesizeZzfx } from "./vendor/zzfx.js";
import { synthesizeZzfxm } from "./vendor/zzfxm.js";
export const synthParametersSchema = z.array(z.number().finite().min(-100000).max(100000).nullable()).max(21);
export const synthSongSchema = z.object({
    instruments: z.array(synthParametersSchema).min(1).max(4),
    patterns: z.array(z.array(z.array(z.number().finite()).min(3).max(66)).min(1).max(4)).min(1).max(8),
    sequence: z.array(z.number().int().min(0).max(7)).min(1).max(8),
    bpm: z.number().min(40).max(240).default(120)
}).strict();
export const SYNTH_RATE = 44100;
const DEFAULT_PARAMETERS = [1, .05, 220, 0, 0, .1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const PARAMETER_NAMES = ["volume", "randomness", "frequency", "attack", "sustain", "release", "shape", "shapeCurve", "slide", "deltaSlide", "pitchJump", "pitchJumpTime", "repeatTime", "noise", "modulation", "bitCrush", "delay", "sustainVolume", "decay", "tremolo", "filter"];
export function normalizeSynthParameters(input = [], music = false) {
    synthParametersSchema.parse(input);
    const p = DEFAULT_PARAMETERS.map((value, i) => input[i] ?? value);
    const range = (i, min, max) => {
        if (p[i] < min || p[i] > max)
            throw new Error(`ZzFX ${PARAMETER_NAMES[i]} (parameter ${i + 1}) is ${p[i]}; it must be between ${min} and ${max}`);
    };
    range(0, 0, 1);
    range(1, 0, 1);
    range(2, 0, music ? 4000 : 16000);
    for (const i of [3, 4, 5, 11, 12, 16, 18])
        range(i, 0, 5);
    range(6, 0, 5);
    range(7, 0, 8);
    range(15, 0, 1);
    range(17, 0, 1);
    range(19, 0, 1);
    range(20, -20000, 20000);
    if (!Number.isInteger(p[6]))
        throw new Error("ZzFX shape must be an integer from 0 to 5");
    const duration = [3, 4, 5, 16, 18].reduce((sum, i) => sum + p[i], 0);
    if (duration > (music ? 2 : 10))
        throw new Error(`ZzFX envelope exceeds ${music ? 2 : 10} second cap`);
    return p;
}
export function defaultSynthParameters(request) {
    if (/coin|pickup|power.?up/i.test(request))
        return [.6, 0, 880, .005, .04, .18, 0, 1, 0, 0, 440, .05];
    if (/laser|shoot|zap/i.test(request))
        return [.45, .02, 1200, .005, .04, .22, 2, 1, -2.5];
    if (/explosion|boom|rumble/i.test(request))
        return [.7, .05, 70, .005, .08, .7, 4, 1, -.08, 0, 0, 0, 0, 1];
    return [.45, .03, 440, .005, .03, .15];
}
export function defaultSynthSong(seed) {
    const scale = [12, 16, 19, 21, 24];
    const notes = Array.from({ length: 16 }, (_, i) => scale[(i * 3 + (seed % 5)) % scale.length]);
    return {
        instruments: [[.4, 0, 220, .005, .05, .15, 1], [.4, 0, 110, .005, .09, .2, 0]],
        patterns: [[[0, -.25, ...notes], [1, .25, 12, 0, 0, 0, 17, 0, 0, 0, 19, 0, 0, 0, 12, 0, 0, 0]]],
        sequence: [0, 0], bpm: 120
    };
}
export function validateSynthSong(input) {
    const song = synthSongSchema.parse(input);
    song.instruments.forEach((p) => normalizeSynthParameters(p, true));
    for (const pattern of song.patterns)
        for (const channel of pattern) {
            if (channel.length !== pattern[0].length)
                throw new Error("ZzFXM channels in a pattern must have equal note counts");
            if (!Number.isInteger(channel[0]) || channel[0] < 0 || channel[0] >= song.instruments.length)
                throw new Error("ZzFXM instrument index is out of range");
            if (channel[1] < -1 || channel[1] > 1)
                throw new Error("ZzFXM panning must be between -1 and 1");
            if (channel.slice(2).some((note) => note !== -1 && (note < 0 || note >= 49)))
                throw new Error("ZzFXM notes must be -1 (stop), 0 (hold), or below 49; fractional parts attenuate");
        }
    let steps = 0;
    for (const i of song.sequence) {
        if (!song.patterns[i])
            throw new Error("ZzFXM sequence pattern index is out of range");
        steps += song.patterns[i][0].length - 2;
    }
    if (steps * 60 / song.bpm / 4 > 30)
        throw new Error("ZzFXM song exceeds 30 second cap");
    return song;
}
export function renderSynthSound(parameters, seed) {
    const p = normalizeSynthParameters(parameters);
    // Zero volume with delay divides by zero upstream; an explicitly muted sound is silence.
    const samples = p[0] ? synthesizeZzfx(p, seed) : new Float32Array(Math.max(9, Math.ceil([3, 4, 5, 16, 18].reduce((s, i) => s + p[i], 0) * SYNTH_RATE)));
    return encodeSynthWav([samples]);
}
export function renderSynthSong(input, seed) {
    const song = validateSynthSong(input);
    const instruments = song.instruments.map((p) => normalizeSynthParameters(p, true));
    // The tracker receives zero-safe instruments too; a tiny amplitude is inaudible after PCM quantization.
    for (const p of instruments)
        if (!p[0])
            p[0] = Number.EPSILON;
    return encodeSynthWav(synthesizeZzfxm(instruments, song.patterns, song.sequence, song.bpm, seed));
}
function encodeSynthWav(channels) {
    const length = Math.max(...channels.map((channel) => channel.length));
    if (length < 1 || length > SYNTH_RATE * 30)
        throw new Error("Synth output exceeds sample cap or is empty");
    let peak = 0;
    for (const channel of channels)
        for (let i = 0; i < channel.length; i++) {
            const value = channel[i] ?? 0;
            if (!Number.isFinite(value))
                throw new Error("Synth produced non-finite samples; revise parameters");
            peak = Math.max(peak, Math.abs(value));
        }
    const gain = peak > .95 ? .95 / peak : 1, pcm = Buffer.alloc(length * channels.length * 2);
    for (let i = 0; i < length; i++)
        for (let c = 0; c < channels.length; c++) {
            const fade = Math.min(1, i / 128, (length - 1 - i) / 128);
            pcm.writeInt16LE(Math.round((channels[c][i] ?? 0) * gain * fade * 32767), (i * channels.length + c) * 2);
        }
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels.length, 22);
    header.writeUInt32LE(SYNTH_RATE, 24);
    header.writeUInt32LE(SYNTH_RATE * channels.length * 2, 28);
    header.writeUInt16LE(channels.length * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
export const SYNTH_LICENSE = `ZzFX 1.4.0 / ZzFXM 2.0.3 — MIT-licensed synthesis code, no sampled media.
ZzFX: https://github.com/KilledByAPixel/ZzFX/tree/ac5a4727a44e5506a12f7340087e0b889cfd69dc
ZzFXM: https://github.com/keithclark/ZzFXM/tree/cb07fa9ca36aefd67a0c8c656d2958b62f8ed9fe
Node adapters use seeded randomness, omit Web Audio playback, and fade/limit PCM output.

Copyright (c) 2019 Frank Force
Copyright (c) 2020 Keith Clark

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
//# sourceMappingURL=synthesis.js.map