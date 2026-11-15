// POST /api/lead
// Nimmt eine Anfrage aus dem Grundstück-Check entgegen, prüft sie und leitet sie weiter.
//
// Umgebungsvariablen (Cloudflare Dashboard > Workers & Pages > horizon-prototyp > Settings > Variables and Secrets):
//   LEAD_WEBHOOK_URL   optional  Webhook für CRM / Make / Zapier / n8n / Slack (JSON-POST)
//   ALLOWED_ORIGINS    optional  Komma-getrennt, z.B. "https://www.kunde.ch,https://kunde.webflow.io"
//   RESEND_API_KEY     optional  Secret. Schickt jeden Lead als E-Mail über Resend (resend.com)
//   LEAD_EMAIL_TO      mit Resend  Empfänger, komma-getrennt. Ohne verifizierte Domain nur die Adresse des Resend-Kontos
//   LEAD_ROUTES        optional  JSON: zusätzliche Empfänger pro Anfrageart oder Gewerk, z.B.
//                                 {"finanzierung":"hypo@bank.ch","aushub":"offerten@tiefbau.ch","sanitaer":"a@x.ch,b@y.ch"}
//                                 Schlüssel: grundstueck, finanzierung, offerte oder eine Gewerk-ID (aushub, baumeister, huelle,
//                                 elektro, hlk, sanitaer, lift, ausbau1, ausbau2, planer, umgebung). Alle Anfragen gehen immer
//                                 auch an LEAD_EMAIL_TO. Weitere Empfänger brauchen in Resend eine verifizierte Absender-Domain.
//   LEAD_EMAIL_FROM    optional  Absender, Standard "Grundstück-Check <onboarding@resend.dev>".
//                                 Mit verifizierter Domain z.B. "Grundstück-Check <anfragen@kunde.ch>"
// Bindings:
//   LEADS              optional  KV-Namespace, in dem jede Anfrage zusätzlich gespeichert wird

const MAX_BODY = 20_000;
const TYPES = { grundstueck: "Grundstück", finanzierung: "Finanzierung", offerte: "Offertanfrage" };
const GEWERKE = ["aushub", "baumeister", "huelle", "elektro", "hlk", "sanitaer", "lift", "ausbau1", "ausbau2", "planer", "umgebung"];

export async function handleLead(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!originAllowed(origin, request, env)) return json({ error: "origin_not_allowed" }, 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);

  let d;
  try { d = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }

  // Honeypot: Bots füllen das versteckte Feld "website" aus. Still annehmen, nichts weiterleiten.
  if (d.website) return json({ ok: true });

  const name = str(d.name, 120);
  const email = str(d.email, 160);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_contact" }, 400);

  const type = TYPES[d.type] ? d.type : "grundstueck";
  if (type !== "grundstueck" && d.consent !== true) return json({ error: "consent_required" }, 400);
  const lead = {
    id: crypto.randomUUID(),
    type,
    consent: d.consent === true,
    receivedAt: new Date().toISOString(),
    name,
    email,
    phone: str(d.phone, 40),
    role: str(d.role, 60),
    goal: str(d.goal, 60),
    address: str(d.address, 200),
    egrid: str(d.egrid, 20),
    parzelle: str(d.parzelle, 30),
    gemeinde: str(d.gemeinde, 80),
    kanton: /^[A-Z]{2}$/.test(d.kanton || "") ? d.kanton : null,
    geoportalUrl: safeUrl(d.geoportalUrl),
    score: Number.isFinite(+d.score) ? Math.max(0, Math.min(100, Math.round(+d.score))) : null,
    level: str(d.level, 40),
    demo: !!d.demo,
    facts: sanitizeFacts(d.facts),
    finanz: type === "finanzierung" ? sanitizeFinanz(d.finanz) : null,
    offerte: type === "offerte" ? sanitizeOfferte(d.offerte) : null,
    page: str(d.page, 300),
    country: request.cf?.country || null,
  };

  const tasks = [];
  if (env.LEADS) tasks.push(env.LEADS.put(`lead:${lead.receivedAt}:${lead.id}`, JSON.stringify(lead)));
  if (env.LEAD_WEBHOOK_URL) {
    tasks.push(fetch(env.LEAD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...lead, text: summary(lead) }),
    }).then(r => { if (!r.ok) throw new Error(`webhook ${r.status}`); }));
  }
  if (env.RESEND_API_KEY && env.LEAD_EMAIL_TO) {
    tasks.push(sendEmail(lead, env, env.LEAD_EMAIL_TO));
    // Weiterleitung an Partner (Bank, Unternehmer) gemäss LEAD_ROUTES, nur mit Einwilligung
    if (lead.consent) for (const to of routeTargets(lead, env)) tasks.push(sendEmail(lead, env, to.to, to.label).catch(e => console.error("Partner-Mail", to.label, String(e))));
  }
  else if (env.RESEND_API_KEY) console.warn("RESEND_API_KEY gesetzt, aber LEAD_EMAIL_TO fehlt");
  if (!tasks.length) console.warn("Lead erhalten, aber kein Ziel konfiguriert (LEAD_WEBHOOK_URL, RESEND_API_KEY + LEAD_EMAIL_TO oder LEADS)", lead.id);

  const results = await Promise.allSettled(tasks);
  const failed = results.filter(r => r.status === "rejected");
  failed.forEach(f => console.error("Lead-Weiterleitung fehlgeschlagen", lead.id, String(f.reason)));
  // Nur Fehler melden, wenn nichts geklappt hat; sonst geht der Lead nicht verloren.
  if (tasks.length && failed.length === tasks.length) return json({ error: "delivery_failed" }, 502);

  return json({ ok: true, id: lead.id });
}

