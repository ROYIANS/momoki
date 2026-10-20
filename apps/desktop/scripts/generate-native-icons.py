"""Generate and independently verify the desktop-only opaque brand icon set."""

import argparse
import hashlib
import io
import json
import plistlib
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, __version__ as pillow_version


PACKAGE = Path(__file__).resolve().parent.parent
ROOT = PACKAGE.parent.parent
TARGET = PACKAGE / "src-tauri" / "icons"
SOURCE = PACKAGE / "assets" / "app-icon-cream-1024.png"
BRAND_DIR = ROOT / "packages" / "distribution" / "public" / "brand"
BACKGROUND = (244, 240, 232, 255)
# Windows does not mask a square ICO. This is the rounded-rect radius used by the
# approved cream tile, as a fraction of each ICO frame's side.
WINDOWS_RADIUS_RATIO = 0.2237
PNG_SIZES = {"16x16.png": 16, "32x32.png": 32, "64x64.png": 64, "128x128.png": 128,
             "128x128@2x.png": 256, "icon.png": 512}
DESKTOP_FILES = (*PNG_SIZES, "icon.icns", "icon.ico")
TAURI_VERSION = "2.12.1"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def web_hashes():
    paths = sorted(path for path in BRAND_DIR.iterdir() if path.is_file())
    return {path.relative_to(ROOT).as_posix(): sha256(path) for path in [*paths, ROOT / "apps" / "web" / "index.html"]}


def opaque_source():
    with Image.open(SOURCE) as tile:
        if tile.size != (1024, 1024):
            raise ValueError("Expected the approved 1024x1024 opaque icon tile; do not upscale a favicon")
        pixels = tile.convert("RGBA")
    if pixels.getchannel("A").getextrema() != (255, 255):
        raise ValueError("The approved icon tile must be fully opaque; it is used without compositing")
    return pixels


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def image_check(image, label, size):
    if image.size != (size, size):
        raise ValueError(f"{label}: expected {size}x{size}, found {image.size}")
    rgba = image.convert("RGBA")
    alpha_range = rgba.getchannel("A").getextrema()
    if alpha_range != (255, 255):
        raise ValueError(f"{label}: expected every pixel opaque, found alpha range {alpha_range}")
    corners = [rgba.getpixel(point) for point in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]]
    if any(pixel != BACKGROUND for pixel in corners):
        raise ValueError(f"{label}: corners differ from cream #f4f0e8: {corners}")
    # The mark has black ink on the cream tile; a blank tile has no dark pixels.
    if rgba.getchannel("R").getextrema()[0] >= 100:
        raise ValueError(f"{label}: logo artwork is absent")
    return {"size": size, "alphaRange": list(alpha_range), "corners": [list(pixel) for pixel in corners]}


def icns_members(path):
    data = path.read_bytes()
    if data[:4] != b"icns" or struct.unpack(">I", data[4:8])[0] != len(data):
        raise ValueError("Invalid ICNS container length/header")
    members = {}
    offset = 8
    while offset < len(data):
        tag = data[offset:offset + 4].decode("ascii")
        length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        if length <= 8 or offset + length > len(data):
            raise ValueError(f"Invalid ICNS member {tag}")
        if tag in members:
            raise ValueError(f"Duplicate ICNS member {tag}")
        members[tag] = data[offset + 8:offset + length]
        offset += length
    if offset != len(data):
        raise ValueError("ICNS member lengths do not close the container")
    return members


def canonicalize_icns(path):
    members = icns_members(path)
    # Keep the repository's original modern PNG member set. macOS iconutil emits
    # different corner bytes from small legacy entries (also from its own encoder).
    # Retina 16pt and the other PNG members retain correct bytes on both decoders.
    for tag in ["is32", "s8mk", "il32", "l8mk"]:
        del members[tag]
    # The pinned CLI iterates a Rust hash map; sort members for reproducible containers.
    chunks = [tag.encode("ascii") + struct.pack(">I", len(payload) + 8) + payload
              for tag, payload in sorted(members.items())]
    path.write_bytes(b"icns" + struct.pack(">I", 8 + sum(map(len, chunks))) + b"".join(chunks))


