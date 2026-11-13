# Kom igång med God's Eye View Sverige

Appen körs på din egen dator. Den är gratis, och allt du behöver för de
svenska lagren är gratis också. Räkna med ungefär 15 minuter första gången,
mest för att skaffa nycklarna.

> **Vad det kostar:** ingenting. Appen tar inte betalt, och de svenska
> källorna kräver bara en gratis registrering. Det enda som kan kosta är
> Googles fotorealistiska 3D-städer (kräver ett betalkonto hos Google). Hoppa
> över den nyckeln om du vill vara säker; appen visar då OpenStreetMap, eller
> satellitbilder från Esri om du lägger in en gratis ArcGIS-nyckel.

## 1. Installera

Välj ett av sätten. Alla fungerar på Windows, macOS och Linux.

### A. Pinokio – ett klick, ingen terminal (enklast)

1. Installera [Pinokio](https://desktop.pinokio.co/), version 8.2 eller senare.
2. Välj att ladda ned från en adress (*Download from URL*) och klistra in
   `https://github.com/Kajjan7610/Gods-view-sweden`
3. Klicka **Install** och sedan **Start**. Appen öppnas i webbläsaren.

Hackar jordklotet i Pinokios eget fönster? Kopiera adressen Pinokio visar och
öppna den i din vanliga webbläsare.

### B. Docker

Kräver [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
git clone https://github.com/Kajjan7610/Gods-view-sweden.git
cd Gods-view-sweden
docker compose up
```

Öppna **http://localhost:4173**.

### C. Terminal med Node.js

Kräver [Node.js](https://nodejs.org/) 24 eller 26.

```bash
git clone https://github.com/Kajjan7610/Gods-view-sweden.git
cd Gods-view-sweden
npm ci
npm run dev
```

Öppna **http://localhost:4173**. Lägg till `?lang=sv` i adressen om appen inte
redan visas på svenska.

## 2. Lägg in de gratis nycklarna

Appen fungerar direkt, men vägkameror, tåg, bussar och flygtavlan behöver
nycklar. Klicka på **KOPPLA PÅ** nere till höger i appen, klistra in nyckeln
och spara. Appen startar om av sig själv; inget annat behövs. Nycklarna
sparas bara på din dator och skickas bara till respektive källa.

| Nyckel i panelen | Ger dig | Skaffa den |
|---|---|---|
| **TRAFIKVERKET** | 1 550 vägkameror, tåg i realtid, väglag, vägväder, fartkameror, vägfärjor | Registrera dig på [data.trafikverket.se](https://data.trafikverket.se/home) och skapa en nyckel |
| **TRAFIKLAB** (två nycklar) | Bussar, tunnelbana och spårvagnar live i 16 regioner, linjenummer och störningar | Skapa ett projekt på [developer.trafiklab.se](https://developer.trafiklab.se) och lägg till *GTFS Regional Realtime* och *GTFS Regional Static* |
| **TRAFIKLAB REALTIME** | Bussar, spårvagnar, tunnelbana och båtar från stadens största hållplats i panelen STAD | Lägg till *Trafiklab Realtime APIs* i samma projekt på [developer.trafiklab.se](https://developer.trafiklab.se) (en egen nyckel) |
| **SWEDAVIA** (två nycklar) | Flygtavlan för Swedavias tio flygplatser och köerna i säkerhetskontrollen | Registrera dig på [apideveloper.swedavia.se](https://apideveloper.swedavia.se) och prenumerera på *FlightInfo* och *WaitTime* (gratisnivåerna) |

Valfritt, också gratis: **ARCGIS** (Esris satellitbild i stället för
OpenStreetMap; ett gratis ArcGIS Location Platform-konto, nyckel med bara
Basemaps), **ENTSO-E** (flödena i lagret Kraftsystemet, från
den europeiska transparensplattformen), **NASA FIRMS**
(bränder, öppna data), **CESIUM ION** (fler kartor, terräng och Googles
3D-städer; gratis för icke-kommersiella personliga projekt) och
**AISSTREAM** (fartyg; inga publicerade villkor). **OPENSKY** och **TOMTOM** finns kvar i panelen från
originalet, men deras villkor kräver tillstånd för en app som den här, så
den svenska versionen använder dem inte. Flyg kommer i stället från
adsb.lol (öppna data, ODbL), utan nyckel.

> **Egna nycklar, källornas villkor.** Varje användare skaffar sina egna
> nycklar; dela inte dina med andra. Appens kod är fri (MIT-licens), men
> datan kommer från källorna och deras villkor gäller dig som använder
> nyckeln. Cesium ions fria konto gäller bara icke-kommersiella
> personliga projekt. Visar du bilder eller filmer offentligt, låt
> Cesium-loggan, Google Maps-loggan och källangivelserna synas i bild, och
> ange källorna, till exempel "adsb.lol (ODbL 1.0)" för flyg. Visa inte
> flygrutter i bilder och filmer. Källa och licens för varje lager
> står under **ⓘ** i Datalager och i [SVERIGE.md](../SVERIGE.md).

## 3. Utforska

- **Datalager** till vänster: välj **Svenska data** överst för att bara se
  lagren med svenska data. Märket **SE** är våra egna lager, **+SE** är
  originalets lager där svenska data har lagts till.
- **ⓘ** i slutet av ett lagers källrad visar varifrån datan kommer, hur mycket
  den täcker, hur ofta den uppdateras och vilken licens den har.
- Stanna lågt över en svensk ort så dyker panelen **STAD** upp till höger,
  med befolkning, val, väder och läget just nu.
- Klicka på saker på kartan: butiker, polisstationer, kameror, flygplatser.

## Om något krånglar

- **En rad säger att en nyckel saknas:** lägg in den under KOPPLA PÅ.
  Resten av appen fungerar ändå.
- **Port 4173 är upptagen:** stäng det andra programmet, eller starta med
  `npm run dev -- --port 4180`.
- **Trögt jordklot:** lägg till `?globe=lite` i adressen för sparläget utan
  3D-städer.

Vill du prova utan att installera något? Originalets README beskriver
GitHub Codespaces (ungefär 60 gratis timmar i månaden med ett GitHub-konto),
men en del funktioner fungerar inte där.

---

Appen visar öppna data som kan vara försenade, ofullständiga eller fel.
Använd den inte för navigering eller i nödsituationer. Källor och villkor:
[SVERIGE.md](../SVERIGE.md) och [DATA_SOURCES.md](../DATA_SOURCES.md).
