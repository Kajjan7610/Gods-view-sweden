# Web fonts

The app serves its fonts itself, so a visitor's browser never asks Google
Fonts for them (each request would send the visitor's IP address to Google
without consent). `scripts/vendor-fonts.mjs` copies them from Google Fonts
into `files/` and writes `fonts.css`; `sources.txt` lists the Google Fonts
URLs it copies from, including the Material Symbols `icon_names` subset.
Run the script by hand after changing `sources.txt`.

| Font | Licence | Text |
|---|---|---|
| Inter | SIL Open Font License 1.1 | `OFL-inter.txt` |
| JetBrains Mono | SIL Open Font License 1.1 | `OFL-jetbrainsmono.txt` |
| Noto Sans Arabic | SIL Open Font License 1.1 | `OFL-notosansarabic.txt` |
| Material Symbols Outlined (subset) | Apache License 2.0 | `LICENSE-material-symbols.txt` |

The fonts are not covered by the project's MIT License; they keep their own
licences, whose texts are in this folder.
