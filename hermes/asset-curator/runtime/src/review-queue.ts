import path from "node:path";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, readFile, writeFile, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { GrabbedAssetManifest } from "./types.js";

// Only the host may supply approveCallback. Never expose it as a tool argument.
export type ReviewItem = { id: string; title: string; status: "pending" | "approved" | "rejected"; stagedRoot: string; destination: string; manifestName: string; manifestPath?: string; files: { name: string; hash: string; bytes: number }[]; createdAt: string };
const MAX_BYTES = 256 * 1024 * 1024, MAX_FILES = 10000, MAX_ITEMS = 200;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const inside = (root: string, target: string) => { const r = path.relative(root, target); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function stagingRoot() { return path.join(os.homedir(), "Downloads", "asset-curator-review"); }
async function noLinks(target: string): Promise<void> {
  let p = path.resolve(target);
  for (;;) {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in review paths"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parent = path.dirname(p); if (parent === p) return; p = parent;
  }
}
async function stateRoot(): Promise<string> {
  const settings = process.env.ASSET_GRABBER_SETTINGS_PATH;
  if (!settings || !path.isAbsolute(settings)) throw new Error("Review queue requires an explicit plugin-owned ASSET_GRABBER_SETTINGS_PATH");
  const root = path.join(path.dirname(settings), "asset-review-queue");
  if (inside(path.join(os.homedir(), "Downloads"), root)) throw new Error("Queue state cannot be stored in Downloads");
  await noLinks(root); await mkdir(root, { recursive: true, mode: 0o700 }); return root;
}
async function locked<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await stateRoot(), lock = path.join(root, "lock");
  try { await mkdir(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Review queue is busy (or requires host recovery after an interrupted operation)"); throw e; }
  try { return await fn(root); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(root: string): Promise<ReviewItem[]> {
  const file = path.join(root, "queue.json"); await noLinks(file);
  try { const rows = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(rows) || rows.length > MAX_ITEMS) throw new Error("Invalid queue state"); return rows; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
async function save(root: string, rows: ReviewItem[]) {
  await noLinks(root); const tmp = path.join(root, `${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
  await rename(tmp, path.join(root, "queue.json"));
}
async function snapshot(root: string): Promise<Map<string, Buffer>> {
  await noLinks(root); if (!(await lstat(root)).isDirectory()) throw new Error("Review source must be a directory");
  const result = new Map<string, Buffer>(); let total = 0, entries = 0;
  async function visit(dir: string) {
    if (path.relative(root, dir).split(path.sep).length > 32) throw new Error("Review bundle exceeds directory depth limit");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > MAX_FILES) throw new Error("Review bundle exceeds entry limit");
      if (!entry.name || /[<>:"|?*\x00-\x1f]/.test(entry.name) || /[. ]$/.test(entry.name)) throw new Error("Unsafe review filename");
      const file = path.join(dir, entry.name); await noLinks(file);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) throw new Error("Only ordinary files can be reviewed");
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let data: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES - total || result.size >= MAX_FILES) throw new Error("Review bundle exceeds limits or contains a hard link");
        const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
        while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
        data = buffer.subarray(0, offset);
        if (data.length !== stat.size || data.length > MAX_BYTES - total) throw new Error("Review file changed while reading");
      } finally { await handle.close(); }
      total += data.length; result.set(path.relative(root, file), data);
    }
  }
  await visit(root); return result;
}
function checks(files: Map<string, Buffer>) { return [...files].map(([name, data]) => ({ name, hash: hash(data), bytes: data.length })).sort((a,b) => a.name.localeCompare(b.name)); }
async function verify(item: ReviewItem) {
  if (item.stagedRoot !== path.join(stagingRoot(), item.id) || !/^[0-9a-f-]{36}$/.test(item.id)) throw new Error("Invalid staged ownership");
  const files = await snapshot(item.stagedRoot);
  if (JSON.stringify(checks(files)) !== JSON.stringify(item.files)) throw new Error("Review content changed; queue a fresh review");
  await noLinks(item.destination); return files;
}
async function writeBundle(root: string, files: Map<string, Buffer>) {
  for (const [name, data] of files) {
    const file = path.join(root, name); if (!inside(root, file)) throw new Error("Invalid bundle path");
    await noLinks(file); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: "wx", mode: 0o600 });
  }
}
export async function queueManifest(manifest: GrabbedAssetManifest, projectRoot: string): Promise<ReviewItem> {
  return locked(async root => {
    await noLinks(projectRoot); const project = await realpath(projectRoot);
    if (!(await lstat(project)).isDirectory() || project === path.parse(project).root || inside(project, root)) throw new Error("Choose a project separate from plugin settings");
    const source = path.resolve(manifest.paths.root), staging = stagingRoot();
    if (!inside(staging, source) || source === staging) throw new Error("Prepared manifest must be staged under Downloads/asset-curator-review");
    const rows = await load(root); if (rows.length >= MAX_ITEMS) throw new Error("Review queue limit reached");
    const files = await snapshot(source);
    const manifestName = path.relative(source, path.resolve(manifest.paths.manifest));
    if (!files.has(manifestName) || !inside(source, path.resolve(manifest.paths.ready))) throw new Error("Manifest paths must belong to the prepared bundle");
    if (files.has("asset-curator-review-receipt.json")) throw new Error("Reserved review receipt filename");
    for (const value of Object.values(manifest.paths)) if (value && !inside(source, path.resolve(value))) throw new Error("Manifest paths must remain within the bundle");
    const stored = JSON.parse(files.get(manifestName)!.toString("utf8"));
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) throw new Error("Prepared manifest does not match its file");
    const fingerprints = checks(files);
    if (rows.some(row => row.status !== "rejected" && JSON.stringify(row.files) === JSON.stringify(fingerprints))) throw new Error("This bundle is already queued or approved");
    const id = randomUUID(), stagedRoot = path.join(staging, id);
    const item: ReviewItem = { id, title: String(manifest.asset?.title ?? "Asset").slice(0, 200), status: "pending", stagedRoot, destination: path.join(project, "asset-curator", id, "bundle"), manifestName, files: fingerprints, createdAt: new Date().toISOString() };
    await noLinks(staging); await mkdir(staging, { recursive: true });
    const tmp = path.join(staging, `.queue-${id}`); await mkdir(tmp);
    try { await writeBundle(tmp, files); await rename(tmp, stagedRoot); await save(root, [...rows, item]); }
    finally { await rm(tmp, { recursive: true, force: true }); }
    return item;
  });
}
export async function decideQueuedAsset(id: string, decision: "approve" | "reject", approveCallback: (message: string) => Promise<boolean>): Promise<ReviewItem> {
  if (!["approve", "reject"].includes(decision)) throw new Error("Invalid review decision");
  return locked(async root => {
    const rows = await load(root), item = rows.find(row => row.id === id);
    if (!item || item.status !== "pending") throw new Error("Review item is absent or already decided");
    await verify(item);
    const fingerprint = hash(Buffer.from(JSON.stringify(item.files)));
    if (typeof approveCallback !== "function" || await approveCallback(`${decision === "approve" ? "Approve import" : "Reject and discard staged copy"} of ${JSON.stringify(item.title)}? Queue ID: ${id}. Content SHA-256: ${fingerprint}. Exact destination: ${item.destination}. Original downloads will be kept.`) !== true) throw new Error("User did not confirm the review decision");
    const files = await verify(item); // Never use bytes that changed while the user was deciding.
    if (decision === "approve") {
      const originalManifest = JSON.parse(files.get(item.manifestName)!.toString("utf8"));
      const promotedManifest = structuredClone(originalManifest);
      for (const [key, value] of Object.entries(originalManifest.paths)) {
        if (typeof value === "string") promotedManifest.paths[key] = path.join(item.destination, path.relative(originalManifest.paths.root, value));
      }
      files.set(item.manifestName, Buffer.from(JSON.stringify(promotedManifest, null, 2)));
      files.set("asset-curator-review-receipt.json", Buffer.from(JSON.stringify({ queueId: item.id, reviewedFiles: item.files, originalManifest }, null, 2)));
      const parent = path.dirname(item.destination); await noLinks(parent);
      await mkdir(path.dirname(parent), { recursive: true });
      await mkdir(parent); // Exclusive reservation: existing destinations are never overwritten.
      const tmp = path.join(parent, ".pending"); await mkdir(tmp);
      try { await writeBundle(tmp, files); await noLinks(item.destination); await rename(tmp, item.destination); }
      catch (error) { /* Leave reservation for host recovery; never delete potentially foreign files. */ throw error; }
    }
    item.status = decision === "approve" ? "approved" : "rejected";
    if (item.status === "approved") item.manifestPath = path.join(item.destination, item.manifestName);
    await save(root, rows); // Persist terminal state before cleanup; retries cannot replay approval.
    await noLinks(item.stagedRoot); await rm(item.stagedRoot, { recursive: true });
    return item;
  });
}
async function renderQueue(): Promise<{ items: ReviewItem[]; pending: number; html: string }> {
  return locked(async root => {
    const items = await load(root), pending = items.filter(item => item.status === "pending").length;
    const cards: string[] = []; let previewBudget = 8 * 1024 * 1024;
    for (const item of items) {
      let preview = "<p>Preview unavailable. Active HTML and SVG are never embedded.</p>";
      if (item.status === "pending") {
        try {
          // Preview only the bounded image; full-bundle verification happens at decision time.
          // Never re-read up to 200 entire 256 MiB bundles for a page refresh.
          const entry = item.files.find(file => /\.(png|jpe?g|webp)$/i.test(file.name) && file.bytes <= 2 * 1024 * 1024);
          if (entry) {
            const name = entry.name, target = path.join(item.stagedRoot, name);
            if (!inside(item.stagedRoot, target)) throw new Error("Invalid preview path");
            await noLinks(target);
            const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let data: Buffer;
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.nlink !== 1 || info.size !== entry.bytes) throw new Error("Preview changed");
              const buffer = Buffer.alloc(entry.bytes + 1); let offset = 0;
              while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
              data = buffer.subarray(0, offset);
              if (data.length !== entry.bytes || hash(data) !== entry.hash) throw new Error("Preview changed");
            } finally { await handle.close(); }
            const mime = data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg" : data.toString("ascii",0,4) === "RIFF" && data.toString("ascii",8,12) === "WEBP" ? "image/webp" : undefined;
            if (mime && data.length <= previewBudget) { previewBudget -= data.length; preview = `<img alt="${escape(name)}" width="240" src="data:${mime};base64,${data.toString("base64")}">`; }
          }
        } catch { preview = "<p>Content changed or unavailable. Approval is blocked.</p>"; }
      }
      cards.push(`<article><h2>${escape(item.title)}</h2>${preview}<p>${escape(item.status)} · ${item.files.length} files</p><p>Destination: ${escape(item.destination)}</p><p>Queue ID: ${escape(item.id)}</p>${item.status === "pending" ? `<form method="post" action="${uiPath}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${item.id}"><button name="decision" value="approve">Yes: request approval</button><button name="decision" value="reject">No: request discard</button></form><p>Selection: ${selections.get(item.id) ?? "none"}</p>` : ""}<p>Action intent only. Return to Hermes and ask to apply selections; host confirmation required. One selection is applied per request; repeat for remaining selections. Rejection discards only the queue-owned snapshot, preserving the prepared source and original download.</p></article>`);
    }
    return { items, pending, html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'"><title>Asset Review Queue</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f3f5f8;color:#182235;max-width:940px;margin:36px auto;padding:0 24px}h1{font-size:30px}h2{font-size:21px}article{background:white;border:1px solid #d8dfe8;border-radius:14px;padding:24px;margin:20px 0;overflow-wrap:anywhere}img{object-fit:contain;max-width:100%;max-height:280px;background:#eef1f5;border-radius:8px}button{font:inherit;border:1px solid #48658c;border-radius:8px;background:#173d70;color:white;padding:10px 16px;margin:6px 10px 6px 0;cursor:pointer}button[value=reject]{background:white;color:#173d70}p{margin:10px 0}</style></head><body><h1>Asset Review Queue</h1><p>${pending} pending</p>${cards.join("")}</body></html>` };
  });
}

// The loopback page records intentions only, never approvals or filesystem mutations.
const selections = new Map<string, "approve" | "reject">();
const uiPath = `/review/${randomBytes(24).toString("hex")}`;
const csrf = randomBytes(32).toString("hex");
let server: Server | undefined, uiUrl = "";
async function startUI(): Promise<string> {
  if (server) return uiUrl;
  server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
    try {
      if (req.headers.host !== new URL(uiUrl).host || req.url !== uiPath) { res.writeHead(404).end(); return; }
      if (req.method === "POST") {
        if (req.headers.origin !== new URL(uiUrl).origin || req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") { res.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
        const values = new URLSearchParams(body), id = values.get("id") ?? "", decision = values.get("decision");
        if (values.get("csrf") !== csrf || !/^[0-9a-f-]{36}$/.test(id) || (decision !== "approve" && decision !== "reject")) { res.writeHead(403).end(); return; }
        const queue = await renderQueue();
        if (!queue.items.some(item => item.id === id && item.status === "pending")) { res.writeHead(409).end(); return; }
        selections.set(id, decision); res.writeHead(303, { Location: uiPath }).end(); return;
      }
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      const result = await renderQueue(); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(result.html);
    } catch { res.writeHead(503).end("Queue busy or unavailable. Retry after the current review finishes."); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback UI unavailable");
    uiUrl = `http://127.0.0.1:${address.port}${uiPath}`; server.unref(); return uiUrl;
  } catch (error) { server.close(); server = undefined; throw error; }
}
export async function listQueue() {
  const queue = await renderQueue(); return { items: queue.items, pending: queue.pending, selected: selections.size, url: await startUI() };
}
export async function applyQueueSelections(approveCallback: (message: string) => Promise<boolean>) {
  const results: { id: string; status?: string; error?: string }[] = [];
  for (const [id, decision] of [...selections].slice(0, 1)) {
    selections.delete(id);
    try { const item = await decideQueuedAsset(id, decision, approveCallback); results.push({ id, status: item.status }); }
    catch (error) { results.push({ id, error: error instanceof Error ? error.message : "Review failed" }); }
  }
  return results;
}
