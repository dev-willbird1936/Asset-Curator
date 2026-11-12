# Asset Curator for Hermes

**Find a usable asset or create it from code, with policy and provenance.** This is a real local MCP application, not a prompt-only plugin: indexed catalogs, bounded downloads/extraction, optional browser retrieval, optional relevance checks, programmable pixel art, parameter synthesis and editable code projects.

Version: **0.2.5**. Compatibility target: **Hermes >=0.23.1**, Node >=20.18.1 with npm (locked Cheerio/Undici floor). Verified on Windows with Node 24.16.0 and Hermes' PM-managed Node 26.12.1; macOS/Linux were not exercised in this run. Source is readable TypeScript plus compiled plain JavaScript; no executable binaries, model weights or node_modules are committed. Catalog admission is pending. Install the exact 40-character commit named in the catalog entry; a public repository alone is not an accepted listing.

## Install (explicit once)

1. **Local development:** copy this whole directory into an empty `<active Hermes profile root>/plugins/asset-curator/`, with `plugin.json` directly inside it. Use the selected profile's data root (`HERMES_HOME` when explicitly set), not the Hermes source-install directory. Hermes 0.23.1's `plugins install` accepts catalog/Git identifiers, **not filesystem paths**. For a future published package, use `hermes plugins install dev-willbird1936/Asset-Curator#hermes/asset-curator --ref <reviewed-40-character-Git-SHA> --no-enable`; that is not a working public listing yet.
2. In that installed plugin directory, run `node setup.mjs` (Windows: `setup.bat`). This explicitly installs the reviewed npm lockfile with lifecycle scripts disabled. It does not download a browser, model, Blender, Material Maker or Remotion.
3. Enable `hermes plugins enable asset-curator`, then reload MCP or start a new session.

Run setup again after an update if dependencies are absent. Setup is never invoked by discovery/launch and never self-updates code. An incomplete install fails with the exact recovery command instead of fetching packages behind an agent's back. A developer rebuilds the local source bundle with `npm run build && node scripts/build-hermes-plugin.mjs` from the repository root; that build command is not part of installed runtime behavior.

The portable package registers one stdio server, `asset-curator`, with **untrusted** trust. Hermes asks before non-readonly asset/preference writes; unattended calls fail closed when approval is required. Explicitly enabled classifier calls can also occur during metadata searches and may incur charges: host read/write approval is not a spending policy. Choose Once/Session/Always through Hermes, never through plugin auto-approval. No hooks, middleware, tool overrides, OAuth client, login backend, telemetry or background service is registered.

## First use and agent workflow

Start with `get_setup` (Hermes shows MCP names under the server prefix). Ask the three required questions once, without guessing:
- Known project-usable licenses (`safe`) or include restrictive/unknown claims (`any`)? Neither gives legal clearance.
- Browser-assisted retrieval when direct download is unavailable?
- Existing assets, creation, or both (recommended)?

Save only the user's answers using `configure_preferences`. Optionally ask which decision/classifier provider/model they want; `configure_classifier` accepts NONSECRET provider/model only; it refuses an endpoint URL. Default is none, no API cost.

Then:
- **Existing:** search_assets -> grab_asset -> inspect actual ready/ files and manifest. Search results say how the request was read (`interpretation`), whether each result's style is confirmed by metadata (`style`), which matches need browser consent (`withheld`) and what to try when nothing fits (`nextSteps`). Pass a result's `source:id` to grab_asset as `assetId` to fetch exactly that one. "not wooden" or "no vocals" excludes those results. A request that says GLB gets one self-contained GLB where the model fits the 64 MiB repack cap.
- **3D characters and props:** KayKit (CC0) is searched directly: 903 low-poly models including rigged characters with idle, walk and attack clips. Poly Haven covers photoreal models, materials and HDRIs.
- **Create:** list_generators -> generate_asset (18 presets incl. genuine ZzFX/ZzFXM) or get_generator_help -> render_pixel_recipe for custom declarative Pixelbolt art.
- **Advanced:** create_generator_project writes complete editable source for eight libraries, never a fake rendered match. Adapt the starter, explicitly execute with an approved optional runtime, inspect actual output, then prepare_existing_asset(origin=created) with its real license/input rights.
- Keep attribution, notices, manifests and uncertainty. Metadata-only relevance is not image verification. Do not execute scripts from downloaded packs or enable Blender auto-run.

Setup also asks when the agent should use the plugin: `auto` (whenever it judges a task needs assets, the default) or `on-request` (only when you name Asset Curator or directly ask for an asset). The choice reaches tool descriptions from the next session. Setup can also record a projects folder you choose; the plugin may then save assets straight into a project inside it (pass an absolute `outputDir`). Without one, files stay in the plugin's own folder and each result says how to copy them into the project. A drive root, your whole home folder, or a folder containing the Hermes profile is refused.

When you work inside a project, `search_assets` accepts `projectPath`. The plugin reads the project's rendering code, asset files and docs (not pictures) to work out its art style. When the request names no style, results whose source declares a conflicting style are set aside in `offStyle`, and the response includes the project's colours for drawing matching sprites.

