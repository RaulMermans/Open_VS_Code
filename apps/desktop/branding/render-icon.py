"""Original geometric mark for Open VS Code. Not a VS Code, Cursor, or Claude logo."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
INK = (20, 32, 43, 255)
TEAL = (61, 220, 151, 255)
PAPER = (244, 247, 246, 255)


def draw(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = size * 0.08
    radius = size * 0.22
    draw.rounded_rectangle((pad, pad, size - pad, size - pad), radius=radius, fill=INK)
    left = size * 0.28
    top = size * 0.30
    thickness = max(2, int(size * 0.07))
    arm = size * 0.28
    # Open bracket.
    draw.rectangle((left, top, left + thickness, size - top), fill=PAPER)
    draw.rectangle((left, top, left + arm, top + thickness), fill=PAPER)
    draw.rectangle((left, size - top - thickness, left + arm, size - top), fill=PAPER)
    # Offset diamond.
    cx = size * 0.68
    cy = size * 0.50
    r = size * 0.11
    draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=TEAL)
    return image


def main() -> None:
    targets = {48: "icon-48.png", 128: "icon-128.png", 256: "icon.png", 512: "icon-512.png"}
    for size, name in targets.items():
        draw(size).save(ROOT / name)


if __name__ == "__main__":
    main()