def icns_check(path):
    """Inspect every embedded PNG, including small and duplicate retina-sized members."""
    members = icns_members(path)
    png_sizes = {"ic07": 128, "ic08": 256, "ic09": 512, "ic10": 1024,
                 "ic11": 32, "ic12": 64, "ic13": 256, "ic14": 512}
    if set(members) != set(png_sizes):
        raise ValueError(f"ICNS member set differs from the modern desktop set: {sorted(members)}")
    report = {}
    for tag, size in png_sizes.items():
        with Image.open(io.BytesIO(members[tag])) as image:
            report[tag] = image_check(image, f"icon.icns/{tag}", size)
    return report


def rounded_alpha(size):
    scale = 4
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=max(1, round(size * WINDOWS_RADIUS_RATIO * scale)),
        fill=255,
    )
    mask = big.resize((size, size), Image.Resampling.LANCZOS)
    # Lanczos reaches into the curve on small frames and leaves the corners slightly opaque.
    pixels = mask.load()
    for y in range(size):
        for x in range(size):
            if pixels[x, y] < 16:
                pixels[x, y] = 0
    return mask


def round_windows_ico(path):
    """Mask each Tauri ICO frame. PNG and ICNS stay square so macOS can apply its own mask."""
    with Image.open(path) as container:
        sizes = sorted(container.ico.sizes())
        frames = []
        for width, height in sizes:
            frame = container.ico.getimage((width, height)).convert("RGBA")
            frame.putalpha(rounded_alpha(width))
            frames.append(frame)
    # Pillow drops any size larger than the first image, so the 256 frame must lead.
    frames.sort(key=lambda frame: frame.size, reverse=True)
    frames[0].save(path, format="ICO", sizes=[frame.size for frame in frames], append_images=frames[1:])


def ico_frame_check(image, label, size):
    if image.size != (size, size):
        raise ValueError(f"{label}: expected {size}x{size}, found {image.size}")
    rgba = image.convert("RGBA")
    corners = [rgba.getpixel(point) for point in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]]
    if any(pixel[3] != 0 for pixel in corners):
        raise ValueError(f"{label}: Windows corners must be transparent, found {corners}")
    edge = rgba.getpixel((size // 2, 0))
    if edge != BACKGROUND:
        raise ValueError(f"{label}: top edge must stay cream #f4f0e8, found {edge}")
    if rgba.getchannel("R").getextrema()[0] >= 100:
        raise ValueError(f"{label}: logo artwork is absent")
    return {"size": size, "corners": [list(pixel) for pixel in corners], "topEdge": list(edge)}


def ico_check(path):
    with Image.open(path) as container:
        sizes = sorted(container.ico.sizes())
        if sizes != [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)]:
            raise ValueError(f"ICO member sizes differ from the pinned Tauri set: {sizes}")
        return [ico_frame_check(container.ico.getimage(size), f"icon.ico/{size[0]}", size[0]) for size in sizes]


def inspect(directory):
    pngs = {}
    for name, size in {"source.png": 1024, **PNG_SIZES}.items():
        with Image.open(directory / name) as image:
            pngs[name] = image_check(image, name, size)
    with Image.open(directory / "source.png") as saved_source:
        if saved_source.convert("RGBA").tobytes() != opaque_source().tobytes():
            raise ValueError("Native source changes approved logo pixels/framing from the approved opaque tile")
    return {"png": pngs, "icns": icns_check(directory / "icon.icns"), "ico": ico_check(directory / "icon.ico")}


def generate(pnpm):
    if not Path(pnpm).is_absolute():
        raise ValueError("Pass an absolute local machine pnpm executable")
    executable = Path(pnpm).resolve()
    if not executable.is_file() or "/.cache/codex-runtimes/" in str(executable):
        raise ValueError("Pass the absolute local machine pnpm path; the Codex Runtime pnpm is prohibited")
    dependency = PACKAGE / "node_modules" / "@tauri-apps" / "cli" / "package.json"
    if json.loads(dependency.read_text())["version"] != TAURI_VERSION:
        raise ValueError(f"Native icons require the pinned @tauri-apps/cli {TAURI_VERSION}")
    before = web_hashes()
    with tempfile.TemporaryDirectory(prefix="momoki-native-icons-") as temporary:
        directory = Path(temporary)
        source = directory / "source.png"
        source.write_bytes(png_bytes(opaque_source()))
        generated = directory / "generated"
        result = subprocess.run([str(executable), "--dir", str(PACKAGE), "exec", "tauri", "icon",
                                 str(source), "--output", str(generated)], check=True, capture_output=True, text=True)
        subprocess.run([str(executable), "--dir", str(PACKAGE), "exec", "tauri", "icon", str(source),
                        "--png", "16", "--output", str(generated)], check=True, capture_output=True, text=True)
        # The CLI generates mobile/store assets too; only the reviewed desktop set is installed.
        for name in DESKTOP_FILES:
            shutil.copyfile(generated / name, directory / name)
        canonicalize_icns(directory / "icon.icns")
        round_windows_ico(directory / "icon.ico")
        report = inspect(directory)
        if before != web_hashes():
            raise ValueError("Web branding changed during native icon generation")
        manifest = {"format": "momoki.native-icons.v1", "source": SOURCE.relative_to(ROOT).as_posix(),
                    "sourceSha256": sha256(SOURCE), "sourceSize": [1024, 1024], "background": "#f4f0e8",
                    "composition": "approved opaque tile copied as-is for PNG and ICNS; Windows ICO frames use a rounded-rect alpha mask at 0.2237 of the side",
                    "generator": {"pillow": pillow_version, "tauriCli": TAURI_VERSION,
                                  "icnsOrdering": "ascending member tag (CLI hash-map iteration normalized)",
                                  "icnsMembers": "original repository modern PNG set ic07..ic14; legacy small entries omitted"},
                    "webHashes": before,
                    "files": {name: sha256(directory / name) for name in ["source.png", *DESKTOP_FILES]}}
        TARGET.mkdir(parents=True, exist_ok=True)
        for name in manifest["files"]:
            shutil.copyfile(directory / name, TARGET / name)
        (TARGET / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"generated": list(manifest["files"]), "checks": report,
                          "cliExit": result.returncode, "webUnchanged": True}, indent=2))