Read-only metadata tools do not need setup. Acquisition, download and creation enforce saved mode and licensing. Browser consent is never inferred from host approval.

## Optional classifier — Hermes credentials only

Select provider/model using `configure_classifier`. A custom endpoint receives the custom key, so only the user sets it: the **Optional custom classifier URL** plugin setting (`custom_url`, mapped to `ASSET_GRABBER_ADVISOR_URL`). Hermes profiles ignore any URL saved in the plugin's settings file. Enter only the selected provider key on this plugin's Hermes Settings -> Plugins page, or through Hermes' approved active-profile secret configuration. The manifest's secret fields use the normal provider names (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, PARALLEL_API_KEY, NACE_API_KEY), or ASSET_GRABBER_ADVISOR_API_KEY for custom. Keys are forwarded through the official profile-scoped MCP env route; they are not visible manifest data. Hermes reconnects changed secret launch inputs.

OpenRouter model IDs `nace-ai/drex-max`, Jev and Clef use native typed Decisions requests rather than chat. Its unversioned Drex alias is not a v1.1 guarantee (the live test reported `nace-ai/drex-max-20261016`). Select `nace`/`drex-max-v1.1` with a separate approved `NACE_API_KEY` for the pinned direct route; entitlement is required. Select `parallel`/`fast` for web-grounded decisions and call-wide citations. Typed classifiers preserve the query, batch at most eight candidate questions, handle refusals as uncertainty, and never claim pixel/file verification. Invalid/unavailable checks fall back deterministically. These routes are optional; no key/model call is needed for core use.

**Never paste keys in chat or this directory.** The launcher forces environment-only credentials, a separate nonsecret profile preference file, and no Codex/Claude subscription CLI route. No .env/auth.json/browser-profile/keychain/other-app credential store is read by the plugin. No subscription/OAuth workaround is provided. File/argument keys are ignored by API calls in this profile and key persistence/terminal key-entry is refused. Standalone Asset Curator's local-key UI is NOT this profile's credential route.

Optional advanced approved variables: ASSET_GRABBER_ADVISOR_PROVIDER/MODEL/URL can pin nonsecret classifier settings; ASSET_GRABBER_BROWSER_EXECUTABLE chooses installed Chromium; ASSET_GRABBER_SAFE_ROOT chooses an explicit asset workspace. Unset optional variables are safe. With no workspace override, assets/cache live under this profile's PLUGIN_DATA/assets and all returned paths are usable by the calling agent. The launcher refuses unsafe-path bypass. Policy preferences persist per Hermes profile, not by copying another profile's consent.

## Behavior and limitations (install disclosures)

- **Network:** contacts selected public asset/catalog/CDN services and caches public metadata. Optional selected API classifier receives bounded candidate metadata, not local files/keys; Parallel may retrieve clean public pages and returns citations. Charges vary by provider. Untrusted non-readonly calls require Hermes approval. No paid model call is required for core use.
- **Filesystem:** reads bundled source/catalogs and explicitly supplied asset files inside the configured safe root; writes prepared outputs, cache, manifests and nonsecret profile settings. Owned output is staged, foreign folders are not overwritten, changed inputs get variants, failed refreshes preserve edits. Dependencies/notices can exceed the ready-media selection cap.
- **Processes:** approved browser-assisted grabs launch a fresh owned installed Chrome/Edge context for bounded native downloads and close it. They never adopt signed-in profiles, log in, buy, solve CAPTCHAs, accept terms or bypass access controls. External generator PROJECTS are written only; this server does not secretly install or execute them. The explicit setup command invokes npm. No daemon/scheduled job.
- **Rights:** known-license filtering is conservative, not legal advice. Pixel Search's upstream/third-party rights caveats require explicit any mode. Openverse Freesound previews are labeled previews. SpriteKiln showcase media is all-rights-reserved and excluded. Remotion's optional runtime has Free/Company eligibility terms, not unconditional MIT; heavyweight optional runtimes may be absent.
- **Reliability:** actual Node generation/Pixelbolt, PixelFX torch, SpriteKiln CPU idle, direct HDRI/font/icon/Openverse/Pixel retrieval and Quaternius/Drive browser flow have local test evidence. Three heavyweight generator runtimes remain optional/unexecuted unless later verification says otherwise; do not confuse source/syntax validation with rendered media.
- **Source trust:** no runtime updater or remote executable loader. launch checks the packaged runtime snapshot; this detects mismatched local builds, not publisher authenticity. A real catalog reviewed SHA pin is still required for listing.

## Verify locally

`hermes plugins doctor /path/to/plugin --ci` and `hermes plugins validate /path/to/plugin --install-deps` use Hermes' real validation, with isolated test home for development. MCP smoke tests must also connect to launch.mjs and invoke the tools, not merely parse these manifests.

See the root README and VALIDATION.md for the checks performed and their limits. No commit, push, PR, X post or form submission is performed by this package.
