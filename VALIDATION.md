# Release validation

Version 0.2.3. Hermes 0.23.1, Windows, Node 24. Run on 11 and 12 November 2026.

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

## Four-way game comparison

The same dungeon-game brief was run in Hermes with no plugin, existing-only, create-only and both. All four returned a playable page that an automated keyboard playthrough won without console errors. Play them at https://dev-willbird1936.github.io/Asset-Curator/. The create-only run shown is a second run after a test-harness fault. The plugin ran version 0.2.1 for these.

## Limits

- Style evidence is metadata only. Nothing inspects pixels; a result marked "unconfirmed" may or may not match.
- Painterly, watercolour and anime art has no reliable licensed source or generator here; such requests are flagged, not fulfilled.
- Typos and non-English subject words are not corrected; they return no direct result.
- Kenney packs need the consented browser route; that route was not re-tested in this pass.
- Openverse is rate-limited for anonymous use (20 requests a minute, 200 a day).
- Audio was not auditioned. macOS and Linux are untested. Catalog acceptance is not guaranteed.
