# God's Eye View – Sverige

Fork av [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
med svenska öppna data, av Kaj Obst. `README.md` har ett svenskt block med bilder
överst; resten av originalets README lämnas orört så att uppdateringar från
originalet går att slå ihop. Allt svenskt beskrivs i detalj här.

## Princip: öppna data först

Projektet visar vad som går att bygga på dagens öppna data. Varje källa hör
till en av tre grupper:

- **Öppna data:** fri licens eller uttryckligen fritt att använda med
  källan angiven (CC0, CC BY, ODbL och liknande). Projektet bygger på dem.
- **Offentliga men utan publicerad licens:** visas med källan angiven och
  står under "Källor med oklara eller särskilda villkor" tills dataägaren
  har svarat eller en öppen källa finns.
- **Kräver tillstånd:** används inte, även om en gratis nyckel fungerar. En
  nyckel ger åtkomst, inte tillstånd. Hit hör OpenSky och TomTom, som
  originalets flyg- och trafiklager använder. I den svenska versionen
  kommer flyg som standard från adsb.lol (öppna data, ODbL), och
  `TOMTOM_API_KEY` lämnas tom så att trafiklagret kör sin simulering.

Två nivåer gäller:

- **I appen** visas öppna data och källor utan publicerad licens, alltid
  med källan angiven. Licensen står i appens källtabell, och avsnittet
  "Källor med oklara eller särskilda villkor" nedan räknar upp de lager som
  saknar publicerad licens.
- **I det som publiceras** – README-bilder, filmer, inlägg och
  presentationer – syns bara öppna data och källor vars villkor uttryckligen
  tillåter att de visas offentligt, med källangivelsen synlig i bilden.
  Lager utan publicerad licens stängs av innan något spelas in.
- **Före varje ny källa** läses hela villkoren, även när en gratis nyckel
  fungerar, och det prövas vad kartan visar när källan läggs ihop med de
  andra lagren.

## Vad som är tillagt

| Del | Källa | Var i appen |
|---|---|---|
| Vägkameror (1 553 st, livebilder i 3D) | Trafikverket, objekt `Camera` | Cameras / CCTV |
| Tåg i realtid, färgade efter försening (rosa 3–14 min, magenta 15+ min) | Trafikverket, objekt `TrainPosition` och `TrainAnnouncement` | Transit |
| Bussar, tunnelbana, spårvagn, pendeltåg (16 regionbolag, med linjenummer) | Trafiklab GTFS Regional | Transit |
| Väglag och händelser (olyckor, avstängda vägar, vägarbeten, hinder, färjor) | Trafikverket, `RoadCondition` och `Situation` | Road Conditions (Sweden), under Events |
| Nederbördsradar, Norden (var 5:e minut, senaste timmen) | SMHI, radarkomposit (CC BY 4.0, ingen nyckel) | Rain radar, under Weather (knapp Nordics) |
| Nederbördsradar, Europa inkl. Norge, Finland, Danmark och Baltikum (var 5:e minut) | EUMETNET OPERA, radarkomposit (CC BY 4.0, ingen nyckel) | Rain radar, under Weather (knapp Europe) |
| Vägfärjor: Trafikverkets ca 40 färjeleder med nästa avgångar de kommande tre timmarna och nästa avgångstid bredvid varje led; gula där Trafikverket har ett meddelande för leden (inställda turer, nedsatt kapacitet, planerade avstängningar) | Trafikverket, objekt `FerryRoute`, `FerryAnnouncement` och färjemeddelanden i `Situation` (befintlig nyckel) | Road ferries (Sweden) / Vägfärjor, under Movement |
| Vägväder: ca 830 väderstationer längs vägarna (vägbanans och luftens temperatur, daggpunkt, vind, sikt, nederbörd; halkrisk markeras) | Trafikverket, objekt `WeatherMeasurepoint` | Road Weather (Sweden), under Events |
| Vädervarningar: gula, orange och röda varningar som områden, plus meddelanden (vattenbrist, höga flöden, brandrisk), samt VMA och krisnyheter som punkter | SMHI, IBWW-varningar (CC BY 4.0) och Krisinformation.se (MSB); ingen nyckel | Weather Warnings (Sweden), under Weather |
| Polisens händelser (de 500 senaste notiserna, ca 10 dagar), placerade vid kommunens centralort | Polismyndigheten, `polisen.se/api/events` (öppna data, ange källan) | Police Events (Sweden), under Events |
| Kollektivtrafikstörningar: de regionala trafikbolagens aktuella störningar vid de hållplatser de gäller (stängd/trafikeras inte, flyttad, övrigt) | Trafiklab GTFS Regional ServiceAlerts (befintlig nyckel `TRAFIKLAB_GTFS_RT_KEY`) | Transit Disruptions (Sweden) / Kollektivtrafikstörningar, under Events |
| Sjöväder: ett 70-tal stationer längs kusten (vattenstånd mot medelvattenstånd, vattentemperatur, vågor) | SMHI:s havsobservationer (CC BY 4.0), ingen nyckel | Sea Weather (Sweden) / Sjöväder, under Weather |
| Norrskensprognos: chans för norrsken rakt ovanför (NOAA OVATION) som lysande band på 110 km höjd, Kp-index och chansen över nio svenska orter | NOAA SWPC (fri data, ingen nyckel) | Aurora Forecast / Norrskensprognos, under Weather |
| Väder nu: ca 185 SMHI-stationer (temperatur, vind, byar, nederbörd senaste timmen) och SMHI:s prognos för platsen vid klick | SMHI metobs och prognos snow1g (CC BY 4.0, ingen nyckel) | Weather Now (Sweden) / Väder nu, under Weather |
| Luftkvalitet: ca 75 SMHI-mätstationer (NO2, PM10, PM2.5, O3) på europeiska EAQI-skalan, tillsammans med Kanadas stationer | SMHI Datavärdskap luft (CC BY 4.0, ingen nyckel) | Air quality / Luftkvalitet, under Weather |
| Elpris per elområde (SE1–SE4), spotpris per kvart idag och imorgon | elprisetjustnu.se (Nord Pool-priser, ingen nyckel) | Electricity Prices (Sweden), under Infrastructure |
| Kraftsystemet: flöden på de 14 förbindelserna till och mellan elområdena (rörliga vinklar i flödesriktningen, MW), Sveriges import, export och netto totalt och per grannland, val av import/export/inrikes och en knapp per land som lyfter fram dess förbindelser, en KRAFT-panel i högerkanten med dygnet hittills eller senaste veckan per kvart (produktion per kraftslag, förbrukning och utbyte), import/export per elområde och Sveriges produktion per kraftslag och förbrukning | ENTSO-E Transparency Platform (CC BY 4.0, gratisnyckel `ENTSOE_SECURITY_TOKEN`); Svenska kraftnäts Kontrollrummet bara med `POWER_GRID_SOURCE=svk` | Power Grid (Sweden) / Kraftsystemet, under Infrastructure |
| Vattenföring: ca 150 SMHI-stationer i vattendragen, senast publicerade flöde i m³/s (kvartsvärden, publiceras med fördröjning) och om det stiger eller sjunker | SMHI hydrologiska observationer (CC BY 4.0, ingen nyckel) | River Flow (Sweden) / Vattenföring, under Weather |
| Butikskedjor: ICA:s, Coops, Axfoods (Willys, Hemköp, City Gross), Lidls och Systembolagets butiker samt apoteken hos Apotek Hjärtat (ICA Gruppen), Apoteket, Kronans Apotek (med Apoteksgruppen) och DOZ Apotek, färgade efter företag och koncept, med en knapp per företag; klick ger adress, om butiken är öppen nu, kartlagd storlek, webbsida, telefon, rullstol och paketombud, hur många som bor inom 2 km, närmaste hållplats, närmaste andra kedjor och företaget (org.nr och huvudkontor); klick på kortet öppnar butikens webbsida. Bara butiker, inga lager eller kontor. | OpenStreetMap (ODbL) som ögonblicksbild i repot, företagsfakta från Wikidata (CC0), befolkning från SCB:s 1 km-rutor (CC0) | Retail Chains (Sweden) / Butikskedjor, under Infrastructure |
| Brandstationer: räddningstjänstens 841 stationer, färgade efter högsta beredskapsform (heltid, deltid med eller utan första insatsperson, räddningsvärn) | Myndigheten för civilt försvar (MCF), INSPIRE-nedladdningstjänst (ingen nyckel; EU-värdefullt dataset, MCF anges som källa) | Fire Stations (Sweden) / Brandstationer, under Infrastructure |
| Polisstationer: Polisens 261 stationer, färgade efter vad receptionen erbjuder (pass och id-kort, andra ärenden, inga angivna); klick ger adress, tjänster och närmaste station som tar emot passansökan, klick på kortet öppnar stationens sida med öppettider | Polismyndighetens öppna data (ingen nyckel; Polisen anges som källa) | Police Stations (Sweden) / Polisstationer, under Infrastructure |
| Skyddsrum: MCF:s cirka 63 000 skyddsrum med 6,8 miljoner platser, i vyn när man zoomat in (de 1 500 närmaste kartans mitt), storlek efter platser; de fem närmaste listas klickbart i raden; klick ger fastighet, platser och om skyddsrummet har tillfällig begränsning | Myndigheten för civilt försvar (MCF), INSPIRE (ingen nyckel, inga villkor) | Shelters (Sweden) / Skyddsrum, under Infrastructure |
| Sjukhus och akuter: cirka 120 sjukhus, där de 62 akutmottagningarna i Socialstyrelsens statistik för 2025 färgas efter mediantid till läkare eller total vistelsetid jämfört med rikets (61 min respektive 4 h 16 min); raden listar de fem närmaste akutmottagningarna eller de med kortast median i vyn, klickbart; kortet visar medianerna 2025 och 2024, besök och förändring, och "ring 112 / 1177". Årsmedianer för vuxna, inte aktuell väntetid (öppna livetider finns inte i Sverige). | Socialstyrelsen, Patientregistret (faktablad 2026-6-10339), och OpenStreetMap (ODbL) som ögonblicksbild i repot | Hospitals & Emergency (Sweden) / Sjukhus och akuter, under Infrastructure |
| Kommuner och län: gränserna för alla 290 kommuner och 21 län som linjer på marken (länsgränser gula och tjockare, gränser till havs utelämnade), namnen följer vyn (län på hög höjd, kommuner närmare), kartans mitt i raden med kommun, län och folkmängd; klick på en kommun markerar den och visar län, folkmängd med förändring på ett år och kommunkod | OpenStreetMap (ODbL) som ögonblicksbild i repot; folkmängd per månad från SCB (TAB6473, CC0) | Municipalities & Counties (Sweden) / Kommuner och län, under Infrastructure |
| Valdistrikt 2026: riksdagsvalet i alla 6 312 valdistrikt som ytor på marken, färgade efter största parti eller valdeltagande; klick på ett distrikt visar kommun, räknade röster, valdeltagande och alla partiers andelar | Valmyndigheten (öppna data, källan anges) som ögonblicksbild i repot | Election Districts 2026 (Sweden) / Valdistrikt 2026, under Infrastructure |
| Skyddad natur: Sveriges 31 nationalparker, cirka 6 000 gällande naturreservat och 52 kulturreservat som ytor på marken, färgade efter skyddsform; på hög höjd bara nationalparkerna, närmare in reservaten i vyn (högst 1 500 närmast mitten); klick ger kommun, areal och år för beslutet, klick på kortet öppnar området i Naturvårdsverkets Skyddad natur | Naturvårdsverket, Naturvårdsregistret (CC0, "Källa: Naturvårdsverket") som ögonblicksbild i repot | Protected Nature (Sweden) / Skyddad natur, under Infrastructure |
| Fornlämningar: Riksantikvarieämbetets registrerade fornlämningar och övriga kulturhistoriska lämningar (cirka 840 000 i hela landet) som prickar på marken när man zoomat in under 12 km, de 1 500 närmast kartans mitt, färgade efter antikvarisk bedömning; klick ger typ, bedömning, lämnings- och RAÄ-nummer och kommun, klick på kortet öppnar lämningen hos RAÄ. Bara det som identifierar lämningen visas, inte beskrivning eller vägbeskrivning | Riksantikvarieämbetet, Kulturmiljöregistret via INSPIRE OGC API Features (public domain, ingen nyckel, inga åtkomstbegränsningar; källa och datum anges) | Ancient Monuments (Sweden) / Fornlämningar, under Infrastructure |
| Blixtnedslag: varje urladdning den senaste timmen som punkt, färgad efter ålder (vit = senaste 5 min), stora för nedslag i marken och små för blixtar i molnet; klick ger tid, typ och toppström | DMI:s blixtdata (CC BY 4.0, ingen nyckel; DMI:s sensornät och grannländernas sensorer) | Lightning Strikes (Sweden) / Blixtnedslag, under Weather |
| Blixtar över Europa och Afrika var 5:e minut, sedda från EUMETSAT:s vädersatellit MTG | EUMETSAT EUMETView (ingen nyckel, ingen avgift) | Lightning density / Blixttäthet, under Weather (knapp Europa, standard) |
| Strålning: Strålsäkerhetsmyndighetens gammastationer (ca 25 i drift) med senaste timmens dosrat i µSv/h på SSM:s egen färgskala | Strålsäkerhetsmyndighetens gammastationskarta (ingen nyckel, ingen angiven licens; SSM anges som källa) | Radiation (Sweden) / Strålning, under Infrastructure |
| Stadsdossier: när vyn stannar lågt över en svensk ort visar panelen STAD i högerkanten stadsvapen, foto och inledning, tätortens och kommunens folkmängd med kurva, skattesats, inkomst, arbetslöshet och kommunvalet, tolv nyckeltal under STATISTIK (skola, trygghet, hälsa, ekonomi, miljö och besökare, med hela Sveriges värde och kommunens plats bland kommunerna), samt läget just nu (väder, luft, varningar, Polisen, sol) och en länk till ortens P4-kanal hos Sveriges Radio | Kolada (RKA), Wikidata (CC0), Wikipedia (CC BY-SA 4.0), SMHI, Polisen; ingen nyckel | Panelen STAD i högerkanten (dyker upp vid första besöket) |
| Stadsdossierns flikar Sevärt (slott, kyrkor, museer m.m. utpekade på kartan), besökspass, tåg från stadens station, bussar, spårvagnar, tunnelbana och båtar från stadens mest trafikerade hållplats, VMA-banner och norrsken i natt | Wikidata (CC0), Trafikverket, Trafiklab Realtime (CC BY 4.0), Krisinformation.se, NOAA SWPC | Panelen STAD |
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
| SE | Elpris (Sverige) | elprisetjustnu.se · Nord Pool via ENTSO-E | Spotpris per kvart i elområdena SE1–SE4 | Var 15:e minut | Fri att använda enligt Elpriset just nu; priserna kommer från Nord Pool via ENTSO-E |
| SE | Kraftsystemet (Sverige) | ENTSO-E · Svenska kraftnät | Sveriges förbindelser mellan elområdena och till grannländerna | Var 5:e minut | Flöden från ENTSO-E: CC BY 4.0; Svenska kraftnät (POWER_GRID_SOURCE=svk): ingen publicerad licens |
| SE | Strålning (Sverige) | Strålsäkerhetsmyndigheten (SSM) | Cirka 25 gammastationer | Var 10:e minut | Ingen angiven licens; källan anges |
| SE | Brandstationer (Sverige) | Myndigheten för civilt försvar (MCF) | Räddningstjänsternas alla brandstationer | En gång per dygn | EU-värdefullt dataset, källan anges |
| SE | Polisstationer (Sverige) | Polismyndigheten | Alla polisstationer, cirka 260 | En gång per dygn | Öppna data, källan anges |
| SE | Skyddsrum (Sverige) | Myndigheten för civilt försvar (MCF) | Alla skyddsrum, cirka 63 000 med 6,8 miljoner platser | En gång per dygn | Inga tillämpliga villkor (INSPIRE) |
| SE | Sjukhus och akuter (Sverige) | Socialstyrelsen · OpenStreetMap | Cirka 120 sjukhus; väntetidsmedianer för de 62 akutmottagningarna i statistiken | Årlig statistik; ögonblicksbild i appen, byggs om för hand | Statistiken fri att använda med källa (Socialstyrelsen) · ODbL (OpenStreetMap) |
| SE | Kommuner och län (Sverige) | OpenStreetMap · SCB | Alla 290 kommuner och 21 län, med folkmängd per månad | Ögonblicksbild i appen, byggs om för hand | ODbL (OpenStreetMap) · CC0 1.0 (SCB) |
| SE | Valdistrikt 2026 (Sverige) | Valmyndigheten | Riksdagsvalet 2026 i alla 6 312 valdistrikt, slutlig rösträkning | Ögonblicksbild i appen, byggs om för hand | Öppna data, fria att använda med Valmyndigheten angiven som källa |
| SE | Fornlämningar (Sverige) | Riksantikvarieämbetet | Alla registrerade fornlämningar och övriga kulturhistoriska lämningar, för vyn | Dagligen hos RAÄ; läses för vyn och sparas ett halvt dygn | Allmän egendom (public domain); källa och datum anges |
| SE | Skyddad natur (Sverige) | Naturvårdsverket | Alla nationalparker, gällande naturreservat och kulturreservat | Ögonblicksbild i appen, byggs om för hand | CC0 1.0 |
| SE | Butikskedjor (Sverige) | OpenStreetMap · Wikidata · SCB | Nio kedjors butiker och apotek i hela Sverige; kartlagda av frivilliga | Ögonblicksbild i appen, byggs om för hand | ODbL (OpenStreetMap) · CC0 1.0 (Wikidata, SCB) |
| SE | Väglag (Sverige) | Trafikverket | Väglag och aktuella händelser i hela Sverige | Var 3:e minut | CC0 1.0 |
| SE | Vägväder (Sverige) | Trafikverket | Cirka 830 vägväderstationer | Var 5:e minut | CC0 1.0 |
| SE | Vägfärjor (Sverige) | Trafikverket | Omkring 40 färjeleder, avgångar de kommande tre timmarna | Varannan minut | CC0 1.0 |
| SE | Polishändelser (Sverige) | Polismyndigheten | De 500 senaste notiserna, cirka tio dagar, hela Sverige | Var 5:e minut | Öppna data, källan anges |
| SE | Kollektivtrafikstörningar (Sverige) | Trafiklab (Samtrafiken) | Störningar vid hållplatserna hos 16 regionala trafikbolag | Var 15:e minut | CC0 1.0 |
| +SE | Luftkvalitet | SMHI | Cirka 75 mätstationer på den europeiska EAQI-skalan. Originalet: Kanadensiska stationer (ECCC AQHI) | Varje timme | CC BY 4.0 (SMHI); EAQI-indexet räknas fram av appen |
| +SE | Regnradar | SMHI · EUMETNET OPERA | Nordisk radar från SMHI och europeisk radar från OPERA. Originalet: Radar över USA (NOAA) | Var 5:e minut | CC BY 4.0 (SMHI, OPERA) |
| SE | Vädervarningar (Sverige) | SMHI · Krisinformation.se | Vädervarningar, VMA och krisnyheter i hela Sverige | Var 5:e minut | CC BY 4.0 (SMHI) |
| SE | Väder nu (Sverige) | SMHI | Cirka 185 väderstationer, och en prognos där du klickar | Var 10:e minut | CC BY 4.0 |
| SE | Sjöväder (Sverige) | SMHI | Cirka 70 stationer längs kusten | Var 10:e minut | CC BY 4.0 |
| SE | Vattenföring (Sverige) | SMHI | Cirka 150 stationer i vattendragen | Kvartsvärden, publiceras med fördröjning | CC BY 4.0 |
| SE | Norrskensprognos | NOAA SWPC | Norra halvklotet, med chansen över nio svenska orter | Var 10:e minut | Allmän egendom (USA:s statsförvaltning) |
| +SE | Blixttäthet | EUMETSAT (MTG) | Blixtar över Europa och Afrika från satelliten MTG. Originalet: Blixttäthet över Nord- och Sydamerika (NOAA) | Var 5:e minut | CC BY 4.0 (© EUMETSAT 2026) |
| SE | Blixtnedslag (Sverige) | DMI | Varje urladdning över Norden den senaste timmen | Varje minut | CC BY 4.0 |

<!-- källor:end -->

## Avgränsningar och säkerhet

Varje lager visar uppgifter som redan finns publicerade. Men när många källor
ligger i samma vy kan helheten säga mer än varje källa för sig. Därför gäller
de här gränserna, även för nya lager:

- **Inga personer.** Inga funktioner för att söka efter, känna igen eller
  spåra enskilda personer (samma gräns som originalet, se
  [CONTRIBUTING.md](CONTRIBUTING.md)). Inga personuppgifter i koden eller i
  ögonblicksbilderna.
- **Inga rörelser hos polis eller räddningstjänst.** Polisbilars positioner
  är inte offentliga och byggs inte. Polisstationerna visar adress och vad
  receptionen erbjuder. Polishändelserna är Polisens egna notiser, placerade
  vid kommunens centralort och ofta publicerade timmar i efterhand.
  Brandstationerna visar den beredskapsform MCF själv publicerar, inga larm
  eller fordon. Fartygslagret visar inte polisens eller Kustbevakningens
  fartyg (AIS-typ 55). Sjöräddningens fartyg (typ 51) syns: de sänder sin
  position öppet för att andra fartyg ska se dem.
- **Bara butiker och apotek.** Butikskedjorna visar inga lager,
  distributionscentraler, kontor eller bankomater.
- **Platser, inte aktiv övervakning.** Fartkamerorna är Trafikverkets
  kameraplatser; polisen flyttar utrustningen mellan dem.
- **Ingen egen insamling från webbsidor.** Kedjornas butikssökare och
  regionernas väntetidssidor används inte. Ögonblicksbilder från
  OpenStreetMap byggs med skript som körs för hand; appen frågar aldrig
  Overpass själv.
- **Nycklar bara i `.env`**, som aldrig checkas in. Hela historiken är
  genomsökt efter nycklar utan träff, och varje commit söks igenom innan den
  görs.
- **Egna nycklar, källornas villkor.** Varje användare skaffar sina egna
  nycklar, och varje källas villkor gäller den som använder nyckeln; koden
  är fri (MIT), datan är det inte alltid. Några källor får bara användas
  icke-kommersiellt, bland annat OpenSky (flyg); se OpenSky under "Källor
  med oklara eller särskilda villkor".
- **Varje ny källa prövas** innan den byggs in: dokumenterat gränssnitt och
  licens, om dataägarens godkännande krävs, om villkoren tillåter
  användningen, och vad källan tillför helheten. Utfallet skrivs in här.

### Källor med oklara eller särskilda villkor

Alla svenska källor är genomgångna (2026-11-10). De flesta har en öppen
licens eller öppna data med källan angiven: Trafikverket, Trafiklab, SCB och
Wikidata (CC0), SMHI, DMI och EUMETSAT (CC BY 4.0), MCF, Polisen,
Socialstyrelsen, Krisinformation, NOAA och OpenStreetMap (ODbL). Följande har
oklara eller särskilda villkor. De visas med källan angiven, och de utan
licens ska helst ersättas med en dokumenterad källa eller godkännas:

- **Polisen (händelser och polisstationer):** ingen licens angiven, men
  Polisens "Regler för öppna data" (granskade av Polisen 2026-09-24) gäller:
  varje anrop ska ha en User-Agent som namnger appen, det ska gå minst 10
  sekunder mellan anropen, högst 60 i timmen och 1 440 per dygn, och ett
  404-svar är permanent. Appen skickar `GodsEyeViewSverige/1.0` med en länk
  till projektet, hämtar händelserna var 5:e minut och stationerna en gång
  per dygn, väntar 5 minuter efter ett fel och 30 minuter efter svaret 429,
  och frågar aldrig igen efter 404. Polisens bilder får inte användas utan
  tillstånd; appen visar inga.
- **Kraftsystemet:** läser ENTSO-E:s transparensplattform, ett dokumenterat
  gränssnitt, med en gratis nyckel (se Nycklar). Flödena mellan elområdena
  och grannländerna är där fria att återanvända (CC BY 4.0), medan
  produktion per kraftslag och förbrukning inte står på ENTSO-E:s lista
  över fri data och kräver Svenska kraftnäts godkännande. Lagret visar
  därför bara flödena, med "ENTSO-E (CC BY 4.0)" som källa, och panelen
  KRAFT med dygnskurvan visas inte; produktion och förbrukning läses bara
  med `ENTSOE_PRODUCTION=on`, när Svenska kraftnät har godkänt det. Utan
  nyckel ber lagret om den och visar inget. ENTSO-E publicerar senast en
  timme efter driftperioden, så lagret visar senaste publicerade kvarten,
  inte nuet. Svenska kraftnäts egen kontrollrumstjänst, samma som sidan
  svk.se/om-kraftsystemet/kontrollrummet använder, är odokumenterad och
  har ingen licens; den används bara med `POWER_GRID_SOURCE=svk`. Svenska
  kraftnät är tillfrågat (2026-11-10). Provat mot riktig data 2026-11-11: alla 14
  förbindelser svarade, produktionen stämde med Svenska kraftnäts på
  megawatten, och inga överlappande serier eller luckor fanns. En riktning
  som ändå kommer två gånger för samma kvart lämnas bort i stället för att
  räknas dubbelt.
- **Strålning:** Strålsäkerhetsmyndighetens gammastationskarta. Ingen licens
  angiven.
- **Sjöväder:** SMHI:s havsobservationer (CC BY 4.0): vattenstånd mot årets
  medelvattenstånd, vattentemperatur och vågor vid ett 70-tal stationer
  längs kusten, men ingen vind och inga sjöar eller kanaler; tre anrop per
  uppdatering. Sjöfartsverkets ViVa används inte: Sjöfartsverket svarade
  2026-11-13 att det inte tillåter vidarepublicering av informationen.
- **Trafikmeddelanden (SR):** används inte sedan 2026-11-13. Sveriges
  Radios API-villkor tillåter materialet "endast … genom länkning och/eller
  streaming" och att det inte lagras, medan lagret visade och sparade hela
  texten; SR:s trafik-API underhålls inte heller längre. Lagret är dolt och
  appen frågar inte SR; koden finns kvar om SR skulle ge sitt tillstånd.
  Olyckor, vägarbeten och avstängningar visas i stället av Trafikverkets
  Väglag (CC0) och kollektivtrafikens störningar av Trafiklab (CC0).
- **Elpris:** Elpriset just nu säger att API:et är fritt för vem som helst,
  för vad som helst. Priserna är Nord Pools och hämtas från ENTSO-E, där
  dagens priser inte står på listan över data som är fri att återanvända.
  Källan anges som "Elpriset just nu.se (Nord Pool via ENTSO-E)".
- **Swedavia (flygtavlan, dossiern, cockpit):** villkoren lästa 2026-11-11
  (apideveloper.swedavia.se, "Terms of Use" vid registreringen). Swedavia
  ger en licens att använda och visa datan offentligt i en egen app eller
  webbtjänst (3.3), och det ska tydligt framgå att datan kommer från
  Swedavia, helst med en länk till swedavia.se (3.4, 5.1). Oförändrad data
  får visas i egna appar men inte skickas vidare till andra system eller
  säljas (3.7), och nyckeln får inte lämnas till någon annan (5.2).
  Tavlan och dossiern anger "Källa: Swedavia".
- **Open-Meteo (vädret i cockpit, originalets lager):** villkoren lästa
  2026-11-11 (open-meteo.com/en/terms). Den fria nivån gäller bara
  icke-kommersiellt bruk, under 10 000 anrop per dygn, och datan är CC BY
  4.0. Marknadsföring räknas som kommersiellt, så cockpitens väderpanel
  visas inte i filmer.
- **Kolada (dossiern):** fritt, även kommersiellt, men källan ska anges som
  "Kolada", värden vi själva räknar fram får inte anges med Kolada som källa,
  och appen får inte framstå som ett officiellt samarbete. Koladas API har
  inga angivna gränser för anrop; fliken STATISTIK läser ändå bara en gång
  per dygn. Placeringen bland kommunerna anges som appens egen beräkning.
- **SMHI (väder, varningar, radar, luftkvalitet, vattenföring):** CC BY 4.0:
  SMHI ska anges som källa, och det ska framgå om materialet har ändrats.
  SMHI:s riktlinjer säger dessutom att bara dokumenterade API:er får
  användas, att samma data inte ska hämtas flera gånger och att inaktuella
  data helst inte ska lämnas ut. Vattenföringen läses från det dokumenterade
  API:et för kvartsvärden (opendata.smhi.se/hydroobs). Realtidsfilerna med
  tim- och dygnsvärden är en avgiftsbelagd tjänst och används inte.
- **TomTom (originalets trafiklager, valfri nyckel):** de svenska
  tilläggen använder inte TomTom. Stadsdossierns köer runt orten hämtades
  därifrån men togs bort 2026-11-11, eftersom appen inte uppfyller
  villkoren (lästa 2026-11-11, punkterna 2, 11, 12, 14 och 17): licensen
  gäller en "Permitted Solution" enligt ett abonnemang, annars bara egen
  utvärdering och test (2.1–2.2). Svar får inte lagras; de får bara cachas
  i klienten, enligt svarets egna cachehuvuden, och aldrig för att betjäna
  flera användare (11.4). Innehållet får inte bli en egen tjänst eller
  databas (11.6.1) och inte användas för trafikövervakning eller för att
  välja platser för fartkameror (11.6.8). Slutanvändare ska godkänna ett
  licensavtal minst lika strängt som TomToms (12). TomToms
  upphovsrättsnotis ska hämtas från deras Copyright API (17.3).
  Originalets trafiklager läser, enligt originalets dokumentation,
  fortfarande TomToms flödesdata genom en serverproxy med 120 sekunders
  cache när `TOMTOM_API_KEY` är satt; samma villkor gäller där, och utan
  nyckeln kör lagret sin simulering. Köerna i dossiern ska ersättas med
  Trafikverkets TrafficFlow (CC0), tidigast när schemaversion 1.6 med
  normalflöde (BaselineTraffic) är i drift, planerad till 2026-11-18, och
  täckningen är kontrollerad mot verkliga data.
- **Valmyndigheten (valresultat i dossiern och valdistrikten):** öppna data
  som är fria att använda med Valmyndigheten angiven som källa (val.se, "Om
  våra öppna data"). Valmyndigheten anges som källa.
- **Wikipedia och Wikimedia Commons (text, foto och vapen i dossiern):**
  texten är CC BY-SA 4.0 och länkas. Bilderna har egna licenser, ofta CC BY
  eller CC BY-SA, som kräver att upphovsperson och licens anges vid bilden.
  Servern läser båda ur filens metadata hos Commons (eller svenska
  Wikipedia, för en fil den har själv), och panelen, ortskortet och Sevärt
  visar till exempel "Foto: Listz3 · CC BY-SA 4.0" med länk till filens
  sida. En bild utan licens att ange visas inte.
- **OpenSky (flyg, originalets lager):** villkoren lästa 2026-11-11
  (opensky-network.org/about/terms-of-use). Licensen gäller bara ideell
  forskning och ideell utbildning; myndigheter kan få undantag efter
  OpenSkys beslut (punkt 1). Kommersiell användning kräver skriftligt
  tillstånd, och det gör också all användning av API:et i en levande
  produkt, tjänst eller ett automatiserat system, även internt och även
  utan vinstsyfte (punkt 1 och 3(vi)). Flyglagret frågar API:et var 30:e
  sekund medan appen är öppen och omfattas därför av det kravet, med eller
  utan konto. Datan får inte lämnas vidare till andra (3(iii)); var och en
  som kör appen har sitt eget avtal med OpenSky. Visas data offentligt,
  även på webben, i filmer eller presentationer, ska anropssignaler,
  registreringar och ICAO-adresser anonymiseras (3(i)), artikeln citeras
  (Schäfer m.fl., "Bringing up OpenSky", IPSN 2014; webbadressen
  opensky-network.org får läggas till) och OpenSky få en kopia eller en
  länk (4(i)). OpenSky hör därför till gruppen "kräver tillstånd" och
  används inte i den svenska versionen: flyg kommer som standard från
  adsb.lol, och OpenSky frågas aldrig, inte heller efter spåret bakåt, som
  då inte visas. `FLIGHTS_SOURCE=opensky` tar tillbaka OpenSky och kräver
  då deras skriftliga tillstånd.
- **adsb.lol (flyg):** villkoren lästa 2026-11-11 (api.adsb.lol/docs).
  API:et är gratis och all data adsb.lol publicerar har licensen ODbL 1.0,
  samma som OpenStreetMap: källan ska anges, och en sammanställd databas
  som görs offentlig ska delas under samma licens. Den som använder API:et
  i produktion ombeds kontakta adsb.lol först, och en nyckel (som fås genom
  att skicka in egen mottagardata) är planerad. Appen läser flygplanen
  inom 250 sjömil från kartans mitt. Täckningen över Sverige var
  2026-11-11 i nivå med OpenSkys (137 mot 139 flygplan runt Malmö, 60 mot
  64 runt Stockholm, 12 mot 12 runt Kiruna). adsb.lol:s data är
  ofiltrerad, men appen tar bort flygplan vars ägare bett om att inte visas
  (märkta PIA eller LADD); vid kontrollen var det ett eller två per område.
  Källan anges som "adsb.lol (ODbL 1.0)" under "Datakällor" och ska anges
  likadant i bilder och filmer.
- **AISStream (fartyg, originalets lager):** inga villkor eller licens
  publicerade på aisstream.io (sökt 2026-11-11); tjänsten beskriver sig
  som gratis. Hör till gruppen utan publicerad licens.
- **NASA FIRMS (bränder, originalets lager):** öppna data. NASA uppmuntrar
  fri användning och publicering; källan anges som "NASA FIRMS"
  (earthdata.nasa.gov/data/tools/firms/faq, läst 2026-11-11).
- **Cesium ion (kartor, terräng och Googles 3D-städer):** villkoren lästa
  2026-11-11 (cesium.com/legal/terms-of-service och bilaga B-2). Det fria
  kontot gäller icke-kommersiella personliga projekt. Licensen är personlig:
  tjänsten får inte göras tillgänglig för andra eller köras som en tjänst
  åt andra (2.2.1), data får inte sparas för användning utan
  internetanslutning (2.2.2) och Cesium ion-loggan ska synas i appens
  huvudfönster (2.2.3), vilket den gör. Googles 3D-städer hämtas genom
  Cesium ion, och då gäller också bilaga B-2: Googles källangivelse ska
  synas, innehållet får inte sparas eller cachas, inte användas för att
  skapa eget innehåll och inte tas med i elektroniska eller tryckta
  dokument (3a(vi)). Bilaga B-2 förbjuder också att Googles innehåll
  används tillsammans med eller nära en karta från någon annan än Google
  (3e). Cesiums egen guide för innehåll och källangivelse
  (cesium.com/learn/ion/content-usage-and-attribution-guide) säger
  samtidigt att renderingar av ett projekt, till exempel filmer, får
  publiceras om källangivelserna syns i bilden; länken "Datakällor"
  räcker inte. Cesiums personal har i forumet (tråd 43302, 2025) svarat
  att film med Googles 3D-städer går bra om alla källangivelser syns, och
  Cesiums guide om restider med Googles 3D-städer och Esri uppmanar
  läsarna att dela resultatet. README visar därför åter bilder med Googles
  3D-städer, med Cesium-loggan, Google Maps-loggan och källangivelsen
  synliga. Frågan är också ställd i Cesiums forum (2026-11-11), liksom
  frågan om kartöverlägg (sjömärken, pister, NASA-bilder, radar) ovanpå
  Googles 3D-städer; bilderna tas bort igen om svaret blir nej.
  Lantmäteriets enhet för kart- och bildsekretess svarade 2026-11-12 att
  det är Google som sprider den geografiska informationen och som ska ha
  spridningstillstånd enligt lagen om skydd för geografisk information;
  den som använder Googles data behöver inget eget tillstånd.
  Googles egna regler för Map Tiles API (developers.google.com/maps/
  documentation/tile/policies, läst 2026-11-12), som bilaga B-2 hänvisar
  till, tillåter reklamfilmer om appens funktioner bara om filmen är högst
  30 sekunder, märkt "for promotional purposes only", utan Street View och
  med Googles källangivelse. Den långa filmen (1:43) är därför borttagen ur
  README; titelanimationen (7 sekunder) är märkt. Längre filmer görs på
  OpenStreetMap-kartan.
- **OpenStreetMap (kartan OSM):** data under ODbL. Kartbilderna kommer från
  OpenStreetMaps egna servrar, vars regler
  (operations.osmfoundation.org/policies/tiles, lästa 2026-11-11) kräver
  att källangivelsen syns på kartan, inte bakom en knapp, och förbjuder
  att kartbilder laddas ner i förväg eller i mängd. Appen visar "©
  OpenStreetMap contributors" på kartan när OSM är valt.

## Nycklar (`.env`, checkas aldrig in)

| Variabel | Används till | Var den skaffas |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | kameror, tåg, väglag, händelser | data.trafikverket.se |
| `TRAFIKLAB_GTFS_RT_KEY` | bussar m.m. live | trafiklab.se → GTFS Regional Realtime |
| `TRAFIKLAB_GTFS_STATIC_KEY` | linjenummer och fordonstyp | trafiklab.se → GTFS Regional Static |
| `TRAFIKLAB_REALTIME_KEY` | lokaltrafikens avgångar i stadsdossiern | trafiklab.se → Trafiklab Realtime APIs |
| `SWEDAVIA_FLIGHTINFO_KEY` | avgångar och ankomster i dossiern, tavlan och cockpit | apideveloper.swedavia.se → FlightInfo Free |
| `SWEDAVIA_WAITTIME_KEY` | köerna i säkerhetskontrollen | apideveloper.swedavia.se → WaitTime Free |
| `ADSBDB_ROUTES` | `on`: flygrutter från adsbdb, vars ruttdata inte får publiceras utan David J Taylors tillstånd; tom (standard): inga rutter | ingen nyckel |
| `REGIONAL_NEWS_GOOGLE` | `on`: rubrikerna i stadspanelen och cockpit från Google News, vars villkor bara tillåter personligt, icke-kommersiellt bruk; tom (standard): inga rubriker över Sverige, GDELT utanför | ingen nyckel |
| `FLIGHTS_SOURCE` | tom (standard): flyg från adsb.lol (ODbL) runt kartans mitt, OpenSky frågas aldrig; `opensky`: originalets OpenSky, som kräver deras skriftliga tillstånd | ingen nyckel |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | flyg med större kvot än utan konto (originalets lager; OpenSkys villkor kräver skriftligt tillstånd för användning i en app som denna, se "Källor med oklara eller särskilda villkor") | opensky-network.org → konto → API client (under KOPPLA PÅ) |
| `ENTSOE_PRODUCTION` | `on`: produktion, förbrukning och dygnskurva från ENTSO-E också; bara när Svenska kraftnät har godkänt det | ingen nyckel |
| `ENTSOE_SECURITY_TOKEN` | kraftsystemets flöden från ENTSO-E (CC BY 4.0); behövs för lagret | transparency.entsoe.eu → registrera, mejla transparency@entsoe.eu "RESTful API access", sedan My Account → Generate token |
| `CESIUM_ION_TOKEN` | fotorealistiska 3D-städer | ion.cesium.com |
| `ARCGIS_API_KEY` | Esris satellitbild i 2D och sparläget; utan nyckel visas OpenStreetMap. Nyckeln syns i webbläsaren och ska begränsas hos Esri till appens adresser; den gäller högst ett år och behöver förnyas | location.arcgis.com → gratis Location Platform-konto (inte ett ArcGIS public account) → Developer credentials → API-nyckel, offentlig applikation, bara Baskartor, referenter `http://localhost:4173` och `http://127.0.0.1:4173` |

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

### 2026-11-13 (strängare innehållspolicy)
- Webbläsarens innehållspolicy (CSP) tillåter inte längre skript och ramar
  från YouTube, Facebook och X. De behövdes bara för Nepal-scenens inbäddade
  media, och scenen erbjuds inte i forken. Det enda främmande skriptet som
  tillåts är Googles Maps JavaScript API för Street View.

### 2026-11-13 (Sjöfartsverkets ViVa borttagen)
- Sjöfartsverket svarade 2026-11-13 att det inte tillåter vidarepublicering
  av ViVa-informationen. Sjöväder läser därför bara SMHI:s havsobservationer
  (CC BY 4.0); valet `SEA_WEATHER_SOURCE=viva` och all kod som läste ViVa är
  borta, liksom ViVa i källhänvisningar, ursprungsuppgifter och dokumentation.
  Lagret har varit SMHI som standard sedan 2026-11-13, så det som syns i
  appen ändras inte.
- Källkortet överst i README (`docs/media/sverige/kallor.webp`) är omgjort:
  Sveriges Radio och Sjöfartsverket (används inte), Svenska kraftnät (bara
  tillval) och Strålsäkerhetsmyndigheten (ingen angiven licens) är borta;
  MCF, Socialstyrelsen, Naturvårdsverket och Riksantikvarieämbetet har
  tillkommit. Siffrorna räknas som förut: API:er och
  dataset är summan av källornas märken (Trafikverket 1, SMHI 6, Swedavia 2,
  Samtrafiken 3, Polisen 2, MCF 2, övriga 1), datatyper samma summa med
  Trafikverkets 10 objekttyper; 24 och 33 i dag. "Live" är strukket ur
  undertexten eftersom några källor är ögonblicksbilder i repot. Kraftsystemets
  rad i tabellen ovan anger nu ENTSO-E, som är standard sedan 2026-11-11.
- Rutan Data attribution nämnde fortfarande Sveriges Radios
  trafikmeddelanden fast lagret är dolt sedan tidigare i dag; den raden är
  borttagen.

### 2026-11-13 (vägfärjor)
- Nytt lager **Vägfärjor (Sverige)** (delningstoken `10`) under Movement,
  bredvid kollektivtrafiken: Trafikverkets ca 40 färjeleder som prickar med
  nästa avgångstid bredvid. Klick på en led visar hamnarna, Trafikverkets
  meddelande för leden och de närmaste avgångarna de kommande tre timmarna
  med Trafikverkets noter (t.ex. kallelseturer). Gul prick betyder att
  Trafikverket har ett meddelande med text för leden, till exempel inställd
  trafik på Holmöleden i hårt väder; varje led har också en stående
  situation med bara ledens namn, och den räknas inte som meddelande.
- Källa: Trafikverkets öppna API (CC0), objekten `FerryRoute`,
  `FerryAnnouncement` och `Situation` med meddelandetypen Färjor, i ett
  enda anrop med den befintliga nyckeln `TRAFIKVERKET_API_KEY`. Servern
  frågar högst varannan minut medan lagret är på. Inga personuppgifter.
- Forkens egna lager har fått delningstoken `0c`–`0z` i tur och ordning
  medan `00`–`0b` lämnas åt originalets nya lager; nu när `0z` är använd
  fortsätter forken på `10`.

### 2026-11-13 (lokaltrafikens avgångar i stadsdossiern)
- Stadsdossiern visar nu, bredvid tågen och flygen, de närmaste bussarna,
  spårvagnarna, tunnelbanetågen och båtarna från stadens mest trafikerade
  hållplats den närmaste timmen: linje, destination, tid, försening, läge och
  Trafiklabs störningsrubrik. Hållplatsen är den med flest avgångar per dygn
  bland hållplatserna inom 8 km som bär stadens namn. Tågen visas inte här
  igen; de kommer från Trafikverket.
- Källa: Trafiklab Realtime APIs (CC BY 4.0, "Trafiklab (CC BY 4.0)" i
  dossierns källrad och i rutan Data attribution med länk till licensen).
  Ny gratisnyckel `TRAFIKLAB_REALTIME_KEY` (Bronze: 100 000 anrop i månaden,
  25 i minuten), som kan läggas in under KOPPLA PÅ. Appen stannar vid 3 000
  anrop per dygn (93 000 en månad med 31 dagar) och 20 i minuten. Hållplatsen
  slås upp en gång per stad och dygn, avgångarna högst en gång i minuten, och
  dossiern frågar var tionde minut. Nyckeln stannar på servern.

### 2026-11-13 (Mapillarys logga i Street Levels källhänvisning)
- Mapillarys villkor (§ 11) kräver att appar som visar Mapillarys bilder
  visar Mapillarys logga och länkar till mapillary.com. Källhänvisningen för
  Street Level har nu loggan, länkad till mapillary.com, både på jordklotet
  och i rutan Data attribution. Loggan kommer oförändrad ur Mapillarys
  officiella pressmaterial (`public/logos/`, ursprung och varumärke i
  `public/logos/README.md`).

### 2026-11-13 (Nepal-scenen och resten av granskningen)
- Originalets scen om översvämningen i Nepal erbjuds inte längre:
  händelsepaketet är bara icke-kommersiellt (CC BY-NC 4.0) och bevisraderna
  laddade Facebooks, X:s och YouTubes skript utan samtycke. En webbläsare som
  redan har scenen i sitt sparade projekt blir av med den vid nästa
  start. Scenen finns kvar i koden för sammanslagningar med originalet.
- Anropen till Nominatim, routningen och de andra tjänsterna som vill att
  appen presenterar sig anger nu forkens adress i User-Agent i stället för
  originalets.
- Swedavia: högst 300 anrop per nyckel och dygn (9 300 en månad med 31
  dagar) mot den fria nivåns 10 000, med marginal för omstarter samma dag.
- Trafiklabs störningar frågas villkorat (If-Modified-Since och ETag), som
  Trafiklab rekommenderar; ett oförändrat flöde laddas inte ner igen.
- Valobservationer från Acartia läses inte: API:et kräver konto och nyckel,
  och späckhuggarnas positioner bredvid fartygens är en risk för dem.
- Kamerapaket vars enda villkor är en artighetsnotis (Austin, Caltrans,
  TxDOT, DelDOT, Tallinn, Tarktee, Warendorf, A22) laddas bara om man slår
  på dem med `CCTV_…_ENABLED=1`; Tallinns och Warendorfs kameror kan visa
  människor.
- Upphovspersonens länk till 3D-modellen Cessna Citation pekar rätt.

### 2026-11-13 (Sveriges Radios trafikmeddelanden borttagna)
- Lagret Trafikmeddelanden (SR) visas inte längre och appen frågar inte
  SR. Villkoren tillåter SR:s material bara genom länkning eller strömning
  och inte att det lagras, medan lagret visade och sparade hela texten, och
  SR:s trafik-API underhålls inte längre. Trafikverkets Väglag och
  Trafiklabs störningar täcker olyckor, vägarbeten, avstängningar och
  kollektivtrafiken. Koden finns kvar om SR ger sitt tillstånd.

### 2026-11-13 (Esris satellitbild bara med egen nyckel)
- Esris satellitbild, som visas i 2D och sparläget, hämtades utan nyckel
  från den gamla tjänsten services.arcgisonline.com. Esri kräver numera en
  nyckel för sina baskartor, och källraden syntes bara bakom en knapp.
  Satellitbilden läses nu från Esris nyckeltjänst med `ARCGIS_API_KEY`
  (gratis ArcGIS Location Platform-konto, 2 miljoner kartrutor i månaden,
  bara behörigheten Baskartor, begränsad till appens adresser), och
  "Powered by Esri" med datakällorna står på kartan. Utan nyckel är
  OpenStreetMap kartan i 2D och sparläget. Nyckeln läggs in under KOPPLA PÅ.

### 2026-11-13 (stadsdossiern: SCB:s API version 2)
- Folkmängden i stadsdossiern läses nu från SCB:s PxWebApi 2.0
  (statistikdatabasen.scb.se/api/v2). Version 1, som dossiern använde,
  slutar fungera vid årsskiftet 2026/2027. Tabellerna hittas genom en
  sökning på titeln, och den med senaste period vinner: tätorternas
  folkmängd i TAB4060 (år, inom senaste tätortsgränsen) och kommunens per
  månad i TAB6471 (i dag september 2026). Svaren kommer i JSON-stat 2.0,
  och SCB tillåter högst 30 anrop per 10 sekunder.
- Provat mot SCB med appens kod: Västerås tätort 133 067 (2025) och
  kommunen 161 967 (september 2026), likaså Gävle, Stockholm och Kiruna.
  Salem saknar tätort med kommunens namn och visar Wikidatas uppgift, som
  förut.

### 2026-11-13 (upphovsperson och licens vid dossierns bilder)
- Fotona och stadsvapnen i stadsdossiern, på ortskortet och under Sevärt
  är ofta CC BY eller CC BY-SA, som kräver att upphovspersonen och licensen
  anges vid bilden; det stod bara "Foto: Wikimedia Commons". Servern läser
  nu båda ur filens metadata hos Commons, högst 50 filer per anrop och
  sparade en vecka, och korten visar till exempel "Vapen: Marmelad · CC
  BY-SA 2.5" med länk till filens sida. En bild utan licens att ange, eller
  vars uppgifter inte gick att läsa, visas inte. Provat: Uppsala, Göteborg,
  Malmö och Stockholm, och 34 av 34 bilder under Sevärt i Uppsala.
- Stadsvapnen som syns i README-bilderna står med upphovsperson och licens
  i docs/media/README.md.

### 2026-11-13 (egen granskning av villkor och integritet)
- Markhöjderna under kamerorna (`cctv_ground_heights.json`, från
  originalet) var hämtade ur Googles 3D-städer, och Googles regler för Map
  Tiles tillåter inte att sådant sparas, sprids eller används för att ta
  fram egen terräng. Filen följer inte längre med; kamerorna placeras när
  appen körs, som originalet redan gör när filen saknas.
- En riktig TomTom-trafikruta låg som testfil. Den är ersatt med en
  egenritad ruta i samma format.
- Typsnitten (Inter, JetBrains Mono, Noto Sans Arabic och ikonerna i
  Material Symbols) serveras nu av appen själv i stället för av Google
  Fonts, så att ingen besökares IP-adress går till Google vid varje
  sidladdning. `scripts/vendor-fonts.mjs` hämtar dem på nytt när listan i
  `public/fonts/sources.txt` ändras; licenserna ligger bredvid.
- Cockpitens nyhetsrubriker hämtas inte längre från Google News, vars
  villkor bara tillåter personligt, icke-kommersiellt bruk och inte
  offentlig visning. GDELT provades som ersättare men svarade nästan alltid
  429 (för många anrop), även med minst fem sekunder mellan anropen. Över
  svenska orter frågas därför ingen; nyheterna där kommer från
  Krisinformation.se. Utanför Sverige läses GDELT, högst ett anrop per fem
  sekunder och inget alls en minut efter ett 429-svar.
  `REGIONAL_NEWS_GOOGLE=on` tar tillbaka Google News för eget bruk.
- S2 GhostMaps (originalets lager) visas inte längre: licensen är bara
  icke-kommersiell och lagret är en militär lägesbild, som de militära lager
  forken redan tagit bort.
- Sjöväder läser som standard SMHI:s havsobservationer (CC BY 4.0).
  Sjöfartsverkets ViVa läses bara med `SEA_WEATHER_SOURCE=viva` tills
  Sjöfartsverket har svarat.
- SMHI:s varningar visas med hela texten; SMHI:s villkor säger att
  varningar inte får ändras, och korten kortade tidigare av dem.
- Rättade uppgifter: kollektivtrafikstörningarna och elpriset uppdateras
  var 15:e minut (det stod varannan minut och varje minut),
  Krisinformation.se drivs av MCF (det stod MSB), blixtar från EUMETSAT är
  CC BY 4.0 och krediteras "© EUMETSAT 2026", EAQI-indexet för luftkvalitet
  är appens egen beräkning, och Valmyndighetens villkor finns ("fri att
  använda med Valmyndigheten angiven som källa").
- LICENSE och DATA_SOURCES.md beskrev TeleGeography-filerna som medskickade;
  nu står att de, och markhöjderna, inte följer med. De svenska
  ögonblicksbilderna från OpenStreetMap står med bland ODbL-datan.

### 2026-11-13 (README-bilderna och filmen tagna om med dagens HUD)
- En egen granskning visade att alla bilder i README, titelanimationen och
  cockpitklippet i filmen var tagna före 2026-11-12, med originalets
  sken av hemligstämplad satellitbild ("TOP SECRET // NOFORN", "KH11",
  omlopps- och passnummer). Appen visar sedan dess vad den visar, öppna
  data; nu gör bilderna det också. Alla är tagna om, och titelanimationen
  är gjord av dagens flygtagning med "for promotional purposes only" i
  bilden.
- Cockpitbilden visas utan väderpanelen från Open-Meteo, vars fria nivå
  bara gäller icke-kommersiellt bruk.
- Kraftsystemet står nu med rätt källa i README: flödena kommer från
  ENTSO-E, inte Svenska kraftnät, sedan 2026-11-11.

### 2026-11-12 (fornlämningar från Riksantikvarieämbetet)
- Nytt lager **Fornlämningar (Sverige)** (delningstoken `0c`) under
  Infrastructure, efter Skyddad natur: Riksantikvarieämbetets registrerade
  fornlämningar och övriga kulturhistoriska lämningar som prickar på marken,
  färgade efter antikvarisk bedömning (fornlämning, möjlig fornlämning,
  övrig kulturhistorisk lämning, ingen bedömning). Lagret visas under 12 km
  höjd och ritar de 1 500 närmast kartans mitt. Klick på en prick visar typ,
  bedömning, lämnings- och RAÄ-nummer, kommun och om den är bekräftad i
  fält; klick på kortet öppnar lämningen hos RAÄ.
- Källan är Kulturmiljöregistret (samma som Fornsök) via RAÄ:s
  INSPIRE-tjänst (OGC API Features), ingen nyckel. Enligt RAÄ:s
  produktbeskrivning (version 3, 2026-02-02) omfattas datan inte av
  upphovsrätt (public domain) och har inga åtkomstbegränsningar; källa och
  datum bör anges, vilket kortet och källförteckningen gör. Lägena kan
  avvika upp till 20 m, och informationen får inte användas för att
  planera markingrepp.
- Ingenting laddas ned i förväg: det finns cirka 840 000 lämningar. Servern
  frågar RAÄ bara om rutan i vyn, utvidgad till ett rutnät på 0,02 grader
  så att närliggande vyer delar svar, och sparar svaret ett halvt dygn.
  Högst 4 000 lämningar per fråga; en bredare vy än 0,15 grader frågar
  ingen. Efter ett fel lämnas RAÄ i fred i två minuter.
- Medvetet utelämnat: lämningarnas beskrivning och orientering
  (vägbeskrivning till platsen). De finns hos RAÄ, ett klick bort. Lagret
  visar samma lägen som RAÄ självt publicerar i Fornsök för alla.

### 2026-11-12 (Sveriges Radios kanaler ur radiolagret)
- Radiolagret (originalets, med stationer från Radio Browser) visar inte
  längre Sveriges Radios kanaler. De känns igen på att strömmen eller
  hemsidan ligger hos sr.se eller sverigesradio.se, eller på namnet.
  SR:s villkor (punkt 2) säger att andra får använda SR:s linjära kanaler
  bara med SR:s skriftliga godkännande, och vår app samlar andras kanaler.
  Alla andra stationer, även svenska kommersiella, visas som förut.
  Stadsdossiern länkar till ortens P4-kanal hos Sveriges Radio.

### 2026-11-12 (film, sjökablar och lokalradio efter en granskning av villkoren)
- Den långa filmen (1:43) är borttagen ur README: Googles regler för
  Map Tiles API tillåter reklamfilmer med Googles 3D-städer på högst 30
  sekunder, märkta "for promotional purposes only". Titelanimationen överst
  är 7 sekunder och har fått märkningen. Skälen står under Cesium ion i
  "Källor med oklara eller särskilda villkor".
- Originalets sjökabellager (TeleGeography) finns inte längre i den svenska
  versionen. Datafilerna är borttagna och lagret visas inte i Datalager;
  koden finns kvar så att sammanslagningar med originalet fungerar.
  TeleGeography säljer i dag den geokodade datan bakom sina kartor med
  årlig licens, och deras Creative Commons-licens (CC BY-SA 4.0) gäller
  kartbilder, länkar och skärmdumpar, inte GeoJSON-filerna. Ingen licens
  som tillåter att just de här filerna sprids vidare har gått att hitta.
- Stadsdossiern spelar inte längre P4 i appen. Knappen är nu en länk till
  ortens P4-kanal hos Sveriges Radio (alla 25 kanalsidor kontrollerade):
  enligt SR:s villkor punkt 2 får andra använda SR:s linjära kanaler bara
  med SR:s skriftliga godkännande. I Skåne och Västra Götaland väljs
  kanalen närmast orten.
- KOPPLA PÅ säger nu att varje nyckel hör till användarens eget konto hos
  leverantören, att användaren ansvarar för nyckeln, kvoter, avgifter och
  villkoren, och att publicering av bilder eller filmer kan kräva separat
  tillstånd.

### 2026-11-12 (skyddad natur: nationalparker och reservat)
- Nytt lager **Skyddad natur (Sverige)** (delningstoken `0d`) under
  Infrastructure, efter Valdistrikt 2026: Sveriges 31 nationalparker,
  6 019 gällande naturreservat och 52 kulturreservat som ytor på marken,
  mörkgröna, gröna respektive bruna. På hög höjd (vyn bredare än 3 grader)
  visas bara nationalparkerna; närmare in reservaten i vyn, högst 1 500
  närmast mitten. Klick på ett område visar kommun, areal och året beslutet
  vann laga kraft; klick på kortet öppnar området i Naturvårdsverkets
  kartjänst Skyddad natur.
- Källan är Naturvårdsverkets Naturvårdsregistret, nedladdat som öppna data
  (CC0 enligt "Naturvårdsregistret – Beskrivning av öppna data", utgåva 1.2;
  Naturvårdsverket ber om "Källa: Naturvårdsverket", som kortet och
  källförteckningen anger). Bara beslut med status "Gällande" tas med:
  överklagade eller ännu inte gällande beslut kan ändras.
- Medvetet utelämnat: vattenskyddsområden, eftersom de tillsammans pekar ut
  dricksvattentäkterna, samt tillträdesförbud, biotopskydd, naturminnen och
  de andra små skyddsformerna.
- `scripts/build-protected-nature.mjs` körs för hand: läser Naturvårdsverkets
  shapefiler (ny läsare `scripts/lib/shapefile.mjs`), räknar om SWEREF 99 TM
  till WGS 84, förenklar gränserna med en 150-del av områdets storlek (5 till
  50 m) och stoppar om en kontur blir mindre än områdets registrerade areal.
  Ögonblicksbilden är 2,7 MB (1,1 MB packad).

### 2026-11-12 (valdistrikt: riksdagsvalet 2026)
- Nytt lager **Valdistrikt 2026 (Sverige)** (delningstoken `0e`) under
  Infrastructure, efter Kommuner och län: riksdagsvalet 2026 i alla 6 312
  valdistrikt, slutlig rösträkning, som ytor på marken färgade efter
  största parti eller, med knappen VALDELTAGANDE, efter valdeltagande på
  en neutral färgskala utan rött, så att inget område läses som sämre.
  Klick på ett distrikt visar kommun, antal räknade röster, valdeltagande
  och alla riksdagspartiers andelar, störst först, och övriga partier
  tillsammans.
- Källan är Valmyndighetens öppna data: valdistriktskartorna (från
  länsstyrelserna, i SWEREF 99 TM) och rösterna per distrikt. All data är
  fri att använda med Valmyndigheten angiven som källa, utan avtal eller
  avgift (val.se, "Om vår öppna data"). Ett distrikts röster är de som
  räknades där; sena förtidsröster räknas i kommunens uppsamlingsdistrikt,
  som saknar yta och inte visas.
- `scripts/build-election-districts.mjs` körs för hand: räknar om
  koordinaterna till WGS 84, förenklar gränserna (5 m i tätort till 40 m för
  stora landsbygdsdistrikt), kopplar ihop dem med rösterna och kontrollerar
  att varje distrikt ligger i sin kommun. Ögonblicksbilden är 3,8 MB.
- Lagret visas under 120 km höjd och läser bara distrikten i vyn, högst
  1 200 närmast mitten, så inget ritas för hela landet på en gång.

### 2026-11-12 (Lantmäteriets svar om spridningstillstånd)
- Lantmäteriet svarade att spridningstillstånd för Googles 3D-städer är
  Googles sak, inte den som använder datan. Svaret står under Cesium ion i
  "Källor med oklara eller särskilda villkor".

### 2026-11-12 (HUD:en säger vad den visar; statistikraderna kortare)
- HUD:ens banner säger nu "ÖPPNA DATA // SVERIGE // PUBLICERAT" i stället
  för originalets amerikanska sekretessmärkning, raden under den
  "GEV-SE · öppen källkod" i stället för påhittade satellitbeteckningar,
  och den blinkande punkten "LIVE" i stället för "REC". Undertiteln under
  loggan säger "ALLT HÄR ÄR OFFENTLIGT".
- Originalets omlopps- och passbeteckningar, bildkvalitetsmåtten GSD
  och NIIRS och satellitmåtten längs kanterna (COLL, ONA, BAND, BITS och
  LVL) visas inte. Koordinaterna, MGRS, höjden och solhöjden står kvar.
- I stadsdossierns flik STATISTIK står raden under varje värde nu på en
  rad ("2026 · Sverige 229,7 · plats 86 av 290"); att platsen räknas från
  det högsta värdet sägs en gång längst ner.

### 2026-11-12 (stadsdossierns flik STATISTIK)
- Ny flik STATISTIK i stadsdossiern med tolv nyckeltal från Kolada för
  kommunen: meritvärde åk 9 och elever per lärare (Skolverket), anmälda
  brott och våldsbrott per 100 000 invånare (BRÅ och SCB), medellivslängd
  för kvinnor och män (SCB), sjukpenningtal (Försäkringskassan),
  skuldsatta hos Kronofogden, nystartade företag (Tillväxtanalys),
  växthusgaser per invånare (Nationella emissionsdatabasen), andel skyddad
  natur (SCB) och gästnätter per invånare (Tillväxtverket).
- Varje tal visar senaste år som de flesta kommuner har, hela Sveriges
  värde och kommunens plats bland kommunerna räknat från högst. Placeringen
  är appens egen beräkning och står inte med Kolada som källa, som Koladas
  villkor kräver. Ett kort påpekande säger att brott räknas där de anmäls.
- Servern läser alla kommuners värden i ett anrop per dygn (tre sidor och
  ett för hela Sverige) och svarar varje ort ur samma tabell; fliken
  hämtar bara när den öppnas.
- Andel förnybar el valdes bort: bara ett 60-tal kommuner har värden, så
  en placering skulle vilseleda. Underkategorier av brott och statistik om
  flyktingar och utrikes födda är medvetet utelämnade.

### 2026-11-12 (fartygslagret: polisens och Kustbevakningens fartyg)
- Fartygslagret visar inte längre fartyg som anger AIS-typ 55 (polis och
  Kustbevakningen), varken som rad, i Kontakter eller med spår. Ett fartyg
  vars typ ännu inte har kommit visas tills dess. Sjöräddningens fartyg
  (typ 51) syns som förut.

### 2026-11-12 (Polisens regler för öppna data)
- Anropen till Polisen följer nu Polisens regler för öppna data: en
  User-Agent som namnger appen (`GodsEyeViewSverige/1.0` med länk till
  projektet), minst 10 sekunder mellan alla anrop till Polisen, 5 minuters
  paus efter ett fel (tidigare 1 minut för händelserna) och 30 minuter efter
  svaret 429. Efter ett 404-svar frågas den resursen aldrig igen.
- Reglerna står under "Källor med oklara eller särskilda villkor".

### 2026-11-11 (sjöväder från SMHI som tillval)
- Med `SEA_WEATHER_SOURCE=smhi` läser Sjöväder SMHI:s öppna
  havsobservationer (CC BY 4.0) i stället för Sjöfartsverkets ViVa: tre
  filer med alla stationers senaste dygn ger vattenståndet mot årets
  medelvattenstånd, vattentemperaturen och vågorna. Det är tre anrop per
  uppdatering i stället för ett per station.
- SMHI mäter ingen vind, så lagret färgar då stationerna efter vattenstånd
  och visar inte knappen VIND. Kortet, lagrets rad och Datakällor anger
  SMHI.
- Standard är fortfarande ViVa.
- `.env.example` beskriver nu kraftsystemets, flygets och sjövädrets
  källval som de är.

### 2026-11-11 (regeln för det som publiceras)
- Principen har fått två nivåer: appen får visa källor utan publicerad
  licens med källan angiven, medan bilder, filmer, inlägg och presentationer
  bara visar öppna data och källor vars villkor tillåter offentlig visning,
  med källangivelsen synlig. Hela villkoren läses före varje ny källa.

### 2026-11-11 (kraftsystemet från ENTSO-E: bara flödena)
- Kraftsystemet läser nu ENTSO-E som standard, ett dokumenterat gränssnitt
  med öppen licens för flödena. Svenska kraftnäts odokumenterade
  kontrollrumstjänst används bara med `POWER_GRID_SOURCE=svk`.
- Lagret visar bara flödena mellan elområdena och grannländerna, som
  ENTSO-E släpper fritt (CC BY 4.0). Produktion och förbrukning hämtas inte
  alls; de kräver Svenska kraftnäts godkännande och slås på med
  `ENTSOE_PRODUCTION=on`. Det sparar också åtta av de 36 anropen per
  uppdatering. Panelen KRAFT med dygnskurvan visas bara när produktionen
  får visas.
- Utan ENTSO-E-nyckel, eller om ENTSO-E avvisar den, säger lagret det och
  visar inget; det tar inte Svenska kraftnäts tjänst i stället.
- Kortet, lagrets rad, Datakällor och källtabellen anger ENTSO-E som källa;
  tidigare stod Svenska kraftnät överallt.
- En riktning som ENTSO-E skickar två gånger för samma kvart gör att
  förbindelsen lämnas bort i stället för att räknas dubbelt.
- Provat mot riktig data genom proxyn: alla 14 förbindelser, produktionen
  lika med Svenska kraftnäts, inga överlapp och inga luckor.

### 2026-11-11 (ENTSO-E i nyckelpanelen)
- ENTSO-E:s nyckel (`ENTSOE_SECURITY_TOKEN`) kan sparas i panelen KOPPLA PÅ
  (Markstation · leverantörsinställningar) som de andra nycklarna, med
  länk till var den skaffas. Pinokio-startaren skickar också med den.

### 2026-11-11 (flygtavlan över källangivelsen; Swedavias villkor)
- Flygtavlan slutar nu ovanför kartans källangivelse. Tidigare räckte den
  så långt ner att den täckte Google Maps- och Cesium-loggan, som enligt
  villkoren alltid ska synas.
- README:s bild av flygtavlan är tagen om, med loggorna synliga.
- Swedavias villkor är hittade och lästa; de står under "Källor med oklara
  eller särskilda villkor" i stället för att Swedavia saknar villkor.
  Open-Meteos villkor (vädret i cockpit) står där också.

### 2026-11-11 (tre README-bilder tagna om)
- Titelfilmen, cockpitbilden och bilden på kraftsystemet är tagna om i
  3D-läget med Googles 3D-städer, med Cesium-loggan, Google Maps-loggan
  och källangivelsen synliga. Flyget kommer från adsb.lol (ODbL), flygplan
  vars ägare bett om att inte visas är bortfiltrerade, och ingen flygrutt
  från adsb.lol eller adsbdb syns.

### 2026-11-11 (README-bilderna tillbaka)
- Sex av README:s bilder med Googles 3D-städer är tillbaka: Cesiums guide
  tillåter publicerade renderingar när källangivelserna syns, och det gör
  de i bilderna. Skälen står under Cesium ion i "Källor med oklara eller
  särskilda villkor".
- Tre bilder kommer inte tillbaka: filmen överst visar flygplanens
  anropssignaler från tiden då flyget kom från OpenSky, vars villkor kräver
  att de döljs vid publicering; cockpitbilden visar en flygrutt från
  adsbdb, som inte får publiceras utan tillstånd; bilden på kraftsystemet
  visar Esris satellitbild, vars villkor inte är lästa.

### 2026-11-11 (bilder utan Googles 3D-städer; rutter och OSM)
- README:s kartbilder och film är borttagna: sju visade Googles 3D-städer,
  som Cesium ions villkor för Googles innehåll inte tillåter i dokument,
  och en Esris satellitbild, vars villkor inte är lästa. Bilden med
  källorna är kvar. Nya bilder tas på OpenStreetMap-kartan.
- adsbdb:s flygrutter läses inte längre: ruttdatan får enligt adsbdb.com
  inte kopieras, publiceras eller läggas i andra databaser utan David J
  Taylors tillstånd. Rutter som sparats på disk tidigare raderas.
  `ADSBDB_ROUTES=on` tar tillbaka dem. Flygplanstyp och registrering
  läses som förut.
- OpenStreetMap-kartan visar "© OpenStreetMap contributors" på själva
  kartan, som OpenStreetMaps regler kräver; tidigare stod det bara under
  Datakällor.

### 2026-11-11 (öppna data först; flyg från adsb.lol)
- Ny inledande princip: källorna delas in i öppna data, offentliga utan
  publicerad licens och sådana som kräver tillstånd. Den sista gruppen
  används inte. OpenSky och TomTom hör dit.
- Flyglagret hämtar som standard flygplanen runt kartans mitt från
  adsb.lol (ODbL) och frågar aldrig OpenSky, inte heller efter spåret
  bakåt. `FLIGHTS_SOURCE=opensky` tar tillbaka originalets OpenSky.
  Täckningen över Sverige är kontrollerad genom appens egen proxy.
- Flygplan vars ägare bett om att inte visas (readsb-märkningen PIA eller
  LADD) tas bort ur adsb.lol:s svar. Svaret anger hur många som togs bort.
- Datakällor anger adsb.lol för flygen och OpenSky bara när det väljs.
- AISStreams, NASA FIRMS och Cesium ions villkor är lästa och står under
  "Källor med oklara eller särskilda villkor", liksom att skärmbilder med
  Googles 3D-städer är tveksamma enligt Cesium ions villkor.

### 2026-11-11 (OpenSkys villkor lästa)
- OpenSkys villkor är lästa i sin helhet och sammanfattade under "Källor
  med oklara eller särskilda villkor". Det som stod tidigare var för
  svagt: myndigheter omfattas bara efter undantag, användning av API:et i
  en levande app kräver skriftligt tillstånd även utan vinstsyfte, och
  offentlig visning kräver anonymiserade flygplan och citat av artikeln.
  Samma rättelse är gjord i Kom igång och README.
- Ingen kod är ändrad.

### 2026-11-11 (stadsdossiern: TomTom-köerna borttagna)
- Avsnittet "Köer runt staden" i dossierns flik Nu är borttaget, och
  `/api/city-transit` frågar inte längre TomTom, med eller utan nyckel.
  Skälet är TomToms villkor, som appen inte uppfyller (se "Källor med
  oklara eller särskilda villkor").
- Ersättaren är Trafikverkets TrafficFlow (CC0, samma nyckel som tåg och
  vägkameror). Den byggs tidigast när schemaversion 1.6 med normalflöde är
  i drift (planerad 2026-11-18) och täckningen är kontrollerad.
- Originalets trafiklager är orört: det använder TomTom bara när
  `TOMTOM_API_KEY` är satt.
- Testet för att kraftsystemets sparande stannar väntade en fast tid på
  att dagen skrevs till disk och föll när hela testsviten kördes under
  belastning. Det väntar nu tills läsningen är klar.
### 2026-11-11 (passets inställning heter vad den gör; TomToms villkor lästa)
- Inställningen "Filmisk ankomst" i besökspasset heter nu "Ortskort vid
  första besöket": den styr bara om ortskortet visas, sedan den
  automatiska inflygningen togs bort.
- TomToms villkor är lästa och sammanfattade under "Källor med oklara eller
  särskilda villkor", med det appen inte uppfyller.

### 2026-11-11 (kraftsystemet: rättningar efter andra kodgranskningen)
- Servern slutar fråga Svenska kraftnäts kontrollrum när ingen har frågat på
  en halvtimme. Förut fortsatte den spara dygnet var 15:e minut tills
  dev-servern stängdes, även med lagret avstängt. Veckodiagrammet får då
  luckor för tiden lagret varit av.
- Ett elområde utan import- eller exportvärde visas inte, i stället för att
  stå med 0 MW, och en saknad tidsstämpel visas inte som 01:00.
- En ritning som misslyckades loggas som ritfel och görs om vid nästa
  uppdatering. Ett avstängt lager bär inte kvar sitt senaste fel.
- ENTSO-E-reserven (avstängd tills nyckeln finns): en gräns eller zon som
  inte svarar blir en lucka i stället för att fälla hela uppdateringen, och
  en länk med en oläst riktning visas inte alls. Ett avvisat anrop läses
  inte längre som "inga data", ett tomt mätvärde är inte 0 MW, och
  produktion äldre än två timmar visas inte bredvid färska flöden.
- Kvar i reserven tills den kan provas mot riktiga data: luckor i ett
  enskilt kraftslag, överlappande serier och att källan ska anges som
  ENTSO-E i reservläget.

### 2026-11-11 (stadsdossierns panel: rättningar efter kodgranskning)
- En transportkälla som inte svarade visas inte som tom: när TomTom inte
  svarar står det inte längre "Inga köer just nu", utan trafiken nämns bland
  det som saknar svar, och ett nytt försök görs efter en minut.
- En vald sevärdhets bild länkar till sin sida på Wikimedia Commons, där
  upphovsperson och licens står.

### 2026-11-11 (flygplatsköer och VMA-banner: rättningar efter kodgranskning)
- Kötiderna i säkerhetskontrollen hämtas bara när flygplatsens terminaler
  ryms i bild. Förut räckte det att vyn låg inom 20 km från en flygplats,
  så varje vy över centrala Stockholm drog ett Swedavia-anrop var tredje
  minut mot dagskvoten.
- Kötider som är äldre än en kvart visas inte: varken ett reservsvar från
  Swedavia-proxyn eller etiketter som inte gått att förnya.
- Köerna och VMA-bannern läser om direkt när fliken visas igen, i stället
  för att vänta på nästa kamerarörelse eller nästa tvåminuterstakt.
- Ett VMA som inte längre kan bekräftas hos Krisinformation ligger kvar men
  säger när det senast bekräftades ("Uppdaterad 15:00").

### 2026-11-10 (stadsdossierns serverdelar, andra rundan; bildkällor och villkor)
- Paus efter fel: ortsfakta, norrskensutsikten (NOAA och SMHI) och
  sevärdheterna (Wikidata) lämnar källan i fred i 1 minut efter en
  misslyckad hämtning. Kp-prognosen hämtas en gång för alla som väntar.
- Kolada-reserven för valresultat visar ett val: ett parti som inte ställde
  upp senaste valåret får inte med sin äldre andel.
- Sevärdheterna hämtas närmast först, så en tät ort inte får ett
  godtyckligt urval.
- Strax efter midnatt läses även gårdagens flyglista (högst var 30:e minut),
  så ett flyg som försenats över midnatt inte försvinner 00:00. Går listan
  inte att läsa visas dagens flyg ändå.
- Foto och vapen länkar till sin sida på Wikimedia Commons, i panelen och på
  ortskortet, där upphovsperson och licens står.
- Villkoren för TomTom, Valmyndigheten och Wikimedia Commons står under
  "Källor med oklara eller särskilda villkor".

### 2026-11-10 (stadsdossierns serverdelar: rättningar efter kodgranskning)
- Försenade tåg försvinner inte längre tio minuter efter sin annonserade
  tid: frågan till Trafikverket tar med tåg som fortfarande väntas, och
  hoppar över dem som redan har gått.
- De svenska delar som använder en nyckel (transport och flyg, Trafikverket,
  fartkameror, kollektivtrafikstörningar, ENTSO-E) svarar bara appens egen
  sida. En annan webbsida i samma webbläsare kan inte längre förbruka
  nycklarna. Transportdelen svarar dessutom bara för platser i Sverige.
- Flyg och kötider som är äldre än en kvart visas inte som aktuella när
  Swedavia inte svarar eller dagskvoten är slut.
- Valresultatet från val.se hämtas med tidsgräns (60 s) och storleksgräns,
  så en långsam val.se inte hänger varje ort. En sparad tabell som inte
  täcker hela landet litas inte på och sparas inte.
- En misslyckad hämtning från Wikipedia försöks igen efter tio minuter i
  stället för ett dygn.
- Saknade värden läses inte som 0: valdeltagande, tätortens folkmängd, Kp i
  norrskensutsikten och molnighet (förut "klar himmel").
- En tom stationslista från Trafikverket sparas inte i ett dygn.
- Norrskensutsikten visar nattens starkaste stormnivå, inte den första.

### 2026-11-10 (stadsdossiern: ortskort vid sidan i stället för skylt mitt i bilden)
- Första besöket i en ort visar ett kort till vänster om kartan i stället
  för skylten mitt i bilden: ortens foto och vapen, "Ny stämpel i passet",
  invånare, grundad och höjd, och knappen "Flyg in och läs mer". Orten syns
  hela tiden bakom kortet.
- Kortet ligger kvar tills man stänger det, trycker på knappen eller lämnar
  orten (förut 12 sekunder). Inget rör sig förrän knappen trycks; då glider
  kameran in, STAD-panelen öppnas och kortet lämnar plats.
- Kortets rörelser stängs av för den som har bett om minskad rörelse i
  systemet. Inställningen "Filmisk ankomst" styr om kortet visas.

### 2026-11-10 (stadsdossiern: ingen automatisk inflygning, nuläget bara när det visas)
- Första besöket i en ort flyger inte längre in av sig självt. Namnskylten
  visas med knappen "Flyg in och läs mer"; först när den trycks glider
  kameran in till en långsam cirkel runt orten (i stället för det tidigare
  hårda klippet) och STAD-panelen öppnas. Skylten ligger kvar i 12 sekunder.
  Inställningen "Filmisk ankomst" styr nu om skylten visas. Det här är en
  första version; utseendet är inte bestämt.
- Nuläget (väder, luft, polis, trafik, norrsken, fartkameror och
  krisinformation) hämtas bara när STAD-panelen är öppen på fliken NU.
  Förut hämtades alla sju flödena för varje ort kameran stannade över, även
  med panelen stängd, vilket också gav anrop mot TomTom, Swedavia och
  Trafikverket.
- En del av nuläget som inte svarar nämns ("Inget svar från: Polisen,
  Krisinformation") i stället för att bara saknas, och ett nytt försök görs
  efter en minut.

### 2026-11-10 (norrsken: rättningar efter kodgranskning)
- Lagerraden visar vilken tid prognosen gäller ("Prognos för 23:11", med
  datum när den inte är från i dag), och lagret märks som inaktuellt när
  prognostiden ligger mer än en timme bakåt. Förut kunde en gammal oval
  visas som chansen den närmaste halvtimmen om NOAA slutade förnya filen.
- Kp-raden säger vilka timmar värdet är från ("Kp-index 2,3 från 19:00"):
  Kp är ett tretimmarsvärde och kan vara flera timmar äldre än prognosen.
- En ritning som misslyckades loggas som ritfel och görs om vid nästa
  uppdatering. Ett nytt Kp-värde når raden även när prognostiden är
  densamma, och en fil utan tidsangivelse ritas om varje gång i stället för
  att frysa. Ett avstängt lager bär inte kvar sitt senaste fel.
- Proxyn lämnar NOAA i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med den senaste prognosen, märkt X-Data-Stale (eller
  502 om ingen finns). Loggraden och cachen skrivs en gång per hämtning.

### 2026-11-10 (luftkvalitet: rättningar efter kodgranskning)
- EAQI räknas med de gränser EEA anger i dag (airindex.eea.europa.eu, läst
  2026-11-10), i µg/m³: PM2.5 5/15/50/90/140, PM10 15/45/120/195/270, NO2
  10/25/60/100/150 och O3 60/100/120/160/180. Koden hade de äldre gränserna,
  som gav för låg nivå för kvävedioxid och för hög för partiklar. Det gäller
  även stadsdossiern. Svaveldioxid, indexets femte ämne, läses inte.
- När ett av näten (SMHI eller Kanada) inte svarar visas det andra nätets
  stationer tillsammans med ett fel som namnger det som saknas. Förut
  försvann de svenska stationerna utan att något syntes.
- Källraden säger "Varje timme" i stället för "Var 20:e minut": värdena är
  timvärden och var vid kontrollen en till tre timmar gamla. Proxyn hämtar
  därför högst var 30:e minut.
- Proxyn lämnar SMHI i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med de senaste stationerna, märkta X-Data-Stale (eller
  502 om inga finns). Loggraden och cachen skrivs en gång per hämtning.
- Förfrågningar som kommer samtidigt strax efter start väntar på att listan
  över mätserier har lästs från disk, i stället för att starta en ny, tung
  kartläggning hos SMHI.
- Kortet skriver mätvärdena med appens talformat ("PM10 109,2 µg/m³").

### 2026-11-10 (sjöväder: rättningar efter kodgranskning; SMHI-hämtning)
- Vattenstånd jämförs bara när nollpunkten är densamma. ViVa anger tre
  referenser: medelvattenyta (58 stationer vid kontrollen), sjökortsnivå
  (10) och RH 2000 (6). Kortet skrev förut "mot medelvattenstånd" för alla,
  och Vänerns stationer såg ut att ha mycket högt vatten. Nu namnger kortet
  referensen ("+48 cm mot sjökortsnivå"), och bara stationer mot medelvatten
  färgas, räknas i teckenförklaringen och får värdet utskrivet i
  vattenståndsläget.
- Ett mätvärde som är äldre än 3 timmar räknas inte som aktuellt väder,
  även om stationens andra givare är färska. Kortet visar datum när
  mätningen inte är från i dag.
- Proxyn lämnar ViVa i fred i 5 minuter efter en runda där ingen station
  svarade (en runda är ett anrop per station) och svarar under tiden med de
  senaste stationerna, märkta X-Data-Stale (eller 502 om inga finns).
  Loggraden och cachen skrivs en gång per runda.
- En station som inte svarar en runda behåller sina senaste värden så länge
  de är aktuella, i stället för att försvinna från kartan i tio minuter.
- En ritning som misslyckades loggas som ritfel och görs om vid nästa
  uppdatering. Ett avstängt lager bär inte kvar sitt senaste fel. Det öppna
  kortet följer de nyaste värdena även när punkterna inte ritas om.
- Vattenföring: proxyn frågar först SMHI när datat senast ändrades och
  laddar bara ner när det är nytt (dock minst en gång i timmen), enligt
  SMHI:s riktlinje att inte hämta samma data flera gånger.

### 2026-11-10 (vattenföring: rättningar efter kodgranskning)
- Ett prov utan värde eller tid räknas inte längre som 0 m³/s. Förut gav
  ett saknat sista värde "0 m³/s, sjunker 12,5 m³/s". SMHI skriver null när
  en station saknar data.
- Kortet skiljer på huvudavrinningsområdets namn och stationens egen yta:
  "Helge Å · 1,8 km² uppströms stationen" i stället för "Helge Å ·
  avrinningsområde 2 km²". Ytor under 10 km² visas med en decimal, och
  stationer utan områdesnamn visar ytan ensam.
- Texterna säger vad som visas: senast publicerade flöde, inte "senaste
  kvartens". Vid kontrollen 2026-11-10 kom timmens fyra kvartsvärden mellan
  21:30 och 21:37, så värdena var mellan en halv och en och en halv timme
  gamla. Trenden skrivs "sedan 20:15" i stället för "senaste timmen", och
  källraden säger "Kvartsvärden, publiceras med fördröjning".
- Kortet visar datum när värdet inte är från i dag, SMHI:s kvalitetskod
  ("Okontrollerat värde", "Grovt kontrollerat värde") och stationens ägare
  när det inte är SMHI. Lagret märks som inaktuellt när även det nyaste
  värdet är äldre än 3 timmar.
- Proxyn lämnar SMHI i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med de senaste stationerna, märkta X-Data-Stale (eller
  502 om inga finns). Loggraden och cachen skrivs en gång per hämtning.
- En ritning som misslyckades loggas som ritfel och görs om vid nästa
  uppdatering. Ett avstängt lager bär inte kvar sitt senaste fel.
- Texten för när en station mätte delas nu av strålning och vattenföring
  (`src/layers/measuredWhen.js`).
- SMHI:s villkor och riktlinjer står under "Källor med oklara eller
  särskilda villkor". Vattenföringen kommer från SMHI:s dokumenterade API
  för kvartsvärden; realtidsfilerna med tim- och dygnsvärden är en
  avgiftsbelagd tjänst och används inte.

### 2026-11-10 (strålning: rättningar efter kodgranskning)
- Kortet visar datum och klockslag när en station inte har mätt i dag, i
  stället för bara klockslag. En station i service som senast mätte för
  68 timmar sedan såg förut ut att ha mätt i dag.
- Proxyn lämnar Strålsäkerhetsmyndigheten i fred i 1 minut efter en
  misslyckad hämtning och svarar under tiden med de senaste stationerna,
  märkta `X-Data-Stale` (eller 502 om inga finns). Loggraden och cachen
  skrivs en gång per hämtning.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs om
  vid nästa uppdatering i stället för att vänta på nästa timvärde. Ett
  avstängt lager bär inte kvar sitt senaste fel. Kortet och tiden för
  senaste uppdatering följer lagrets egen klocka.
- En station helt utan mätvärde räknas som i service, i stället för att
  visas med 0,00 µSv/h.

### 2026-11-10 (elpris: rättningar efter kodgranskning)
- Ett elområde vars dagsfil inte går att hämta behåller de priser det hade,
  medan de andra uppdateras. Förut fällde en enda misslyckad fil av åtta
  hela svaret. Ett svar där någon fil saknades frågas om efter 5 minuter i
  stället för 15.
- Priserna sparas per datum. Efter midnatt är gårdagens "i morgon" dagens
  priser även när Elpriset just nu inte svarar; förut låg gårdagens priser
  kvar under "I dag" i upp till sex timmar, utan pris "nu".
- Proxyn lämnar Elpriset just nu i fred i 5 minuter efter en hämtning där
  inget gick att läsa, och svarar under tiden med de senaste priserna,
  märkta `X-Data-Stale`. Loggraden skrivs en gång per hämtning.
- "I morgon" räknas som nästa kalenderdag i stället för 24 timmar framåt,
  som blev fel en timme per år vid vardera omställningen mellan sommar-
  och vintertid.
- Ett ritfel loggas som ritfel, inte hämtfel, och ritas om en minut senare.
  Ett avstängt lager bär inte kvar sitt senaste fel. Priset "nu", färgen
  och kortet följer lagrets egen klocka.

### 2026-11-10 (kollektivtrafikstörningar: rättningar efter kodgranskning)
- Störningar som hämtats medan en operatörs hållplatslista laddas ned
  sparas och placeras ut när listan finns, utan att Trafiklab tillfrågas
  igen. Förut frågades alla 16 operatörer varje minut tills listan fanns,
  vilket kunde tömma nyckelns månadskvot (30 000 anrop) på drygt ett dygn
  med lagret påslaget.
- När alla operatörer misslyckas (till exempel med slut kvot) lämnas
  Trafiklab i fred en kvart och den senaste listan visas, märkt som
  gammal. En operatör som misslyckas ensam behåller sina senaste
  störningar i upp till två timmar, i stället för att tappa dem.
- Hållplatslistorna förnyas var fjortonde dag i stället för var sjunde: 16
  operatörer en gång i veckan behövde cirka 69 nedladdningar i månaden,
  medan gratisnivån (Bronze) tillåter 50; nu högst cirka 48.
- En avstängd hiss, rulltrappa eller entré räknas som övrig störning, inte
  som stängd hållplats; stationen trafikeras som vanligt (8 av dagens 396
  störningar). "Trafikeras ej", "trafikerar ej" och "stannar ej" räknas som
  stängd hållplats, som varianterna med "inte".
- Lagret ritar inte om de cirka 460 prickarna varannan minut när svaret är
  detsamma (proxyn svarar likadant en kvart), men korten läser alltid de
  senaste texterna. Mätt i förhandsvisningen: en oförändrad uppdatering tar
  cirka 4 ms. Ett ritfel loggas som ritfel och görs om; ett avstängt lager
  bär inte kvar sitt senaste fel; tiden följer lagrets egen klocka.

### 2026-11-10 (genomgång av alla svenska källors villkor)
- Alla svenska källor är genomgångna. Avsnittet i Avgränsningar heter nu
  **Källor med oklara eller särskilda villkor** och listar strålning,
  sjöväder, SR:s trafikmeddelanden, elpris, Swedavia, Kolada och OpenSky
  utöver kraftsystemet, med vad som gäller för var och en.
- **SR:s trafikmeddelanden** följer SR:s API-villkor: kortet visar hela
  meddelandet som SR publicerat det (förut kortades det till fyra rader),
  anger Sveriges Radio och öppnar sverigesradio.se/trafik vid klick på
  kortet, med text på alla 12 språk.
- **Kolada** anges som "Kolada" i dossiern, som Kolada ber om, i stället för
  "Kolada (RKA)".
- Licensraderna under ⓘ: elpriset säger "Fri att använda enligt Elpriset
  just nu; priserna kommer från Nord Pool via ENTSO-E", SR:s trafik nämner
  SR:s API-villkor, och sjövädret säger "Ingen angiven licens; källan anges".
  DATA_SOURCES.md har samma uppgifter.

### 2026-11-10 (egna nycklar och källornas villkor)
- README, Kom igång och avsnittet **Avgränsningar och säkerhet** säger nu
  rakt ut att varje användare skaffar egna nycklar och att källornas
  villkor gäller; koden är fri (MIT), datan inte alltid. OpenSky (flyg) får
  bara användas icke-kommersiellt och ska anges som källa vid offentlig
  användning.
- OpenSky står i nyckeltabellen och bland de valfria nycklarna i Kom igång.
- Ny punkt i Avgränsningar: varje ny källa prövas (gränssnitt, licens,
  dataägarens godkännande, villkor och vad den tillför helheten) innan den
  byggs in, och utfallet skrivs in där.

### 2026-11-10 (kraftsystemet: reserv från ENTSO-E)
- Kraftsystemets adresser (`/api/power-grid`, `/day`, `/week`) kan läsas
  från ENTSO-E:s transparensplattform i stället för Svenska kraftnäts
  kontrollrum. Det är avstängt från början: kontrollrummet är kvar tills
  Svenska kraftnät svarat på frågan om villkor. Reserven slås på med
  `POWER_GRID_SOURCE=entsoe` och en gratis nyckel i `ENTSOE_SECURITY_TOKEN`
  (stöds bara via `.env` än så länge, inte under KOPPLA PÅ).
- Svaren har samma form som kontrollrummets, så lagret och KRAFT-panelen
  fungerar som förut: fysiska flöden på de 14 förbindelserna (båda
  riktningarna), produktion per kraftslag och förbrukning summerade över
  SE1–SE4, och veckan direkt från ENTSO-E i stället för sparade dagar.
  Svaret bär `source: "entsoe"`.
- En uppdatering är 36 förfrågningar (ENTSO-E tillåter 400 i minuten per
  nyckel) och sparas en kvart. Efter ett fel lämnas ENTSO-E i fred i 1
  minut, och en avvisad nyckel skickas inte om. Nyckeln skickas bara till
  ENTSO-E och syns aldrig i svar eller loggar.

### 2026-11-10 (avgränsningar och säkerhet)
- Nytt avsnitt **Avgränsningar och säkerhet** överst i den här filen. Det
  samlar gränserna som tidigare låg utspridda i loggen (inga personer, inga
  polisfordon, bara butiker, ingen insamling från webbsidor, nycklar),
  nämner de två svenska källorna utan publicerad licens (Svenska kraftnät
  och Strålsäkerhetsmyndigheten) med nästa steg.
- Skälet är frågan om vad en sammanställning av öppna källor blir, som
  kom upp i en kommentar på LinkedIn.

### 2026-11-10 (SR trafik: rättningar efter kodgranskning)
- Kortet läser alltid den senaste texten från SR. Förut bytte lagret ut
  sina rader bara när ett meddelandes id, prioritet eller skapandetid
  ändrades, så en omskriven rubrik, beskrivning eller plats visades
  först när något annat i listan ändrades. Prickarna ritas om bara när
  någon av dem skulle se annorlunda ut (plats, prioritet, kategori).
- Proxyn lämnar SR i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med den senaste listan, märkt `X-Data-Stale` (eller
  502 om ingen finns). Loggraden och cachen skrivs en gång per hämtning.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om vid nästa uppdatering. Ett avstängt lager bär inte kvar sitt senaste
  fel. Tiden för senaste uppdatering följer lagrets egen klocka.

### 2026-11-10 (väglag: rättningar efter kodgranskning)
- Kartan ändras på plats i stället för att alla linjer och prickar tas
  bort och ritas om så fort något ändras: nya rader läggs till, de som
  försvunnit tas bort, och en rad ritas om bara om dess typ, allvarlighet
  eller geometri ändrats. Mätt i förhandsvisningen med dagens data (818
  sträckor, 2 905 händelser, cirka 2 800 ritade): en uppdatering med 2
  nya händelser låste sidan i cirka 0,2–0,3 s och gör det nu i cirka
  0,03–0,07 s, vilket är tiden för att tolka svaret. Knapparna rör bara
  sina egna rader: normalt väglag på från cirka 0,29 till 0,09 s, av
  från 0,18 till 0,04 s; mindre händelser på från 0,18 till 0,07 s, av
  från 0,28 till 0,12 s. Första ritningen tar lika lång tid som förut.
- Kortet läser alltid den senaste texten från Trafikverket. Förut
  behöll lagret en händelses gamla text, tid och plats tills något annat
  i listan ändrades.
- Händelser av typen "Väglag" (t.ex. blixthalka) och trafikmeddelandet
  "Brand i fordon" räknas som hinder (orange) i stället för grått.
- En vald rad som lämnar kartan, för att den är över eller för att en
  knapp dolt den, tappar sitt kort.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om från början vid nästa uppdatering. Ett avstängt lager bär inte kvar
  sitt senaste fel. Tiden för senaste uppdatering följer lagrets egen
  klocka. Kommentaren om lagrets delningskod är rättad (0j, inte 9).

### 2026-11-10 (vägväder och Trafikverkets proxy: rättningar efter kodgranskning)
- Den gemensamma proxyn för Trafikverket (vägväder och väglag) lämnar
  Trafikverket i fred i 1 minut efter en misslyckad hämtning och svarar
  under tiden med den senaste ögonblicksbilden, märkt `X-Data-Stale`
  (eller 502 om ingen finns). En avvisad nyckel skickas inte om vid
  varje fråga; svaret under pausen säger fortfarande att nyckeln
  avvisades. Loggraden och cachen skrivs en gång per hämtning.
- En vägväderstation vars mätning passerar en timme ritas blekt även när
  datan står still, som under ett avbrott hos Trafikverket. Förut
  räknades blekningen bara om när mätvärdena ändrades.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om vid nästa uppdatering. Ett avstängt lager bär inte kvar sitt senaste
  fel. Blekningen och tiden för senaste uppdatering följer lagrets egen
  klocka.

### 2026-11-10 (SMHI-varningar och krisinformation: rättningar efter kodgranskning)
- Bara en nyhet som Krisinformation märkt med Sverige ritas som "Gäller
  hela Sverige". En nyhet om utlandet, om ett område som ortsregistret
  inte känner, eller helt utan område ritas fortfarande mitt i landet,
  men kortet visar det område nyheten anger, eller "Krisinformation
  anger ingen plats" (ny text på alla 12 språk).
- Nyheter som varken publicerats eller uppdaterats på tre dygn släpps av
  proxyn: `/v3/news?days=3` svarar även med äldre (i dag en 92 timmar
  gammal nyhet om ett oväder som redan passerat). VMA berörs inte.
- När Krisinformation inte svarar behålls den senaste krislistan i högst
  1 timme, i stället för utan tidsgräns, så att ett VMA som upphört inte
  ligger kvar på kartan.
- Proxyn lämnar SMHI och Krisinformation i fred i 1 minut efter en
  misslyckad hämtning och svarar under tiden med den senaste
  ögonblicksbilden, märkt `X-Data-Stale` (eller 502 om ingen finns).
  Loggraden och cachen skrivs en gång per hämtning.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om vid nästa uppdatering. Ett avstängt lager bär inte kvar sitt senaste
  fel. Tiden för senaste uppdatering följer lagrets egen klocka.

### 2026-11-10 (SMHI-väder: rättningar efter kodgranskning)
- Lagret ritar om när en stations vind, byar eller nederbörd ändras, inte
  bara temperaturen eller mättiden. Förut kunde vind som kom tillbaka efter
  en misslyckad hämtning saknas i upp till en timme (grå prickar i
  vindläget, kort utan vind).
- Proxyn lämnar SMHI i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med de senaste mätningarna, märkta `X-Data-Stale`
  (eller 502 om inga finns). Ett svar där vind-, by- eller
  nederbördsfilen saknades sparas 1 minut i stället för 10. Loggraden och
  cachen skrivs en gång per hämtning.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om vid nästa uppdatering. Ett avstängt lager bär inte kvar sitt senaste
  fel. Prognosens halvtimmesgräns följer lagrets egen klocka.
- Symbolen för närmaste dygnet är den första i prognosen (vädret nu), som
  kommentaren i koden sade; förut togs den från mitten av dygnet, kl. 06
  nästa morgon om man klickade kl. 18. Dagarna har kvar middagens symbol.
- Prognosen sammanfattas med en enda datumformaterare i stället för en ny
  per tidssteg (cirka 100 per prognos).

### 2026-11-10 (polishändelser: rättningar efter kodgranskning; dev-servern)
- Kategorierna läser "rån" som ett eget ord: "Trafikolycka, smitning
  från" är trafik och "Olaga intrång" stöld och skadegörelse, inte våld
  och hot (8 av 500 notiser i dagens lista hade fel färg). "Mordbrand"
  och "Sjukdom/olycksfall" räknas till bränder och olyckor; "Farligt
  föremål, misstänkt", "Detonation" och "Bombhot" till våld och hot.
- Proxyn lämnar Polisen i fred i 1 minut efter en misslyckad hämtning
  och svarar under tiden med den senaste listan, märkt `X-Data-Stale`
  (eller 502 om ingen finns). Loggraden och cachen skrivs en gång per
  hämtning, inte en gång per väntande fråga.
- En ritning som misslyckades loggas som ritfel, inte hämtfel. Ett
  avstängt lager bär inte kvar sitt senaste fel. Tidsfönstret och de
  ljusa prickarna för färska notiser följer lagrets egen klocka.
- En tid utan tidszon läses som svensk tid, sommar eller vinter, i
  stället för alltid vintertid. En koordinat med en tom halva släpps i
  stället för att bli 0. Kortets rubrik slutar inte på " · " när
  notisen saknar ort.
- Dev-servern bevakar inte längre halvfärdiga nedladdningar
  (`*.crdownload`, `*.part`, `*.tmp`). En nedladdning som webbläsaren
  höll låst i projektmappen fick bevakningen att krascha med EBUSY och
  stängde servern; provat med en låst fil efter rättningen.

### 2026-11-10 (blixtnedslag: rättningar efter kodgranskning)
- Prickarna ändras på plats varje minut i stället för att alla tas bort
  och ritas om: nya nedslag läggs till, de som passerat en timme tas
  bort, och bara de som bytt åldersklass får ny färg. Mätt i
  förhandsvisningen med en minuts normal omsättning: 2 000 nedslag gick
  från cirka 0,1–0,2 s hack till under 0,01 s, 5 000 från cirka 0,3–0,4 s
  till cirka 0,02 s och 20 000 från cirka 1,2–2,5 s till cirka 0,1 s.
  Första ritningen, när lagret slås på, tar lika lång tid som förut.
- Proxyn lämnar DMI i fred i 1 minut efter en misslyckad hämtning och
  svarar under tiden med den senaste listan, märkt `X-Data-Stale` (eller
  502 om ingen finns). Loggraden om en lyckad hämtning skrivs en gång per
  hämtning, inte en gång per väntande fråga.
- Ett nedslag utan angiven toppström får ingen rad om ström på kortet, i
  stället för "0 kA toppström". Ett nedslag utan koordinater släpps, i
  stället för att hamna på longitud 0.
- En ritning som misslyckades loggas som ritfel, inte hämtfel, och görs
  om från början vid nästa omgång i stället för att vänta en minut.
- Ett valt nedslag som passerar en timme tappar sitt kort samtidigt som
  pricken, inte upp till ett par minuter senare.
- Ett avstängt lager bär inte kvar sitt senaste fel. En geoid som inte
  gick att ladda efterfrågas igen nästa gång lagret slås på. Kortet säger
  "1 sensor" i stället för "1 sensorer", på alla 12 språk. Tiden för
  senaste uppdatering följer samma klocka som resten av lagret.

### 2026-11-10 (fartkameror: rättningar efter kodgranskning)
- En kameraplats utan känd riktning ritas som en prick utan pil, och
  kortet säger ingenting om riktning. Det gäller både platser som saknar
  riktning och platser där Trafikverket anger 0 grader, vilket oftast står
  för ingen riktning alls. Förut ritades de som en pil rakt norrut. I dag
  är det 45 av 2 825 platser. Priset är att de få platser som verkligen
  pekar rakt norrut också blir prickar. Förklaringen har fått en egen rad
  för prickarna, på alla 12 språk.
- Länet läses ur alla värden i Trafikverkets lista, inte bara det första,
  och serverloggen räknar de länsnummer som inte gick att läsa. Loggen
  visar att Trafikverket självt skickar länsnummer 0 för 360 platser. De
  saknar därför fortfarande län på kortet.
- Proxyn lämnar Trafikverket i fred i 5 minuter efter en misslyckad
  hämtning och svarar under tiden med den senaste listan, märkt
  `X-Data-Stale` (eller 502 om ingen finns). Ett tomt svar räknas som en
  misslyckad hämtning i stället för att sparas ett dygn.
- En trasig koordinat ("-", "1.2.3") släpps inte igenom. En plats som
  kommer två gånger ritas en gång, och en ritning som misslyckades görs om
  vid nästa omgång.
- En halv position (`?lat=59` utan `lon`) besvaras med 400 i stället för
  200 med noll kameror.
- Vägnamn klipps vid 40 tecken i stället för 12, så Saltsjöbadsleden
  står utskrivet.
- Ett nytt namn, en ny väg eller ett nytt län på en plats når kortet utan
  omladdning. Loggraden om en lyckad hämtning skrivs en gång per hämtning,
  inte en gång per väntande fråga.
- Ett valt kort släpps när vyn zoomas ut bortom 400 km, där markörerna
  ändå är dolda. Stadsdossierns "visa kamera" väntar upp till 35 sekunder
  på lagrets första läsning i stället för 5, och ger upp direkt om
  läsningen misslyckades. Ett avstängt lager bär inte kvar sitt senaste
  fel.

### 2026-11-10 (brandstationer: rättningar efter kodgranskning)
- Ett klick på ett kort är aldrig ett klick på marken. Förut räknades
  bara kort som ledde till en sida som klickbara, och bara lagrets egna:
  ett klick på brandstationens kort avmarkerade stationen, och ett klick
  på ett annat lagers kort avmarkerade eller valde det som låg bakom.
  Rättat i de 17 lager som bara kände sina egna kort: brandstationer,
  fartkameror, blixtnedslag, elpris, strålning, vattenföring, vägväder,
  sjöväder, SMHI-väder, SR trafik, kollektivtrafikstörningar,
  polishändelser, vägläge, SMHI-varningar och krisinformation, samt
  originalets drönarzoner, brandområden och GhostMaps. Kort med länk
  öppnar sidan som förut; kort utan länk gör ingenting.
- Brandstationernas proxy lämnar MCF i fred i 5 minuter efter en
  misslyckad hämtning och svarar under tiden med den senaste listan (eller
  502 om ingen finns), som polisstationerna och skyddsrummen.
- En avklippt lista släpps inte igenom: en full sida (1 000 rader) eller
  en länk till nästa sida räknas som avklippt även när svaret saknar
  antal.
- Kortets rubrik bär ortsnamnet bara när stationen ligger inom 5 km från
  centralorten, annars står det bara BRANDSTATION. Raden "X km från Y"
  finns kvar. Förut kunde en station sex mil från Kiruna heta
  BRANDSTATION · KIRUNA.

### 2026-11-10 (markhöjder: rättningar efter kodgranskning)
- Höjderna syns efter varje svar, inte först när hela omgången är klar.
  De punkter som fått höjd (64 platser per fråga) flyttas på plats med den
  gemensamma hjälpen `src/layers/liftEntities.js`; lagret ritas inte om.
  Uppmätt på fartkamerorna (2 825 punkter, första besöket): första
  höjderna efter 0,6 s i stället för 44 s, 45 frågor som förut, och ingen
  paus över 50 ms vid något lyft (förut en omritning på cirka 0,2 s).
  Gäller 15 lager; kraftsystemet har ett par dussin platser i ett enda
  svar och ritar om som förut.
- Höjder som webbläsaren redan sparat ligger på plats före första
  ritningen. Ett påslag ritar en gång i stället för två och frågar
  ingenting; av och på under samma besök ritar inte om något.
- Skyddsrum: raderna i en ny vy frågas före det som var kvar av den gamla,
  och rader som lämnat vyn frågas inte alls.
- Ett fel mitt i en omgång behåller det som redan hämtats. Efter ett fel
  frågas ingenting, inte heller nya rader, förrän väntetiden gått ut (2
  minuter, fördubblas upp till 30).
- Webbläsarens lager kastar den plats som använts minst nyligen, inte den
  äldst skrivna. Skyddsrummen, vars rader kommer och går, har ett eget
  lager (10 000 platser) och kan inte tränga ut de fasta lagrens höjder
  (20 000 platser).
- Rader som försvunnit glöms i minnet (platsens höjd finns kvar till de
  kommer tillbaka), och en rad som flyttas under samma id frågas om.
- Smått: `place()` är klar när dess rader är inne, även med en fråga
  redan ute; ett fel i lagrets egen ritning loggas inte som ett
  misslyckat uppslag; en avbruten fråga lämnar sin tur vidare; höjder som
  en annan flik sparat tas över i stället för att skrivas över.
- Inte kontrollerat: terrängvägens gräns på 90 frågor per minut delas med
  CCTV och markplan. Markhöjderna tar högst 60 per minut, men summan är
  inte uppmätt.

### 2026-11-10 (omritning under samma id når kartan)
- När ett lager ritade om sina punkter under oförändrade id (nya
  markhöjder, ny färg) fick Cesium aldrig veta det: en borttagning och ett
  tillägg under samma id inom en och samma paus av händelserna tar ut
  varandra, så kartan fortsatte rita de gamla punkterna. Markhöjderna
  hämtades alltså men syntes inte. Den gemensamma hjälpen
  `src/layers/redrawEntities.js` tar bort det gamla innan händelserna
  pausas och används nu på alla 20 ställen där de svenska lagren ritar om
  (19 lager och stadsdossiern). Kraftsystemet har redan egna id per
  omritning och är orört.
- Kostnad: omritningen når nu kartan på riktigt. På det största lagret
  (2 825 fartkameror) tar den en engångspaus på ungefär 0,2 sekunder när
  höjderna kommer; att slå av och på ett lager ritar inte om något.
- Kraftsystemets kort: flödena och produktionsraden kan vara från olika
  kvartar. Då står båda tiderna ("flöden 10:45 · produktion 10:30") i
  stället för en tid som daterar den ena fel.

### 2026-11-10 (kraftsystemet: rättningar efter kodgranskning)
- Ett klick på ett kort (lagrets eget eller ett annat lagers) räknas inte
  som ett klick på marken; elområdets kort är alltid träffbart.
- Efter midnatt visas gårdagen inte längre som "hittills i dag": dygnet är
  tomt tills första kvarten kommer ("Inga kvartsvärden ännu i dag"), och
  veckan räknar inte gårdagen två gånger. Servern frågar aldrig
  Svenska kraftnät om ett annat datum än dagens.
- Kartan får flödena även när produktionen inte gick att hämta (tidigare
  502); produktionen visar då senast kända värde, högst två timmar
  gammalt, annars streck.
- Sommar- och vintertid: dygnsdiagrammet går från svensk midnatt till nästa
  (23, 24 eller 25 timmar) och veckans datum stegas per kalenderdag.
- Ett saknat värde visas som streck, inte som 0 MW; en förbindelse som
  förekommer två gånger räknas en gång. Produktionsraden tar alla
  kraftslag ur samma kvart.
- Panelen säger när den visar äldre data ("Äldre data från ...") och när en
  uppdatering misslyckades; ett misslyckat eller gammalt dygn hämtas om
  vid nästa läsning. "Laddar" visas bara medan något faktiskt hämtas.
- Efter en misslyckad hämtning väntar servern en minut innan nästa försök;
  samtidiga förfrågningar delar på en hämtning.
- Lagret läser var femte minut (servern höll redan svaret i fem minuter),
  ritar inte om något när svaret är oförändrat och begär bildrutor för
  de rörliga linjerna bara när någon förbindelse är i bild.
- Effekt skrivs så att värdet inte avrundas bort (250 MW i stället för
  0,3 GW); y-axeln har enheten i bildtexten. Panelens rad heter
  nettoexport och nettoimport, eftersom den summerar nettot per kvart.
- Smått: ett framlyft land som försvinner ur svaret släpper nedtoningen,
  ett öppet kort byter språk direkt och punkterna flyttas när markhöjder
  kommer in.
- Tester för servern, posterna, källan, kartlagret, korten, diagrammet och
  panelen.

### 2026-11-10 (butikskedjor: rättningar efter kodgranskning)
- Ett klick på ett kort (lagrets eget eller ett annat lagers) räknas inte
  som ett klick på marken; butikens kort är alltid träffbart.
- City Gross ligger under Axfood (helägt av Axfood sedan 1 november 2024)
  och Apoteksgruppen under Kronans Apotek (sammanslagna hösten 2022): nio
  kedjor och nio knappar. Gamla rader i ögonblicksbilden förs över när de
  läses.
- Samma butik kartlagd två gånger (punkt och byggnadsyta) visas som en:
  samma kedja inom 20 m, eller inom 45 m när den ena är en yta och
  konceptet är detsamma.
- Butikens webblänk visas bara när den går till kedjans egen domän; http
  blir https.
- Apotek som enligt namnet tillhör en annan kedja (t.ex. "Apotek Hjärtat …"
  taggat som Apoteket) hamnar hos rätt kedja; ombud visas inte.
- "Öppettider kontrollerade" visas bara när butiken har öppettider; avstånd
  avrundas innan enheten väljs (995 m blir 1,0 km).
- Öppettider: fler skrivsätt läses ("Mo-Fr 07:00-20:00, Sa-Su 08:00-20:00",
  "Sa, Su", "07:00 - 23:00").
- Byggskriptet: statuskontroll och omförsök mot SCB och Wikidata, vägrar
  skriva över ögonblicksbilden om en kedja tappat över 20 % av butikerna
  (utom med `--force`), sparar inte längre webbplats och grundår, och
  huvudkontor bara när det ligger i Sverige. Skriptet har inte körts;
  rättningarna görs när raderna läses, så Lidls rad (svenskt
  organisationsnummer, tyskt huvudkontor) rättas först vid nästa handkörda
  bygge.

### 2026-11-10 (polisstationer: rättningar efter kodgranskning)
- Ett klick på ett annat lagers kort räknades som ett klick på marken och
  släckte den valda stationen, eller valde stationen bakom kortet. Ett
  klick som hamnar på något kort räknas nu inte som ett klick på marken;
  stationens eget kort är alltid träffbart och öppnar sidan på polisen.se
  när den finns.
- Sju stationer ligger några kvarter från en passexpedition (Göteborg City
  20 m från Passcentralen, Stockholm Kungsholmen 190 m) och fick raden
  "…, 0 km". Avstånd under en kilometer står nu i meter, avrundade till
  tiotal, och avrundas innan enheten väljs.
- 43 stationer lämnar ut pass men tar inte emot ansökningar. De hette
  "Reception, inga pass"; klassen heter nu "Reception, ingen passansökan"
  och kortets rad "Närmaste passansökan: …". Färgklasserna är desamma.
- En station som byter namn, adress eller webbsida ritas om; förut jämfördes
  bara id, läge och tjänster.
- Efter en misslyckad hämtning lämnas Polisen i fred i fem minuter i stället
  för att få ett nytt försök vid varje fråga; under tiden visas den senaste
  listan som inaktuell (eller 502 om ingen finns).
- Tester för klick, kort, omritning och pausen.

### 2026-11-09 (skyddsrum: rättningar efter kodgranskning)
- Lagret stängde av sig självt när kameran hann flytta sig innan förra
  svaret kommit: den avbrutna hämtningen räknades som ett fel. En hämtning
  som en nyare har gått om är nu inget fel; bara en som avbryts av att
  lagret stängs av är det.
- Ett klick på det valda skyddsrummets eget kort släcker inte längre
  markeringen: kortet är träffbart i etikettlagret, och ett klick som
  hamnar på något kort räknas inte som ett klick på marken.
- Avstängt behåller lagret varken punkter eller lista, och `setParams` gör
  ingenting medan lagret är av.
- I en lutad vy når kartrutan till horisonten och blev bredare än de 3° som
  servern svarar för, så lagret bad om inzoomning fast kameran stod lågt.
  Lagret frågar nu efter en ruta på högst 3° kring skärmens mitt
  (`clipViewBox`), så de närmaste skyddsrummen ritas även då. Antalet "i
  vyn" gäller den rutan.
- Efter en misslyckad hämtning lämnas MCF i fred i fem minuter i stället för
  att få ett nytt försök vid varje fråga; under tiden visas den senaste
  ögonblicksbilden som inaktuell. En ruta eller mittpunkt utanför jordklotet
  nekas, och en ruta som är precis 3° bred räknas inte längre som för bred
  på grund av avrundning.
- Avståndet avrundas innan enheten väljs: 996 m står som "1 km", inte
  "1 000 m".
- Gemensamma markhöjder (`groundHeights.js`): rader från en nyare vy som
  kommer medan en höjdfråga pågår frågas direkt när den är klar, i stället
  för att vänta på nästa kameraflytt.

### 2026-11-09 (sjukhus och akuter: rättningar efter kodgranskning)
- Ett klick på det valda sjukhusets eget kort släcker inte längre
  markeringen: kortet är träffbart i etikettlagret, och ett klick som
  hamnar på något kort (lagrets eget eller ett annat lagers) räknas inte som
  ett klick på marken.
- `setParams` gör ingenting medan lagret är av.
- Alingsås lasarett ritades grått fast Socialstyrelsen redovisar det
  tillsammans med Kungälvs sjukhus som "Sjukhusen i väster". Båda får nu de
  gemensamma siffrorna (67 sjukhus med statistik i stället för 66), och
  kortet säger att de gäller samlat.
- Faktabladets publiceringsdatum var fel: 2026-06-16 enligt
  Socialstyrelsens publikationssida, inte 2026-05-25. Datumet står nu i
  faktabladets fil och följer med ögonblicksbilden in i lagret i stället för
  att vara inskrivet i koden.
- Året är inte längre inskrivet i lagret och texterna. Lagret läser
  `statistics.year` ur ögonblicksbilden och visar det året mot året innan,
  så nästa års faktablad kräver ingen ändring i lagrets kod eller
  översättningar. Bygget avbryter om faktabladet saknar rikets median för
  året.
- De handkörda byggena (`scripts/lib/osmSnapshot.mjs`, som även butiks- och
  kommunbyggena använder) behåller inte längre ett Overpass-svar med
  `remark`: en fråga som fått slut på tid eller minne svarar 200 med det den
  hunnit samla. Ett sådant svar räknas som misslyckat och nästa spegel
  prövas, som i appens egen Overpass-transport. Saknas en markhöjd i svaret
  från Re:Earth avbryts bygget i stället för att lämna raden utan höjd.
- Kvar att känna till: butiksbyggets hämtning av befolkningsrutor och
  Wikidata saknar statuskontroll och nya försök, och avståndet räknas på
  fyra ställen med var sin kopia av samma formel.

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
  2026-6-10339, publicerat 2026-06-16), bilaga 1 med besök, mediantid till
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
