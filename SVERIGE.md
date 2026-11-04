# God's Eye View – Sverige

Fork av [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
med svenska öppna data. Originalets `README.md` lämnas orört så att uppdateringar
från originalet går att slå ihop; allt svenskt beskrivs här.

## Vad som är tillagt

| Del | Källa | Var i appen |
|---|---|---|
| Vägkameror (1 553 st, livebilder i 3D) | Trafikverket, objekt `Camera` | Cameras / CCTV |
| Tåg i realtid | Trafikverket, objekt `TrainPosition` | Transit |
| Bussar, tunnelbana, spårvagn, pendeltåg (16 regionbolag, med linjenummer) | Trafiklab GTFS Regional | Transit |
| Väglag och händelser (olyckor, avstängda vägar, vägarbeten, hinder, färjor) | Trafikverket, `RoadCondition` och `Situation` | Road Conditions (Sweden), under Events |

All data är CC0 1.0. Källor, villkor och tekniska detaljer står i
[DATA_SOURCES.md](DATA_SOURCES.md).

## Nycklar (`.env`, checkas aldrig in)

| Variabel | Används till | Var den skaffas |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | kameror, tåg, väglag, händelser | data.trafikverket.se |
| `TRAFIKLAB_GTFS_RT_KEY` | bussar m.m. live | trafiklab.se → GTFS Regional Realtime |
| `TRAFIKLAB_GTFS_STATIC_KEY` | linjenummer och fordonstyp | trafiklab.se → GTFS Regional Static |
| `CESIUM_ION_TOKEN` | fotorealistiska 3D-städer | ion.cesium.com |

Utan nyckel hoppas respektive del över med en förklarande rad; inget annat slutar fungera.
Trafiklabs gratisnivå (Bronze) räcker till ungefär 125 timmars tittande på ett län i
månaden – begär den kostnadsfria Silver-uppgraderingen vid tyngre användning.

## Starta lokalt

```
npm ci
npm run dev
```

Öppna http://localhost:4173. Kräver Node 24 eller 26.

## Hålla jämna steg med originalet

```
git fetch origin
git merge origin/main
```

(`origin` = bilawalsidhu/gods-eye-view, `sweden` = det här repot.)

## Logg över justeringar

### 2026-11-04 (kamerapanelens startkamera)
- Kamerapanelen startar på kameran närmast vyn (t.ex. Vallbymotet i Västerås) i
  stället för katalogens första kamera i Austin. Under 30 s efter start följer valet
  med när vyn sätter sig (inflygning, sparad vy); en kamera du själv väljer
  (klick, PREV/NEXT, listan, NEAREST, delningslänk) ändras aldrig.

### 2026-11-04 (startvy)
- Ny laddning utan delningslänk flyger till Västerås i stället för Austin, TX
  (`HOME_VIEW` i `src/camera.js`); laddningstexten "Flying to {place}..." översatt
  till alla 11 språk. En sparad vy i adressfältet vinner fortfarande.

### 2026-11-04 (synk med originalet)
- Hämtade 51 nya commits från bilawalsidhu/gods-eye-view: bl.a. lagret
  "Prohibited & Restricted Airspace" (FAA, drönarluftrum), kamerakällan Houston
  (TranStar, avstängd utan TxDOT:s tillstånd) och skriven AI-chatt.
- Originalets drönarlager tog delningslänk-token 8, så "Road Conditions (Sweden)"
  flyttade till token 9. Testernas låsta antal och token-fixturer följer med.

### 2026-11-04
- Kamerabilder: Trafikverket har bytt bildadresser till
  `…/v2/Images/data/road.infrastructure.camera/…`; valideringen följer nu det nya
  formatet (alla 1 553 kameror i stället för 804).
- Kamerahöjd: alla svenska kameror har fått verklig markhöjd; reservhöjden är
  nätets median 33 m (var 60 m, vilket fick kameror vid Mälaren att sväva ~58 m).
- Kamerariktning: väglagskameror (749 st) publicerar ingen riktning och riktas nu
  längs närmaste väg i NVDB. Axeln stämmer inom 30° för 85 % av kamerorna med känd
  riktning; fram/bak är osäkert och de visas därför som uppskattade (ESTIMATED).
- Tåg: tågflödet räknas uttryckligen som tåg (hastighetstak ~400 km/h), så tåg i
  ~200 km/h inte längre stoppas som "omöjlig förflyttning".
- Väglag och händelser: avstängda vägar egen kategori (vit prick, röd ring);
  hastighetsbegränsningar och körfältsavstängningar samlade som "mindre", dolda som
  standard; inga blå händelsefärger (blått = is/snö); händelsesträckor streckade.

### 2026-11-03
- Trafikverkets vägkameror som ny kamerakälla.
- Trafikverkets tåg och Trafiklabs regionala kollektivtrafik i kollektivtrafiklagret,
  med nycklar på serversidan och täckning i tre cirklar så att Oslo och Helsingfors
  inte hämtar svensk data.
- Nytt lager "Road Conditions (Sweden)" (delningslänk-token 9; var 8 tills originalets drönarlager tog den), översatt till appens
  11 språk.
