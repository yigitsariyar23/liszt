"""Draws build/icon.png (1024x1024), the app icon electron-builder turns into Liszt.icns.

The mark is the L-shaped logo from the top bar, on a dark rounded square sized to Apple's macOS
icon grid (an 824 px tile with a soft shadow on a 1024 canvas). Drawn at 4x and scaled down for
clean edges. Run: python3 scripts/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 4  # supersampling factor
SIZE = 1024 * S
TILE = 824 * S
RADIUS = 185 * S
OFFSET = (SIZE - TILE) // 2


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new('RGBA', size)
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,)
        for x in range(w):
            px[x, y] = color
    return img


def main():
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    tile_box = (OFFSET, OFFSET, OFFSET + TILE, OFFSET + TILE)

    # Shadow under the tile.
    shadow = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((tile_box[0], tile_box[1] + 12 * S, tile_box[2], tile_box[3] + 12 * S), RADIUS, fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18 * S))
    canvas.paste((0, 0, 0, 255), (0, 0), shadow)

    # Dark tile with a faint top highlight and a hairline border.
    tile_mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle(tile_box, RADIUS, fill=255)
    small = vertical_gradient((1, 256), (36, 36, 42), (14, 14, 17)).resize((SIZE, SIZE))
    canvas.paste(small, (0, 0), tile_mask)
    ImageDraw.Draw(canvas).rounded_rectangle(tile_box, RADIUS, outline=(255, 255, 255, 28), width=3 * S)

    # L mark (16-unit grid from the top-bar SVG: one tall pane and a square foot to its right).
    unit = 30 * S
    mark = 14 * unit
    ox = (SIZE - mark) // 2 - unit
    oy = (SIZE - mark) // 2 - unit
    mark_mask = Image.new('L', (SIZE, SIZE), 0)
    d = ImageDraw.Draw(mark_mask)
    for x, y, w, h in [(1, 1, 6, 14), (9, 9, 6, 6)]:
        d.rounded_rectangle((ox + x * unit, oy + y * unit, ox + (x + w) * unit, oy + (y + h) * unit), int(1.5 * unit), fill=255)
    orange = vertical_gradient((1, 256), (242, 145, 99), (214, 104, 62)).resize((SIZE, SIZE))
    canvas.paste(orange, (0, 0), mark_mask)

    out = Path(__file__).resolve().parent.parent / 'build' / 'icon.png'
    out.parent.mkdir(exist_ok=True)
    canvas.resize((1024, 1024), Image.LANCZOS).save(out)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
