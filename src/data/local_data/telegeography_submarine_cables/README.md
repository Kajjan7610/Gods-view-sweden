# TeleGeography Submarine Cable Map — not distributed in the Swedish fork

The original project bundles `cable-geo.json` and `landing-point-geo.json`
from TeleGeography's [Submarine Cable Map](https://www.submarinecablemap.com/)
here, stating CC BY-NC-SA 3.0.

God's Eye View Sverige does not ship them. TeleGeography now licenses the
geocoded data behind its maps for an annual fee, and its Creative Commons
licence (CC BY-SA 4.0) covers references to its maps, URLs and screen
captures, not the GeoJSON files. No licence covering redistribution of these
two files, downloaded on 2026-05-24, could be found.

The layer stays in the code so that merges with the original keep working,
but it is not listed and its source has no cables
(`createEmptyCableSource` in `src/layers/submarineCables/bundledSource.js`).