function routeTargets(l, env) {
  let routes = {};
  try { routes = JSON.parse(env.LEAD_ROUTES || "{}"); } catch { console.warn("LEAD_ROUTES ist kein gültiges JSON"); }
  const out = [];
  if (routes[l.type]) out.push({ to: routes[l.type], label: TYPES[l.type] });
  if (l.offerte) for (const g of l.offerte.gewerke) if (routes[g.id]) out.push({ to: routes[g.id], label: g.name });
  return out;
}

async function sendEmail(l, env, toList, partner) {
  const to = String(toList).split(",").map(s => s.trim()).filter(Boolean);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.LEAD_EMAIL_FROM || "Grundstück-Check <onboarding@resend.dev>",
      to,
      reply_to: l.email,
      subject: `${l.type === "grundstueck" ? "Neue Anfrage" : TYPES[l.type]}${partner && l.type === "offerte" ? " " + partner : ""}: ${l.address || "Grundstück"}${l.type === "grundstueck" ? ` (${l.score ?? "–"}/100)` : ""}${l.demo ? " [Beispiel]" : ""}`,
      html: emailHtml(l, partner),
      text: summary(l),
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 200)}`);
}

function emailHtml(l, partner) {
  const e = v => String(v ?? "–").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f = l.facts || {};
  const num = v => (typeof v === "number" ? v.toLocaleString("de-CH") : v);
  const chfE = v => (typeof v === "number" ? "CHF " + Math.round(v).toLocaleString("de-CH") : "–");
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#5B6862;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#18221E">${v}</td></tr>`;
  const geoUrl = l.egrid ? `https://map.geo.admin.ch/?swisssearch=${encodeURIComponent(l.address || l.egrid)}` : null;
  return `<!doctype html><html><body style="margin:0;background:#F2F4F1;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #D5DBD6;border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862">${l.type === "grundstueck" ? "Neue Anfrage" : e(TYPES[l.type])} aus dem Grundstück-Check${partner ? " · für " + e(partner) : ""}${l.demo ? " · Beispieladresse" : ""}</div>
  <div style="font-size:22px;font-weight:bold;color:#18221E;margin-top:4px">${e(l.address)}</div>
  <div style="font-size:15px;color:#1E6A4E;font-weight:bold;margin-top:6px">${e(l.score)}/100 · ${e(l.level)}</div>
</td></tr>
<tr><td style="padding:16px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Kontakt</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
    ${row("Name", e(l.name))}
    ${row("E-Mail", `<a href="mailto:${e(l.email)}" style="color:#1E6A4E">${e(l.email)}</a>`)}
    ${row("Telefon", l.phone ? `<a href="tel:${e(l.phone.replace(/\s/g, ""))}" style="color:#1E6A4E">${e(l.phone)}</a>` : "–")}
    ${l.role ? row("Rolle", e(l.role)) : ""}
    ${l.goal ? row("Interesse", e(l.goal)) : ""}
    ${l.type !== "grundstueck" ? row("Einwilligung", l.consent ? "Weitergabe an Partner erlaubt" : "nein") : ""}
  </table>
</td></tr>
${l.finanz ? `<tr><td style="padding:16px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Finanzierung</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
    ${row("Gesucht", `<b>${e(l.finanz.art)}</b>`)}
    ${row("Vorhaben", e(l.finanz.vorhaben))}
    ${row("Baustart", e(l.finanz.start))}
    ${row("Anlagekosten", chfE(l.finanz.anlage))}
    ${row("Eigenmittel", chfE(l.finanz.eigenmittel))}
    ${row("Hypothek", `<b style="color:#1E6A4E">${chfE(l.finanz.hypothek)}</b> (Belehnung ${e(l.finanz.belehnung)})`)}
    ${row("Mietertrag", `${chfE(l.finanz.mietertrag)} pro Jahr, netto ${chfE(l.finanz.nettoertrag)}`)}
    ${row("Bruttorendite", e(l.finanz.bruttorendite))}
    ${row("Tragbarkeit", e(l.finanz.tragbar))}
    ${l.finanz.verkauf ? row("Verkaufswert STWE", chfE(l.finanz.verkauf)) : ""}
  </table>
  <p style="margin:10px 0 0;font-size:12px;color:#5B6862">Schätzung aus dem Grundstück-Check, nicht geprüft.</p>
