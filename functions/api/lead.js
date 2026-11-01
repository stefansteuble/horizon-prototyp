// Cloudflare Pages Function: POST /api/lead
// Nimmt eine Anfrage aus dem Grundstück-Check entgegen, prüft sie und leitet sie weiter.
//
// Umgebungsvariablen (Cloudflare Dashboard > Pages > Settings > Variables and Secrets):
//   LEAD_WEBHOOK_URL   optional  Webhook für CRM / Make / Zapier / n8n / Slack (JSON-POST)
//   ALLOWED_ORIGINS    optional  Komma-getrennt, z.B. "https://www.kunde.ch,https://kunde.webflow.io"
// Bindings:
//   LEADS              optional  KV-Namespace, in dem jede Anfrage zusätzlich gespeichert wird

const MAX_BODY = 10_000;

export async function onRequestPost({ request, env }) {
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
  if (!tasks.length) console.warn("Lead erhalten, aber weder LEADS noch LEAD_WEBHOOK_URL konfiguriert", lead.id);

  const results = await Promise.allSettled(tasks);
  const failed = results.filter(r => r.status === "rejected");
  failed.forEach(f => console.error("Lead-Weiterleitung fehlgeschlagen", lead.id, String(f.reason)));
  // Nur Fehler melden, wenn nichts geklappt hat; sonst geht der Lead nicht verloren.
  if (tasks.length && failed.length === tasks.length) return json({ error: "delivery_failed" }, 502);

  return json({ ok: true, id: lead.id });
}

function originAllowed(origin, request, env) {
  if (!origin) return true; // gleiche Seite, kein Origin-Header
  const self = new URL(request.url).origin;
  if (origin === self) return true;
  const list = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(origin);
}

function str(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f]/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function sanitizeFacts(f) {
  if (!f || typeof f !== "object") return {};
  const out = {};
  for (const k of ["parcelArea", "year", "klasse", "floors", "zone", "oev", "heat", "solar"]) {
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
  ].join("\n");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
