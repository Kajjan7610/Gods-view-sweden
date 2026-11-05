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
| Kollektivtrafikstörningar: de regionala trafikbolagens aktuella störningar vid de hållplatser de gäller (stängd/trafikeras inte, flyttad, övrigt) | Trafiklab GTFS Regional ServiceAlerts (befintlig nyckel `TRAFIKLAB_GTFS_RT_KEY`) | Transit Disruptions (Sweden) / Kollektivtrafikstörningar, under Events |
| Sjöväder: ca 160 stationer längs kusten, i Vänern, Vättern, Mälaren och kanalerna (vind, byvind, vattenstånd, vattentemperatur, vågor) | Sjöfartsverket ViVa, ingen nyckel | Sea Weather (Sweden) / Sjöväder, under Weather |
| Norrskensprognos: chans för norrsken rakt ovanför (NOAA OVATION) som lysande band på 110 km höjd, Kp-index och chansen över nio svenska orter | NOAA SWPC (fri data, ingen nyckel) | Aurora Forecast / Norrskensprognos, under Weather |
| Väder nu: ca 185 SMHI-stationer (temperatur, vind, byar, nederbörd senaste timmen) och SMHI:s prognos för platsen vid klick | SMHI metobs och prognos snow1g (CC BY 4.0, ingen nyckel) | Weather Now (Sweden) / Väder nu, under Weather |
| Luftkvalitet: ca 75 SMHI-mätstationer (NO2, PM10, PM2.5, O3) på europeiska EAQI-skalan, tillsammans med Kanadas stationer | SMHI Datavärdskap luft (CC BY 4.0, ingen nyckel) | Air quality / Luftkvalitet, under Weather |
| Elpris per elområde (SE1–SE4), spotpris per kvart idag och imorgon | elprisetjustnu.se (Nord Pool-priser, ingen nyckel) | Electricity Prices (Sweden), under Infrastructure |
| Kraftsystemet: flöden på de 14 förbindelserna till och mellan elområdena (pilar i flödesriktningen, MW), import/export per elområde och Sveriges produktion per kraftslag och förbrukning | Svenska kraftnät, Kontrollrummet (ingen nyckel) | Power Grid (Sweden) / Kraftsystemet, under Infrastructure |
| Vattenföring: ca 150 SMHI-stationer i vattendragen, flöde i m³/s var 15:e minut och om det stiger eller sjunker | SMHI hydrologiska observationer (CC BY 4.0, ingen nyckel) | River Flow (Sweden) / Vattenföring, under Weather |
| Strålning: Strålsäkerhetsmyndighetens gammastationer (ca 25 i drift) med senaste timmens dosrat i µSv/h på SSM:s egen färgskala | Strålsäkerhetsmyndighetens gammastationskarta (ingen nyckel, ingen angiven licens; SSM anges som källa) | Radiation (Sweden) / Strålning, under Infrastructure |
| Stadsdossier: när vyn stannar lågt över en svensk ort visar panelen STAD i högerkanten stadsvapen, foto och inledning, tätortens och kommunens folkmängd med kurva, skattesats, inkomst, arbetslöshet och kommunvalet, samt läget just nu (väder, luft, varningar, Polisen, sol) och en knapp för lokalradio | Kolada (RKA), Wikidata (CC0), Wikipedia (CC BY-SA 4.0), SMHI, Polisen; ingen nyckel | Panelen STAD i högerkanten (dyker upp vid första besöket) |
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

### 2026-11-05 (flyg och säkerhetskontroll i stadsdossiern)
- Fliken NU visar nu flyg för städer inom 45 km från någon av Swedavias tio
  flygplatser (högst två, den största först – Stockholm får Arlanda och
  Bromma): nästa fyra avgångar och ankomster med destination, tid,
  Swedavias status (beräknad, planerad, inställt), flygbolag, terminal och
  gate. Sent på kvällen fortsätter tavlan på morgondagens flyg, märkta
  "i morgon".
- På Arlanda, Landvetter och Bromma visas även beräknad kö i
  säkerhetskontrollen per terminal (orange från 15 minuter).
- Nycklar: `SWEDAVIA_FLIGHTINFO_KEY` och `SWEDAVIA_WAITTIME_KEY` (gratis på
  apideveloper.swedavia.se, ca 10 000 anrop i månaden var). Svaren sparas
  fem minuter per flygplats och varje nyckel stannar vid 320 anrop per dygn;
  därefter visas senast hämtade tavla. Utan nyckel syns inget flyg.
