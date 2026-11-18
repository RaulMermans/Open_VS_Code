# Open VS Code — `<VS>` icon

`icon-source-vs.png` is the approved source artwork (1995×788, transparent background): the `<VS>` mark
with cyan brackets, a blue V and a violet-to-magenta S. It replaces the earlier cyberpunk mark (Sprint 25).

## Regenerate

```text
python3 apps/desktop/branding/render-icon.py
```

The script (Pillow) centers the visible mark on a transparent square with a 7.5% margin and writes
`icon-48.png`, `icon-128.png`, `icon.png` (256) and `icon-512.png`. Commit the source and all outputs together.
Packaging installs them as the Linux hicolor icons and the window icon (`resources/linux/code.png`).

## Notes

- The mark is wide, so it fills about 37% of the square's height; at 48 px it is legible but small. If launcher
  or task-switcher sizes look unclear, add a small-size variant that keeps the same identity.
- The activity-bar icon (`packages/vscode-integration/media/agent.svg`) is a separate monochrome SVG, as VS Code
  requires there; it is not generated from this artwork.
- Never claim the icon is deployed until the installed application actually displays it (icon caches may need
  a log-out/in).
