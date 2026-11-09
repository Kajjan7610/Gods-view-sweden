# God's Eye View – Sverige

Fork av [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
med svenska öppna data, av Kaj Obst. `README.md` har ett svenskt block med bilder
överst; resten av originalets README lämnas orört så att uppdateringar från
originalet går att slå ihop. Allt svenskt beskrivs i detalj här.

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
| Kraftsystemet: flöden på de 14 förbindelserna till och mellan elområdena (rörliga vinklar i flödesriktningen, MW), Sveriges import, export och netto totalt och per grannland, val av import/export/inrikes och en knapp per land som lyfter fram dess förbindelser, en KRAFT-panel i högerkanten med dygnet hittills eller senaste veckan per kvart (produktion per kraftslag, förbrukning och utbyte), import/export per elområde och Sveriges produktion per kraftslag och förbrukning | Svenska kraftnät, Kontrollrummet (ingen nyckel) | Power Grid (Sweden) / Kraftsystemet, under Infrastructure |
| Vattenföring: ca 150 SMHI-stationer i vattendragen, flöde i m³/s var 15:e minut och om det stiger eller sjunker | SMHI hydrologiska observationer (CC BY 4.0, ingen nyckel) | River Flow (Sweden) / Vattenföring, under Weather |
| Butikskedjor: ICA:s, Coops, Axfoods (Willys, Hemköp), Lidls, City Gross och Systembolagets butiker samt apoteken hos Apotek Hjärtat (ICA Gruppen), Apoteket, Kronans Apotek, Apoteksgruppen och DOZ Apotek, färgade efter företag och koncept, med en knapp per företag; klick ger adress, om butiken är öppen nu, kartlagd storlek, webbsida, telefon, rullstol och paketombud, hur många som bor inom 2 km, närmaste hållplats, närmaste andra kedjor och företaget (org.nr och huvudkontor); klick på kortet öppnar butikens webbsida. Bara butiker, inga lager eller kontor. | OpenStreetMap (ODbL) som ögonblicksbild i repot, företagsfakta från Wikidata (CC0), befolkning från SCB:s 1 km-rutor (CC0) | Retail Chains (Sweden) / Butikskedjor, under Infrastructure |
| Brandstationer: räddningstjänstens 841 stationer, färgade efter högsta beredskapsform (heltid, deltid med eller utan första insatsperson, räddningsvärn) | Myndigheten för civilt försvar (MCF), INSPIRE-nedladdningstjänst (ingen nyckel; EU-värdefullt dataset, MCF anges som källa) | Fire Stations (Sweden) / Brandstationer, under Infrastructure |
| Polisstationer: Polisens 261 stationer, färgade efter vad receptionen erbjuder (pass och id-kort, andra ärenden, inga angivna); klick ger adress, tjänster och närmaste passexpedition, klick på kortet öppnar stationens sida med öppettider | Polismyndighetens öppna data (ingen nyckel; Polisen anges som källa) | Police Stations (Sweden) / Polisstationer, under Infrastructure |
| Skyddsrum: MCF:s cirka 63 000 skyddsrum med 6,8 miljoner platser, i vyn när man zoomat in (de 1 500 närmaste kartans mitt), storlek efter platser; de fem närmaste listas klickbart i raden; klick ger fastighet, platser och om skyddsrummet har tillfällig begränsning | Myndigheten för civilt försvar (MCF), INSPIRE (ingen nyckel, inga villkor) | Shelters (Sweden) / Skyddsrum, under Infrastructure |
| Sjukhus och akuter: cirka 120 sjukhus, där de 62 akutmottagningarna i Socialstyrelsens statistik för 2025 färgas efter mediantid till läkare eller total vistelsetid jämfört med rikets (61 min respektive 4 h 16 min); raden listar de fem närmaste akutmottagningarna eller de med kortast median i vyn, klickbart; kortet visar medianerna 2025 och 2024, besök och förändring, och "ring 112 / 1177". Årsmedianer för vuxna, inte aktuell väntetid (öppna livetider finns inte i Sverige). | Socialstyrelsen, Patientregistret (faktablad 2026-6-10339), och OpenStreetMap (ODbL) som ögonblicksbild i repot | Hospitals & Emergency (Sweden) / Sjukhus och akuter, under Infrastructure |
| Kommuner och län: gränserna för alla 290 kommuner och 21 län som linjer på marken (länsgränser gula och tjockare, gränser till havs utelämnade), namnen följer vyn (län på hög höjd, kommuner närmare), kartans mitt i raden med kommun, län och folkmängd; klick på en kommun markerar den och visar län, folkmängd med förändring på ett år och kommunkod | OpenStreetMap (ODbL) som ögonblicksbild i repot; folkmängd per månad från SCB (TAB6473, CC0) | Municipalities & Counties (Sweden) / Kommuner och län, under Infrastructure |
| Blixtnedslag: varje urladdning den senaste timmen som punkt, färgad efter ålder (vit = senaste 5 min), stora för nedslag i marken och små för blixtar i molnet; klick ger tid, typ och toppström | DMI:s blixtdata (CC BY 4.0, ingen nyckel; DMI:s sensornät och grannländernas sensorer) | Lightning Strikes (Sweden) / Blixtnedslag, under Weather |
| Blixtar över Europa och Afrika var 5:e minut, sedda från EUMETSAT:s vädersatellit MTG | EUMETSAT EUMETView (ingen nyckel, ingen avgift) | Lightning density / Blixttäthet, under Weather (knapp Europa, standard) |
| Strålning: Strålsäkerhetsmyndighetens gammastationer (ca 25 i drift) med senaste timmens dosrat i µSv/h på SSM:s egen färgskala | Strålsäkerhetsmyndighetens gammastationskarta (ingen nyckel, ingen angiven licens; SSM anges som källa) | Radiation (Sweden) / Strålning, under Infrastructure |
| Stadsdossier: när vyn stannar lågt över en svensk ort visar panelen STAD i högerkanten stadsvapen, foto och inledning, tätortens och kommunens folkmängd med kurva, skattesats, inkomst, arbetslöshet och kommunvalet, samt läget just nu (väder, luft, varningar, Polisen, sol) och en knapp för lokalradio | Kolada (RKA), Wikidata (CC0), Wikipedia (CC BY-SA 4.0), SMHI, Polisen; ingen nyckel | Panelen STAD i högerkanten (dyker upp vid första besöket) |
| Stadsdossierns flikar Sevärt (slott, kyrkor, museer m.m. utpekade på kartan), besökspass, tåg från stadens station, köer runt staden, VMA-banner och norrsken i natt | Wikidata (CC0), Trafikverket, TomTom, Krisinformation.se, NOAA SWPC | Panelen STAD |
| Flygtavla: Swedavias tio flygplatser, hela dagens avgångar och ankomster, köerna i säkerhetskontrollen över terminalerna, följ planet i luften och dagens rutter på globen | Swedavia FlightInfo och WaitTime (gratisnycklar) | Kortet över en Swedavia-flygplats och tavlans egen panel |
| Flygväder: METAR och TAF för flygplatserna | NOAA Aviation Weather Center (ingen nyckel) | Flygtavlan och cockpit |
| Cockpit: knapp vid kartan och C-tangenten när ett plan, fartyg eller en satellit är valt, Swedavias rader för planet, svensk lägesbild i genomgången (ort och län, SMHI:s väder, varningar och VMA) | Swedavia, SMHI, Krisinformation.se, NOAA (METAR/TAF) | Cockpit |
| Fartkameror: ca 2 800 fasta trafiksäkerhetskameror som pilar i kamerans riktning, och de närmaste i dossiern | Trafikverket (CC0) | Speed Cameras (Sweden), under Infrastructure, och NU-fliken |
| Sverige-turen "Sverige just nu" | Lagren ovan | Scener |
| Sparläge: starta utan Google 3D Tiles | – | Knappen 3D/2D, eller `?globe=lite` |
| Svenskt gränssnitt (alla ca 3 000 texter) | Egen översättning, `src/i18n/locales/sv.json` | Språkknappen nere till höger, eller `?lang=sv` |

Trafikverkets och Trafiklabs data är CC0 1.0; SMHI:s radar och varningar samt OPERA:s radar är CC BY 4.0 (källa: SMHI respektive EUMETNET OPERA). Källor, villkor och tekniska detaljer står i
[DATA_SOURCES.md](DATA_SOURCES.md).

## Källor och omfattning per lager

<!-- källor:start (scripts/sweden-sources.mjs) -->

Genereras ur `src/ui/layerProvenance.js`, samma tabell som Datalager visar
under ⓘ. SE = vårt eget lager; +SE = originalets lager där vi lagt till
svenska data. Ändra i tabellen och kör `node scripts/sweden-sources.mjs`.

| | Lager | Källa | Omfattning | Uppdateras | Licens |
|---|---|---|---|---|---|
| +SE | Kollektivtrafik | Trafiklab (Samtrafiken) · Trafikverket | Bussar, tunnelbana, spårvagn och pendeltåg från 16 regionala trafikbolag, och tåg med förseningar. Originalet: Öppna GTFS-RT-flöden i USA, Kanada, Finland, Nederländerna, Norge, Australien och Brasilien | Var 15:e sekund | CC0 1.0 (Trafiklab, Trafikverket) |
| +SE | Kameror | Trafikverket | Cirka 1 550 vägkameror med livebilder. Originalet: Offentliga trafikkameror i många länder | Bilderna uppdateras medan de visas | CC0 1.0 (Trafikverket) |
| SE | Fartkameror (Sverige) | Trafikverket | Cirka 2 800 fasta fartkameror i hela Sverige | Varje timme | CC0 1.0 |
| SE | Elpris (Sverige) | elprisetjustnu.se · Nord Pool | Spotpris per kvart i elområdena SE1–SE4 | Varje minut | Öppna data, källan anges |
| SE | Kraftsystemet (Sverige) | Svenska kraftnät | Sveriges förbindelser mellan elområdena och till grannländerna | Varannan minut | Ingen angiven licens; källan anges |
| SE | Strålning (Sverige) | Strålsäkerhetsmyndigheten (SSM) | Cirka 25 gammastationer | Var 10:e minut | Ingen angiven licens; källan anges |
| SE | Brandstationer (Sverige) | Myndigheten för civilt försvar (MCF) | Räddningstjänsternas alla brandstationer | En gång per dygn | EU-värdefullt dataset, källan anges |
| SE | Polisstationer (Sverige) | Polismyndigheten | Alla polisstationer, cirka 260 | En gång per dygn | Öppna data, källan anges |
| SE | Skyddsrum (Sverige) | Myndigheten för civilt försvar (MCF) | Alla skyddsrum, cirka 63 000 med 6,8 miljoner platser | En gång per dygn | Inga tillämpliga villkor (INSPIRE) |
| SE | Sjukhus och akuter (Sverige) | Socialstyrelsen · OpenStreetMap | Cirka 120 sjukhus; väntetidsmedianer för de 62 akutmottagningarna i statistiken | Årlig statistik; ögonblicksbild i appen, byggs om för hand | Statistiken fri att använda med källa (Socialstyrelsen) · ODbL (OpenStreetMap) |
| SE | Kommuner och län (Sverige) | OpenStreetMap · SCB | Alla 290 kommuner och 21 län, med folkmängd per månad | Ögonblicksbild i appen, byggs om för hand | ODbL (OpenStreetMap) · CC0 1.0 (SCB) |
| SE | Butikskedjor (Sverige) | OpenStreetMap · Wikidata · SCB | Elva kedjors butiker och apotek i hela Sverige; kartlagda av frivilliga | Ögonblicksbild i appen, byggs om för hand | ODbL (OpenStreetMap) · CC0 1.0 (Wikidata, SCB) |
| SE | Väglag (Sverige) | Trafikverket | Väglag och aktuella händelser i hela Sverige | Var 3:e minut | CC0 1.0 |
| SE | Vägväder (Sverige) | Trafikverket | Cirka 830 vägväderstationer | Var 5:e minut | CC0 1.0 |
| SE | Polishändelser (Sverige) | Polismyndigheten | De 500 senaste notiserna, cirka tio dagar, hela Sverige | Var 5:e minut | Öppna data, källan anges |
| SE | Trafikmeddelanden (SR) | Sveriges Radio | Aktuella trafikmeddelanden i hela Sverige | Var 3:e minut | Öppna data, källan anges |
| SE | Kollektivtrafikstörningar (Sverige) | Trafiklab (Samtrafiken) | Störningar vid hållplatserna hos 16 regionala trafikbolag | Varannan minut | CC0 1.0 |
| +SE | Luftkvalitet | SMHI | Cirka 75 mätstationer på den europeiska EAQI-skalan. Originalet: Kanadensiska stationer (ECCC AQHI) | Var 20:e minut | CC BY 4.0 (SMHI) |
| +SE | Regnradar | SMHI · EUMETNET OPERA | Nordisk radar från SMHI och europeisk radar från OPERA. Originalet: Radar över USA (NOAA) | Var 5:e minut | CC BY 4.0 (SMHI, OPERA) |
| SE | Vädervarningar (Sverige) | SMHI · Krisinformation.se | Vädervarningar, VMA och krisnyheter i hela Sverige | Var 5:e minut | CC BY 4.0 (SMHI) |
| SE | Väder nu (Sverige) | SMHI | Cirka 185 väderstationer, och en prognos där du klickar | Var 10:e minut | CC BY 4.0 |
| SE | Sjöväder (Sverige) | Sjöfartsverket ViVa | Cirka 160 stationer längs kusten, i de stora sjöarna och kanalerna | Var 10:e minut | Öppna data, källan anges |
| SE | Vattenföring (Sverige) | SMHI | Cirka 150 stationer i vattendragen | Var 15:e minut | CC BY 4.0 |
| SE | Norrskensprognos | NOAA SWPC | Norra halvklotet, med chansen över nio svenska orter | Var 10:e minut | Allmän egendom (USA:s statsförvaltning) |
| +SE | Blixttäthet | EUMETSAT (MTG) | Blixtar över Europa och Afrika från satelliten MTG. Originalet: Blixttäthet över Nord- och Sydamerika (NOAA) | Var 5:e minut | Fri att använda, källan anges |
| SE | Blixtnedslag (Sverige) | DMI | Varje urladdning över Norden den senaste timmen | Varje minut | CC BY 4.0 |

<!-- källor:end -->

## Nycklar (`.env`, checkas aldrig in)

| Variabel | Används till | Var den skaffas |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | kameror, tåg, väglag, händelser | data.trafikverket.se |
| `TRAFIKLAB_GTFS_RT_KEY` | bussar m.m. live | trafiklab.se → GTFS Regional Realtime |
| `TRAFIKLAB_GTFS_STATIC_KEY` | linjenummer och fordonstyp | trafiklab.se → GTFS Regional Static |
| `SWEDAVIA_FLIGHTINFO_KEY` | avgångar och ankomster i dossiern, tavlan och cockpit | apideveloper.swedavia.se → FlightInfo Free |
| `SWEDAVIA_WAITTIME_KEY` | köerna i säkerhetskontrollen | apideveloper.swedavia.se → WaitTime Free |
| `CESIUM_ION_TOKEN` | fotorealistiska 3D-städer | ion.cesium.com |

Nycklarna kan klistras in i appen under **KOPPLA PÅ** (nere till höger); appen skriver då `.env` själv.

Utan nyckel hoppas respektive del över med en förklarande rad; inget annat slutar fungera.
Trafiklabs gratisnivå (Bronze) räcker till ungefär 125 timmars tittande på ett län i
månaden – begär den kostnadsfria Silver-uppgraderingen vid tyngre användning.

## Starta lokalt

Steg för steg, med Pinokio, Docker eller Node och de gratis nycklarna: [docs/KOM-IGANG.md](docs/KOM-IGANG.md).

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

### 2026-11-09 (kommuner och län: rättningar efter kodgranskning)
- Ett klick på ett annat lagers objekt (ett sjukhus, en kamera) markerar
  inte längre kommunen under det. Bara kartan själv och lagrets egna linjer
  räknas som mark (`scenePick.isSurfacePick`), och klickpunkten tas från ytan
  linjerna ligger på (`pickGroundPosition`) i stället för ellipsoiden.
- Ett klick på kommunens eget kort faller inte längre igenom och släcker
  markeringen: kortet är nu träffbart i etikettlagret.
- Med knappen Län släckt försvann även de kommungränser som råkar vara
  länsgränser, så kommunerna längs länsgränsen stod öppna. De ritas nu som
  kommungränser från en egen datakälla som fylls första gången den behövs.
  Namnen följer knapparna: är den ena sorten släckt visas den andra på alla
  höjder.
- Knapparna och kartbytet bygger inte längre om linjerna. Varje sorts linjer
  ligger i en egen datakälla som bara tänds och släcks, och vid byte mellan
  globen och 3D-tiles ändras bara linjernas yta, och bara medan lagret är på.
- Fem linjer som förenklingen krympt till en punkt ritas inte (1 787 + 411
  linjer i stället för 1 792 + 411).
- `setParams` gör ingenting medan lagret är av, och radens kartmitt nollas
  när lagret stängs av.
- Byggskriptet avbryter om SCB publicerar en ny månad mellan två anrop (annars
  kunde två perioder blandas under ett datum) och avkodar linjerna med lagrets
  egen `decodeLine`. SCB lägger från referensår 2025 brus på småtal (Cell Key
  Method), så ett län behöver inte vara exakt summan av sina kommuner; båda
  visas som SCB publicerar dem.
- Kvar att känna till: de flesta andra svenska lagers kort är inte träffbara,
  så ett klick på ett sådant kort kan fortfarande nå kommunen under det.
  Etiketter och kort står på höjd 0, och radens kartmitt räknas mot
  ellipsoiden.

### 2026-11-09 (kommuner och län)
- Nytt lager **Kommuner och län (Sverige)** (delningstoken `0f`) under
  Infrastructure, efter Sjukhus och akuter: gränserna för Sveriges 290
  kommuner och 21 län.
- Gränserna kommer från OpenStreetMap via det handkörda
  `scripts/build-municipalities.mjs`. SCB:s öppna gränsfiler (CC0) prövades
  först men är förenklade för statistikkartor (cirka 34 punkter per kommun)
  och såg kantiga ut mot flygbilderna. Varje gränslinje lagras en gång och
  delas av kommunerna på båda sidor, så grannar möts exakt; linjerna är
  förenklade med 25 m tolerans (cirka 56 000 punkter, 600 kB). Gränser till
  havs (`maritime=yes`) används för ytorna men ritas inte.
- Linjerna ligger på marken (terrängen, eller 3D-tiles när globen är dold,
  som undervattenskablarna) och ritas i en batch per färg; markeringen av en
  vald kommun ligger i en egen datakälla så att ett klick aldrig bygger om
  gränslinjerna. Namnen visas via appens etikettlager: länen på hög höjd,
  kommunerna närmare, högst 40 åt gången närmast kartans mitt.
- Folkmängden är SCB:s senaste månadssiffra (tabell TAB6473, augusti 2026)
  och samma månad året innan, så kortet visar förändringen på ett år.
  Namnen tas från SCB ("Stockholm", inte OSM:s "Stockholms kommun"). SCB:s
  årstabell slutar på 2024; den nyare månadstabellen hittades genom att
  jämföra tabellernas senaste period.
- Raden visar kommun, län och folkmängd för kartans mitt; ett klick på en
  kommun markerar den med vit kontur och visar län, folkmängd med datum,
  länets folkmängd och kommunkod. Knapparna Kommuner och Län tänder och
  släcker respektive linjer.

### 2026-11-09 (sjukhus och akuter)
- Nytt lager **Sjukhus och akuter (Sverige)** (delningstoken `0g`) under
  Infrastructure, efter Skyddsrum. Sverige har inga öppna livetider för
  akuten (1177, Vården i siffror och Socialstyrelsens API saknar dem), så
  lagret visar Socialstyrelsens årsstatistik i stället: faktabladet
  "Statistik om akutmottagningar, väntetider och besök 2025" (art.nr
  2026-6-10339, publicerat 2026-05-25), bilaga 1 med besök, mediantid till
  läkare och median total vistelsetid per akutmottagning för 2024 och 2025.
  Siffrorna ligger tolkade i `src/data/local_data/se_hospitals/akut-2025.json`
  (62 mottagningar, stickprov mot PDF:en i testet).
- Sjukhusen kommer från OpenStreetMap (ODbL) via det handkörda
  `scripts/build-hospitals.mjs`: cirka 120 sjukhus i Sverige, utan
  vårdcentraler, mottagningar, ingångar och dubbletter. Varje akutmottagning
  är kopplad till sitt sjukhus för hand; där Socialstyrelsen redovisar flera
  sjukhus samlat (Sahlgrenska, Hallands sjukhus, Skaraborgs sjukhus) får
  varje sjukhus de gemensamma siffrorna och kortet säger det. Markhöjder från
  Re:Earth Terrain ligger i ögonblicksbilden, så appen hämtar ingenting
  efter den första läsningen.
- Stora prickar är akutmottagningarna, färgade efter medianen jämfört med
  rikets: mer än 15 % kortare, inom 15 % eller längre. Ett reglage växlar
  mellan tid till läkare och total vistelsetid. Raden listar de fem närmaste
  akutmottagningarna från kartans mitt, eller med knappen "Kortast i vyn"
  de fem med kortast median i vyn; listan följer kameran ur minnet. Små
  grå prickar är övriga sjukhus.
- Kortet visar medianerna 2025 med 2024 inom parentes, rikets medianer,
  besök 2025 och förändringen mot 2024, att det är årsmedianer för vuxna och
  inte aktuell väntetid, samt "Akut livshotande: ring 112 · Rådgivning: 1177".
- Byggskriptens gemensamma delar (Overpass med speglar och cache, land för en
  punkt, markhöjder) ligger nu i `scripts/lib/osmSnapshot.mjs`, som även
  `build-company-stores.mjs` använder. Åland räknas nu som eget område så
  att Ålands centralsjukhus inte hamnar i Sverige.

### 2026-11-09 (skyddsrum)
- Nytt lager **Skyddsrum (Sverige)** (delningstoken `0h`) under
  Infrastructure, efter Polisstationer: MCF:s register över Sveriges cirka
  63 000 skyddsrum med 6,8 miljoner platser, från MCF:s INSPIRE-tjänst
  (ingen nyckel; metadatan anger inga begränsningar och inga villkor).
- Servern hämtar hela registret en gång per dygn (sju sidor) och svarar på
  varje vy ur minnet (`/api/shelters`), så MCF får en hämtning per dygn hur
  mycket kartan än flyttas.
- Skyddsrummen visas när kameran är under 40 km: de 1 500 närmaste kartans
  mitt, storlek efter antal platser, grönturkosa eller orange för
  tillfällig begränsning. Raden visar antal skyddsrum och platser i vyn och
  de fem närmaste med avstånd; ett klick i listan flyger dit och öppnar
  kortet. Kortet visar skyddsrummets nummer, fastighet, platser och att
  skyddsrum används vid höjd beredskap, när VMA uppmanar till det.
- Adressfältet hos MCF är fastighetsbeteckningen (kvarter och nummer), inte
  gatuadressen, och står därför som "Fastighet".

### 2026-11-09 (svenska texter efter granskningen i originalet)
- Granskningen av den svenska översättningen i originalprojektet (PR #1630)
  är införd här också: exportknapparna i Senaste bilder heter EXP. A/B så
  att de får plats, "1 HÖRT" i singular, INTE FARA ÖVER genomgående, VÄ/HÖ
  för vänster/höger (V är väst på kompassen), STYRD KURS och KURS Ö. GRUND
  hålls isär, MIK i tipset, antal först där plural saknas, "inaktivt ljud",
  OSÄKER, KN för knop, riktiga ellipser, Ladda ned och VÄNTLÄGE, Olagligt
  ingripande och FÖRHANDSVY.
- `sv.json` ingår nu i formatkontrollen, och 42 onödiga rader i listan över
  strängar som får vara likadana som på engelska är borttagna.

### 2026-11-09 (kom igång: guide och nycklar i appen)
- Ny guide [docs/KOM-IGANG.md](docs/KOM-IGANG.md): installera med Pinokio,
  Docker eller Node, skaffa de gratis nycklarna och hitta i appen. Länkad
  överst i README.
- Trafikverket, Trafiklab och Swedavia finns nu i appens nyckelpanel
  **KOPPLA PÅ**, direkt efter Google. Den som installerar klistrar in sina
  gratisnycklar i appen i stället för att redigera `.env`; appen sparar dem
  och startar om. Pinokio-startaren för också vidare de fem svenska
  nycklarna.

### 2026-11-09 (apotek i Butikskedjor)
- Butikskedjor visar nu också apoteken hos Apotek Hjärtat (229), Apoteket
  (333), Kronans Apotek (271), Apoteksgruppen (53) och DOZ Apotek (45, före
  detta Lloyds Apotek), med en knapp per kedja. Totalt 4 132 butiker och
  apotek, med OSM-data från 9 november.
- Apotek är `amenity=pharmacy` i OpenStreetMap, inte butiker, så byggskriptet
  frågar efter apotek för apotekskedjorna. Kedjornas Wikidata-id kommer från
  Name Suggestion Index. Ett apotek har alltid kedjans namn som koncept,
  också när OSM lägger till orten ("Apotek Hjärtat Stattena").
- Företagsraden i kortet visar ägarförhållanden där de är säkra: Apotek
  Hjärtat och ICA är del av ICA Gruppen, Apoteket och Systembolaget är
  statligt ägda. (Wikidata saknar Apotek Hjärtats ägare och anger
  "Regeringskansliet" för de statliga, så det står i koden i stället.)
- Byggskriptet underkänner nu Overpass-svar med data äldre än 14 dagar och
  frågar nästa server: en spegel svarade med OSM-data från juni.

### 2026-11-09 (Datalager: källor och omfattning)
- Varje lager med svenska data har ett märke på källraden: **SE** för
  våra egna lager (18 st) och **+SE** för originalets lager där vi lagt
  till svenska data (Kollektivtrafik, Kameror, Regnradar, Blixttäthet,
  Luftkvalitet).
- ⓘ-knappen i slutet av källraden fäller ut källa, omfattning, hur ofta
  datan uppdateras och licens. I +SE-lagren står vårt tillägg och
  originalets del var för sig, så att det syns vad som kommer varifrån.
- Kollektivtrafikens källrad säger nu "GTFS-RT · Trafiklab · Trafikverket"
  i stället för bara "GTFS-RT".
- Filter överst i Datalager: *Alla lager* eller *Svenska data*. Med
  svenska data visas bara de 23 lagren med svenska data, plus andra lager
  som är påslagna, så att inget som är på försvinner ur listan. Valet
  sparas i webbläsaren.
- Allt kommer ur en enda tabell, `src/ui/layerProvenance.js`. Avsnittet
  *Källor och omfattning per lager* här ovanför skrivs ur samma tabell med
  `node scripts/sweden-sources.mjs`, och ett test larmar om de glider isär.
  Ett test kräver också att varje nytt svenskt lager får en rad i tabellen.
  Översatt till alla 12 språk.

### 2026-11-09 (polisstationer)
- Nytt lager **Polisstationer (Sverige)** (delningstoken `0i`) under
  Infrastructure, efter Brandstationer: Polisens 261 stationer från
  Polisens öppna API (`polisen.se/api/policestations`, ingen nyckel,
  Polisen anges som källa). Servern hämtar listan en gång per dygn
  (`/api/police-stations`) och visar den senaste i upp till en vecka om
  Polisen inte svarar.
- Prickarna färgas efter receptionen: mörkblå där man kan ansöka om pass
  och id-kort (110), ljusblå för andra ärenden som att anmäla brott eller
  lämna in hittegods (100), grå där Polisen inte anger några
  besökstjänster (51).
- Klick på en station visar adress och tjänster, och för stationer utan
  passansökan den närmaste stationen med pass. Klick på kortet öppnar
  stationens sida på polisen.se, där öppettiderna står (de finns inte i
  API:t).
- Bara det Polisen själv publicerar för allmänheten; inga insatser eller
  rörelser. Lagret ligger på markhöjd precis som brandstationerna och är
  avstängt för röststyrning, som övriga svenska lager.

### 2026-11-09 (uppdaterad från originalet: 30 PR:er)
- Originalets senaste 300 commits är inslagna. Vår app är grunden: där
  båda ändrat samma sak gäller vårt beteende, och originalets nya lager
  är avslagna tills man slår på dem.
- Nytt från originalet: fartygens bryggvy (gå in i cockpit på ett valt
  AIS-fartyg, titta runt med pilarna, bryggradar), satellitens omloppsvy
  (åk med en satellit, sensorstråk, zoom, nadir), satellitklasser med
  egna knappar (stationer, avbildning, telekom, Starlink, sonder, skrot),
  världsklocka med tidslinje för uppskjutningar, ritmarkeringar med
  åtgärder, nytt lager **Wildlife Sightings** (iNaturalist; heter Djur-
  och naturobservationer på svenska), trafiklinjer som alternativ till
  prickar, åldersfilter i S2 GhostMaps, kameror från Island och fler
  kamerakällor, samt rättningar i röst, chatt och sökning.
- Cockpit: originalet kräver inte längre att Kontakter är på, bara att
  ämnets eget lager är på. Vår knapp vid kartan och C-tangenten går nu
  direkt in, och fungerar för flygplan, fartyg och satelliter. Vår väg
  som först startade Kontakter är borttagen.
- C-tangenten: originalet har slutat låta C växla cockpit, eftersom C
  också öppnar kamerorna. Vi behåller växlingen: C går in i och ur
  cockpit när något är valt som går att gå in i, annars öppnar C
  kamerorna som förut. Originalets fyra tester för detta är omskrivna.
- Röststyrning: originalets tillägg fyllde röstassistentens promptbudget
  (55 500 tecken), så **Road Conditions (Sweden)** stängs av för
  röststyrning precis som våra övriga svenska lager och originalets nya
  djurlager. Lagret fungerar som vanligt i övrigt.
- Kameror: vi behåller vårt automatval som följer vyn, och originalets
  nya omval när en kamera faller bort följer med.
- Delningstoken: originalets nya lager tog token 9, så **Road Conditions
  (Sweden)** flyttar till `0j` i vår egen nedräkningsserie, där originalet
  aldrig hamnar. Gamla delade länkar med vägförhållanden öppnar i stället
  djurobservationerna.
- 202 nya svenska strängar för originalets nya delar.

### 2026-11-09 (kraftsystemet: veckokurva)
- KRAFT-panelen har val mellan I dag och Vecka. Svenska kraftnät lämnar
  bara ut innevarande dygn, så servern sparar varje dygn den ser i
  .gev-cache/power-grid-days/ (åtta dygn, äldre tas bort). När lagret
  väl har använts hämtar servern dygnet var 15:e minut så länge den är
  igång, så att dygnet blir helt även om ingen tittar vid midnatt.
- Veckan ritas per kvart med en markering per dygn och veckodagar under;
  tider då servern inte var igång blir luckor, och panelen säger varför.
  Kurvan fylls på dag för dag från och med i dag.

### 2026-11-09 (kraftsystemet: dygnskurva)
- Ny panel KRAFT i högerkanten medan Kraftsystemet är på: dygnet hittills
  per kvart, produktionen staplad per kraftslag (kärnkraft, vatten, vind,
  värme, övrigt) med förbrukningen som linje, och under den utbytet med
  grannländerna, export uppåt och import nedåt. Pekaren över diagrammet
  läser av en kvart; annars visas senaste kvarten. Summerat i GWh:
  producerat, förbrukat, ut och in.
- Data från samma kontrollrumstjänst (ny serverväg /api/power-grid/day,
  cache 5 min). Svenska kraftnät lämnar bara ut innevarande dygn (tidigare
  datum ger 403), så panelen visar i dag; gårdagen skulle kräva att
  servern sparar dygnen själv.

### 2026-11-09 (kraftsystemet: import och export)
- Raden för Kraftsystemet visar Sveriges import, export och netto för
  senaste kvarten, nettot per grannland (Finland, Norge, Danmark, Tyskland,
  Polen, Litauen) och en växel Alla / Import / Export / Inrikes. En knapp
  per land lyfter fram dess förbindelser och tonar ner resten.
- Pilarna är rörliga vinklar i flödets riktning, snabbare ju större
  flödet är (stilla för den som valt reducerad rörelse i systemet).
  Scenen ritar bara vid behov, så lagret ber om ca 15 bilder i sekunden
  medan något rör sig, en fjärdedel av kontinuerlig ritning.
  Etiketterna säger varifrån och vart, t.ex. "Polen → SE4 · 459 MW", på
  läsarens språk.
- Svenska kraftnäts flödeskarta ligger ungefär en timme efter, så raden
  skriver "Kl. 10:45" i stället för "Nu".
- Rättat: linjerna fick samma id vid varje omritning, och Cesium behöll då
  de gamla; en förbindelse som bytt riktning kunde visa den gamla pilen
  tills sidan laddades om.
- Markhöjderna (groundHeights.js) sparas nu i webbläsaren och hämtas i
  gemensam takt, högst ett anrop i sekunden, eftersom höjdproxyn tillåter
  90 anrop i minuten per klient och alla lager vid första laddningen
  behövde ungefär så många. Senare besök behöver inga höjdanrop.

### 2026-11-09 (alla svenska lager på marken utan 3D-tiles-mätning)
- De tio återstående svenska lagren med punkter fästa mot 3D-tiles får
  samma markhöjd via appens höjdtjänst: elpriser, gammastrålning,
  kraftnät (elområden och grannländernas ändpunkter), vattenföring,
  vägförhållanden (händelsepunkterna), sjöväder, SMHI-varningar (VMA och
  krismeddelanden), SMHI-väder, Sveriges Radio trafik och
  kollektivtrafikstörningar. Vägarnas linjer och varningsområdena är kvar
  som förut: de ritas som markklassning på grafikkortet och mäter inte
  höjd per tile. Med alla 15 svenska lagren påslagna och fotorealistiska
  tiles: värsta bildrutan 21 ms. Upstreams egna lager är orörda.

### 2026-11-09 (väderstationer, polishändelser och blixtnedslag)
- Samma rättelse för de tre sista lagren som fäste punkterna mot 3D-tiles.
  Väderstationer vid väg (813, även temperaturetiketterna) och
  polishändelser (500, på kommunens höjd även när de sprids runt den) får
  markhöjd via appens höjdtjänst. Blixtnedslag (upp till 20 000 vid åska,
  byts varje minut) frågar inte Re:Earth alls: de ritas på geoidmodellens
  höjd, ungefär havsnivån, vilket räcker eftersom DMI anger 0,5–2 km
  osäkerhet i positionen. Med alla sex berörda lagren påslagna och
  fotorealistiska tiles: värsta bildrutan 20 ms under samma rörelser.

### 2026-11-09 (brandstationer och fartkameror laggade)
- Samma frysning som Butikskedjor hade, mätt med fotorealistiska tiles över
  Stockholm: brandstationerna (841) gav ryck på upp till 937 ms när kartan
  rörde sig, och fartkamerorna (2 825) hör till samma sort. Ett avstängt
  lager fortsatte dessutom kosta tills sidan laddades om, eftersom
  punkterna bara döljs. Båda lagren hämtar nu sina markhöjder i bakgrunden
  via appens egen höjdtjänst (Re:Earth, diskcachad 30 dagar, geoidmodellen
  som reserv) och fästs bara mot jordglobens terräng. Gemensam modul
  src/layers/groundHeights.js. Med båda påslagna: värsta bildrutan 15 ms,
  samma som utan lager.
- Om Re:Earth inte svarar ritas punkten på geoidmodellens höjd (ungefär
  havsnivån) och frågas om efter 2, 4, 8 … upp till 30 minuter tills en
  riktig höjd kommer, så att den inte ser förskjuten ut i lutad vy i
  fjällen. Bara höjden påverkas; latitud och longitud ändras aldrig.

### 2026-11-09 (butikskedjor laggade)
- Appen frös i 2–3 sekunder per bildruta med Butikskedjor påslaget och
  fotorealistiska 3D-tiles, tydligast när man klickade på en butik. Orsaken
  var de 3 201 punkterna fästa vid marken (CLAMP_TO_GROUND): för varje ny
  3D-tile mätte Cesium höjden igen för varje butik inom tilen och läste
  tillbaka tilens geometri från grafikkortet (75 000 anrop på tre
  bildrutor). Varje butik har nu sin markhöjd i ögonblicksbilden (Re:Earth
  Terrain, CC BY 4.0, samma källa som appen redan använder) och fästs bara
  mot jordglobens terräng, som är billig; med fotorealistiska tiles ligger
  punkten kvar på sin egen höjd.

### 2026-11-09 (mer butiksdata)
- Butikskortet visar nu mer, bara från öppna källor och utan nya nycklar:
  om butiken är öppen nu och när den stänger eller öppnar (läst ur
  OSM-öppettiderna; former som inte går att läsa säkert visas inte),
  när öppettiderna senast kontrollerades på plats, kartlagd yta i m²
  (när butiken är ritad som byggnad, ca 40 %), telefon, rullstolsanpassning,
  paketombud, närmaste namngivna hållplats inom 600 m (OSM, 93 % av
  butikerna), hur många som bor inom 2 km (SCB:s öppna befolkningsrutor
  1 km, CC0, 2025) och de närmaste butikerna från andra kedjor med avstånd
  plus antal kedjebutiker inom 5 km. Klick på kortet öppnar butikens egen
  webbsida när OSM har en (55 %).
- Rättat: landsgränsfiltret jämförde bara med Sverige och grannländerna,
  så butiker i Estland, Lettland och Litauen hamnade på närmaste svenska
  kust. Lidl hade 47 baltiska butiker för mycket (nu 209) och Coop 2 (nu
  777). Totalt 3 201 butiker. Hållplatsnamn som bara är en plattformsbokstav
  ("B", "C1") hoppas över.

### 2026-11-08 (Coop saknade butiker)
- Butikskedjorna hittade bara 481 av Coops drygt 800 butiker. Coop är märkt
  på flera sätt i OpenStreetMap: ett äldre Wikidata-id ("Coop (Sweden)", ca
  190 butiker), egna id:n för X:-tra och Coop Forum, och ca 140 butiker med
  bara namnet ("Coop …", "Stora Coop …"). Nu räknas alla id:n, och en butik
  utan id hittas på namnet, för alla kedjor. Coop visas som Stora Coop,
  Coop och X:-tra. Coop har nu 779 butiker (tidigare 481), och alla kedjor
  ökade något: totalt 3 250 butiker.

### 2026-11-08 (butikskedjor)
- Nytt lager **Butikskedjor (Sverige)** (delningstoken `0k`) under
  Infrastructure: butikerna för ICA (Nära, Supermarket, Kvantum, Maxi), Coop,
  Axfood (Willys, Hemköp), Lidl, City Gross och Systembolaget. En knapp per
  företag visar eller döljer det; legenden räknar butiker per koncept. Klick
  ger adress, öppettider och företaget med organisationsnummer och
  huvudkontor. Bara butiker visas, inga lager, kontor eller bankomater.
- Butikerna kommer från OpenStreetMap (ODbL), matchade på kedjornas
  `brand:wikidata`, och ligger som en ögonblicksbild i
  `src/data/local_data/se_company_stores/stores.json`. Den byggs om för hand
  ungefär en gång i veckan med `node scripts/build-company-stores.mjs`;
  appen frågar aldrig Overpass själv (originalets regel: bara egna servrar).
  Företagsfakta hämtas från Wikidata när ögonblicksbilden byggs.
- Företagens egna butikssökare används inte: ica.se blockerar automatisk
  åtkomst, och en lista hämtad därifrån omfattas av företagets
  databasrätt. All the Places (CC0) valdes bort av samma skäl.

### 2026-11-08 (blixtnedslag från DMI)
- Nytt lager **Blixtnedslag (Sverige)** (delningstoken `0l`) under Weather,
  direkt under blixtlagret: varje blixturladdning som DMI:s sensornät och
  grannländernas sensorer lokaliserar, den senaste timmen. Punkterna färgas
  efter ålder (vit de senaste 5 minuterna, sedan gul, orange och röd). Stora
  punkter är nedslag i marken, små är blixtar i molnet. Klick ger klockslag,
  typ, toppström i kA och antal sensorer.
- `/api/lightning-strikes` frågar DMI:s öppna API (CC BY 4.0, ingen
  nyckel) om den senaste timmen över Norden högst en gång i minuten,
  nyaste först, högst 20 000 urladdningar.
- Noggrannheten är 0,5–2 km nära Danmark och sämre längre norrut. Det
  står på kortet och i lagrets beskrivning, tillsammans med att lagret
  inte är en varning.
- Hittades via EU:s dataportal (data.europa.eu). Testat med ett riktigt
  åskväder från 5 juli 2026 som spelades upp som om det pågick.

### 2026-11-08 (blixtar över Europa och brandstationer)
- Blixtlagret har en ny region, **Europa**, som nu är förvald. Den visar
  EUMETSAT:s blixtkamera på vädersatelliten MTG: blixtar sedda från rymden,
  räknade per 2 km-ruta under 5 minuter, var 5:e minut och oftast 10–15
  minuter efter. Både molnblixtar och nedslag räknas. Täckning 0–70° N,
  70° V–70° Ö. Ingen nyckel och ingen avgift. Den amerikanska NOAA-produkten
  finns kvar under knappen Amerika. Delningslänkar skriver regionen som
  `lo=l.p.a` (Amerika); Europa skrivs inte ut eftersom den är förvald.
- SMHI:s egna blixtdata valdes bort: realtidsflödet är en betaltjänst och
  det fria arkivet ligger en dag efter.
- Nytt lager **Brandstationer (Sverige)** (delningstoken `0m`) under
  Infrastructure: räddningstjänstens 841 stationer från MCF:s register,
  färgade efter högsta beredskapsform. Klick ger ett kort med beredskap och
  avstånd till närmaste centralort. Stationerna saknar namn i registret,
  och MCF anger att positionernas noggrannhet varierar.
- Hittades via Sveriges dataportal (dataportal.se). Röst av för lagret som
  för övriga svenska lager; alla tolv språk.

### 2026-11-08 (länk till LinkedIn-inlägget)
- README länkar till LinkedIn-inlägget om bygget, under rubriken.

### 2026-11-08 (under utveckling)
- README har en rad under introt, på svenska och engelska: projektet är en
  grund som byggs vidare på, nya datalager kommer löpande och ändringarna
  loggas här.

### 2026-11-08 (nämn projektet om du bygger vidare)
- README har ett nytt avsnitt "Bygger du vidare?" på svenska och engelska:
  behåll LICENSE med båda copyrightraderna (licensens krav), nämn och länka
  projektet (en begäran, med en färdig rad att klistra in), och ge egna
  projekt ett eget namn.
- Ny `CITATION.cff` så att GitHub visar knappen "Cite this repository" med
  Kaj Obst som upphovsman och originalet som referens.

### 2026-11-07 (riktlinjer för bidrag)
- `CONTRIBUTING.md` och `SECURITY.md` börjar med ett svenskt stycke (och en
  rad på engelska): det här är forken, inte originalet; issues och pull
  requests granskas när tid finns; svenska delar rapporteras här, originalets
  delar i originalet; säkerhetsproblem privat via forkens Security-flik.
  Bidrag får inte innehålla nycklar eller personuppgifter, nya källor ska
  vara öppna och stå i DATA_SOURCES.md, och originalets gräns mot att spåra
  personer gäller.
- Ärendemallarnas länkar (`.github/ISSUE_TEMPLATE/config.yml`) pekar på
  forken för säkerhet, kom igång och kända problem, plus en länk till
  originalets issues för fel i originalets delar.

### 2026-11-07 (README och genomlysning inför publikt repo)
- `README.md` har ett svenskt block överst: vad forken är, erkännande av
  originalet (Bilawal Sidhu och Sameh Khamis, MIT), att forken saknar
  koppling till originalets upphovsmän, siffrorna 110+ / 21 / 30 / 14,
  åtta bilder och kom-igång på svenska. Originalets README följer orörd
  under en avdelare.
- Nya bilder i `docs/media/sverige/` (WebP och en GIF på 6,5 MB), tagna i
  appen med Google Photorealistic 3D Tiles och källhänvisningen synlig i
  bild; förtecknade i `docs/media/README.md`.
- `LICENSE` har en andra copyrightrad för de svenska tilläggen; originalets
  rad och villkor står kvar.
- Tabellen "Vad som är tillagt" tar med flygtavlan, flygvädret, cockpit,
  fartkameror, dossierns nyare flikar, Sverige-turen och sparläget, och
  nyckeltabellen Swedavias två nycklar.
- Genomlysning: hela historiken (3 075 commits) söktes igenom efter
  värdena i `.env` och vanliga nyckelmönster (Google, AWS, GitHub, privata
  nycklar m.fl.) utan träff; `.env`, `.gev-cache/` och `.claude/` har
  aldrig checkats in. Inga lokala sökvägar i filerna.

### 2026-11-07 (fartkameror)
- Nytt lager **Speed Cameras (Sweden)** (delningstoken 0n) under
  Infrastructure: Trafikverkets cirka 2 800 fasta trafiksäkerhetskameror
  som gula pilar vridna åt det håll kameran pekar. Pilarna syns när vyn är
  inom ungefär 400 km. Klick på en pil visar väg, platsnamn, riktning
  (t.ex. "riktad 101° (öster)") och län.
- Dossierns NU-flik visar "24 trafiksäkerhetskameror inom 15 km" (Uppsala)
  och de fem närmaste med väg och avstånd. Klick på en rad slår på lagret,
  flyger dit och visar kamerans kort.
- Det är platser, inte aktiva kameror: polisen flyttar utrustningen mellan
  platserna, vilket står i kortet och i lagrets förklaring.
- Ny adress `/api/speed-cameras` på den befintliga Trafikverket-nyckeln;
  listan sparas ett dygn. Polisbilars positioner är inte offentliga och
  byggs inte.

### 2026-11-07 (sevärt i staden)
- Ny flik **SEVÄRT** i dossiern (flikarna ligger nu i två rader): slott
  och borgar, fästningar, kyrkor och domkyrkor, museer, runstenar,
  fornlämningar och ruiner, herrgårdar, minnesmärken, natur (vattenfall,
  naturreservat, nationalparker) och fyrar inom 12 km, från Wikidata, t.ex.
  Uppsala: Uppsala slott, Gustavianum, Ärkebiskopsborgen, Gamla Uppsala.
  Högst 40 och högst 8 av en sort; de med Wikipedia-artikel, bild eller
  en sevärd sort först.
- Varje plats pekas ut på kartan som en prick i sin sorts färg med namn.
  Klick i listan eller på kartan väljer platsen: den blir guldfärgad,
  kameran flyger in söderifrån och listan visar bild (Wikimedia Commons)
  och länk till Wikipedia. Medan en plats är vald byter dossiern inte stad
  om platsen ligger i grannkommunen.
- Ny adress `/api/city-sights` (sparas ett dygn per stad).

### 2026-11-07 (besöksräknare)
- Dossierns huvud visar "Besök 4 · första 5 nov." för en stämplad stad.
- PASS-fliken visar antal besök totalt, en lista **Mest besökta** (städer
  med fler än ett besök, ×antal) och antal vid de senaste stämplarna.
- Ett återbesök räknas först tio minuter efter det förra, så att
  panorering fram och tillbaka mellan två städer inte räknar upp.

### 2026-11-07 (norrsken i natt)
- Dossierns NU-flik har en rad "Norrsken i natt: chansen är låg/möjlig/
  god/hög" med prognostiserat Kp under kvällens mörka timmar mot det Kp
  orten behöver (Kiruna 1 … Malmö 7), NOAA:s stormskala (G1…), andel
  moln från SMHI, när det är mörkt (solen under −10°) och bästa timmen,
  t.ex. Västerås i kväll: möjlig, Kp 4,7 väntas, här räcker 5, 13 % moln.
- Knappen "Visa norrskensovalen på kartan" slår på originalets
  OVATION-lager (NOAA:s norrskensoval).
- Ny adress `/api/aurora-outlook` (ny fil `server/providers/auroraOutlook.js`;
  originalets `aurora.js` för OVATION-lagret är orört).

### 2026-11-07 (Krisinformation och VMA)
- Nyckelfritt från Krisinformation.se (Myndigheten för civilt försvar) via
  `/api/krisinformation` (VMA och de senaste tre dygnens nyheter, två
  minuters cache).
- Ett aktivt VMA var som helst i Sverige visas som röd banner överst i
  appen med område och "Läs mer"; den kan stängas för sidans livstid.
- Dossierns NU-flik har en del Krisinformation.se: VMA för kommunen eller
  länet i rött, därefter de senaste nyheterna för kommunen, länet eller
  hela landet ("Hela Sverige").

### 2026-11-07 (sparläge för Google 3D)
- Varje start med Google Photorealistic 3D Tiles förbrukar en session av
  Cesium ions gratiskvot (1 000 per månad); den tog slut i november,
  främst genom automatiska testkörningar.
- Ny knapp **3D/2D** i hörnraden: med 3D på laddas Google 3D-staden som
  förut; i sparläge (2D, bärnstensfärgad) startar jordgloben på Esris
  nyckelfria satellitbild och inga 3D-tiles hämtas, alltså ingen session.
  Valet sparas i webbläsaren; ett byte laddar om sidan (vyn behålls i
  adressen).
- `?globe=lite` tvingar sparläge för en laddning (alla automatiska
  kontroller använder det framöver), `?globe=3d` tvingar 3D.
- Alternativ till ion: egen `GOOGLE_MAPS_API_KEY` med Map Tiles API
  påslaget, så hämtas 3D-tiles direkt från Google.

### 2026-11-07 (dagens rutter på globen)
- Flygplatstavlan har en globknapp, "Dagens rutter på kartan": tavlan
  stängs och varje destination för flygplatsens avgångar i dag ritas som
  en båge från flygplatsen (tjockare för fler flyg, högre för längre
  sträckor) med namn och antal, t.ex. "Helsingfors · 13". Kameran ser rakt
  ner över rutternas tyngdpunkt. Arlanda i dag: 72 destinationer, 162
  avgångar.
- En remsa på kartan ("Rutter i dag: …") öppnar tavlan igen och har ✕ för
  att dölja rutterna. Klick på en destination (etikett eller punkt)
  öppnar tavlan filtrerad på dess avgångar.
- Positionerna kommer från OurAirports (public domain), hämtas högst en
  gång i veckan och sparas i `.gev-cache/ourairports/` (ca 580 kB);
  `/api/airport-routes?iata=ARN` grupperar dagens avgångar per destination.

### 2026-11-07 (flygväder METAR/TAF)
- Nyckelfritt flygväder från NOAA Aviation Weather Center
  (aviationweather.gov) via `/api/aviation-weather?ids=ESSA,…` (högst sex
  ICAO-koder, varje station sparas tio minuter).
- Flygplatstavlan: en väderrad under rubriken med flygkategori i färg
  (VFR grön, MVFR blå, IFR röd, LIFR lila), t.ex. "VFR · 260° 8 kt ·
  10 km eller mer · CAVOK · 3 °C", och en ny flik **Väder** med avkodad
  vind, sikt, moln, väder, temperatur/daggpunkt och QNH samt rå METAR och
  TAF. Raden öppnar fliken.
- Cockpitens SWEDAVIA-kort visar vädret på varje sträckas flygplats.

### 2026-11-07 (Swedavia i cockpit)
- Cockpit visar ett SWEDAVIA-kort under färdplanen när planet avgår från
  eller ankommer till en Swedavia-flygplats i dag: avgång och/eller
  ankomst med tid ("Startade 11:29", "Beräknad 12:50 · om 2 min"),
  försening, terminal, gate, bagageband och flygplatsens egen rad. På
  telefon (där briefingfönstret är dolt) en remsa under VISNING/RADIO.
  Läses om varannan minut medan cockpit flyger planet.
- Ny adress `/api/airport-flight?callsign=&registration=&airports=`: söker
  planets rader på rutans ändar (IATA eller ICAO), på flygplatsen det
  följdes från på tavlan och i alla dagslistor som redan finns, utan
  extra anrop för dem. Anropssignalen går före; registreringen ensam
  (flygplanet flyger flera sträckor om dagen) ger bara sträckan som pågår.
- Tavlan skiljer på planet i luften (fylld knapp) och flygplanet som ännu
  flyger sträckan innan, t.ex. SK020:s plan på väg in som SK1420
  (streckad knapp, "Följ planet, som är på väg in").
- Flygplatslistan har nu även ICAO-koder.

### 2026-11-07 (läsbarhet och textstorlek)
- Mätning av all synlig text i cockpit (1600×900): 104 av 145 texter var
  under 10 px (35 under 8 px, minst 5–6 px) och 62 var svagare än 60 %.
- Ny knapp **Aa** i hörnraden bredvid språkväljaren (även i cockpit och på
  telefon) växlar Normal → Större → Störst; valet sparas i webbläsaren och
  **Större** är standard. Normal är originalets utseende.
- Större/Störst lyfter cockpitens minsta text (skalor, kontaktkortet,
  signallistan, färdplanen, visionsväljaren, väder- och verktygsknappar,
  sidopanelernas rubriker) till ett golv och den svaga vitgrå texten till
  78/88 % täckning; de cyanfärgade rubrikerna behåller färgen. Sidokorten
  blir lite bredare och signalfönstrets långa rader slutar med … i
  stället för att skjuta innehållet över kanten. Efter: 0 texter under
  8 px i cockpit (Större), allt minst 11 px (Störst).
- Telefon (alla storlekar): VISNING och RADIO flyttas från fart- och
  höjdsiffrorna upp under rollskalan, flygets metarad hålls på en rad och
  visionsväljaren visar pilar utan orden FÖRRA/NÄSTA.
- STAD-panelen och flygplatstavlan har större grundtext (minst ~9 px).
- Allt i den egna filen `src/ui/styles/sverige-legibility.css` (laddas
  före Cyber-temat, som ska vara sist), så originalets stilfiler är
  orörda och kommande synkar inte krockar.

### 2026-11-07 (flygplatstavla, steg 3: från tavla till plan i luften)
- Rader vars plan finns i flyglagrets data får en gul flygplansknapp, och
  utfällda detaljer får "Följ planet". Ett klick stänger tavlan och låser
  kameran på planet (därifrån finns Cockpit som vanligt), t.ex. BA785 som
  startade 10:29 och följdes över Nederländerna på FL388.
- Matchningen sker på Swedavias anropssignal (det transpondern sänder,
  "BAW785"), annars på registreringen med eller utan bindestreck
  ("SEROH" mot "SE-ROH"). Flyglagrets kontakter läses högst var 20:e
  sekund medan tavlan visas.
- Är flyglagret avstängt erbjuder tavlans fot "Slå på", och raderna får
  sina knappar när de första positionerna kommit in.

### 2026-11-07 (flygplatstavla, steg 4: köer över terminalerna)
- När vyn stannar inom 20 km från Arlanda, Landvetter eller Bromma (under
  40 km höjd) får varje säkerhetskontroll en punkt och en etikett på sin
  egen position från Swedavia, t.ex. "T5 · 2 min · Snabbspår 0 min":
  grön under 5 minuter, gul 5–14, orange från 15 eller när Swedavia
  säger att kön svämmar över. Läses om var tredje minut medan vyn stannar.
- Etiketterna ritas av appens world-overlay (som övriga lager); ett klick
  på etikett eller punkt öppnar tavlans flik Säkerhet.
- Tavlans köer har knappen "Visa på kartan", som stänger tavlan och
  flyger in söderifrån över terminalen.
- Under dossierns filmiska ankomstrunda (30 s) rör sig kameran hela
  tiden; kortet och etiketterna kommer när rundan slutar eller avbryts.

### 2026-11-07 (flygplatstavla, steg 2: tavlan)
- Ny panel: en Swedavia-flygplats hela dag som en avgångstavla, med
  flikarna Avgångar, Ankomster och Säkerhet (den sista bara på Arlanda,
  Landvetter och Bromma). Raderna står i planerad ordning; en gul linje
  "Nu" visar var dagen är och tavlan scrollar dit när den öppnas.
  Försenade flyg visar ursprunglig och ny tid, avgångna dämpas, inställda
  blir röda och Swedavias egen rad ("Gå till gate", "Boarding",
  "Försenad till …") skiftar med split-flap.
- Klick på en rad fäller ut detaljer: flygbolag, codeshare, planerad,
  beräknad och faktisk tid, terminal, incheckningsdiskar, gate och dess
  öppettider, bagageband med första och sista väska, Schengen/utrikes/
  inrikes, anropssignal och flygplanets registrering.
- Sökfält (flygnummer med eller utan mellanslag, stad på svenska eller
  engelska, IATA-kod, flygbolag), knapp för i dag/i morgon och
  uppdatering var tredje minut medan tavlan är öppen och sidan syns.
- Öppnas med "Hela tavlan" vid varje flygplats i dossierns NU-flik, eller
  från kortet som dyker upp när vyn stannar över en Swedavia-flygplats
  (inom 6 km, under 25 km höjd). På telefon fyller tavlan skärmen.
- Flygplatslistan ligger nu i `src/data/swedaviaAirports.js`, delad av
  servern och tavlan. NU-fliken visar Swedavias rad i första hand.

### 2026-11-07 (flygplatstavla, steg 1: hela dagen på servern)
- Ny adress `/api/airport-board?iata=ARN` (`&date=tomorrow`,
  `&only=security`): en Swedavia-flygplats hela dag i båda riktningar,
  även flyg som redan gått, med anmärkningsraden från flygplatsens egna
  skärmar ("Gå till gate", "Försenad till 16:15", "Sista bagage") och dess
  ton, incheckningsdiskar, gatens öppning och stängning, bagageband,
  mellanlandningar, codeshare, registrering, anropssignal och
  Schengen/utrikes/inrikes. Köerna kommer med kontrollpunktens position.
- Dossierns NU-flik och tavlan läser samma dagslista (sparad tre minuter),
  så tavlan kostar inga extra anrop när dossiern redan visar flygplatsen.

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
