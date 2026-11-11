import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
const USER_AGENT = "asset-curator-mcp/0.2 (+https://github.com/dev-willbird1936/Asset-Curator)";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 750 * 1024 * 1024;
const DEFAULT_FETCH_RETRIES = 2;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
export async function fetchText(url, timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024) {
    const cachePath = httpCachePath(url);
    const cached = await readFreshCache(cachePath, cacheTtlMs(), maxBytes);
    if (cached !== undefined)
        return cached;
    try {
        const text = await retry(`GET ${url}`, async () => {
            const response = await fetch(url, {
                headers: { "user-agent": USER_AGENT },
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!response.ok) {
                throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
            }
            return (await boundedResponse(response, maxBytes, `GET ${url}`)).toString("utf8");
        });
        await writeCache(cachePath, text);
        return text;
    }
    catch (error) {
        const stale = await readFreshCache(cachePath, Infinity, maxBytes);
        if (stale !== undefined)
            return stale;
        throw error;
    }
}
export async function fetchBinary(url, maxBytes = 2 * 1024 * 1024) {
    const cachePath = httpCachePath(url).replace(/\.txt$/, ".bin");
    const cached = async (ttl) => {
        if (process.env.ASSET_GRABBER_HTTP_CACHE_DISABLE === "1")
            return undefined;
        try {
            const info = await stat(cachePath);
            return info.size <= maxBytes && Date.now() - info.mtimeMs <= ttl ? await readFile(cachePath) : undefined;
        }
        catch {
            return undefined;
        }
    };
    const fresh = await cached(cacheTtlMs());
    if (fresh)
        return fresh;
    try {
        const bytes = await retry(`GET ${url}`, async () => {
            const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`GET ${url} failed: HTTP ${response.status}`);
            }
            return boundedResponse(response, maxBytes, `GET ${url}`);
        });
        if (process.env.ASSET_GRABBER_HTTP_CACHE_DISABLE !== "1") {
            await mkdir(path.dirname(cachePath), { recursive: true });
            await writeFile(cachePath, bytes);
        }
        return bytes;
    }
    catch (error) {
        const stale = await cached(Infinity);
        if (stale)
            return stale;
        throw error;
    }
}
async function boundedResponse(response, maxBytes, label) {
    if (!response.body)
        throw new Error(`${label} returned no body`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maxBytes)
                throw new Error(`${label} exceeds max bytes (${maxBytes})`);
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    return Buffer.concat(chunks);
}
export async function downloadFile(url, targetPath, options = DEFAULT_DOWNLOAD_TIMEOUT_MS) {
    const timeoutMs = typeof options === "number" ? options : (options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const maxBytes = typeof options === "number" ? DEFAULT_MAX_DOWNLOAD_BYTES : (options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const response = await retry(`Download ${url}`, () => fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs)
    }));
    if (!response.ok || !response.body) {
        throw new Error(`Download ${url} failed: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`Download ${url} exceeds max bytes (${contentLength} > ${maxBytes})`);
    }
    try {
        await pipeline(response.body, byteLimitStream(maxBytes, `Download ${url}`), createWriteStream(targetPath));
    }
    catch (error) {
        await rm(targetPath, { force: true });
        throw error;
    }
}
async function retry(label, operation, attempts = DEFAULT_FETCH_RETRIES + 1) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt === attempts)
                break;
            await delay(250 * 2 ** (attempt - 1));
        }
    }
    throw lastError instanceof Error ? new Error(`${label} failed after ${attempts} attempts: ${lastError.message}`) : lastError;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function httpCachePath(url) {
    const root = path.resolve(process.env.ASSET_GRABBER_HTTP_CACHE_DIR ?? ".cache/asset-grabber-http");
    const hash = createHash("sha256").update(url).digest("hex");
    return path.join(root, `${hash}.txt`);
}
function cacheTtlMs() {
    const value = Number(process.env.ASSET_GRABBER_HTTP_CACHE_TTL_MS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_TTL_MS;
}
async function readFreshCache(filePath, ttlMs, maxBytes) {
    if (process.env.ASSET_GRABBER_HTTP_CACHE_DISABLE === "1")
        return undefined;
    try {
        const info = await stat(filePath);
        if (Date.now() - info.mtimeMs > ttlMs || info.size > maxBytes)
            return undefined;
        return readFile(filePath, "utf8");
    }
    catch {
        return undefined;
    }
}
async function writeCache(filePath, value) {
    if (process.env.ASSET_GRABBER_HTTP_CACHE_DISABLE === "1")
        return;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, "utf8");
}
function byteLimitStream(maxBytes, label) {
    let total = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            total += chunk.byteLength;
            if (total > maxBytes) {
                callback(new Error(`${label} exceeds max bytes (${total} > ${maxBytes})`));
                return;
            }
            callback(null, chunk);
        }
    });
}
//# sourceMappingURL=http.js.map