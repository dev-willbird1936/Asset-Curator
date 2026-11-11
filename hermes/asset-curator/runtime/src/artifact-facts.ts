import { open, stat } from "node:fs/promises";
import path from "node:path";
import { readGltfJson } from "./gltf.js";

export type ArtifactFacts = {
  basis: "file-metadata-not-visual";
  filesInspected: number;
  filesSkipped: number;
  files: { file: string; bytes: number; format: string; image?: { width: number; height: number; animationFrames: number }; audio?: { sampleRate: number; channels: number; bitsPerSample: number; durationSeconds: number }; model?: { meshDefinitions: number; primitiveDefinitions: number; materialDefinitions: number; vertexEntries: number; triangleDefinitions: number; skins: number; animations: string[] }; note?: string }[];
};

// Facts describe encoded metadata, NOT aesthetic quality, scene-instance totals,
// successful engine import, verified pixels, or audio audition.
export async function inspectArtifactFacts(files: string[], root: string): Promise<ArtifactFacts> {
  const facts: ArtifactFacts = { basis: "file-metadata-not-visual", filesInspected: Math.min(files.length, 32), filesSkipped: Math.max(0, files.length - 32), files: [] };
  for (const file of files.slice(0, 32)) {
    const format = path.extname(file).slice(1).toLowerCase(), info = await stat(file);
    const fact: ArtifactFacts["files"][number] = { file: path.relative(root, file).split(path.sep).join("/"), bytes: info.size, format };
    try {
      if (format === "gltf" || format === "glb") {
        const model = await readGltfJson(file);
        let vertices = 0, triangles = 0, primitives = 0;
        const count = (index: unknown): number => {
          if (!Number.isSafeInteger(index) || Number(index) < 0) throw new Error("Missing accessor");
          const value = model.accessors?.[Number(index)]?.count;
          if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) throw new Error("Invalid accessor count");
          return value;
        };
        for (const mesh of model.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
          primitives++; vertices += count(primitive.attributes?.POSITION);
          const entries = primitive.indices === undefined ? count(primitive.attributes?.POSITION) : count(primitive.indices);
          if (primitive.mode === undefined || primitive.mode === 4) triangles += Math.floor(entries / 3);
          else if (primitive.mode === 5 || primitive.mode === 6) triangles += Math.max(0, entries - 2);
        }
        fact.model = { meshDefinitions: (model.meshes ?? []).length, primitiveDefinitions: primitives, materialDefinitions: (model.materials ?? []).length, vertexEntries: vertices, triangleDefinitions: triangles, skins: (model.skins ?? []).length, animations: (model.animations ?? []).map((clip: { name?: unknown }, i: number) => typeof clip.name === "string" ? clip.name.slice(0, 160) : `unnamed-${i}`) };
        fact.note = (triangles > 500000 ? `Very heavy mesh (${triangles.toLocaleString("en-US")} triangles): expect to decimate or add LODs before real-time use. ` : "") + "Accessor-declared counts, summed per primitive definition (shared vertices may repeat). Not scene-instance totals or renderer validation. Animation names do not prove usable movement.";
      } else if (format === "png" || format === "wav") {
        const handle = await open(file, "r");
        try {
          const header = Buffer.alloc(24), read = await handle.read(header, 0, 24, 0);
          if (format === "png") {
            if (read.bytesRead < 24 || !header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || header.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid PNG header");
            let frames = 1, offset = 8;
            for (let n = 0; offset + 12 <= info.size && n < 100000; n++) {
              const chunk = Buffer.alloc(12); await handle.read(chunk, 0, 8, offset);
              const length = chunk.readUInt32BE(0), type = chunk.toString("ascii", 4, 8);
              if (offset + length + 12 > info.size) throw new Error("Invalid PNG chunk bounds");
              if (type === "acTL") { if (length !== 8) throw new Error("Invalid APNG control"); await handle.read(chunk, 0, 4, offset + 8); frames = chunk.readUInt32BE(0); }
              offset += length + 12; if (type === "IEND") break;
            }
            fact.image = { width: header.readUInt32BE(16), height: header.readUInt32BE(20), animationFrames: frames };
            fact.note = "PNG/APNG headers only; animation frame uniqueness/transparency/visual quality not verified.";
          } else {
            if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") throw new Error("Unsupported WAV header");
            let offset = 12, fmt: { rate: number; channels: number; bits: number; byteRate: number } | undefined, data = 0;
            for (let n = 0; offset + 8 <= info.size && n < 10000; n++) {
              const chunk = Buffer.alloc(24); await handle.read(chunk, 0, Math.min(24, info.size - offset), offset);
              const length = chunk.readUInt32LE(4), type = chunk.toString("ascii", 0, 4);
              if (offset + 8 + length > info.size) throw new Error("Invalid WAV chunk bounds");
              if (type === "fmt ") {
                if (length < 16 || ![1, 3].includes(chunk.readUInt16LE(8))) throw new Error("Unsupported WAV encoding");
                fmt = { channels: chunk.readUInt16LE(10), rate: chunk.readUInt32LE(12), byteRate: chunk.readUInt32LE(16), bits: chunk.readUInt16LE(22) };
              }
              if (type === "data") data += length;
              offset += 8 + length + (length & 1);
            }
            if (!fmt?.byteRate || !fmt.rate || !fmt.channels || !data) throw new Error("Incomplete WAV metadata");
            fact.audio = { sampleRate: fmt.rate, channels: fmt.channels, bitsPerSample: fmt.bits, durationSeconds: data / fmt.byteRate };
            fact.note = "PCM/float WAV headers only; no audition, creative/style quality or seamless-loop verification.";
          }
        } finally { await handle.close(); }
      }
    } catch { fact.note = "Detailed metadata unavailable/unsupported or exceeds inspection bounds; do not invent artifact properties."; }
    facts.files.push(fact);
  }
  return facts;
}
