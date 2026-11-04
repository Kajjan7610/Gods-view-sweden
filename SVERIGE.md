# God's Eye View – Sverige

Fork av [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
med svenska öppna data. Originalets `README.md` lämnas orört så att uppdateringar
från originalet går att slå ihop; allt svenskt beskrivs här.

## Vad som är tillagt

| Del | Källa | Var i appen |
|---|---|---|
| Vägkameror (1 553 st, livebilder i 3D) | Trafikverket, objekt `Camera` | Cameras / CCTV |
| Tåg i realtid, färgade efter försening (rosa 3–14 min, magenta 15+ min) | Trafikverket, objekt `TrainPosition` och `TrainAnnouncement` | Transit |
| Bussar, tunnelbana, spårvagn, pendeltåg (16 regionbolag, med linjenummer) | Trafiklab GTFS Regional | Transit |
| Väglag och händelser (olyckor, avstängda vägar, vägarbeten, hinder, färjor) | Trafikverket, `RoadCondition` och `Situation` | Road Conditions (Sweden), under Events |
| Nederbördsradar, Norden (var 5:e minut, senaste timmen) | SMHI, radarkomposit (CC BY 4.0, ingen nyckel) | Rain radar, under Weather (knapp Nordics) |
| Nederbördsradar, Europa inkl. Norge, Finland, Danmark och Baltikum (var 5:e minut) | EUMETNET OPERA, radarkomposit (CC BY 4.0, ingen nyckel) | Rain radar, under Weather (knapp Europe) |
| Vägväder: ca 830 väderstationer längs vägarna (vägbanans och luftens temperatur, daggpunkt, vind, sikt, nederbörd; halkrisk markeras) | Trafikverket, objekt `WeatherMeasurepoint` | Road Weather (Sweden), under Events |
| Vädervarningar: gula, orange och röda varningar som områden, plus meddelanden (vattenbrist, höga flöden, brandrisk), samt VMA och krisnyheter som punkter | SMHI, IBWW-varningar (CC BY 4.0) och Krisinformation.se (MSB); ingen nyckel | Weather Warnings (Sweden), under Weather |
| Polisens händelser (de 500 senaste notiserna, ca 10 dagar), placerade vid kommunens centralort | Polismyndigheten, `polisen.se/api/events` (öppna data, ange källan) | Police Events (Sweden), under Events |
| Trafikmeddelanden från Sveriges Radio (ca 150 st, färg och storlek efter prioritet) | Sveriges Radios öppna API, ingen nyckel | Traffic Reports (Sweden) / Trafikmeddelanden (SR), under Events |
| Sjöväder: ca 160 stationer längs kusten, i Vänern, Vättern, Mälaren och kanalerna (vind, byvind, vattenstånd, vattentemperatur, vågor) | Sjöfartsverket ViVa, ingen nyckel | Sea Weather (Sweden) / Sjöväder, under Weather |
| Elpris per elområde (SE1–SE4), spotpris per kvart idag och imorgon | elprisetjustnu.se (Nord Pool-priser, ingen nyckel) | Electricity Prices (Sweden), under Infrastructure |
| Svenskt gränssnitt (alla ca 3 000 texter) | Egen översättning, `src/i18n/locales/sv.json` | Språkknappen nere till höger, eller `?lang=sv` |

Trafikverkets och Trafiklabs data är CC0 1.0; SMHI:s radar och varningar samt OPERA:s radar är CC BY 4.0 (källa: SMHI respektive EUMETNET OPERA). Källor, villkor och tekniska detaljer står i
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

### 2026-11-04 (synk med originalet, sen kväll)
- 34 nya commits: bränder (NASA FIRMS) visas som värmekarta på avstånd, med färg
  från glöd till vitglödgad, filter för brandintensitet (FRP) och säkerhet, och en
  reglage för fläckstorlek; arabisk chatt-autokomplettering. De nya brandtexterna
  översattes till svenska. Bara listan över texter som är samma som engelska
  krockade; den slogs ihop per språk.

### 2026-11-04 (sjöväder från Sjöfartsverket)
- Nytt lager "Sjöväder (Sverige)" under Weather: Sjöfartsverkets ViVa-stationer
  (ca 160 med mätvärden: egna, SMHI:s och hamnarnas) längs kusten, i Vänern,
  Vättern, Mälaren och kanalerna. Färg efter medelvind (upp till 4, 4–8, 8–13,
  13–20 kuling, över 20 storm m/s) eller, med knappen VATTENSTÅND, efter
  vattenstånd mot medelvattenstånd. Värdena skrivs ut för de stationer som
  sticker ut mest (knapp VÄRDEN). Grå prick = stationen mäter inte det som visas.
- Klick ger kort med vind, byvind och riktning, vattenstånd, vatten- och
  lufttemperatur, våghöjd och mättid.
- ViVa svarar en station per anrop, så servern går igenom alla, sex åt gången
  (ca 2,5 s), högst var 10:e minut och bara när lagret är på. Ingen nyckel.
  Delningskod `0u`. I kväll blåser det mest i Bottenviken, ca 12 m/s.

### 2026-11-04 (Sveriges Radios trafikmeddelanden)
- Nytt lager "Trafikmeddelanden (SR)" under Events: de meddelanden SR:s
  trafikredaktioner publicerar (ca 150 i kväll) som punkter, färg och storlek
  efter prioritet: mycket allvarlig (röd), stor händelse (orange), störning (gul),
  information (blå), mindre störning (grå). Knappar VÄGTRAFIK, KOLLEKTIVTRAFIK,
  PLANERAT (av från början) och ÖVRIGT.
- Klick ger kort med typ och väg, plats, meddelandet och tid.
- Sveriges Radios öppna API, ingen nyckel; innehållet visas som SR publicerar det,
  med SR som källa. Hämtas var 3:e minut. Delningskod `0v`.

### 2026-11-04 (elpris per elområde)
- Nytt lager "Electricity Prices (Sweden)" (svenska: Elpris) under Infrastructure:
  de fyra elområdena SE1 Luleå, SE2 Sundsvall, SE3 Stockholm och SE4 Malmö som
  färgade punkter med pris, t.ex. "SE3 · 1,31 kr". Knappar: NU (kvarten nu,
  standard), IDAG (dagens snitt) och IMORGON (morgondagens snitt, när auktionen
  publicerat det).
- Färger: grönt upp till 0,50 kr/kWh, gulgrönt till 1, gult till 2, orange till 3,
  rött över 3. Klick ger kort med priset nu, dagens lägsta/högsta med klockslag,
  snitt och morgondagen.
- Spotpris per kvart från elprisetjustnu.se (Nord Pool, gratis, ingen nyckel),
  utan moms, nätavgift och energiskatt. Ingen öppen karta över elområdenas
  gränser används; varje område är en punkt inne i området.
- Delningskod `0w`; röststyrningen hoppar över lagret.

### 2026-11-04 (VMA och krisinformation)
- Varningslagret "Weather Warnings (Sweden)" visar nu också Krisinformation.se:
  VMA (viktigt meddelande till allmänheten) som stora röda punkter och
  myndigheternas krisnyheter från de senaste tre dygnen som blå punkter.
  Knappen KRISINFO slår av och på; den är på från början.
- Meddelandena anger ett område men sällan en koordinat: en kommun hamnar vid
  centralorten, ett län i snittet av länets centralorter och "hela Sverige" mitt
  i landet (Flataklocken). Kortet säger vilket, visar ingressen, tid och avsändare
  och öppnar meddelandet på krisinformation.se. Texten är svenska, som MSB
  publicerar den.
- Hämtas tillsammans med SMHI:s varningar var 5:e minut (ingen nyckel). Om
  Krisinformation inte svarar fungerar varningarna ändå och senaste listan behålls.
- I kväll: ingen VMA, två krisnyheter för hela landet.

### 2026-11-04 (tågförseningar)
- Tågen i Transit färgas efter försening: lila som förut när de går i tid,
  rosa vid 3–14 minuter sent och magenta vid 15 minuter eller mer (färger som
  inget annat trafikslag använder).
- Tågkortet visar förseningen överst, t.ex. "7 min sen · avgick från Stockholm C",
  och slutstationen ("Mot Uppsala C").
- Data: Trafikverkets `TrainAnnouncement` (samma nyckel). Servern hämtar
  stationsanropen sedan förra hämtningen, högst en gång per minut, och sparar
  det senaste per tåg i tre timmar; stationsnamnen hämtas en gång per dygn.
  Misslyckas en hämtning behålls de senaste förseningarna och positionerna
  påverkas inte. I kväll hade 199 av 203 tåg en försening kopplad.

### 2026-11-04 (svenskt gränssnitt)
- Appen finns nu på svenska: alla ca 3 000 texter i `src/i18n/locales/sv.json`.
  Webbläsare på svenska får svenska direkt; annars väljs Svenska under
  språkknappen (globen nere till höger) eller med `?lang=sv` i adressen.
- Stil och ordlista står i `docs/translations/sv.md` (t.ex. lager, flöde, luftfartyg,
  fartyg, tagning, förval, väglag, notis). Imperativ utan "du", sammansatta ord
  ihop, decimalkomma och mellanslag före enheter och %. Siffror och datum
  formateras svenskt av webbläsaren (−0,8 °C).
- Med svenska som språk visar SMHI-varningarna SMHI:s egen svenska text.
- 157 texter är medvetet samma som på engelska (koder som HDG och FOV,
  produktnamn, städer, musikgenrer, ord som stavas likadant); de står under
  `sv` i `src/i18n/same-as-english.json`.
- Några långa etiketter kortades så att de får plats, t.ex. VISUELLA FÖRVAL.

### 2026-11-04 (Polisens händelser)
- Nytt lager "Police Events (Sweden)" under Events: Polisens 500 senaste
  händelsenotiser (öppna data, ingen nyckel, källa Polismyndigheten) som prickar
  färgade efter kategori: våld och hot, trafik, bränder och olyckor, stöld och
  skadegörelse, narkotika och fylleri, försvunna personer, övrigt. Knappar för
  24 H (standard), 3 DAYS och ALL (ca 10 dagar); länens natt- och
  kvällssammanfattningar ligger bakom SUMMARIES.
- Polisens API ger bara länets mittkoordinat. Kommunen står däremot sist i
  rubriken ("… Trafikolycka, Göteborg"), så servern placerar varje notis vid
  kommunens centralort ur en tabell över alla 290 kommuner (genererad från
  Wikidata, CC0). Flera notiser på samma ort sprids i en spiral runt centralorten
  så att alla går att klicka på; notiser för hela länet har vit ring och ligger i
  länets mitt. Kortet säger rakt ut att platsen är ungefärlig.
- Klick på en prick ger rubrik, sammanfattning, tid och länk till notisen på
  polisen.se. Notiserna är preliminära och publiceras ofta några timmar efteråt.
- Delningskod `0x`. Röststyrningen hoppar över lagret, som för de andra svenska
  lagren.

### 2026-11-04 (SMHI:s vädervarningar)
- Nytt lager "Weather Warnings (Sweden)" under Weather, direkt under Rain radar: SMHI:s
  konsekvensbaserade vädervarningar (CC BY 4.0, ingen nyckel) som ytor i gult, orange
  och rött. Varningar som inte börjat än ritas blekare med streckad kant (knapp UPCOMING).
  SMHI:s meddelanden, t.ex. risk för vattenbrist, höga flöden och brandrisk, ligger bakom
  knappen MESSAGES eftersom de ofta täcker hela län i veckor.
- Klick på en yta ger ett kort med nivå och händelse, område och län, tidsfönster,
  "Vad händer?" och första rådet ur "Vad ska jag tänka på?". Texten är på svenska när
  appen är på svenska och annars på engelska (SMHI skriver båda). Klick på kortet öppnar
  SMHI:s varningssida.
- Servern hämtar SMHI:s varnings-JSON var 5:e minut (`/api/smhi-warnings`) och visar
  senaste läget som inaktuellt i upp till en timme om SMHI inte svarar.
- Delningskod `0y`. Röststyrningen hoppar över lagret, som för vägvädret.

### 2026-11-04 (vägväder)
- Nytt lager "Road Weather (Sweden)" under Events, direkt under väglaget: Trafikverkets
  ca 830 vägväderstationer (samma nyckel som kamerorna, CC0). Prickarna färgas efter
  vägbanans temperatur (knapp AIR byter till lufttemperatur) i klasserna ≤ −10, −10…−5,
  −5…0, 0…+3, +3…+8 och över +8 °C. Inzoomat skrivs temperaturen bredvid varje station
  (knapp VALUES).
- Vit ring = halkrisk, appens egen bedömning: vägbanan ≤ 0 °C och kallare än daggpunkten
  (rimfrost) eller nederbörd på den, eller is/snö uppmätt av en vägbanesensor när vägen
  är högst +1 °C. Knappen ICE RISK ONLY visar bara de stationerna.
- Klick på en station ger ett kort med vägbana, luft, daggpunkt, fukt, vind och byar,
  nederbörd senaste 30 min, sikt under 10 km, vägbanesensorns läge och friktion (där den
  finns) och mättid. Data uppdateras var 5:e minut; stationer utan mätning på 6 timmar
  visas inte.
- Svenska lager får delningskoder bakifrån i serien `00`–`0z`: vägväder är `0z`, nästa blir
  `0y`, `0x` … Originalets nästa lager tar `00`, `01` …, så de krockar inte på länge.
  (Koder längre bak, som `zz`, skulle göra varje delningslänk ~170 byte längre.)
- Röststyrningen hoppar över vägvädret: originalets röstprompt är redan vid sin
  storleksgräns, precis som för deras eget luftrumslager.
- Trafikverkets gemensamma serverdel (nyckel, cache, stale-läge) ligger nu i
  `server/providers/trafikverketProxy.js` och delas av väglag och vägväder.

### 2026-11-04 (synk med originalet, kväll)
- 28 nya commits från originalet: kameradata för Bosch MIC, infrastrukturlagrets
  markprovtagning och rättade översättningar för textchatten. Språkfilerna krockade
  bara där båda sidor lagt till texter sist; de slogs ihop nyckel för nyckel.

### 2026-11-04 (OPERA-radar för Europa)
- Ny radarknapp "Europe" i Rain radar: EUMETNETs OPERA-komposit av ett 150-tal
  europeiska väderradarer (CC BY 4.0, ingen nyckel), var 5:e minut med ~4 minuters
  fördröjning. Fyller luckorna utanför SMHI:s täckning – norska kusten, Finland,
  Danmark, Baltikum – och resten av Europa. Nordics (SMHI) är fortfarande standard.
- Servern läser OPERA:s GeoTIFF (1 km, Lambert azimutal ytriktig projektion),
  krymper till 2 km med starkaste ekot per ruta och räknar om till
  latitud/longitud; samma färgklasser som SMHI från 5 dBZ och samma tunna
  täckningslinje.
- Skillnad mot SMHI: OPERA visar starkaste ekot på någon höjd, så nederbörd i
  luften som inte når marken syns också (t.ex. runt fronter) och bilden kan se
  blötare ut. I fjällen ser norska radarer också skurar som svenska radarer
  skjuter över. OPERA:s regnintensitetsprodukt (RATE) provades men kommer bara
  var 15:e minut och stämde inte bättre med SMHI.
- Delningslänk: `lo=v.p.e` (Europe), `v.p.n` (Nordics), `v.p.u` (USA).

### 2026-11-04 (radarns täckningsgräns)
- En tunn ljus linje markerar kanten på SMHI:s radartäckning. Innanför betyder
  "inget" uppehåll; utanför (t.ex. Norges väst- och nordkust, östra Finland) finns
  ingen data. Jämfört med MET Norways nordiska radarbild: över Sverige stämmer
  SMHI-bilden (nästan torrt 2026-11-04 förmiddag); skurarna längs norska kusten
  ligger utanför SMHI:s räckvidd.

### 2026-11-04 (SMHI-radar)
- Ny radarprodukt "Rain radar · Nordics" från SMHI:s öppna radarkomposit, standard
  i radarlagret (knapp för USA finns kvar). Servern räknar om SMHI:s bild från
  SWEREF 99 TM till latitud/longitud, tar bara med färgade nederbördspixlar och
  bygger tidslinjen av de senaste 13 bilderna (en timme, var 5:e minut).
- Teckenförklaring från SMHI:s färgklasser (5–55+ dBZ); källangivelse SMHI (CC BY 4.0).

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
