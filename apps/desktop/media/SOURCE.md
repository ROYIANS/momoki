# Decoder source and build provenance

The application uses the two unmodified CLI executables from
[AtlasYang/ffmpeg-static-builds ffmpeg-8.0.3-build4](https://github.com/AtlasYang/ffmpeg-static-builds/releases/tag/ffmpeg-8.0.3-build4).
The build source is pinned to
[`0393ae2c796360fbcbbc44c85eeb769eead473b1`](https://github.com/AtlasYang/ffmpeg-static-builds/tree/0393ae2c796360fbcbbc44c85eeb769eead473b1).
The source registry `source-lock.json` records each tag's resolved commit, exact
source archive URL, downloaded length/SHA-256 and license text URL/hash. All nine
source archives are bundled under `media/sources/` alongside the executables, so
source availability does not depend on an expiring CI log or a network request.
The decoder lock separately pins the three actual executable archive identities
and the measured extracted executable identities.

**Archive hosting (2026-10-21).** The upstream repository
`AtlasYang/ffmpeg-static-builds` was removed after the release was reviewed, so
its original archives can no longer be downloaded. The three archives are now
hosted as assets of this project's `media-ffmpeg-8.0.3-build4` GitHub Release.
They are repacked, in the same flat tar.gz/zip layout the release tooling
accepts, from the exact reviewed executables: every extracted `ffmpeg` and
`ffprobe` keeps the byte length and SHA-256 pinned in `decoder-lock.json`, and
the archive length/SHA-256 there now describes the repacked archives. Nothing
inside the executables changed, and the provenance reports and all source
archives are unchanged.

The libaom source entry also names a tracked `archiveFile` under `sources/`.
Its upstream Gitiles archive regenerates per-file timestamps on each request,
changing archive bytes for the same commit. The tracked copy preserves the
original reviewed length and SHA-256; build preparation verifies and copies it
instead of redownloading that generated archive. Its upstream URL remains in
the registry as provenance. Other source archives retain their pinned downloads.

## Build configuration and modifications

The published per-target build reports in `provenance/` contain the runtime
FFmpeg/ffprobe version, compiler, complete configure line and dynamic-library
list. The reviewed build scripts enable only explicitly listed libraries, with
`--disable-gpl --disable-nonfree --disable-version3 --disable-autodetect`.
FFmpeg is built from tag `n8.0.3` with no source patch in those scripts.

The dependency script modifies **libvorbis 1.3.7's generated configure** before
running it on every target: it removes every literal
`-force_cpusubtype_ALL` from that generated file. To reproduce, generate configure
with `./autogen.sh`, then apply
`sed -i.bak 's/-force_cpusubtype_ALL//g' configure`. This removes an obsolete
Apple linker flag; the bundled libvorbis source is the original upstream source,
with this modification described here rather than silently claiming unmodified
build inputs. Dependency configuration and build commands remain available in
[the pinned dependency script](https://github.com/AtlasYang/ffmpeg-static-builds/blob/0393ae2c796360fbcbbc44c85eeb769eead473b1/scripts/build-deps.sh)
and [FFmpeg build script](https://github.com/AtlasYang/ffmpeg-static-builds/blob/0393ae2c796360fbcbbc44c85eeb769eead473b1/scripts/build-ffmpeg.sh).

The upstream build reuses dependency caches keyed on its version file. Published
reports state versions and flags; they are not an independent reproducible-build
attestation. These materials preserve the reviewed upstream inputs and notices.
They do not claim that Momoki rebuilt the binaries or audited all compiler
runtime contributions. The Windows report records GCC 16.2.0/MSYS2 and static
libgcc. Before public redistribution, confirm the matching compiler/runtime
source notices and any additional distribution obligations against the actual
installer. Public release review remains separate from implementation and local
fixture evidence.

## Verification and supported platforms

`media-resources.mjs` obtains only the requested target, verifies the pinned
archive before extracting the exact two ordinary members, verifies their measured
hashes and copies pinned source/license materials. The Rust provider checks the
bundled target manifest against the compiled decoder lock and hashes ordinary
executables before launch. No runtime download, PATH lookup or arbitrary shell is
used. Linux keeps its existing packaging and does not include this workflow.

All three archives were verified during development. Only the macOS arm64 tools
were executed on this development host; Windows and Intel/macOS runtime behavior,
macOS 14 compatibility, final signing and installed resource layout require their
corresponding-host batch acceptance. Reading a PE/Mach-O header or verifying a
hash does not establish runtime support.
