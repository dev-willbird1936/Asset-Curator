# Asset Curator for Hermes

Ask Hermes for a game asset. Get an existing file or create one from code, with licence and provenance kept.

Built by [@wb1936 on X](https://x.com/wb1936).

## Features

- **16 MCP tools** for discovery, generation, retrieval and preparation.
- **29 source channels:** 13 direct/local, 12 browser-assisted and four manual tool links. Availability and licensing vary; this is not 29 automatic download providers.
- **Rigged low-poly characters and props:** 903 CC0 KayKit models fetched per model at pinned commits, alongside Poly Haven, ambientCG, Openverse, Google Fonts and three icon sets.
- **You choose when it triggers:** setup asks whether the agent uses the plugin automatically when a task needs assets, or only when you name it or ask for an asset.
- **Saves into your project if you let it:** choose a projects folder at setup and assets land inside the project, licence files included; otherwise every result says where the files are and how to copy them.
- **Matches your project's art style:** pass the project folder, and a generic "treasure chest" in a pixel-art game no longer returns a photoreal model. Off-style matches are set aside and the project's colours are returned for drawing a matching sprite.
- **Play the comparison:** [one dungeon game built four ways](https://dev-willbird1936.github.io/Asset-Curator/), with and without the plugin.
- **Honest search:** results report how the request was read, whether the style is confirmed by metadata, which matches need browser consent, and what to try when nothing fits. "not wooden" excludes wooden results; a request with no subject returns nothing.
- **18 native presets**, custom Pixelbolt recipes, ZzFX/ZzFXM sound synthesis and eight editable authoring integrations.
- Saved per-profile licensing policy, browser consent and existing/create/both mode.
- Optional metadata classifiers. No additional model or API key is required for core retrieval/generation; Hermes itself still needs a model.
- Bounded downloads and archive handling, GLB resource repacking, staged output, licences and provenance manifests.

## Install

This is a portable Hermes plugin in [`hermes/asset-curator`](hermes/asset-curator). See its [installation and disclosure guide](hermes/asset-curator/README.md).

Catalog admission is pending, not guaranteed. Until listed, install the repository/subdirectory at the exact commit shown in the catalog PR:

```sh
hermes plugins install dev-willbird1936/Asset-Curator#hermes/asset-curator --ref <40-character-reviewed-commit> --no-enable
```

Run `node setup.mjs` in the installed plugin directory once (Windows: `setup.bat`), then `hermes plugins enable asset-curator`. Setup runs locked npm installation with lifecycle scripts disabled. No installation occurs at launch.

Requires Hermes >=0.23.1 and Node >=20.18.1/npm. Windows verified; macOS/Linux not yet tested.

## Verification and honest limits

Version 0.2.5. The development suite passes 20 test programs. A live quality pass ran 44 edge-case searches, 18 end-to-end grabs and 10 checks through the installed package; see VALIDATION.md. Hermes 0.23.1 Doctor, actual 16-tool MCP discovery, normal write denial and restart recovery passed in an isolated profile.

Sixteen real Hermes requests produced seven visually matched results, three partial matches, three unlistened audio outputs and three unfulfilled requests. One authentication interruption was continued separately and retained; these are not statistical quality estimates. The new barrel preset was additionally generated and rendered outside that frozen cohort.

No hand-drawn/anime/watercolour generation is claimed. A generated project is not a rendered asset. sand3d, Material Maker and Remotion runtime execution remains unverified. Metadata is not visual or legal proof. Licence filtering is not legal clearance.

## Security and source

The plugin's MCP server is untrusted. It does not auto-approve writes or read another application's credential store. Optional keys enter through Hermes' profile-scoped secret configuration. Browser retrieval uses a fresh installed browser context and stops at login, CAPTCHA, payment and terms gates.

All runtime TypeScript and plain JavaScript are reviewable. No model weights, executable binaries, private histories, credentials or node_modules are included. No telemetry or self-update mechanism.

See [security reporting](SECURITY.md), [tool inventory](TOOL-INVENTORY.md) and [third-party notices](NOTICE.md). MIT for the original code; upstream components retain their own notices.
