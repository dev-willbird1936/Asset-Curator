import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Repack data, never execute an importer, shader, downloader or remote URI.
const LIMIT = 64 * 1024 * 1024;
export const GLTF_JSON_LIMIT = 8 * 1024 * 1024;

export async function readGltfJson(file: string): Promise<Record<string, any>> {
  const size = (await stat(file)).size;
  if (size > LIMIT) throw new Error("Model metadata inspection exceeds 64 MiB cap");
  const bytes = await readFile(file);
  let json: Buffer;
  if (path.extname(file).toLowerCase() === ".glb") {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error("Invalid GLB 2.0 header");
    const length = bytes.readUInt32LE(12);
    if (length > GLTF_JSON_LIMIT || length % 4 || length + 20 > bytes.length) throw new Error("Invalid GLB JSON chunk");
    json = bytes.subarray(20, 20 + length);
  } else {
    if (size > GLTF_JSON_LIMIT) throw new Error("glTF JSON exceeds 8 MiB cap");
    json = bytes;
  }
  const model = JSON.parse(json.toString("utf8"));
  if (!model || model.asset?.version !== "2.0") throw new Error("Unsupported glTF metadata version");
  return model;
}

export async function repackGltf(file: string, root: string, output: string): Promise<void> {
  const model = await readGltfJson(file), physicalRoot = await realpath(root);
  let total = 0;
  const chunks: Buffer[] = [], offsets: number[] = [];
  const append = (bytes: Buffer) => {
    const start = total, padded = (bytes.length + 3) & ~3;
    if (padded < bytes.length || total + padded > LIMIT) throw new Error("GLB repack exceeds 64 MiB cap");
    chunks.push(bytes); if (padded > bytes.length) chunks.push(Buffer.alloc(padded - bytes.length));
    total += padded; return start;
  };
  async function resource(uri: unknown): Promise<Buffer> {
    if (typeof uri !== "string") throw new Error("Missing glTF resource URI");
    if (uri.startsWith("data:")) {
      const match = /^data:[a-z0-9.+/-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
      if (!match || match[1].length > LIMIT * 4 / 3 + 4 || match[1].length % 4) throw new Error("Invalid/oversized glTF data URI");
      return Buffer.from(match[1], "base64");
    }
    let decoded: string;
    try { decoded = decodeURIComponent(uri.split(/[?#]/)[0]); } catch { throw new Error("Invalid glTF resource encoding"); }
    if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || /^[\\/]/.test(decoded) || /[\x00-\x1f]/.test(decoded)) throw new Error("Remote/absolute glTF resource refused");
    const target = await realpath(path.resolve(path.dirname(file), decoded)), relative = path.relative(physicalRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("glTF resource escapes source pack");
    if ((await stat(target)).size > LIMIT) throw new Error("GLB resource exceeds 64 MiB cap");
    return readFile(target);
  }
  const buffers = model.buffers ?? [], views = model.bufferViews ?? [], images = model.images ?? [];
  if (!Array.isArray(buffers) || !Array.isArray(views) || !Array.isArray(images) || buffers.length > 256 || images.length > 256 || views.length > 100000) throw new Error("Invalid/oversized glTF resource tables");
  for (const buffer of buffers) {
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) throw new Error("Invalid glTF buffer length");
    if (buffer.byteLength > LIMIT) throw new Error("glTF buffer exceeds the 64 MiB single-file GLB repack cap");
    const bytes = await resource(buffer.uri);
    if (bytes.length < buffer.byteLength) throw new Error("Truncated glTF buffer");
    offsets.push(append(bytes.subarray(0, buffer.byteLength)));
  }
  for (const view of views) {
    if (!Number.isSafeInteger(view.buffer) || !buffers[view.buffer] || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 || !Number.isSafeInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > buffers[view.buffer].byteLength) throw new Error("Invalid glTF buffer view bounds");
    view.byteOffset = offsets[view.buffer] + (view.byteOffset ?? 0); view.buffer = 0;
  }
  for (const image of images) {
    if (image.uri === undefined) {
      if (!Number.isSafeInteger(image.bufferView) || !views[image.bufferView] || typeof image.mimeType !== "string") throw new Error("Invalid embedded glTF image");
      continue;
    }
    if (image.bufferView !== undefined) throw new Error("Ambiguous glTF image source");
    const bytes = await resource(image.uri);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
      : bytes.subarray(0, 12).equals(Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10])) ? "image/ktx2" : undefined;
    if (!mime || image.mimeType && image.mimeType !== mime) throw new Error("Unsupported/mismatched glTF image encoding");
    image.bufferView = views.length; image.mimeType = mime; delete image.uri;
    views.push({ buffer: 0, byteOffset: append(bytes), byteLength: bytes.length });
  }
  // Unknown extensions may contain references we cannot safely rebase/embed.
  let nodes = 0;
  function check(value: unknown, depth = 0): void {
    if (++nodes > 200000 || depth > 64) throw new Error("glTF metadata nesting exceeds cap");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "extensions" && child && typeof child === "object") for (const extension of Object.keys(child)) {
        if (!/^(?:KHR_materials_(?:anisotropy|clearcoat|dispersion|emissive_strength|ior|iridescence|pbrSpecularGlossiness|sheen|specular|transmission|unlit|variants|volume)|KHR_(?:draco_mesh_compression|mesh_quantization|texture_basisu|texture_transform|lights_punctual)|EXT_(?:texture_webp|mesh_gpu_instancing))$/.test(extension)) throw new Error("Unsupported glTF extension for safe repack: " + extension);
      }
      if (key === "uri" && typeof child === "string" && !child.startsWith("data:")) throw new Error("Unsupported external URI in glTF extension");
      check(child, depth + 1);
    }
  }
  model.buffers = total ? [{ byteLength: total }] : [];
  model.bufferViews = views;
  check(model);
  const json = Buffer.from(JSON.stringify(model)), jsonLength = (json.length + 3) & ~3;
  if (jsonLength > GLTF_JSON_LIMIT || total + jsonLength + 28 > LIMIT) throw new Error("GLB repack exceeds size cap");
  const outputBytes = Buffer.alloc(20 + jsonLength + (total ? 8 + total : 0), 0);
  outputBytes.writeUInt32LE(0x46546c67, 0); outputBytes.writeUInt32LE(2, 4); outputBytes.writeUInt32LE(outputBytes.length, 8);
  outputBytes.writeUInt32LE(jsonLength, 12); outputBytes.writeUInt32LE(0x4e4f534a, 16);
  outputBytes.fill(32, 20, 20 + jsonLength); json.copy(outputBytes, 20);
  if (total) { outputBytes.writeUInt32LE(total, 20 + jsonLength); outputBytes.writeUInt32LE(0x004e4942, 24 + jsonLength); Buffer.concat(chunks, total).copy(outputBytes, 28 + jsonLength); }
  await writeFile(output, outputBytes, { flag: "wx" });
}