- Källraden i panelen nämner nu Trafikverket, TomTom och Swedavia när
  deras uppgifter visas.

### 2026-11-05 (synk, utökad tur och mobil)
- Synk med originalet: 18 nya commits (bussar och BRT i Rio de Janeiro,
  leverantörens namn i Kontakter- och Cockpit-räknarna). Konflikterna i
  README och kollektivtrafikens flödeslista löstes genom att behålla båda.
- Turen "Sverige just nu" har två nya bilder före Arlanda: vattenföring i
  Norrland och strålningsövervakning (nu nio bilder, ca 85 s). Ett sparat
  scenprojekt där turen inte redigerats får de nya bilderna automatiskt;
  en redigerad tur lämnas orörd.
- Mobil: panelen STAD visas nu i Kontext-bladet (den saknade regler och
  blev osynlig på telefon) och tar sin egen höjd där; titelkortet vid
  ankomst ligger ovanför flikraden.

### 2026-11-05 (besökspass och filmisk ankomst)
- Stadsdossiern har en femte flik, PASS. Varje svensk ort du besöker får
  en stämpel som sparas i webbläsaren, och fliken visar hur många av de
  290 kommunerna du besökt, fyra utmaningar med förloppsstapel (alla 21
  residensstäder, en ort i varje län, tre orter norr om polcirkeln, alla
  kommuner) och de senaste stämplarna med datum.
- "Visa min resa på kartan" ritar stämplarna som guldpunkter på globen,
  sammanbundna i den ordning du besökte dem.
- Filmisk ankomst: första besöket i en ort ger ett titelkort (namn,
  invånare, grundår, län) och kameran cirklar långsamt ett varv runt
  centrum. Ett klick, en tangent, scrollhjul, en annan flygning, en scen
  eller cockpit avbryter direkt. Kan stängas av i PASS-fliken.
- Startvyn och delade länkar räknas inte som resor: under appens första
  20 sekunder ges ingen stämpel och ingen ankomst.
- Dossierns faktadel sparas bara tio minuter (i stället för ett dygn) när
  någon källa inte svarade, och servern loggar vilken.

### 2026-11-05 (tåg och köer i stadsdossiern)
- Fliken NU visar nu de sex nästa avgångarna från stadens station
  (Trafikverket: centralstationen före andra, inom 8 km) med destination,
  spår, tågtyp, beräknad tid och försening samt Trafikverkets orsak, och
  inställda tåg markerade. "Spår x" (ersättningsbuss) döljs.
- Under "Köer runt staden" listas de tre köer inom 12 km som ger störst
  fördröjning (TomTom Traffic Incidents): väg, längd, extra minuter och
  sträcka. Kräver TomTom-nyckeln; utan den visas inget avsnitt.
- Flikens delar visas var för sig så fort de kommer fram, i stället för
  att vänta på genomgångens väder (som också hämtar nyheter och kan ta
  över 10 sekunder).

### 2026-11-05 (stadsdossiern med senaste siffrorna)
- Tätortens folkmängd kommer nu från SCB:s årliga tabell inom senaste
  tätortsgränsen, t.ex. Gävle 86 981 (2025) i stället för Wikidatas
  86 533 (2023).
- Kommunens folkmängd, kvinnor och män kommer från SCB:s månadsstatistik,
  t.ex. Gävle 104 008 (augusti 2026). Kolada är kvar som reserv och för
  tioårskurvan.
- Kommunvalet är 2026 års slutliga resultat från Valmyndigheten, med
  valdeltagande. Lokala partier på minst 3 % visas med namn (t.ex.
  Skärgårdspartiet i Värmdö), övriga summeras. Valmyndigheten har bara
  Excel-filer, så servern hämtar den en gång (ca 11 MB), packar bara upp
  de två kommunbladen och sparar resultatet i `.gev-cache/city-dossier/`.
  SCB har ännu inte lagt in valet 2026 i sitt API.
- Wikipedias inledning kan fortfarande nämna äldre siffror; den texten är
  Wikipedias egen.

