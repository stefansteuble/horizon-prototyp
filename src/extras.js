// Zusatzdaten für die Auswertung: ÖREB-Kataster, ÖV-Reisezeit, Umgebung (OpenStreetMap), Leerwohnungsziffer (BFS).
// Alle Antworten werden im Cloudflare-Cache gehalten, damit externe Dienste geschont werden und die Seite schnell bleibt.

const HOUR = 3600, DAY = 86400;

export async function handleExtras(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\//, "");
  const handlers = { oereb, oev, umgebung, lwz };
  const fn = handlers[route];
  if (!fn) return json({ error: "not_found" }, 404);
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  try {
    const { body, ttl } = await fn(url.searchParams);
    const res = json(body, 200, ttl);
    if (ttl) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) {
    console.error(`extras/${route}`, String(e));
    return json({ error: "upstream_failed", detail: String(e).slice(0, 200) }, 502);
  }
}

/* ---------- ÖREB-Kataster: Auszug per E-GRID, auf das Wesentliche reduziert ---------- */
async function oereb(p) {
  const egrid = String(p.get("egrid") || "");
  const ws = String(p.get("ws") || "").replace(/\/+$/, "");
  if (!/^CH[0-9A-Z]{10,14}$/.test(egrid)) throw new Error("invalid egrid");
  let wsUrl;
  try { wsUrl = new URL(ws); } catch { throw new Error("invalid ws"); }
  // Nur kantonale ÖREB-Dienste (https, Schweizer Domain), keine beliebigen Ziele
  if (wsUrl.protocol !== "https:" || !/\.ch$/.test(wsUrl.hostname)) throw new Error("ws not allowed");

  const r = await fetchWithTimeout(`${wsUrl.href.replace(/\/+$/, "")}/extract/json/?EGRID=${egrid}`, 20000, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`oereb ${r.status}`);
  const j = await r.json();
  const ex = ci(ci(j, "GetExtractByIdResponse"), "extract");
  const re = ci(ex, "RealEstate") || {};
  const rs = ci(re, "RestrictionOnLandownership") || [];
  const seen = new Set();
  const items = [];
  for (const r0 of rs) {
    const th = ci(r0, "Theme") || {};
    const it = {
      theme: ci(th, "Code") || null,
      sub: ci(th, "SubCode") || null,
      themeText: txt(ci(th, "Text")),
      text: txt(ci(r0, "LegendText")),
      typeCode: ci(r0, "TypeCode") || null,
      area: num(ci(r0, "AreaShare")),
      length: num(ci(r0, "LengthShare")),
      pct: num(ci(r0, "PartInPercent")),
      docs: docsOf(r0),
    };
    const k = `${it.theme}|${it.text}`;
    if (seen.has(k)) { const prev = items.find(x => `${x.theme}|${x.text}` === k); if (prev && (it.pct || 0) > (prev.pct || 0)) Object.assign(prev, { area: it.area, pct: it.pct }); continue; }
    seen.add(k);
    items.push(it);
  }
  const codes = arr => (ci(ex, arr) || []).map(t => ci(t, "Code")).filter(Boolean);
  return {
    ttl: DAY,
    body: {
      egrid,
      municipality: ci(re, "MunicipalityName") || null,
      area: num(ci(re, "LandRegistryArea")),
      items,
      concerned: codes("ConcernedTheme"),
      notConcerned: codes("NotConcernedTheme"),
      withoutData: codes("ThemeWithoutData"),
    },
  };
}
function docsOf(r) {
  const out = [];
  const add = list => (list || []).forEach(p => {
    const url = txt(ci(p, "TextAtWeb")); const title = txt(ci(p, "Title")) || txt(ci(p, "OfficialTitle"));
    if (url && /^https?:\/\//.test(url) && !out.some(o => o.url === url)) out.push({ title: title || "Dokument", url });
  });
  add(ci(r, "LegalProvisions"));
  add(ci(r, "Documents"));
  return out.slice(0, 4);
}

/* ---------- ÖV: nächste Haltestelle und Reisezeit zu Zürich HB und zum nächsten Zentrum ---------- */
const CENTERS = [
  ["Zürich HB", 47.378, 8.540], ["Bern", 46.949, 7.439], ["Basel SBB", 47.547, 7.590], ["Luzern", 47.050, 8.310],
  ["St. Gallen", 47.423, 9.370], ["Winterthur", 47.500, 8.724], ["Genève", 46.210, 6.142], ["Lausanne", 46.517, 6.629],
  ["Lugano", 46.005, 8.947], ["Aarau", 47.391, 8.051], ["Zug", 47.173, 8.515], ["Olten", 47.352, 7.908],
  ["Chur", 46.853, 9.529], ["Biel/Bienne", 47.133, 7.243], ["Fribourg", 46.803, 7.151], ["Neuchâtel", 46.997, 6.936],
  ["Sion", 46.227, 7.359], ["Schaffhausen", 47.698, 8.633], ["Frauenfeld", 47.558, 8.896], ["Thun", 46.755, 7.630],
  ["Baden", 47.476, 8.308], ["Wil SG", 47.462, 9.040], ["Rapperswil", 47.225, 8.817], ["Uster", 47.348, 8.709],
];
async function oev(p) {
  const lat = coord(p.get("lat"), 45.7, 47.9), lon = coord(p.get("lon"), 5.8, 10.6);
  const T = "https://transport.opendata.ch/v1";
  const loc = await (await fetchWithTimeout(`${T}/locations?x=${lat}&y=${lon}&type=station`, 10000)).json();
  const stops = (loc.stations || []).filter(s => s.id);
  if (!stops.length) return { ttl: 7 * DAY, body: { stop: null, targets: [] } };
  const stop = stops[0];
  const dist = (a, b) => haversine(lat, lon, a, b);
  const nearest = CENTERS.filter(c => c[0] !== "Zürich HB").map(c => [c, dist(c[1], c[2])]).sort((a, b) => a[1] - b[1])[0];
  const targets = [CENTERS[0]];
  if (nearest && nearest[1] < 60000 && dist(CENTERS[0][1], CENTERS[0][2]) > 8000) targets.push(nearest[0]);
  if (dist(CENTERS[0][1], CENTERS[0][2]) <= 8000 && nearest) targets.push(nearest[0]);

  const day = nextWeekday();
  const conn = async ([name]) => {
    const q = `${T}/connections?from=${encodeURIComponent(stop.id)}&to=${encodeURIComponent(name)}&date=${day}&time=07:45&limit=4` +
      `&fields[]=connections/duration&fields[]=connections/transfers`;
    try {
      const j = await (await fetchWithTimeout(q, 10000)).json();
      const cs = (j.connections || []).map(c => ({ min: durMin(c.duration), transfers: c.transfers })).filter(c => c.min != null);
      if (!cs.length) return { name, min: null };
      cs.sort((a, b) => a.min - b.min);
      return { name, min: cs[0].min, transfers: cs[0].transfers };
    } catch { return { name, min: null }; }
  };
  const res = await Promise.all(targets.map(conn));
  return {
    ttl: 7 * DAY,
    body: {
      stop: { id: stop.id, name: stop.name, distance: Math.round(stop.distance || 0), icon: stop.icon || null },
      walkMin: Math.max(1, Math.round((stop.distance || 0) / 75)),
      targets: res,
      when: `werktags ab 07:45 (${day})`,
    },
  };
}

/* ---------- Umgebung: Schulen, Kindergärten, Einkauf, Gesundheit aus OpenStreetMap ---------- */
const CATS = {
  schule: { label: "Schule", test: t => t.amenity === "school" },
  kindergarten: { label: "Kindergarten", test: t => t.amenity === "kindergarten" },
  einkauf: { label: "Einkauf", test: t => t.shop === "supermarket" || t.shop === "convenience" },
  gesundheit: { label: "Arzt oder Apotheke", test: t => t.amenity === "doctors" || t.amenity === "pharmacy" || t.healthcare === "doctor" },
};
async function umgebung(p) {
  const lat = coord(p.get("lat"), 45.7, 47.9), lon = coord(p.get("lon"), 5.8, 10.6);
  const R = 1500;
  const a = `(around:${R},${lat},${lon})`;
  const q = `[out:json][timeout:25];(nwr${a}[amenity=school];nwr${a}[amenity=kindergarten];nwr${a}[shop=supermarket];` +
    `nwr${a}[shop=convenience];nwr${a}[amenity=doctors];nwr${a}[amenity=pharmacy];);out center tags 300;`;
  const servers = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  let data = null, lastErr = null;
  for (const s of servers) {
    try {
      const r = await fetchWithTimeout(s, 28000, {
        method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "horizon-prototyp (TTMS Schweiz AG)" },
      });
      if (!r.ok) throw new Error(`overpass ${r.status}`);
      data = await r.json(); break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error("overpass failed");
  const out = {};
  for (const [k, c] of Object.entries(CATS)) out[k] = { label: c.label, count: 0, nearest: null };
  for (const el of data.elements || []) {
    const t = el.tags || {}, la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
    if (la == null || lo == null) continue;
    const d = Math.round(haversine(lat, lon, la, lo));
    for (const [k, c] of Object.entries(CATS)) {
      if (!c.test(t)) continue;
      out[k].count++;
      if (!out[k].nearest || d < out[k].nearest.distance) out[k].nearest = { name: t.name || t.brand || null, distance: d };
    }
  }
  return { ttl: 30 * DAY, body: { radius: R, categories: out } };
}

/* ---------- Leerwohnungsziffer (BFS, Leerwohnungszählung, Datensatz DF_LWZ_1) ---------- */
async function lwz(p) {
  const bfs = String(p.get("bfs") || ""), kt = String(p.get("kt") || "");
  if (!/^\d{1,4}$/.test(bfs) || (kt && !/^[A-Z]{2}$/.test(kt))) throw new Error("invalid params");
  const geo = [bfs, kt, "8100"].filter(Boolean).join("+");
  const from = new Date().getFullYear() - 5;
  const u = `https://disseminate.stats.swiss/rest/data/CH1.LWZ,DF_LWZ_1,1.1.0/${geo}._T._T.RATE.A?startPeriod=${from}`;
  const r = await fetchWithTimeout(u, 15000, { headers: { accept: "application/vnd.sdmx.data+csv;version=2.0.0;labels=id" } });
  if (!r.ok) throw new Error(`bfs ${r.status}`);
  const lines = (await r.text()).trim().split(/\r?\n/);
  const head = lines.shift().split(",");
  const iGeo = head.indexOf("GR_KT_GDE"), iT = head.indexOf("TIME_PERIOD"), iV = head.indexOf("OBS_VALUE");
  const series = {};
  for (const l of lines) {
    const c = l.split(",");
    const v = Number(c[iV]); if (!isFinite(v)) continue;
    (series[c[iGeo]] ||= []).push({ year: +c[iT], rate: v });
  }
  for (const k in series) series[k].sort((a, b) => a.year - b.year);
  return { ttl: DAY, body: { gemeinde: series[bfs] || [], kanton: series[kt] || [], schweiz: series["8100"] || [], source: "BFS, Leerwohnungszählung (Stichtag 1. Juni)" } };
}

/* ---------- Hilfsfunktionen ---------- */
function ci(o, k) { return o && typeof o === "object" ? o[Object.keys(o).find(x => x.toLowerCase() === k.toLowerCase())] : undefined; }
function txt(x) {
  if (x == null) return null;
  if (typeof x === "string") return x;
  if (Array.isArray(x)) { const de = x.find(t => (ci(t, "Language") || "") === "de") || x[0]; return de ? txt(ci(de, "Text") ?? de) : null; }
  if (typeof x === "object") { const t = ci(x, "Text"); return t != null ? txt(t) : null; }
  return String(x);
}
function num(v) { const n = Number(v); return v == null || v === "" || !isFinite(n) ? null : n; }
function coord(v, min, max) { const n = Number(v); if (!isFinite(n) || n < min || n > max) throw new Error("invalid coordinate"); return Math.round(n * 1e4) / 1e4; }
function haversine(a1, o1, a2, o2) {
  const R = 6371000, t = Math.PI / 180, dA = (a2 - a1) * t, dO = (o2 - o1) * t;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * t) * Math.cos(a2 * t) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function durMin(d) { const m = /(\d+)d(\d+):(\d+):(\d+)/.exec(d || ""); return m ? (+m[1]) * 1440 + (+m[2]) * 60 + (+m[3]) : null; }
function nextWeekday() {
  const d = new Date(Date.now() + DAY * 1000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function fetchWithTimeout(u, ms, opt = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { ...opt, signal: c.signal }); } finally { clearTimeout(t); }
}
function json(body, status = 200, ttl = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": ttl ? `public, max-age=${Math.min(ttl, DAY)}, s-maxage=${ttl}` : "no-store" },
  });
}
