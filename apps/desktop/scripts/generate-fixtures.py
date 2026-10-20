"""Deterministic developer-only PNG and two-page Chinese PDF fixtures."""
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

target = Path(__file__).resolve().parent.parent / "fixtures" / "media"
target.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (64, 48))
image.putdata([(x * 4, y * 5, (x + y) * 2) for y in range(48) for x in range(64)])
image.save(target / "image.png", optimize=False)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
document = canvas.Canvas(str(target / "document.pdf"), pagesize=(595, 842), invariant=1, pageCompression=0)
for line in ["第一场：雨夜；角色：林一；保持红色雨伞。", "第二场：清晨；素材属于工作区。"]:
    document.setFont("STSong-Light", 16)
    document.drawString(72, 760, line)
    document.setFont("Helvetica", 12)
    document.drawString(72, 720, "Momoki fixture 2026-10-11")
    document.showPage()
document.save()