</td></tr>` : ""}
${l.offerte ? `<tr><td style="padding:16px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Offertanfrage · ${e(l.offerte.stand)} · Baustart ${e(l.offerte.start)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;width:100%">
    ${l.offerte.gewerke.filter(g => !partner || TYPES[l.type] === partner || g.name === partner).map(g => `<tr><td style="padding:6px 12px 6px 0;color:#5B6862;white-space:nowrap;vertical-align:top">BKP ${e(g.bkp)}</td><td style="padding:6px 0;color:#18221E"><b>${e(g.name)}</b><br><span style="color:#5B6862;font-size:13px">${e(g.menge)}</span></td><td style="padding:6px 0 6px 12px;text-align:right;white-space:nowrap;vertical-align:top">${chfE(g.betrag)}</td></tr>`).join("")}
  </table>
  <p style="margin:10px 0 0;font-size:12px;color:#5B6862">Beträge aus der Kostenschätzung nach BKP, ±25 %.</p>
</td></tr>` : ""}
<tr><td style="padding:16px 24px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Grundstück</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
    ${row("Parzelle", `${e(l.parzelle)}${l.gemeinde ? ", " + e(l.gemeinde) : ""}${f.parcelArea ? ` · ${e(num(f.parcelArea))} m²` : ""}`)}
    ${row("E-GRID", e(l.egrid))}
    ${row("Gebäude", `${e(f.klasse)}${f.year ? `, Baujahr ${e(f.year)}` : ""}${f.floors ? `, ${e(f.floors)} Geschosse` : ""}`)}
    ${row("Bauzone", f.oerebZone ? `${e(f.oerebZone)} <span style="color:#5B6862">(ÖREB)</span>` : e(f.zone))}
    ${f.altlasten ? row("Altlasten", /^Eintrag/.test(f.altlasten) ? `<b style="color:#8A5A0E">${e(f.altlasten)}</b>` : e(f.altlasten)) : ""}
    ${f.garage ? row("Tiefgarage/Aushub", e(f.garage)) : ""}
    ${f.anlage ? row("Anlagekosten*", `${e(f.anlage)}${f.mietertrag ? ` · Mietertrag ${e(f.mietertrag)}` : ""}${f.rendite ? ` · Rendite ${e(f.rendite)}` : ""}`) : ""}
    ${f.lwz ? row("Leerwohnungsziffer", e(f.lwz)) : ""}
    ${f.oevZuerich ? row("ÖV", e(f.oevZuerich)) : ""}
    ${row("ÖV-Güteklasse", e(f.oev))}
    ${row("Heizung", e(f.heat))}
    ${row("Solarstrom Dach", f.solar ? `${e(num(f.solar))} kWh/Jahr` : "–")}
    ${f.landValue ? row("Landwert*", `<b style="color:#1E6A4E">${e(f.landValue)}</b> (Residualwert, Richtwert)`) : ""}
    ${f.reserve || f.gfMax ? row("Ausbau-Reserve*", `<b style="color:#A4501A">${e(f.reserve)}</b>${f.gfMax ? ` · zulässig ${e(f.gfMax)}` : ""}${f.units ? ` · ${e(f.units)} Whg.` : ""}`) : ""}
  </table>
  ${f.reserve || f.gfMax ? `<p style="margin:10px 0 0;font-size:12px;color:#5B6862">* ${f.simRules ? e(f.simRules) + ". " : ""}Schätzung, nicht nach der Bauordnung der Gemeinde geprüft.</p>` : ""}
  ${geoUrl ? `<p style="margin:16px 0 0"><a href="${e(geoUrl)}" style="color:#1E6A4E;font-size:14px">Auf map.geo.admin.ch öffnen</a></p>` : ""}
</td></tr>
${l.geoportalUrl || l.kanton ? `<tr><td style="padding:16px 24px;border-top:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Eigentümer prüfen${l.kanton ? " · Kanton " + e(l.kanton) : ""}</div>
  <p style="margin:0 0 10px;font-size:14px;color:#18221E">Im Kantonsportal die Parzelle <b>${e(l.parzelle)}</b>${l.gemeinde ? " in <b>" + e(l.gemeinde) + "</b>" : ""} suchen (E-GRID ${e(l.egrid)}) und dort die Eigentümerauskunft öffnen.</p>
  ${l.geoportalUrl ? `<p style="margin:0 0 10px"><a href="${e(l.geoportalUrl)}" style="display:inline-block;background:#1E6A4E;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:9px 14px;border-radius:6px">Kantonsportal öffnen</a></p>` : ""}
  <p style="margin:0;font-size:12px;color:#5B6862">Nur für diese Anfrage verwenden. Die Online-Auskunft ist je nach Kanton limitiert, und Eigentümer können ihre Daten sperren lassen. Dann gibt das Grundbuchamt Auskunft.</p>
