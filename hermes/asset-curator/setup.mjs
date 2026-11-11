// Explicit installation command, NEVER run by launch.mjs or plugin discovery.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.dirname(fileURLToPath(import.meta.url)),runtime=path.join(root,"runtime");
const [major,minor,patch]=process.versions.node.split(".").map(Number);
if(major<20 || (major===20 && (minor<18 || (minor===18 && patch<1)))) throw Error("Node >=20.18.1 required by the locked dependency tree");
const candidates=[process.env.npm_execpath,path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js"),path.resolve(path.dirname(process.execPath),"../lib/node_modules/npm/bin/npm-cli.js"),process.env.APPDATA&&path.join(process.env.APPDATA,"npm/node_modules/npm/bin/npm-cli.js")];
const npm=candidates.find(p=>p?.endsWith(".js")&&existsSync(p));
if(!npm) throw Error("npm CLI not found. Use npm ci --omit=dev --ignore-scripts inside runtime/ with its project .npmrc.");
const lock=JSON.parse(await readFile(path.join(runtime,"package-lock.json"),"utf8"));
if(lock.lockfileVersion!==3) throw Error("Expected reviewed v3 lockfile");
console.log("Installing only reviewed lockfile dependencies; lifecycle scripts disabled. No model/browser/heavy runtime install.");
const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>["PATH","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","SYSTEMROOT","WINDIR","COMSPEC","PATHEXT","TEMP","TMP","TMPDIR","LANG","LC_ALL","HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS"].includes(key.toUpperCase())));
execFileSync(process.execPath,[npm,"ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund","--registry=https://registry.npmjs.org/","--userconfig",path.join(runtime,".npmrc"),"--globalconfig",path.join(runtime,"npm-global.conf")],{cwd:runtime,stdio:"inherit",timeout:180000,env:safeEnv});
console.log("Dependency setup complete. Enable the plugin through Hermes; keys remain optional and Hermes-managed.");
