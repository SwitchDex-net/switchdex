# SwitchDex brand assets

The SwitchDex mark — an "SD" monogram where the routed "S" and the arch of the
"D" terminate in connector nodes, echoing a network switch path.

| File | Use |
|------|-----|
| `logo.svg` | Master, 96px artboard. Blue tile — use as the primary app/avatar icon. |
| `logo-256.svg` | Avatar size (GitHub org/profile, forums). Same art, 256px. |
| `logo-32.svg` | Favicon. |
| `logo-mark.svg` | Transparent background, blue glyph (no tile) — for light READMEs / docs headers. |

## Colors

- Tile / strokes: `#1f6feb` (SwitchDex blue)
- D outline: `#cfe2ff`
- Connector nodes: `#bcd9ff` (on tile) / `#58a6ff` (transparent mark)
- Recommended dark background: `#0d1117`

## Notes

These are vector SVGs — they scale to any size without quality loss. If a venue
requires a raster PNG (some forum avatar uploaders do), export from `logo.svg` at
the size you need, e.g. with ImageMagick or Inkscape:

```bash
# requires librsvg or inkscape
rsvg-convert -w 512 -h 512 logo.svg > logo-512.png
# or
inkscape logo.svg --export-type=png -w 512 -o logo-512.png
```

GitHub renders SVG directly for org/repo avatars and in READMEs, so the SVG files
work as-is for most uses.
