import { access, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [major,minor,patch]=process.versions.node.split(".").map(Number);
if(major<20 || (major===20 && (minor<18 || (minor===18 && patch<1)))) throw Error("Node >=20.18.1 required by the locked dependency tree");
const root=path.dirname(fileURLToPath(import.meta.url)),data=process.env.PLUGIN_DATA;
if (!data || !path.isAbsolute(data)) throw Error("Hermes must provide an absolute profile-scoped PLUGIN_DATA; no fallback to other stores");
const build=JSON.parse(await readFile(path.join(root,"BUILD.json"),"utf8"));
for (const [name,expected] of Object.entries(build.files)) {
 const bytes=await readFile(path.join(root,"runtime",name));
 if(createHash("sha256").update(bytes).digest("hex")!==expected) throw Error("Runtime source differs from its local build manifest; rebuild/review the package, not a remote updater");
}
try { await access(path.join(root,"runtime","node_modules","@modelcontextprotocol","sdk","package.json")); }
catch { throw Error("Locked Node dependencies are not installed. Run the approved one-time command: node "+path.join(root,"setup.mjs")+". No runtime auto-install was attempted."); }
const configured=process.env.ASSET_GRABBER_SAFE_ROOT;
const workspace=configured && !configured.startsWith("${") ? path.resolve(configured) : path.join(data,"assets");
await mkdir(workspace,{recursive:true});
process.chdir(workspace);
process.env.ASSET_GRABBER_SAFE_ROOT=workspace;
process.env.ASSET_GRABBER_ALLOW_UNSAFE_PATHS="0";
process.env.ASSET_GRABBER_CREDENTIAL_MODE="environment";
process.env.ASSET_GRABBER_SETTINGS_PATH=path.join(data,"preferences.json");
for(const [name,value] of Object.entries(process.env)) if(value?.startsWith("${") && value.endsWith("}")) delete process.env[name];
await import(pathToFileURL(path.join(root,"runtime","lib","index.js")).href);
