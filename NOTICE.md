Asset Curator MCP is maintained by dev-willbird1936.

Public Hermes distribution: https://github.com/dev-willbird1936/Asset-Curator

Code-generation integrations:
- ZzFX 1.4.0 (Frank Force, MIT), revision ac5a4727a44e5506a12f7340087e0b889cfd69dc.
- ZzFXM 2.0.3 (Keith Clark and Frank Force, MIT), revision cb07fa9ca36aefd67a0c8c656d2958b62f8ed9fe.
Their pure DSP is adapted for Node with module exports, seeded local randomness and no Web Audio/global patches. Upstream MIT notices remain in src/vendor, compiled distribution and generated packs. PCM export adds a short edge fade and peak limiter.
- Pixelbolt 0.15.0 (PixelForge contributors, MIT) is an exact pinned, zero-dependency runtime package. Its complete MIT notice is copied into rendered packs.
- SpriteKiln's bundled humanoid template/palettes/kits are CC0 1.0 by Lucas Ramos; our starter changes name, size and framing. SpriteKiln code is MIT. No all-rights-reserved showcase assets are included.
- Material Maker's bundled metal-pattern-2 .ptex example is MIT (Rodolphe Suescun and contributors); the original license is included.
- The sand3d bracket starter adapts the project's Apache-2.0 README example and changes dimensions; the Apache license is included.
- PixelFX code is MIT; the source project references reviewed revision 044e12a45dc9cc312cec50ee606dfc98afe5adc2. Its runtime is optional, not fetched or executed by project creation.
- Remotion starter code is original MIT code, but the optional Remotion runtime has its own Free/Company License, NOT an unconditional MIT license. Eligibility is required before rendering; license terms are included. No Remotion code, browser or platform binary is bundled in the starter.

Optional tool runtimes are not installed automatically. Source projects are authoring starters, not generated matches or rights clearance for arbitrary requests. Preserve actual input licenses and attribution after editing.

Pixel Search interoperability uses the public format/index from cfahlgren1/pixel-search
(https://huggingface.co/spaces/cfahlgren1/pixel-search; CC0 project metadata).
Sprites, captions and subjects originate from Angais/pixel-art-atlas-1.4m
(https://huggingface.co/datasets/Angais/pixel-art-atlas-1.4m), a synthetic CC0 dedication
to the extent Angais can waive rights; third-party rights and Krea terms are not waived.
Asset Curator keeps these sprites out of safe-license mode. Retrieval pins the Space
revision and preserves a separate catalog id, not a claimed original dataset row id.

The precomputed Space vectors derive from BAAI/bge-base-en-v1.5 and bge-large-en-v1.5
(MIT), thenlper/gte-base (MIT), sentence-transformers/all-mpnet-base-v2 (Apache-2.0)
and mixedbread-ai/mxbai-embed-large-v1 (Apache-2.0); its general vocabulary derives
from minishlab/potion-base-32M (MIT). No encoder model weights or Space fonts/logos
are bundled. The upstream notice is at:
https://huggingface.co/spaces/cfahlgren1/pixel-search/blob/main/LICENSES/NOTICE.md

Downloaded Openverse media retains the original publisher, creator, license and
attribution; Openverse indexes third-party claims and does not grant additional rights.
Audio preview encodings are labeled as previews rather than full-quality originals.
