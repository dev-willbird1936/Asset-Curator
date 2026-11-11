import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { extractZip } from "./archive.js";
import { assertAcquisitionAllowed } from "./settings.js";
import type { AssetGrabberSettings, AssetSearchResult } from "./types.js";

export type BrowserTrace = { used: true; engine: "installed-chromium"; visitedHosts: string[]; actions: string[]; fileName: string; bytes: number; licenseConfirmed: boolean };
type Limits = Pick<AssetGrabberSettings["search"], "maxDownloadBytes" | "maxExtractedBytes" | "maxExtractedFiles">;
// No anti-detection switches, peer-profile adoption, credential reads or CAPTCHA solvers.
const DOWNLOAD_HOSTS = ["google.com", "googleusercontent.com", "gstatic.com", "googleapis.com", "dropbox.com", "dropboxusercontent.com", "itch.io", "itch.zone", "hwcdn.net", "github.com", "githubusercontent.com"];
export const FREE_DOWNLOAD_ALTERNATIVE = /(?:no thanks,? just take me to (?:the )?downloads|continue without donating(?:[.\u2026]*))/i;
const DATA_FORMATS = new Set(["zip", "glb", "gltf", "fbx", "obj", "blend", "mtl", "png", "jpg", "jpeg", "webp", "svg", "wav", "ogg", "mp3", "flac", "m4a", "ttf", "otf", "woff", "woff2", "hdr", "exr"]);

function privateAddress(ip: string): boolean {
  if (ip.includes(":")) return /^(::|fc|fd|fe[89ab])/i.test(ip) || /^::ffff:/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224;
}

export async function assertBrowserUrl(value: string, allowedHosts: string[], trustedLocalOrigin?: string): Promise<URL> {
  const url = new URL(value);
  if (trustedLocalOrigin && url.origin === trustedLocalOrigin && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password) return url;
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("Browser retrieval requires public HTTPS URLs without credentials");
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) throw new Error(`Browser host is not approved for this asset: ${host}`);
  if (host === "localhost" || host.endsWith(".local") || isIP(host.replace(/^\[|\]$/g, "")) && privateAddress(host.replace(/^\[|\]$/g, ""))) throw new Error("Private browser destinations are refused");
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((address) => privateAddress(address.address))) throw new Error("Private browser destinations are refused");
  return url;
}

export function browserGate(text: string, facts: { password?: boolean; captcha?: boolean; card?: boolean; terms?: boolean; freeAlternative?: boolean } = {}): string | undefined {
  if (facts.captcha || /(?:verify (?:that )?you are human|complete the captcha|captcha required|checking your browser|just a moment[.!]?\s*$)/i.test(text)) return "CAPTCHA or browser challenge requires user review";
  if (facts.password || /(?:sign in|log ?in) (?:is required|to download)|you must (?:sign in|log ?in)/i.test(text)) return "Login is required";
  if (!facts.freeAlternative && (facts.card || /(?:payment required|purchase required|buy (?:this|the) (?:asset|pack) to download)/i.test(text))) return "Payment is required";
  if (facts.terms || /(?:must|need to) (?:accept|agree to) (?:the )?(?:terms|license)/i.test(text)) return "Explicit terms acceptance is required";
  if (/virus scan warning|cannot scan this file for viruses/i.test(text)) return "Download safety warning requires user review";
  return undefined;
}

async function gateOn(page: Page): Promise<{ gate?: string; text: string; links: string[] }> {
  if (["accounts.google.com", "login.microsoftonline.com", "login.live.com"].includes(new URL(page.url()).hostname)) return { gate: "Login is required", text: "", links: [] };
  const facts = await page.evaluate(() => {
    const visible = ['input[type="password"]', 'iframe[src*="captcha"], [data-sitekey]', 'input[autocomplete="cc-number"], iframe[src*="checkout"]'].map((selector) => [...document.querySelectorAll(selector)].some((el) => {
      const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
    }));
    const text = (document.body?.innerText ?? "").slice(0, 14000);
    const terms = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some((input) => {
      const box = input.getBoundingClientRect();
      return !input.checked && box.width > 0 && box.height > 0 && /(?:agree|accept).*(?:terms|license)/i.test(input.closest("label")?.textContent || input.getAttribute("aria-label") || "");
    });
    return { text, links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.href), password: visible[0], captcha: visible[1], card: visible[2], terms, freeAlternative: /(?:no thanks,? just take me to (?:the )?downloads|continue without donating)/i.test(text) };
  });
  return { gate: browserGate(facts.text, facts), text: facts.text, links: facts.links };
}

