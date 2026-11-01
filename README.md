# Grundstück-Check

Lead-Tool für Immobilienentwickler: Eigentümer geben ihre Adresse ein und sehen eine automatische Ersteinschätzung ihres Grundstücks. Die Daten stammen live aus [geo.admin.ch](https://api3.geo.admin.ch): Parzelle, Gebäude (GWR), Bauzone, ÖV-Güteklasse und Solarpotenzial. Danach können sie eine persönliche Einschätzung anfordern. Die Anfrage geht an `/api/lead` und wird von dort an einen Webhook (CRM, Make, Zapier, n8n, Slack) und/oder in Cloudflare KV weitergeleitet.

```
public/
  index.html      die App (statisch, ohne Build-Schritt)
  embed.js        Einbettung per iframe mit automatischer Höhe
  _headers        Sicherheits-Header, erlaubte iframe-Domains
functions/
  api/lead.js     Cloudflare Pages Function: Lead prüfen und weiterleiten
wrangler.toml
```

## Deployment auf Cloudflare Pages (über GitHub)

1. Cloudflare Dashboard > **Workers & Pages** > **Create** > **Pages** > **Connect to Git**, dieses Repo wählen.
2. Build-Einstellungen:
   - Framework preset: **None**
   - Build command: *(leer lassen)*
   - Build output directory: `public`
3. **Save and Deploy**. Jeder Push auf `main` deployt automatisch, jeder andere Branch bekommt eine Preview-URL.
4. Unter **Settings > Variables and Secrets** setzen:
   - `LEAD_WEBHOOK_URL`: Webhook, an den jeder Lead als JSON geht (enthält zusätzlich ein Feld `text` als Kurzfassung, z.B. für Slack)
   - optional `ALLOWED_ORIGINS`: nur nötig, wenn das Formular von einer fremden Domain aus direkt aufgerufen wird
5. Optional KV als Backup aller Leads: `npx wrangler kv namespace create LEADS`, dann unter **Settings > Bindings** einen KV-Namespace mit dem Namen `LEADS` verbinden.
6. Optional eigene Domain, z.B. `check.kunde.ch`: **Custom domains** > **Set up a domain**.

Ohne `LEAD_WEBHOOK_URL` und ohne `LEADS` antwortet der Endpunkt mit Erfolg, der Lead landet dann aber nur im Log (Pages > Functions > Real-time Logs). Vor dem Livegang also mindestens eines davon einrichten.

## Einbindung in Webflow

In `public/_headers` die Kundendomain bei `frame-ancestors` ergänzen (`*.webflow.io` ist schon drin), committen.

Dann in Webflow ein **Embed**-Element an der gewünschten Stelle einfügen:

```html
<div data-grundstueck-check></div>
<script src="https://grundstueck-check.pages.dev/embed.js" defer></script>
```

Die Domain durch die eigene Pages-Domain bzw. Custom Domain ersetzen. Das iframe passt seine Höhe automatisch an.

Für Conversion-Tracking feuert das Embed ein DOM-Event, sobald ein Lead gesendet wurde:

```html
<script>
document.addEventListener("grundstueck-check:lead", function (e) {
  // gtag("event", "generate_lead", { value: e.detail.score });
});
</script>
```

## Lokal entwickeln

```bash
npm install
cp .dev.vars.example .dev.vars   # optional Webhook eintragen
npm run dev                      # http://localhost:8788
```

## Datenquellen (alle offen, ohne API-Key)

| Information | Layer / Endpunkt |
|---|---|
| Adresssuche | `SearchServer?type=locations&origins=address` |
| Parzelle, E-GRID, Geometrie | `ch.kantone.cadastralwebmap-farbe` (identify) |
| Gebäude: Baujahr, Geschosse, Wohnungen, Heizung | `ch.bfs.gebaeude_wohnungs_register` (identify) |
| Bauzone (harmonisiert) | `ch.are.bauzonen` (identify) |
| ÖV-Güteklasse | `ch.are.gueteklassen_oev` (identify) |
| Solarpotenzial, Dachumriss | `ch.bfe.solarenergie-eignung-daecher` (find nach `gwr_egid`) |

Nutzungsbedingungen: [geo.admin.ch Terms of use](https://www.geo.admin.ch/de/nutzungsbedingungen). Die Quelle wird in der App genannt.

## Bewertungslogik

Der Score (0 bis 100) ist ein Indikator, kein Gutachten. Er steht in `evaluate()` in `public/index.html`:

| Kriterium | Punkte |
|---|---|
| Gebäudealter ≥ 50 / ≥ 35 / ≥ 20 Jahre | 30 / 20 / 10 |
| Geschossfläche ÷ Parzellenfläche < 0,4 / < 0,7 / < 1,0 | 30 / 20 / 10 |
| Parzelle ≥ 800 m² / ≥ 500 m² | 10 / 5 |
| Wohn-, Misch- oder Kernzone | 10 |
| ÖV-Güteklasse A, B / C / D | 10 / 6 / 3 |
| Fossile Heizung (Öl, Gas) | 10 |

Die zulässige Ausnützung (AZ, ÜZ, BMZ) ist kommunal geregelt und nicht in den Bundesdaten enthalten. Die App sagt das den Nutzern auch so.

## Anpassen

- Firmenname: `MUSTER ENTWICKLUNG AG` in `public/index.html`
- Farben und Schriften: CSS-Variablen in `:root` (heller und dunkler Modus)
- Die Beispieladressen in `DEMO` sind fiktiv und dienen als Startansicht sowie als Fallback, wenn geo.admin.ch nicht erreichbar ist.
