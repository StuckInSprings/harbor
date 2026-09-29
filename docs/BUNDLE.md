# Bundle

`npm run dist` produces `dist/mac-arm64/Harbor.app`. It is 310MB, and roughly
three quarters of that is Chromium, which is the price of Electron and cannot
be trimmed from outside a custom build.

| part | size | what it is |
| --- | --- | --- |
| Electron Framework | 238M | Chromium + Node. 193M is the framework binary. |
| `app.asar.unpacked` | 52M | Native modules: ONNX runtime 34M, libvips 15M, better-sqlite3 2M. |
| `app.asar` | 17M | Harbor's own code and its JavaScript dependencies. |

## What is excluded, and why it is safe

The exclusions live in `build.files` in `package.json`. Each was verified by
removing the module and running the code that would have needed it, rather
than by reading a dependency graph.

- **`onnxruntime-web` (130M)** — WebAssembly builds of ONNX Runtime, for
  browsers. Harbor runs ONNX natively through `onnxruntime-node`. It arrives
  only as a transitive dependency of transformers.js, whose Node build
  mentions it in CDN URL strings and never imports it. Verified: embeddings
  produce identical output with the package absent.
- **`better-sqlite3/deps`, `/src`, `/build` (10M)** — the SQLite amalgamation
  and the addon's C++ source, needed to compile the module, not to load it.
  The prebuilt `.node` in `prebuilds/` is what runs. Verified: the database
  suites pass with all three directories removed.
- **Locales other than English (47M)** — 220 `.lproj` folders shipped by
  default, via `electronLanguages`. Harbor's interface is English only.
- **Every other platform's native binaries** — Linux and Windows builds of
  ONNX Runtime, better-sqlite3, sharp and sqlite-vec, plus the x64 slices.
  This is a macOS arm64 app.

## What cannot be cut

- **`@img/sharp-libvips` (15M)** — image decoding. Harbor only embeds text,
  but `transformers.node.mjs` imports sharp eagerly at module load, so
  removing it fails the import outright. Escaping it means dropping
  transformers.js and driving `onnxruntime-node` with a tokenizer directly.
- **`libonnxruntime.dylib` (34M)** — local embeddings. This is the cost of the
  knowledge index working offline and sending nothing to a second provider.
- **`libvk_swiftshader.dylib` (16M)** — Chromium's software renderer, used
  when GPU initialisation fails. Deletable in an `afterPack` hook, at the
  price of a hard failure on any machine that needs the fallback.

## Not in the bundle, but on disk

The embedding model is downloaded on first use and cached under
`~/Library/Application Support/harbor-showroom/models`. At `fp32` it is 128M. The `q8`
variant is about a quarter of that, but switching would invalidate every
vector already indexed.
