# Native application icons

These resources are derived from the committed, owner-approved opaque tile
`apps/desktop/assets/app-icon-cream-1024.png`: 1024×1024, fully opaque, full-bleed
cream `#F4F0E8` with the frog character and no black disc. Native `source.png`,
the PNG set and `icon.icns` carry those exact pixels (re-encoded as PNG). The
generator does not resize, crop or redraw that tile. macOS applies its own
squircle, so those files stay square. Windows does not, so each `icon.ico` frame
is masked with a rounded rectangle whose radius is 0.2237 of that frame's side;
the four corners are transparent and the straight edges stay cream. The Web logo
(`public/brand/logo.webp`) is a separate transparent asset and is not a native
input; Web branding is never edited to fix the native tile.

The bundle already references `icon.png` and `icon.icns` in `tauri.conf.json`.
The PNG is the Tauri standard 512×512 output. Additional PNGs cover 16, 32, 64, 128
and 256 pixels; ICNS covers macOS resolutions through 1024 pixels; ICO covers
desktop Windows sizes. Mobile and Microsoft Store resources emitted by the CLI
are discarded instead of being checked in.

Regenerate from the repository root with Python + Pillow and the pinned local
Tauri CLI. The recorded versions are Pillow 12.3.0 and `@tauri-apps/cli` 2.12.1.
Use the local machine pnpm executable; do not use the Codex Runtime pnpm:

```sh
python3 apps/desktop/scripts/generate-native-icons.py \
  --pnpm /Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/pnpm
python3 apps/desktop/scripts/generate-native-icons.py --check
```

If the system Python has no Pillow, use an existing Python environment that
provides the recorded Pillow version. Regeneration adds no runtime dependency
to the product. The script validates the tile at 1024 pixels without upscaling a
favicon, runs the pinned CLI in a temporary directory, validates the complete desktop
set, then installs only those reviewed resources. ICNS member order is sorted
by tag because the CLI uses hash-map iteration; member image bytes are retained
unchanged. ICNS retains the repository's original modern PNG member set (`ic07`–`ic14`, 32–1024 physical pixels,
including 16pt at 2×). Small legacy
RGB/alpha entries are omitted: macOS `iconutil` emits incorrect blue-channel
corner bytes from them despite Pillow decoding correctly, and the same issue
also reproduces with Apple's own iconset compiler. The retained PNG members
match on both decoders. Independent 16/32-pixel PNG and ICO sizes remain present.
These two steps make repeated generation byte-for-byte reproducible.

`provenance.json` records the source tile, generator versions, source/artifact
SHA-256 values and every Web brand file plus `index.html` hashes. Read-only
`--check` verifies source pixel equality with the committed tile, opaque PNG and
ICNS pixels, cream corners on those square images, transparent ICO corners with
cream still on the top edge, that dark mark ink is present, all ICNS PNG members,
every ICO size, and the recorded native artifact/source hashes. Broader Web hashes
are reported as generation evidence; unrelated later sponsor/README/favicon edits
do not fail the icon artifact check.

After building an application, verify the resource selected by its real
`Info.plist` (replace the path with the app produced by the build):

```sh
python3 apps/desktop/scripts/generate-native-icons.py --check \
  --bundle 'apps/desktop/.acceptance/builds/<build>/Cuepoint Prototype.app'
```

The packaged ICNS must exactly match this generated artifact, with every pixel
opaque and each corner `[244, 240, 232, 255]`. The Windows ICO is the rounded
exception: its corners are transparent. Finder/Dock presentation still needs
a visual check after packaging; pixel/resource checks alone do not prove how
the operating system displays an installed application.
