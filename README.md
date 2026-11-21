# Kniha jázd

Elektronická kniha jázd pre slovenské firmy nad self-hosted GPS serverom [Traccar](https://www.traccar.org).
Telefón alebo GPS jednotka v aute posiela polohu do Traccaru, kniha jázd si z neho sama ťahá jazdy,
ty ich len označíš ako služobné alebo súkromné, potvrdíš a na konci mesiaca exportuješ.

*English: a self-hosted electronic trip logbook (Slovak VAT rules) built on top of Traccar's REST API.
UI and docs are in Slovak.*

## Čo ponúka navyše oproti samotnému Traccaru

Traccar vie zbierať polohy a vypočítať jazdy. Nevie z nich urobiť knihu jázd pre účtovníctvo. Toto ju dopĺňa:

- **Povinné polia knihy jázd**: poradové číslo, čas a miesto začiatku a konca, účel, typ jazdy
  (služobná / súkromná), vzdialenosť, stav tachometra pred a po jazde, vodič, vozidlo (EČV, VIN).
- **Automatický import** pozícií (každých 15 min) a jázd (každú hodinu) z Traccaru.
- **Viac zariadení na jedno vozidlo** (napr. dva telefóny vodičov v jednom aute).
- **Geofence zóny a pravidlá klasifikácie**: „z domu do kancelárie = služobná", návrh klasifikácie jazdy.
- **Šablóny účelu jazdy**, hromadné potvrdenie a hromadná úprava jázd.
- **Prepočet vzdialenosti cez Google Routes API** (presnejší než súčet GPS bodov) a prepočet tachometra.
- **Rozdelenie jazdy** podľa medzizastávok (waypoints), automatické potlačenie prekrývajúcich sa duplicitných jázd z viacerých zariadení.
- **Nemenný audit log** každej zmeny jazdy.
- **Zamykanie období** (mesačná uzávierka): zamknutý mesiac sa už nedá meniť.
- **Export do PDF a CSV**, história exportov, uložené miesta (adresy) s vyhľadávaním cez Google Places.
- **Prehľady**: podľa vozidla, vodiča, účelu, časová os, nepotvrdené jazdy.
- **Retencia GPS pozícií** (predvolene 90 dní), jazdy ostávajú.

> Kniha jázd je navrhnutá podľa požiadaviek slovenského zákona o DPH na evidenciu jázd pri plnom
> odpočte DPH z vozidla. Nie je to daňové poradenstvo: či tvoje použitie spĺňa zákon, over si
> s daňovým poradcom.

## Architektúra

```
telefón (Traccar Client / OsmAnd) ──▶ Traccar :5055 ──REST API──▶ kniha jázd (Node.js/Express + SPA) ──▶ PostgreSQL
                                                                         │
                                                                         └──▶ Google Routes / Maps / Places (voliteľné)
```

- Backend: Node.js + Express, cron joby (node-cron), PDF cez pdfkit
- Frontend: vanilla JS (ES moduly, hash routing), bez build kroku
- Databáza: PostgreSQL 16, schéma v `database/init/001_schema.sql` (tabuľky, funkcie, triggery)
- Traccar: oficiálny Docker image, nemení sa

## Inštalácia (Docker Compose)

```bash
git clone <repo-url> kniha-jazd && cd kniha-jazd
cp .env.example .env          # vyplň heslá
docker compose up -d
```

1. Otvor Traccar na `http://<server>:8082`, vytvor účet a zadaj ho do `.env` ako `TRACCAR_EMAIL` / `TRACCAR_PASSWORD`.
2. Do telefónu nainštaluj [Traccar Client](https://www.traccar.org/client/), server `http://<server>:5055`,
   identifikátor zariadenia pridaj v Traccar UI.
3. `docker compose restart logbook` a otvor `http://<server>:3000` (prihlásenie cez `BASIC_AUTH_*`).
4. V knihe jázd vytvor vozidlo a priraď mu Traccar zariadenie.

Voliteľne: `cp traccar/traccar.xml.example traccar/traccar.xml` a odkomentuj mount v `docker-compose.yml`.
Príklad nechá zapnutý len protokol OsmAnd (telefóny), filtruje nepresné body a nastavuje detekciu jázd.

### Bezpečnosť

- Aplikácia nemá vlastné používateľské účty. Chráni ju HTTP Basic auth (`BASIC_AUTH_USER`,
  `BASIC_AUTH_PASSWORD`); bez nich sa nespustí. `AUTH_DISABLED=true` použi len za vlastným auth proxy (SSO).
- Do internetu ju vystav len cez reverse proxy s HTTPS. Port 5055 Traccaru musí byť dostupný z telefónov.
- Google kľúč sa posiela do prehliadača (Maps JS API), preto ho obmedz na HTTP referrer `PUBLIC_URL`
  a len na Maps JavaScript, Places a Routes API.

## Konfigurácia (`.env`)

| Premenná | Popis |
|---|---|
| `POSTGRES_PASSWORD` | heslo databázy |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | prihlásenie do knihy jázd |
| `AUTH_DISABLED` | `true` len za vlastným auth proxy |
| `TRACCAR_EMAIL`, `TRACCAR_PASSWORD` | účet v Traccare, cez ktorý sa čítajú dáta |
| `TRACCAR_URL` | predvolene `http://traccar:8082/api` |
| `GOOGLE_PLACES_API_KEY` | Google kľúč (Maps, Places, Routes); bez neho chýba mapa a prepočet vzdialenosti |
| `PUBLIC_URL` | verejná URL, posiela sa ako Referer do Routes API |
| `CORS_ORIGIN` | povolený origin (predvolene žiadny) |
| `POSITION_RETENTION_DAYS` | koľko dní držať GPS pozície (predvolene 90) |

## Cron joby

| Kedy | Čo |
|---|---|
| `*/15 * * * *` | import GPS pozícií z Traccaru |
| `0 * * * *` | import jázd z Traccaru (posledné 2 h, s prekryvom) |
| `0 18 * * *` | kontrola nepotvrdených jázd (log) |
| `0 2 * * 0` | mazanie GPS pozícií starších než retencia |

## Vývoj bez Dockeru

```bash
cd backend && npm install
DATABASE_URL=postgresql://... BASIC_AUTH_USER=dev BASIC_AUTH_PASSWORD=dev npm run dev
```

## Licencia

Apache License 2.0, pozri [LICENSE](LICENSE) a [NOTICE](NOTICE).
Traccar je samostatný projekt (Apache 2.0) a v tomto repozitári nie je pribalený.
