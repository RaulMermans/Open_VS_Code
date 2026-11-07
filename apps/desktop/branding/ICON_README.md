# Open VS Code — Cyberpunk icon replacement pack

The source image is the last user-selected borderless cyberpunk mark from this conversation.
It is designed to have a transparent background and no rounded-square container.

## Install into repository

Extract this archive at the root of `Open_VS_Code` (the ZIP contains the correct `apps/desktop/branding/` prefix).
This replaces `render-icon.py`, `ICON_README.md`, and the four old icon PNGs.
It also adds `icon-source-cyberpunk.png` as the permanent source asset.

Run `python3 apps/desktop/branding/render-icon.py` to reproduce the PNGs.
Commit the source image and all outputs together.

## Release verification

1. Confirm packaging includes these icons (Linux .desktop icon and installed window icon).
2. Rebuild and install a new clean versioned Debian package; current rc.6 remains the rollback version.
3. Check the dock, launcher, task switcher and window icon after logging out/in if icon caches persist.
4. Test the icon at 48px; if the small size is unclear, add a simple small-size variant while preserving the main identity.
5. Verify that no script regenerates the previous green diamond mark.

Never claim the image has been deployed until the installed application actually displays it.