def check(bundle=None):
    manifest = json.loads((TARGET / "provenance.json").read_text())
    if manifest["sourceSha256"] != sha256(SOURCE):
        raise ValueError("Approved icon tile differs from native generation provenance")
    if manifest["files"] != {name: sha256(TARGET / name) for name in ["source.png", *DESKTOP_FILES]}:
        raise ValueError("Native icon artifact hashes differ from the generation provenance")
    if (TARGET / "source.png").read_bytes() != png_bytes(opaque_source()):
        raise ValueError("Native source is not reproducible from the approved original pixels")
    # Broader Web hashes are evidence for this generation, not a gate on unrelated later changes.
    report = {"checks": inspect(TARGET), "webMatchesGenerationEvidence": manifest["webHashes"] == web_hashes(),
              "artifactHashesMatch": True,
              "sourcePixelsAndFramingMatch": True}
    if bundle:
        contents = Path(bundle) / "Contents"
        with (contents / "Info.plist").open("rb") as info_file:
            icon_name = plistlib.load(info_file)["CFBundleIconFile"]
        if not icon_name.endswith(".icns"):
            icon_name += ".icns"
        packaged_icon = contents / "Resources" / icon_name
        if sha256(packaged_icon) != manifest["files"]["icon.icns"]:
            raise ValueError("Packaged app uses a different ICNS resource")
        report["packagedIcon"] = {"path": str(packaged_icon), "sha256": sha256(packaged_icon),
                                  "matchesNativeArtifact": True, "members": icns_check(packaged_icon)}
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read-only pixel/container/hash verification")
    parser.add_argument("--pnpm", help="Absolute local machine pnpm executable for pinned Tauri generation")
    parser.add_argument("--bundle", help="Also verify the actual .app icon resource; requires --check")
    args = parser.parse_args()
    if args.check:
        check(args.bundle)
    elif args.bundle:
        parser.error("--bundle requires --check")
    elif args.pnpm:
        generate(args.pnpm)
    else:
        parser.error("Generation requires --pnpm; artifact verification uses --check")


if __name__ == "__main__":
    main()
