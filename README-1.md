# 31en

Speeltafel voor het kaartspel 31en. Werkt lokaal (doorgeven op één telefoon)
en online (kamercode via een publieke MQTT-broker). Statische PWA, draait op
GitHub Pages zonder server.

## Bestanden

| bestand | wat het doet |
| --- | --- |
| `index.html` | markup + alle CSS |
| `app.js` | kaarten, scoring, spelmotor, gedeelde rendering, lokale modus |
| `online.js` | kamercodes, host draait de motor en stuurt ieders kaarten apart |
| `mqtt.min.js` | mqtt.js 5.10.1, meegeleverd zodat er geen CDN nodig is |
| `sw.js` | service worker, network-first |
| `manifest.json`, `icon-*.png` | installeren op het beginscherm |

## Publiceren

```bash
git init
git add .
git commit -m "31en v1.1.0"
git branch -M main
git remote add origin git@github.com:<gebruiker>/31en.git
git push -u origin main
```

Daarna in de repo: **Settings → Pages → Source: Deploy from a branch →
`main` / `(root)`**. Na een minuut staat hij op
`https://<gebruiker>.github.io/31en/`.

Alle paden zijn relatief (`./`), dus een subdirectory op github.io werkt
zonder aanpassingen.

## Bij een update

Hoog `CACHE` in `sw.js` op (`31en-v1.1.1`) en `VERSION` in `app.js`. De
service worker is network-first, dus een nieuwe versie komt vanzelf binnen,
maar met een nieuwe cachenaam ruim je de oude meteen op.

## Online-modus

De host maakt een kamer en krijgt een code van vijf tekens. De host draait de
spelmotor: hij publiceert de publieke staat (midden, beurt, levens) naar
iedereen en ieders eigen drie kaarten naar een apart topic. Alle topics staan
onder `31en1/<CODE>/`.

Twee dingen om te weten:

- De verbinding loopt over een gratis openbare broker (EMQX, met HiveMQ als
  reserve) en is niet versleuteld. Wie de kamercode heeft, kan meelezen.
  Prima onder vrienden, niet geschikt voor iets gevoeligers.
- Sluit de host de app, dan stopt de kamer. Valt een medespeler weg, dan kan
  de host diens beurt overslaan met de knop onder de tafel.

## Huisregels

Kloppen sluit de ronde, en alle drie kaarten tegelijk ruilen doet dat ook —
alleen de blinde ruil van de beginner niet. Daarna krijgt iedereen nog één
beurt, en in die laatste beurt mag je ook niks doen.

Instelbaar bij het opzetten van een spel: aantal levens, wie op de bok mag,
of de klopper met de laagste hand twee levens verliest, of 31 de ronde meteen
stopt, en of passen ook buiten die laatste beurt mag (standaard uit — niks
doen is kloppen).
