# Actual tool and environment inventory

Version **0.2.0** exposes **16 stdio MCP tools**, verified through real MCP
discovery in the clean npm install, portable Hermes launch and refreshed live
broker. Names below are the server's protocol names; hosts may namespace them.

| Tool | Purpose | Annotation |
| --- | --- | --- |
| get_setup | Read profile setup questions and saved completion state | Read-only |
| configure_preferences | Persist explicit license, browser and acquisition choices | Write |
| configure_classifier | Save nonsecret provider/model/endpoint choices; accepts no API key | Write |
| list_generators | Discover presets and eight authoring integrations | Read-only |
| get_generator_help | Read contracts and bundled Pixelbolt guide/schema | Read-only |
| create_generator_project | Write complete editable source; never install/run it | Write |
| render_pixel_recipe | Bounded self-contained recipe to real PNG/APNG/atlas/Godot output | Write |
| generate_asset | Deterministic sprite/VFX/PBR/GLB/WAV generation | Write |
| list_sources | Registry metadata, enabled state and priorities; not a live health claim | Read-only |
| get_settings | Active settings with credentials redacted | Read-only |
| provider_status | Metadata and optional live public probes | Non-read-only, open-world |
| search_assets | Ranked provider search and optional metadata-only classifier | Non-read-only, open-world |
| compare_results | Per-source search comparison and diagnostics | Non-read-only, open-world |
| grab_asset | Search, download/browser retrieve and prepare files | Write, open-world |
| prepare_existing_asset | Prepare a supplied local file/folder with actual rights metadata | Write |
| get_asset_manifest | Read the exact manifest filename within the safe root | Read-only |

Write-capable tools retain destructive annotations where replacement can occur.
The portable server has untrusted trust and a 180-second timeout; it does not
auto-approve host requests or expand saved acquisition/browser consent.

## Hermes registration surface

One `mcp.json` stdio server, `asset-curator`. No native `register()` entry,
hooks, middleware, Desktop extension, login backend or provider override.
Thus the catalog's native `provides_tools/hooks/middleware` arrays are empty,
as in the official portable catalog example. That does **not** mean the MCP
server has zero tools; Doctor's native registration count and MCP discovery are
separate checks.

## Optional configuration and keys

No environment key is mandatory. The plugin's Hermes extension declares nine
optional secret fields, forwarded by official profile-scoped interpolation:

- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- GEMINI_API_KEY
- DEEPSEEK_API_KEY
- OPENROUTER_API_KEY
- GROQ_API_KEY
- PARALLEL_API_KEY
- NACE_API_KEY
- ASSET_GRABBER_ADVISOR_API_KEY (custom endpoint)

Only the explicitly selected classifier is used. Calling configure_classifier
with an API provider enables network ranking for later approved searches; none
disables it. The standalone UI has an explicit ranking checkbox. Merely storing
a key causes no inference, and configuration itself makes no model call.

Optional nonsecret forwarded variables are ASSET_GRABBER_SAFE_ROOT,
ASSET_GRABBER_ADVISOR_PROVIDER, ASSET_GRABBER_ADVISOR_MODEL,
ASSET_GRABBER_ADVISOR_URL and ASSET_GRABBER_BROWSER_EXECUTABLE. The launcher gets
PLUGIN_ROOT/PLUGIN_DATA from Hermes, forces environment-only credentials and
the profile's explicit nonsecret settings path, and refuses unsafe-path bypass.
It never adopts other applications' credential stores or signed-in profiles.

All external generator projects require deliberate execution after inspection.
Bundled creation does not evaluate arbitrary supplied JavaScript or remote code.
