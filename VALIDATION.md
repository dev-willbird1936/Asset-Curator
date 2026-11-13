# Release validation

Version 0.2.6. Hermes 0.23.1, Windows, Node 24. Run on 11 and 12 November 2026.

## Package checks

- `hermes plugins doctor <package> --ci` and `hermes plugins validate <package>` pass; **security scan: safe**; the MCP server is **untrusted**.
- A fresh profile discovers 16 MCP tools; headless write denial and restart recovery pass.
- 19 development test programs pass. `npm audit --omit=dev` reports no vulnerabilities.
- All 87 runtime files match the SHA-256 entries in `BUILD.json`.

## Routing and output quality pass (live, classifier off, safe licence, browser off)

| Check | Result |
| --- | --- |
| Edge-case searches: art styles, negation, long and role-play prompts, injection text, typos, non-English, emoji, quoted titles | 44 of 44 as expected (11 of 30 before the fixes) |
| End-to-end grabs: download or generate, prepare, inspect file facts | 18 of 18 as expected |
| Same behaviour through the installed package over MCP | 10 of 10 |

"As expected" includes honest failures: nonsense, subjectless and unanswerable requests must return nothing. Examples of delivered files: a rigged KayKit knight with 76 animation clips, a Poly Haven barrel as one self-contained GLB, a blackletter font with its licence, an exact `heart.svg`.

## Trigger choice (0.2.2, live Hermes conversations, Sonnet 5.5 requested)

One fresh profile and conversation per case; two judgement-call cases are not graded. The main run gave the agent Hermes' file and skills tools and a small Three.js project as its working folder.

| Mode | Should use the plugin | Should leave it alone |
| --- | --- | --- |
| on-request | 4 of 4 (named plugin, "find me", "generate", named mid-task) | 4 of 4 (game build, title screen, bug fix, advice) |
| auto | 5 of 5 (game build in English and Spanish, title music and font, icons, video sound effect) | 5 of 5 (bug fix, explanation, pitch, refactor, "don't use plugins") |

- The two game builds ("write the main game file", which never mentions assets) triggered in all three realistic runs of each.
- An earlier run without file tools scored 16 of 18. Unable to save files, the agent pasted self-contained code and skipped assets for both game builds.
- In these trigger runs a test-harness fault declined each conversation's first write-capable call. Grading counts attempted calls, so the verdicts stand. The fault was fixed for the end-to-end runs below.

End to end in auto mode (0.2.2), the agent searched for, downloaded and generated assets for both game builds, then wrote the game, but the files stayed in the plugin's own asset folder. The plugin writes only inside that folder by default, and the test agent had no terminal to copy them, so neither game loaded them.

0.2.3 adds an optional projects folder chosen at setup, an accurate `outputDir` description and a copy hint in every result. With the folder set, both game builds saved their assets (a KayKit car; Mixkit sounds and a generated crate) into `public/assets` inside the project with their licence files, and every asset path in the written `main.js` points to an existing file. The games were not run in a browser. The full 20-case suite on 0.2.3 again passed 18 of 18 graded cases.

One conversation per case is not a statistic. Other models were not tested.

## Project art style (0.2.4)

Tested on four existing 2D pixel-art browser games whose art is drawn in code. The project reader classified all four as 2D pixel art from their rendering code and sprite tooling.

Generic searches in one of them (Stormshrine), live, safe licences:

| Request | Without projectPath | With projectPath |
| --- | --- | --- |
| treasure chest, sword | Photoreal Poly Haven and low-poly KayKit models, no warning | Set aside in `offStyle`; "nothing in a matching style" |
| health pickup icon | Vector Game-icons, no warning | Set aside; pointed to drawing a pixel sprite |
| stone floor texture | Photoreal Poly Haven textures | Set aside; only an unconfirmed procedural texture left |
| explosion effect | Procedural pixel burst | Procedural pixel burst, style confirmed |

A style named in the request still wins: "photoreal stone floor texture" in the pixel game returns Poly Haven floors. Since 0.2.6 a named style also sets aside declared conflicts: "pixel art stone floor texture" set aside 4 photoreal floors, and "photorealistic wooden barrel" set aside 4 non-photoreal results. In a small low-poly Three.js project, KayKit chests and skeletons were kept and photoreal results set aside.

