# Bundled Bun runtime notices

The standalone Storm CLI bundles the official Bun runtime `1.3.12` (revision `700fc117a2fd01ac0201deaa6fa69c5557acb04f`). `BUN-LICENSE.md` is the verbatim upstream `LICENSE.md` from that tag; it identifies Bun's MIT license, statically linked JavaScriptCore/WebKit under LGPL-2, linked libraries, and embedded polyfills.

Sources:

- <https://github.com/oven-sh/bun/blob/bun-v1.3.12/LICENSE.md>
- <https://github.com/oven-sh/bun/blob/bun-v1.3.12/docs/project/license.mdx>
- <https://github.com/oven-sh/bun/tree/bun-v1.3.12>

**Scope note:** Upstream's license page lists third-party components and license families but does not include all the individual third-party license texts/notices. This directory preserves that upstream notice as published; it is not a complete independently verified third-party notice bundle or a representation of full redistribution compliance. In particular, upstream notes LGPL-covered static components and requirements related to relinking. Review applicable component materials and compliance obligations before distributing the CLI beyond private self-use. Recheck this metadata and associated notices whenever the bundled Bun runtime version changes.