</td></tr>` : ""}
<tr><td style="padding:12px 24px;background:#F2F4F1;border-top:1px solid #D5DBD6;border-radius:0 0 10px 10px;font-size:12px;color:#5B6862">
  Eingegangen ${e(new Date(l.receivedAt).toLocaleString("de-CH", { timeZone: "Europe/Zurich" }))} · Antworten geht direkt an ${e(l.email)}
</td></tr>
</table></td></tr></table></body></html>`;
}

function originAllowed(origin, request, env) {
  if (!origin) return true; // gleiche Seite, kein Origin-Header
  const self = new URL(request.url).origin;
  if (origin === self) return true;
  const list = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(origin);
}

// Nur https-Links auf Schweizer Kantonsportale (.ch) übernehmen
function safeUrl(v) {
  try {
    const u = new URL(String(v || ""));
    return u.protocol === "https:" && /\.ch$/.test(u.hostname) && u.href.length <= 400 ? u.href : null;
  } catch { return null; }
}

function str(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function sanitizeFacts(f) {
  if (!f || typeof f !== "object") return {};
  const out = {};
  for (const k of ["parcelArea", "year", "klasse", "floors", "zone", "oev", "heat", "solar", "reserve", "gfMax", "units", "simRules", "landValue", "oerebZone", "altlasten", "lwz", "oevZuerich", "garage", "anlage", "mietertrag", "rendite"]) {
    const v = f[k];
    out[k] = typeof v === "number" ? v : str(v, k === "altlasten" ? 200 : 80);
  }
  return out;
}

function sanitizeFinanz(f) {
  if (!f || typeof f !== "object") return {};
  const out = {};
  for (const k of ["art", "vorhaben", "start", "belehnung", "bruttorendite", "tragbar"]) out[k] = str(f[k], 80);
  for (const k of ["anlage", "eigenmittel", "hypothek", "mietertrag", "nettoertrag", "verkauf"]) out[k] = Number.isFinite(+f[k]) && f[k] !== null && f[k] !== "" ? Math.round(+f[k]) : null;
  return out;
}

function sanitizeOfferte(o) {
  if (!o || typeof o !== "object") return { gewerke: [] };
  const gewerke = (Array.isArray(o.gewerke) ? o.gewerke : []).filter(g => g && GEWERKE.includes(g.id)).slice(0, 12)
    .map(g => ({ id: g.id, bkp: str(g.bkp, 6), name: str(g.name, 60), menge: str(g.menge, 200), betrag: Number.isFinite(+g.betrag) ? Math.round(+g.betrag) : null }));
  return { stand: str(o.stand, 60), start: str(o.start, 60), gewerke };
}

function summary(l) {
  return [
    `${l.type === "grundstueck" ? "Neuer Lead" : TYPES[l.type]} aus dem Grundstück-Check${l.demo ? " (Beispieladresse)" : ""}`,
    l.finanz ? `Finanzierung: ${l.finanz.art}, Hypothek CHF ${l.finanz.hypothek ?? "–"}, Anlagekosten CHF ${l.finanz.anlage ?? "–"}` : null,
    l.offerte ? `Offerten: ${l.offerte.gewerke.map(g => g.name).join(", ")}` : null,
    `${l.name} · ${l.email}${l.phone ? " · " + l.phone : ""}`,
    `${l.role || "–"} · Interesse: ${l.goal || "–"}`,
    `Adresse: ${l.address || "–"} (E-GRID ${l.egrid || "–"})`,
    `Potenzial: ${l.score ?? "–"}/100 · ${l.level || ""}`,
    l.geoportalUrl ? `Eigentümer prüfen (Kanton ${l.kanton || "–"}, Parzelle ${l.parzelle || "–"}): ${l.geoportalUrl}` : null,
  ].filter(Boolean).join("\n");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