function confirmsLicense(asset: AssetSearchResult, text: string, links: string[]): boolean {
  const license = asset.license.toLowerCase();
  if (license.includes("cc0") || license.includes("public domain")) return /\bcc0\b|public domain|creative commons zero/i.test(text) || links.some((url) => /creativecommons\.org\/publicdomain\/(?:zero|mark)\//i.test(url));
  if (/cc by|creative commons attribution/i.test(license)) return /cc[ -]?by|creative commons attribution/i.test(text) || links.some((url) => /creativecommons\.org\/licenses\/by\//i.test(url));
  if (/\b(mit|isc|ofl|apache)\b/i.test(license)) return /\b(mit|isc|ofl|apache)\b/i.test(text) && /license/i.test(text);
  return false;
}

async function launchOwnedBrowser(): Promise<Browser> {
  const executablePath = process.env.ASSET_GRABBER_BROWSER_EXECUTABLE;
  if (executablePath) return chromium.launch({ executablePath, headless: true });
  for (const channel of process.platform === "win32" ? ["chrome", "msedge"] : ["chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* Do not install a browser or attach to a user's session. */ }
  }
  throw new Error("Browser assistance needs installed Chrome (or Edge on Windows). Set ASSET_GRABBER_BROWSER_EXECUTABLE for an installed Chromium executable; no browser is downloaded automatically.");
}

export async function materializeBrowserAsset(
  asset: AssetSearchResult,
  archivePath: string,
  packDir: string,
  settings: AssetGrabberSettings
): Promise<{ files: string[]; archiveWritten: boolean; browser: BrowserTrace }> {
  assertAcquisitionAllowed(settings, "existing");
  if (!settings.preferences.browserEnabled) throw new Error("Browser assistance is disabled by saved user preferences");
  const limits: Limits = settings.search;
  const initial = new URL(asset.url);
  // An owner-configured local gallery is an explicit source, not a page-provided redirect exception.
  const configuredLocal = settings.customSources.find((source) => source.enabled && asset.source === "custom:" + source.id && new URL(source.url).origin === initial.origin);
  const trustedLocalOrigin = configuredLocal && ["127.0.0.1", "localhost", "[::1]"].includes(initial.hostname) ? initial.origin : undefined;
  const host = initial.hostname;
  const allowedHosts = [...new Set([host, ...DOWNLOAD_HOSTS, ...[asset.downloadUrl, ...(asset.downloadUrls?.map((file) => file.url) ?? [])].filter((url): url is string => Boolean(url)).map((url) => new URL(url).hostname)])];
  await assertBrowserUrl(asset.url, allowedHosts, trustedLocalOrigin);
  await mkdir(packDir, { recursive: true });
  const downloadDir = await mkdtemp(path.join(path.dirname(packDir), ".dl-"));
  let browser: Browser | undefined, timer: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined;
  const visited = new Set<string>(), blockedHosts = new Set<string>(), actions: string[] = [];
  let rejectDownload!: (error: Error) => void;
  const fail = (reason: string) => rejectDownload(new Error(`Browser assistance stopped: ${reason}`));
  let completed = false, started = false, guid = "", fileName = "", licenseConfirmed = false;
  let downloadDestination: Promise<URL> | undefined;
  try {
    browser = await launchOwnedBrowser();
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1365, height: 900 }, serviceWorkers: "block" });
    let page = await context.newPage(), popup: Page | undefined;
    context.on("page", (newPage) => { if (newPage !== page) popup = newPage; });
    const cdp = await browser.newBrowserCDPSession(), pageCdp = await context.newCDPSession(page);
    const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
    const browserContextId = targetInfo.browserContextId;
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId, downloadPath: downloadDir, eventsEnabled: true });
    let resolveDownload!: () => void;
    const download = new Promise<void>((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; });
    // A download can fail while a navigation is settling; always observe its rejection.
    download.catch(() => {});
    const checks = new Map<string, Promise<URL>>();
    const validate = (url: string) => {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || !["https:", "http:"].includes(parsed.protocol)) return Promise.reject(new Error("Browser URL must not contain credentials or non-web schemes"));
      const origin = parsed.origin;
      if (!checks.has(origin)) checks.set(origin, assertBrowserUrl(url, allowedHosts, trustedLocalOrigin));
      return checks.get(origin)!;
    };
    await context.route("**/*", async (route) => {
      try {
        await validate(route.request().url());
        if (["media", "font"].includes(route.request().resourceType())) return route.abort();
        await route.continue();
      } catch { blockedHosts.add(new URL(route.request().url()).hostname); await route.abort().catch(() => {}); }
    });
    cdp.on("Browser.downloadWillBegin", (event) => {
      if (started) { void cdp.send("Browser.cancelDownload", { guid: event.guid, browserContextId }).catch(() => {}); return; }
      started = true; guid = event.guid;
      fileName = path.basename(event.suggestedFilename.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160);
      const extension = path.extname(fileName).slice(1).toLowerCase();
      if (!/^[a-f0-9-]{36}$/i.test(guid) || !DATA_FORMATS.has(extension)) {
        fail("Unsupported or executable download type; only data assets are allowed");
        void cdp.send("Browser.cancelDownload", { guid, browserContextId }).catch(() => {});
        return;
      }
      downloadDestination = validate(event.url);
      void downloadDestination.then((url) => visited.add(url.hostname)).catch(() => {
        fail("Download destination is outside approved public hosts");
        void cdp.send("Browser.cancelDownload", { guid, browserContextId }).catch(() => {});
      });
    });
    cdp.on("Browser.downloadProgress", (event) => {
      if (event.guid !== guid) return;
      if (event.totalBytes > limits.maxDownloadBytes || event.receivedBytes > limits.maxDownloadBytes) {
        fail(`Download exceeds max bytes (${limits.maxDownloadBytes})`);
        void cdp.send("Browser.cancelDownload", { guid, browserContextId }).catch(() => {});
      } else if (event.state === "completed") { completed = true; resolveDownload(); }
      else if (event.state === "canceled") fail("Download canceled or interrupted");
    });
    poll = setInterval(() => {
      if (!guid || completed) return;
      void stat(path.join(downloadDir, `${guid}.crdownload`)).then((info) => {
        if (info.size > limits.maxDownloadBytes) { fail("Download exceeds max bytes"); void cdp.send("Browser.cancelDownload", { guid, browserContextId }).catch(() => {}); }
      }).catch(() => {});
    }, 100);
    timer = setTimeout(() => { fail("Bounded browser operation timed out"); void browser?.close(); }, 90_000);
    const navigate = async (url: string) => {
      const parsed = await validate(url); visited.add(parsed.hostname);
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }); }
      catch (error) { if (!/ERR_ABORTED|Download is starting/.test(String(error))) throw error; }
    };
    await navigate(asset.url); actions.push("opened original asset page");
    const followed = new Set<string>();
    for (let step = 0; step < 6 && !completed; step++) {
      if (started) { await download; break; }
      await page.waitForTimeout(350);
      const facts = await gateOn(page);
      if (facts.gate) throw new Error(`Browser assistance stopped: ${facts.gate}`);
      licenseConfirmed ||= confirmsLicense(asset, facts.text, facts.links);
      if (settings.preferences.licensePolicy === "safe" && !licenseConfirmed) throw new Error("Browser assistance stopped: known project-usable license could not be confirmed on the original source page");
      const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => ({ href: (anchor as HTMLAnchorElement).href, label: ((anchor.textContent || "").trim() || anchor.getAttribute("aria-label") || anchor.querySelector("img")?.getAttribute("alt") || "").trim().replace(/\s+/g, " "), download: anchor.hasAttribute("download"), interactive: anchor.hasAttribute("onclick") || anchor.hasAttribute("data-lity") || (anchor.getAttribute("href") || "").startsWith("#"), visible: anchor.getBoundingClientRect().width > 0 && anchor.getBoundingClientRect().height > 0 && getComputedStyle(anchor).visibility !== "hidden" })));
      const ranked = links.filter(link => link.visible).map((link) => ({ ...link, score: /\.(zip|glb|fbx|obj|png|wav|mp3|hdr|exr)(?:[?#]|$)/i.test(link.href) && (/download|\.zip|\.glb|\.fbx/i.test(link.label) || link.download) ? 10 : FREE_DOWNLOAD_ALTERNATIVE.test(link.label) ? 9 : /^download(?: (?:now|free|here|zip))?$/i.test(link.label) ? 7 : /drive\.google\.com\/(?:file|uc|drive\/folders)|dropbox\.com/i.test(link.href) ? 6 : 0 })).filter((link) => link.score).sort((a, b) => b.score - a.score);
      const link = ranked.find((link) => /^https?:\/\//.test(link.href) && !followed.has(link.href));
      if (link) {
        followed.add(link.href);
        await validate(link.href); actions.push(`followed public download link (${step + 1})`);
        const target = new URL(link.href), current = new URL(page.url());
        if (link.interactive || target.hash && target.origin === current.origin && target.pathname === current.pathname) {
          await page.getByRole("link", { name: link.label, exact: true }).filter({ visible: true }).last().click({ timeout: 5000 });
        } else await navigate(link.href);
      } else {
        const controlName = /^(?:download(?: (?:now|free|zip|all))?|free download|no thanks,? just take me to (?:the )?downloads|continue without donating[.\u2026]*)$/i;
        const buttons = page.getByRole("button", { name: controlName }).filter({ visible: true });
        const links = page.getByRole("link", { name: controlName }).filter({ visible: true });
        await buttons.or(links).first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
        const button = await buttons.count() ? buttons.last() : links.last();
        if (!await button.count()) {
          const controls = await page.locator('button,[role="button"]').evaluateAll((elements) => elements.map((element) => (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 60)).filter(Boolean).slice(0, 8));
          throw new Error("Browser assistance stopped: no supported public download control at " + new URL(page.url()).hostname + "; actions: " + actions.join("; ") + "; available controls: " + controls.join(", ") + "; blocked hosts: " + [...blockedHosts].slice(0, 8).join(", "));
        }
        const label = (await button.innerText()).trim();
        actions.push(`clicked ${label.slice(0, 70)}`);
        await button.click({ timeout: 5000 });
        if (/^download all$/i.test(label) || /^download$/i.test(label) && page.url().startsWith("https://drive.google.com/drive/folders/")) {
          // Folder archives are prepared asynchronously. Do not click repeatedly.
          while (!started) {
            await Promise.race([download, page.waitForTimeout(750)]);
            if (!started) {
              const status = await gateOn(page);
              if (status.gate) throw new Error("Browser assistance stopped: " + status.gate);
            }
          }
          await download;
        }
      }
      await Promise.race([download, page.waitForTimeout(900)]);
      if (popup) {
        page = popup; popup = undefined;
        await Promise.race([download, page.waitForURL((url) => url.protocol === "https:" || url.origin === trustedLocalOrigin, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {})]);
        if (!page.isClosed() && /^https?:/.test(page.url())) visited.add((await validate(page.url())).hostname);
      }
    }
    if (!completed) { if (started) await download; else throw new Error("Browser assistance stopped: navigation budget exhausted"); }
    if (!downloadDestination) throw new Error("Browser download destination was not verified");
    await downloadDestination;
    if (settings.preferences.licensePolicy === "safe" && !licenseConfirmed) throw new Error("Browser assistance stopped: source-page license confirmation is missing");
    const downloaded = path.join(downloadDir, guid), info = await stat(downloaded);
    if (info.size > limits.maxDownloadBytes || !info.size) throw new Error("Browser download is empty or exceeds max bytes");
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const target = extension === "zip" ? archivePath : path.join(packDir, fileName);
    await rename(downloaded, target);
    const files = extension === "zip" ? await extractZip(target, packDir, { maxBytes: limits.maxExtractedBytes, maxFiles: limits.maxExtractedFiles }) : [target];
    return { files, archiveWritten: extension === "zip", browser: { used: true, engine: "installed-chromium", visitedHosts: [...visited], actions, fileName, bytes: info.size, licenseConfirmed } };
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    await browser?.close().catch(() => {});
    await rm(downloadDir, { recursive: true, force: true });
  }
}
