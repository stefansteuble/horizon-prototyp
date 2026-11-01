// POST /api/lead
// Nimmt eine Anfrage aus dem Grundstück-Check entgegen, prüft sie und leitet sie weiter.
//
// Umgebungsvariablen (Cloudflare Dashboard > Workers & Pages > horizon-prototyp > Settings > Variables and Secrets):
//   LEAD_WEBHOOK_URL   optional  Webhook für CRM / Make / Zapier / n8n / Slack (JSON-POST)
//   ALLOWED_ORIGINS    optional  Komma-getrennt, z.B. "https://www.kunde.ch,https://kunde.webflow.io"
//   RESEND_API_KEY     optional  Secret. Schickt jeden Lead als E-Mail über Resend (resend.com)
//   LEAD_EMAIL_TO      mit Resend  Empfänger, komma-getrennt. Ohne verifizierte Domain nur die Adresse des Resend-Kontos
//   LEAD_EMAIL_FROM    optional  Absender, Standard "Grundstück-Check <onboarding@resend.dev>".
//                                 Mit verifizierter Domain z.B. "Grundstück-Check <anfragen@kunde.ch>"
// Bindings:
//   LEADS              optional  KV-Namespace, in dem jede Anfrage zusätzlich gespeichert wird

const MAX_BODY = 10_000;

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

  const lead = {
    id: crypto.randomUUID(),
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
  if (env.RESEND_API_KEY && env.LEAD_EMAIL_TO) tasks.push(sendEmail(lead, env));
  else if (env.RESEND_API_KEY) console.warn("RESEND_API_KEY gesetzt, aber LEAD_EMAIL_TO fehlt");
  if (!tasks.length) console.warn("Lead erhalten, aber kein Ziel konfiguriert (LEAD_WEBHOOK_URL, RESEND_API_KEY + LEAD_EMAIL_TO oder LEADS)", lead.id);

  const results = await Promise.allSettled(tasks);
  const failed = results.filter(r => r.status === "rejected");
  failed.forEach(f => console.error("Lead-Weiterleitung fehlgeschlagen", lead.id, String(f.reason)));
  // Nur Fehler melden, wenn nichts geklappt hat; sonst geht der Lead nicht verloren.
  if (tasks.length && failed.length === tasks.length) return json({ error: "delivery_failed" }, 502);

  return json({ ok: true, id: lead.id });
}

async function sendEmail(l, env) {
  const to = env.LEAD_EMAIL_TO.split(",").map(s => s.trim()).filter(Boolean);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.LEAD_EMAIL_FROM || "Grundstück-Check <onboarding@resend.dev>",
      to,
      reply_to: l.email,
      subject: `Neue Anfrage: ${l.address || "Grundstück"} (${l.score ?? "–"}/100)${l.demo ? " [Beispiel]" : ""}`,
      html: emailHtml(l),
      text: summary(l),
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 200)}`);
}

function emailHtml(l) {
  const e = v => String(v ?? "–").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f = l.facts || {};
  const num = v => (typeof v === "number" ? v.toLocaleString("de-CH") : v);
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#5B6862;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#18221E">${v}</td></tr>`;
  const geoUrl = l.egrid ? `https://map.geo.admin.ch/?swisssearch=${encodeURIComponent(l.address || l.egrid)}` : null;
  return `<!doctype html><html><body style="margin:0;background:#F2F4F1;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #D5DBD6;border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862">Neue Anfrage aus dem Grundstück-Check${l.demo ? " · Beispieladresse" : ""}</div>
  <div style="font-size:22px;font-weight:bold;color:#18221E;margin-top:4px">${e(l.address)}</div>
  <div style="font-size:15px;color:#1E6A4E;font-weight:bold;margin-top:6px">${e(l.score)}/100 · ${e(l.level)}</div>
</td></tr>
<tr><td style="padding:16px 24px;border-bottom:1px solid #D5DBD6">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Kontakt</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
    ${row("Name", e(l.name))}
    ${row("E-Mail", `<a href="mailto:${e(l.email)}" style="color:#1E6A4E">${e(l.email)}</a>`)}
    ${row("Telefon", l.phone ? `<a href="tel:${e(l.phone.replace(/\s/g, ""))}" style="color:#1E6A4E">${e(l.phone)}</a>` : "–")}
    ${row("Rolle", e(l.role))}
    ${row("Interesse", e(l.goal))}
  </table>
</td></tr>
<tr><td style="padding:16px 24px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5B6862;margin-bottom:6px">Grundstück</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
    ${row("Parzelle", `${e(l.parzelle)}${l.gemeinde ? ", " + e(l.gemeinde) : ""}${f.parcelArea ? ` · ${e(num(f.parcelArea))} m²` : ""}`)}
    ${row("E-GRID", e(l.egrid))}
    ${row("Gebäude", `${e(f.klasse)}${f.year ? `, Baujahr ${e(f.year)}` : ""}${f.floors ? `, ${e(f.floors)} Geschosse` : ""}`)}
    ${row("Bauzone", e(f.zone))}
    ${row("ÖV-Güteklasse", e(f.oev))}
    ${row("Heizung", e(f.heat))}
    ${row("Solarstrom Dach", f.solar ? `${e(num(f.solar))} kWh/Jahr` : "–")}
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
  for (const k of ["parcelArea", "year", "klasse", "floors", "zone", "oev", "heat", "solar", "reserve", "gfMax", "units", "simRules"]) {
    const v = f[k];
    out[k] = typeof v === "number" ? v : str(v, 80);
  }
  return out;
}

function summary(l) {
  return [
    `Neuer Lead aus dem Grundstück-Check${l.demo ? " (Beispieladresse)" : ""}`,
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