In 11 live Hermes sessions on copies of the games (auto mode, generic prompts such as "add a new enemy with its own art"), the agent never downloaded an off-style asset. It drew pixel sprites with the pixel generator or extended the project's own code-drawn art, and in one case followed the project's own "no downloaded files" rule. Asked to "find" a chest or a floor texture, it passed `projectPath`, found nothing in pixel style under safe licences, and drew one in the game's colours. The generated sprites match the games' pixel medium; they are simpler and less shaded than the games' best art.

Limits: the reader uses code, files and docs only, never pixels. Style labels come from source metadata. Under safe licences there is no downloadable pixel-art sprite source; Pixel Search needs the any-licence setting.

## Four-way game comparison

The same dungeon-game brief was run in Hermes with no plugin, existing-only, create-only and both. All four returned a playable page that an automated keyboard playthrough won without console errors. Play them at https://dev-willbird1936.github.io/Asset-Curator/. The create-only run shown is a second run after a test-harness fault. The plugin ran version 0.2.1 for these.

## Limits

- Style evidence is metadata only. Nothing inspects pixels; a result marked "unconfirmed" may or may not match.
- Painterly, watercolour and anime art has no reliable licensed source or generator here; such requests are flagged, not fulfilled.
- Typos and non-English subject words are not corrected; they return no direct result.
- Kenney packs need the consented browser route; that route was not re-tested in this pass.
- Openverse is rate-limited for anonymous use (20 requests a minute, 200 a day).
- Audio was not auditioned. macOS and Linux are untested. Catalog acceptance is not guaranteed.

## Permission modes and Asset Review Queue (0.3.0)

13 November 2026, isolated cloud Linux profile / Node 24. This revision changes permission routing and adds three review tools; historical creative-quality results above are not a rerun of 0.3.0.

From `hermes/asset-curator/runtime`:

- `npm run check`: strict TypeScript check passed.
- `npm run test:access`: all five test programs passed.
  - `access-boundary.mjs`: model scope-change rejection, legacy migration, environment settings, project traversal/symlink limits and revocation.
  - `downloads-import.mjs`: real MCP import of a self-created CC0 SVG from Downloads to project/asset-curator; exact bytes, licence pointer, manifest read-back and prepared-file reuse; original retained, unauthorized writes/escape denied.
  - `host-approval.mjs`: MCP form accept/decline/cancel/missing capability; forged approved flag ignored; exact scoped destination; saved mode unchanged; each exception asks again; cancellation with a late accept causes no file write; Hermes-managed/full/project paths exercised.
  - `review-queue.mjs`: content hashes before/after consent, link and overwrite rejection, replay/concurrency, provenance, safe HTML, CSRF/origin checks, one selected decision per invocation, retained original downloads.
  - `review-mcp.mjs`: all 19 tools discovered through the packaged launcher; PNG preview/pending count; HTML Yes/No only stages intent; host-confirmed import; rebased readable manifest and exact usable file bytes; decline/rejection; original retained.
- Current Hermes source was checked for MCP form elicitation and trust-gating semantics, including compatibility in v0.23.1. No filesystem-sandbox inheritance is claimed.

Fresh Hermes integration passed on Hermes commit `6b3697105770eb473836e020633e4a8e1a274577`, Python 3.14.9, MCP SDK 2.3.0 and Node 26.12.1:

- Installed/enabled a disposable immutable local Git snapshot through the real plugin manager; explicit locked dependency setup completed.
- CLI Doctor and Validate passed with no findings; all 98 installed runtime hashes matched BUILD.json.
- All 19 tools were discovered through actual Hermes MCP transport.
- Real untrusted-tool gating, ElicitationHandler and approval router exercised all five modes. Only human CLI answers were simulated. Decline/cancel blocked writes; forged flags did nothing; accepted exceptions stayed one-off; saved no mode remained unchanged.
- Project mode wrote to default/custom workspace destinations; an external destination required approval.
- Review HTML selection made no project changes. Host decline blocked promotion; host acceptance produced usable PNG bytes and a rebased, readable manifest, preserving original downloads.
- Hermes' own elicitation/trust-gating/approval-scope suites passed 33 tests.
- Forced reinstall removed Node dependencies: launch failed closed with the documented setup instruction and no hidden install. Explicit setup then restored the plugin.

 Tests simulate human choices only at the approval UI seam; they do not impersonate a real owner's approval. HTML HTTP/form tests passed, including PNG embedding, pending count and both intent-only buttons. Real Chromium rendering was blocked by the test environment denying required sockets; no screenshots or visual/responsive pass is claimed. A viewport declaration is included. Windows/macOS regression, live provider retrieval and creative-quality testing are not claimed for this revision.
