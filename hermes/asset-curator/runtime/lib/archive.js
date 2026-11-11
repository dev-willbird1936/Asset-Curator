import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { hasAncestorTraversal } from "./util.js";
const DEFAULT_MAX_EXTRACTED_FILES = 10_000;
const DEFAULT_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
export async function extractZip(zipPath, targetDir, options = {}) {
    await mkdir(targetDir, { recursive: true });
    return new Promise((resolve, reject) => {
        const extracted = [];
        const maxFiles = options.maxFiles ?? DEFAULT_MAX_EXTRACTED_FILES;
        const maxBytes = options.maxBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
        let extractedBytes = 0;
        yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
            if (openError || !zipFile) {
                reject(openError ?? new Error("Unable to open ZIP"));
                return;
            }
            zipFile.readEntry();
            zipFile.on("entry", (entry) => {
                const entryName = entry.fileName.replace(/\\/g, "/");
                if (hasAncestorTraversal(entryName) || path.isAbsolute(entryName)) {
                    zipFile.close();
                    reject(new Error(`Blocked unsafe ZIP entry: ${entry.fileName}`));
                    return;
                }
                if (isSymlinkEntry(entry)) {
                    zipFile.close();
                    reject(new Error(`Blocked ZIP symlink entry: ${entry.fileName}`));
                    return;
                }
                const targetPath = path.resolve(targetDir, entryName);
                const targetRoot = path.resolve(targetDir);
                if (!isInsidePath(targetRoot, targetPath)) {
                    zipFile.close();
                    reject(new Error(`Blocked ZIP entry outside output dir: ${entry.fileName}`));
                    return;
                }
                if (extracted.length >= maxFiles) {
                    zipFile.close();
                    reject(new Error(`ZIP exceeds max file count (${maxFiles})`));
                    return;
                }
                if (extractedBytes + entry.uncompressedSize > maxBytes) {
                    zipFile.close();
                    reject(new Error(`ZIP exceeds max extracted bytes (${extractedBytes + entry.uncompressedSize} > ${maxBytes})`));
                    return;
                }
                if (/\/$/.test(entryName)) {
                    mkdir(targetPath, { recursive: true })
                        .then(() => zipFile.readEntry())
                        .catch(reject);
                    return;
                }
                mkdir(path.dirname(targetPath), { recursive: true })
                    .then(() => new Promise((streamResolve, streamReject) => {
                    zipFile.openReadStream(entry, (streamError, readStream) => {
                        if (streamError || !readStream) {
                            streamReject(streamError ?? new Error(`Unable to read ZIP entry: ${entry.fileName}`));
                            return;
                        }
                        let entryBytes = 0;
                        pipeline(readStream, byteLimitStream(maxBytes - extractedBytes, `ZIP entry ${entry.fileName}`, (bytes) => {
                            entryBytes = bytes;
                        }), createWriteStream(targetPath))
                            .then(() => {
                            extracted.push(targetPath);
                            extractedBytes += entryBytes;
                            streamResolve();
                        })
                            .catch(async (error) => {
                            await rm(targetPath, { force: true });
                            streamReject(error);
                        });
                    });
                }))
                    .then(() => zipFile.readEntry())
                    .catch(reject);
            });
            zipFile.once("end", () => resolve(extracted));
            zipFile.once("error", reject);
        });
    });
}
function byteLimitStream(maxBytes, label, onBytes) {
    let total = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            total += chunk.byteLength;
            onBytes(total);
            if (total > maxBytes) {
                callback(new Error(`${label} exceeds remaining ZIP byte budget (${total} > ${maxBytes})`));
                return;
            }
            callback(null, chunk);
        }
    });
}
function isInsidePath(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function isSymlinkEntry(entry) {
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    return mode === 0o120000;
}
//# sourceMappingURL=archive.js.map