# Test fixtures

- `photon-moscow-search.json` - Photon responses for `Москва`, captured
  2026-11-05 with and without a proximity bias near the Tajikistan namesake.
  The fixture is trimmed to the fields the keyless geocoder consumes and is
  used only by offline search tests. Data from OpenStreetMap contributors,
  ODbL 1.0 (https://www.openstreetmap.org/copyright).
- `synthetic-flow-12-935-1686.pbf` — a hand-drawn traffic-flow vector tile
  in TomTom's layout (Mapbox Vector Tile protobuf, layer `"Traffic flow"`,
  extent 4096): five lines with `traffic_level`, `road_type`,
  `road_category`, one `road_closure`, and lines that run past the tile edge
  so clipping is exercised. No TomTom data; made for the Swedish fork,
  which does not distribute the original's captured TomTom tile (TomTom's
  terms do not allow publishing it). Used by the offline traffic
  decode/source tests only.
- `adsb-austin-frames.txt` — 112 raw Mode S frames (`*<hex>;`, one per line,
  in receive order) received over Austin, TX, and
  `adsb-austin-dump1090-aircraft.json` — dump1090-fa's `aircraft.json` decode
  of the same frames, trimmed to the fields the tests assert on. Used by the
  Local ADS-B decoder and record-adapter tests; never loaded at runtime.
- `adsb-austin-capture-timed.json` — a second ~90 s receive over Austin, TX:
  846 extended squitters from six aircraft (`frames`: `[ms, hex]`), with
  dump1090-fa's decoded positions and emitter categories for the same
  interval (`dump1090`: per ICAO `flight`, `category` and `fixes` as
  `[ms, lat, lon]`). The capture has no per-frame timestamps; each frame's
  time is interpolated between the frames whose decoded position equals a
  dump1090 fix, timed as dump1090's `now − seen_pos`. Used by the decoder's
  category, speed-check and track-accuracy tests; never loaded at runtime.
- `ofm-austin-{14-3743-6745,12-935-1686}.pbf` and
  `ofm-camp-mabry-12-935-1685.pbf` — OpenFreeMap / OpenMapTiles tiles from
  `https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf`,
  retrieved 2026-09-23. Trimmed to one transportation feature per class/direction
  and one military landuse feature, preserving original geometry and dictionaries.
  OpenFreeMap © OpenMapTiles Data from OpenStreetMap; © OpenStreetMap
  contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
  These modified data fixtures retain ODbL attribution and database share-alike;
  commercial use and redistribution are permitted under that license. Test-only.
- `osm-alpr-austin-11-467-843.pbf` — one OSM camera feature (original geometry
  and attribute dictionary) from the community-hosted hourly US extract,
  `https://tiles.dontgetflocked.com/cameras-us-hourly/11/467/843.mvt`,
  retrieved 2026-09-23. © OpenStreetMap contributors, ODbL 1.0; modified by
  trimming to one feature, test-only. Same attribution/share-alike terms above.

- `traffic-road-access.json` — representative transportation properties and two
  original vertices per feature near the Texas Capitol, Camp Mabry greenbelt,
  and Austin commercial car parks, from OpenFreeMap z14 tiles, retrieved
  2026-09-25. Each record names its XYZ tile and expected traffic eligibility.
  Modified, test-only OpenStreetMap data; same ODbL attribution and database
  share-alike terms as the OpenFreeMap fixtures above.

- `ofm-outlines-austin-14-3743-{6745,6746}.pbf` — OpenFreeMap / OpenMapTiles
  z14 tiles from
  `https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf`,
  retrieved 2026-09-28. Trimmed to the `transportation_name` features for
  Congress Avenue, South Congress Avenue and East 11th Street, and the
  `building` features within about 150 m of the Texas Capitol and the
  `landcover` park polygon around it, preserving
  original geometry and dictionaries. Used by the street and building outline
  tests. Same OpenFreeMap / OpenMapTiles / OpenStreetMap attribution and ODbL
  1.0 share-alike terms as the fixtures above. Test-only.