### 2026-11-05 (stadsdossier)
- Ny panel STAD i högerkanten. När kameran stannar under 80 km höjd och
  mitten av vyn ligger inom 2 mil från en svensk kommuns centralort visar
  den orten i fyra flikar:
  - OM STADEN: stadsvapen, foto och inledning från Wikipedia (med
    källangivelse och länk), grundår och höjd över havet (Wikidata).
  - BEFOLKNING: tätortens och kommunens folkmängd, kvinnor/män,
    medelålder och en kurva över de senaste tio åren (Kolada).
  - SAMHÄLLE: skattesats, medianinkomst, arbetslöshet, valdeltagande och
    partiernas andelar i senaste kommunvalet som staplar (Kolada).
  - NU: väder och varningar (SMHI och Krisinformation via cockpitens
    genomgång), närmaste luftmätning, Polisens händelser i kommunen senaste
    dygnet, sol upp och ned (midnattssol och polarnatt i norr) och en knapp
    som spelar lokalradio.
- Panelen öppnas av sig själv första gången, som Senaste bilder.
  Faktadelen hämtas via `/api/city-dossier` och sparas ett dygn per kommun.
- Lokalradion söker först "P4 <stad>", sedan "P4 <län>" och tar annars
  närmaste svenska station. Radiokatalogen innehåller bara P4 Stockholm
  och P4 Göteborg, så de flesta städer får närmaste av dem.
- Wikidata-uppslaget tar den föredragna folkmängdsuppgiften (Stockholm har
  en per kommundel) och provar flera namn på centralorten (t.ex.
  "Salemstaden" och "Salem").

### 2026-11-05 (vattenföring från SMHI)
- Nytt lager "Vattenföring (Sverige)" (delningstoken `0o`), under Väder:
  SMHI:s mätstationer i vattendragen (vid testet 154), med storlek och
  färg efter senaste kvartens flöde (under 1, 1–10, 10–50, 50–150 och
  150 m³/s eller mer) och flödet skrivet bredvid de största. Ett klick
  ger ett kort med flödet, om det stigit, sjunkit eller legat still
  senaste timmen, vattendrag och avrinningsområde samt mättid.
- En enda förfrågan till SMHI:s hydrologi-API ger alla stationer, högst
  var 15:e minut och bara när lagret frågar. Vattenstånd och
  vattentemperatur finns inte för alla stationer på en gång i API:t och
  visas därför inte.

### 2026-11-05 (strålning från Strålsäkerhetsmyndigheten)
- Nytt lager "Strålning (Sverige)" (delningstoken `0p`), under
  Infrastruktur: Strålsäkerhetsmyndighetens gammastationer, det nationella
  varningsnätet, med senaste timmens omgivningsdosrat i µSv/h. Färgerna är
  SSM:s egen skala, värdet står bredvid varje station och ett klick ger ett
  kort med värdet, den normala bakgrunden i Sverige (0,05–0,3 µSv/h) och
  mättiden. Stationer i service visas grå; flyttade stationer som tystnat
  i tre dagar tas bort (vid testet 23 aktiva, 2 i service).
- Källan är det GeoJSON-dokument SSM:s öppna karta läser
  (karttjanst.ssm.se/gammastationer). Ingen nyckel, men ingen licens anges,
  så SSM anges som källa med länk. EURDEP valdes bort: där tillhör datan
  varje land och kräver skriftligt tillstånd.

### 2026-11-05 (scenen "Sverige just nu")
- Scener: ny inbyggd tur, "Sverige just nu" (ca 65 s, sju bilder), sist i
  scenlistan. Den visar SMHI:s varningar över landet, väder nu, tåg och
  störningar runt Stockholm, elflöden mellan elområdena, norrsken över
  Kiruna, sjöväder i skärgården och till sist planen runt Arlanda. Varje
  bild tänder sitt eget lager och släcker de andra. Ett sparat scenprojekt
  får turen automatiskt efter "Omniscience Pullback". Scener kan inte följa
  ett plan eller gå in i cockpit (originalets scenspelare stänger av
  spårning under uppspelning), så turen slutar ovanför Arlanda. Bilden med
  tåg väntar några sekunder första gången medan kollektivtrafiken laddas,
  och norrskenet syns bara när det är mörkt.

