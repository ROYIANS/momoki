# Third-party notices

Momoki's original code is licensed under the root MIT LICENSE. That license
does not replace the licenses of third-party source, datasets, assets or packages.

## Installed dependencies

Packages listed in `package.json` and the lockfile retain their own licenses,
copyright notices and any asset-specific notices distributed with those packages.
The README acknowledges the projects used by Momoki. MIT for Momoki's original
code is not a claim that every dependency uses MIT. Examples include Dexie,
TypeScript, Class Variance Authority and fake-indexeddb (Apache-2.0), Lucide (ISC),
and JSZip (MIT OR GPL-3.0-or-later). Consult the installed package's license for the
complete terms and retain the applicable notices when redistributing dependencies.

## Document parsers

- PDF.js / `pdfjs-dist` 5.4.530: https://github.com/mozilla/pdf.js — Apache-2.0.
  The browser worker, CMaps and standard fonts are shipped as local dependency assets;
  preserve the notices/licenses distributed in the package when redistributing.
- Mammoth.js 1.12.0: https://github.com/mwilliamson/mammoth.js — BSD-2-Clause.
  Used inside a local browser worker for raw DOCX text extraction.

## Models.dev model catalog

- Upstream: https://models.dev (https://github.com/anomalyco/models.dev); build-time package
  `@opencode-ai/models` 0.0.104 (MIT).
- Use: `src/lib/ai/modelCatalog/baseline.generated.json` is a compact projection of the
  pinned package snapshot. The app can also download `https://models.dev/api.json` when the
  user asks for a sync. Prices and limits are informational and may differ from a
  provider's actual billing.
- The license of the package and of the upstream repository is reproduced below.

```text
MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