### 2026-11-05 (svensk lägesbild i cockpiten)
- Cockpit: när planet är inom 50 km från en svensk kommuns centralort
  hämtar genomgången svenska källor. Plats blir orten och länet (t.ex.
  "Kopparberg, Örebro län") i stället för originalets grova naturområde
  ("Northern European Plain"). Temperatur, vind, himmel och nederbörd
  kommer från SMHI:s punktprognos för aktuell timme ("Väderdata från
  SMHI"). Lokalt-sidan listar SMHI-varningar som gäller där planet är och
  VMA i hela landet eller inom 10 mil, annars "Inga varningar gäller".
  Nyheterna söks på svenska, senaste veckan och nyast först (SVT, SR,
  lokaltidningar). Sveriges Radios eget API provades men har inga färska
  lokala nyheter för de flesta P4-regioner. Utanför Sverige är allt som
  i originalet.
- Synk med originalet: inget nytt sedan förra synken. Hämtningen av
  originalet tar nu bara `main`; originalets sidogrenar saknade objekt och
  fick `git fetch` att avbrytas.

### 2026-11-05 (cockpit direkt från ett klickat plan)
- Cockpit: när ett plan är valt visas en COCKPIT-knapp nere till höger vid
  kartan. Ett klick (eller `C`) slår på Kontakter om det är avstängt och går
  direkt in i cockpit på samma plan, precis som röstkommandot "Enter
  cockpit". Misslyckas det stängs Kontakter igen. I originalet låg knappen
  bara i Kontext → Kontakter, och `C` gjorde ingenting förrän Kontakter var
  på. Originalets test som kräver att knappen saknas är ändrat därefter.

### 2026-11-05 (klickkort för luftkvalitetsstationer)
- Luftkvalitet: ett klick på en stations ring öppnar nu ett kort med
  stationens namn, EAQI-värde och hälsorisk, de uppmätta halterna
  (t.ex. "NO2 4.9 · PM10 12.9 µg/m³"), mättiden och källan (SMHI eller ECCC).
  Klick på tom mark stänger kortet; det uppdateras vid ny data och stängs om
  stationen slutar rapportera. Originalet hade inget kort för stationerna.
- Radbrytningen `foldText` ligger nu i `src/ui/cardText.js` så att
  luftkvalitetspaketet kan använda den utan att dra med SMHI-varningarnas
  moduler; SMHI-varningarna, Polisen, Sveriges Radio och störningslagret
  importerar den därifrån.

### 2026-11-05 (luftkvalitetslistan räknar det som syns på skärmen)
- Luftkvalitet: listan "sämsta mätningarna i vyn" missade stationer nära
  skärmens överkant. Cesiums vyrektangel provar bara skärmens fyra hörn, och på
  en glob når mitten av överkanten längre norrut än hörnen (vid testet slutade
  rektangeln vid 64,9° N fast Luleå och Piteå på 65,3–65,6° N syntes). Listan
  tar nu med de stationer vars punkt ligger inom bilden och på globens synliga
  sida.

### 2026-11-05 (luftkvalitetslistan följer kameran)
- Luftkvalitet: Väder-kortets lista "sämsta mätningarna i vyn" räknades bara om
  när ny data kom (var 20:e minut), så den kunde visa Stockholm när man tittade
  på Gävle. Listan räknas nu om varje gång kameran har stannat. (Felet finns i
  originalet men märktes först när svenska stationer kom till.)

### 2026-11-05 (störningskortet radbryts)
- Kollektivtrafikstörningar: kortets rader radbryts inte av sig själva, så ett
  långt meddelande blev en enda rad som gick utanför skärmen åt båda håll.
  Rubrik och meddelandetext viks nu till rader om högst 80 tecken (rubrik högst
  2, text högst 3 rader), som SMHI-varningarna och Polisens händelser redan gör.

### 2026-11-05 (kollektivtrafikstörningar från Trafiklab)
- Nytt lager "Kollektivtrafikstörningar (Sverige)" under Events: de 16
  regionala trafikbolagens aktuella störningar (GTFS-RT ServiceAlerts) som
  punkter vid de hållplatser de gäller. Rött = hållplats stängd eller
  trafikeras inte, gult = flyttad, blått = annan störning. Klick visar
  trafikbolagets meddelande och hur länge det gäller.
- Använder den befintliga nyckeln `TRAFIKLAB_GTFS_RT_KEY` (ingen ny nyckel).
  Hämtas högst var 15:e minut och bara när lagret är på, ca 64 anrop i timmen
  av nyckelns månadskvot.
- Hållplatsernas lägen kommer ur trafikbolagens statiska GTFS (`stops.txt`) i
  samma nedladdning som linjenumren, så lagret kostar inga extra statiska
  nedladdningar framöver. De statiska nedladdningarna görs nu en i taget
  (Trafiklab svarade 429 på många samtidiga), och en tom koordinat i
  `stops.txt` räknas som saknad i stället för 0.
- Hallandstrafiken har inget störningsflöde (404) och visas därför utan
  störningar. Delningskod `0q`.
- Första körningen: Trafiklab svarade 429 på de statiska nedladdningarna för
  Skåne, Dalarna, Gävleborg och Västernorrland (nyckelns kvot). De behåller
  sina linjenummer och försöker igen efter 6 timmar; deras störningar syns
  när hållplatserna är hämtade.
### 2026-11-04 (kraftsystemet från Svenska kraftnät)
- Nytt lager "Kraftsystemet (Sverige)" under Infrastructure: en pil på var och
  en av de 14 förbindelserna till och mellan elområdena SE1–SE4 (och till
  Norge, Finland, Danmark, Tyskland, Polen och Litauen), i flödesriktningen och
  lika tjock som flödet, med MW utskrivet. Blått = mellan svenska elområden,
  grönt = in till Sverige, orange = ut från Sverige.
- Klick på ett elområde: import och export, varje förbindelses flöde, och
  Sveriges produktion (kärnkraft, vatten, vind, övrigt) och förbrukning just nu.
- Data: Svenska kraftnäts kontrollrum (samma tjänst som sidan
  svk.se/om-kraftsystemet/kontrollrummet använder, ingen nyckel) via
  `/api/power-grid`, högst var 5:e minut. Tjänsten är odokumenterad och har
  ingen publicerad licens; källan anges som Svenska kraftnät.
- Delningskod `0r`.
### 2026-11-04 (luftkvalitet i Sverige från SMHI)
- Lagret "Air quality" (Luftkvalitet) under Weather visar nu även svenska
  mätstationer, inte bara Kanada. Varje station får det europeiska
  luftkvalitetsindexet EAQI (1–6) efter sitt sämsta ämne av NO2, PM10, PM2.5
  och O3, och färgas med lagrets fyra band (1–2 låg, 3 måttlig, 4 hög, 5–6
  mycket hög). Kortet visar halterna, t.ex. "NO2 23,7 · PM10 12 µg/m³".
- Data: SMHI:s Datavärdskap luft (öppna data, CC BY 4.0, ingen nyckel) via
  `/api/air-quality-se`. SMHI har ca 1 300 serier för de fyra ämnena men de
  flesta är nedlagda, så servern letar upp de aktiva en gång i veckan (tar ett par
  minuter, sparas i `.gev-cache/smhi-air-quality-series.json`)
  och hämtar sedan bara dem, högst var 15:e minut. Första gången lagret slås
  på visas Kanada direkt och Sverige när sökningen är klar.
- EAQI räknas här på timvärden för alla fyra ämnena (EEA använder
  dygnsmedel för partiklar), så partikelvärdena kan slå något snabbare.
- Kanada (ECCC AQHI) ligger kvar. Faller ett av nätverken visas det andra.
### 2026-11-04 (väder nu och prognos från SMHI)
- Nytt lager "Väder nu (Sverige)" under Weather: SMHI:s ca 185 väderstationer med
  senaste timvärdet, färgade efter lufttemperatur (knapp VIND byter till
  medelvind). De kallaste (eller blåsigaste) värdena skrivs ut (knapp VÄRDEN).
- Klick på en station: "Nu: +2,7 °C, vind 1,0 m/s, byar 2,0, 0,0 mm senaste
  timmen", sedan SMHI:s prognos för platsen – närmaste dygnet med väderikon,
  lägsta/högsta temperatur, byar och nederbörd – och de tre följande dagarna.
- Data: SMHI metobs (fyra parametrar, var 10:e minut) och SMHI:s nya
  punktprognos snow1g (som ersatt pmp3g), båda CC BY 4.0 utan nyckel. Prognosen
  hämtas först när man klickar och sparas en halvtimme per plats.
- Delningskod `0s`. Punkt 2 och 3 från listan blev samma lager.

### 2026-11-04 (norrskensprognos)
- Nytt lager "Norrskensprognos" under Weather: NOAA:s OVATION-modell, chansen för
  norrsken rakt ovanför den närmaste halvtimmen, som ett mjukt lysande band på
  110 km höjd (där norrskenet lyser) över norra halvklotet. Grönt från ca 5 %,
  gult från 30 %, rött från 50 %.
- Panelen visar Kp-index (0 lugnt – 9 extrem storm) och chansen över Kiruna,
  Luleå, Umeå, Östersund, Sundsvall, Västerås, Stockholm, Göteborg och Malmö.
- Fri amerikansk data (NOAA SWPC), ingen nyckel, uppdateras var 10:e minut.
  Delningskod `0t`. I kväll: Kp 1,7, 22 % över Kiruna.

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
