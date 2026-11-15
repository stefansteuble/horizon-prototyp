/* Schemaprojekt aus der Bebauungssimulation: ein plausibles Mehrfamilienhaus im Baufeld.
   Kein Architekturentwurf, sondern eine erste Machbarkeitsstudie:
   - rechteckiger Baukörper, so gross wie möglich im Baufeld, Gebäudetiefe max. 16 m
   - Geschosse mit Treppenhaus/Lift, Wohnungen (je ca. 95 m²), Aussen- und Trennwände, Decken, Dach
   - Balkone auf der Südseite mit Geländer
   - Untergeschoss: ab 4 Wohnungen Tiefgarage mit Rampe von der Strassenseite, sonst Keller
   - Gelände als Dreiecksnetz, Gebäude auf Geländehöhe
   Alle Koordinaten lokal in Metern (x Ost, y Nord) relativ zum Adresspunkt, z relativ zur Geländehöhe dort. */
(function (global) {
  const H_FLOOR = 3.0, T_SLAB = 0.3, T_EXT = 0.35, T_INT = 0.2, MAX_DEPTH = 16, UNIT_M2 = 95;
  const BALC_DEPTH = 2.0, RAMP_W = 3.5, RAMP_L = 18, STALL_M2 = 27;

  const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]], sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const len = a => Math.hypot(a[0], a[1]), norm = a => mul(a, 1 / (len(a) || 1));

  function clean(r) { const a = r.slice(); if (a.length > 1 && a[0][0] === a[a.length - 1][0] && a[0][1] === a[a.length - 1][1]) a.pop(); return a; }
  function area(r) { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; }
  function centroid(r) { return mul(r.reduce((t, p) => add(t, p), [0, 0]), 1 / r.length); }
  function inside(p, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
  function segX(a, b, c, d) { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; }
  function rectFits(corners, poly) {
    if (!corners.every(c => inside(c, poly))) return false;
    for (let i = 0; i < 4; i++) for (let j = 0; j < poly.length; j++)
      if (segX(corners[i], corners[(i + 1) % 4], poly[j], poly[(j + 1) % poly.length])) return false;
    return true;
  }
  const rectCorners = (c, a, L, D) => [[-L / 2, -D / 2], [L / 2, -D / 2], [L / 2, D / 2], [-L / 2, D / 2]].map(p => add(c, rot(p, a)));

  /* Grösstes Rechteck im Baufeld, ausgerichtet an einer der Baufeldkanten */
  function bestRect(poly) {
    const c0 = centroid(poly);
    const angles = [];
    for (let i = 0; i < poly.length; i++) { const e = sub(poly[(i + 1) % poly.length], poly[i]); if (len(e) > 2) angles.push(Math.atan2(e[1], e[0]) % (Math.PI / 2)); }
    let best = null;
    for (const a of angles.length ? angles : [0]) {
      const loc = poly.map(p => rot(sub(p, c0), -a));
      const xs = loc.map(p => p[0]), ys = loc.map(p => p[1]);
      const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
      const cc = add(c0, rot([(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2], a));
      for (const fx of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; rectFits(rectCorners(cc, a, W * fx * m, H * m), poly) ? lo = m : hi = m; }
        const L = W * fx * lo, D = H * lo;
        if (L * D > 0 && (!best || L * D > best.L * best.D)) best = { c: cc, a, L, D };
      }
    }
    if (!best) return null;
    // Lange Seite = Länge, Tiefe begrenzen
    if (best.D > best.L) best = { c: best.c, a: best.a + Math.PI / 2, L: best.D, D: best.L };
    if (best.D > MAX_DEPTH) best.D = MAX_DEPTH;
    return best;
  }

  /**
   * input: { parcel, footprint, floorsMax, gfMax, addressPoint:[0,0], terrain(x,y)->z, name }
   * Rückgabe: { storeys:[{name, elev}], elements:[...], summary:{...} }
   */
  function makeDesign(input) {
    const parcel = clean(input.parcel), foot = clean(input.footprint);
    const zAt = input.terrain || (() => 0);
    let R = bestRect(foot);
    if (!R || R.L < 6 || R.D < 6) return null;
    // Geschosse und Länge an die zulässige Geschossfläche anpassen
    let floors = Math.max(1, Math.min(input.floorsMax || 3, Math.round((input.gfMax || R.L * R.D) / (R.L * R.D)) || 1));
    const perFloor = (input.gfMax || R.L * R.D * floors) / floors;
    if (R.L * R.D > perFloor * 1.05) R.L = Math.max(8, perFloor / R.D);
    const { c, a, L, D } = R;
    const W = (u, v) => add(c, rot([u, v], a));                      // lokale Gebäudekoordinaten -> Modell
    const quad = (u0, v0, u1, v1) => [W(u0, v0), W(u1, v0), W(u1, v1), W(u0, v1)];
    const outer = quad(-L / 2, -D / 2, L / 2, D / 2);

    // Südseite: Seite (v = ±D/2), deren Aussennormale am stärksten nach Süden zeigt
    const nPlus = rot([0, 1], a);
    const sv = nPlus[1] > 0 ? -1 : 1;                                // v-Richtung der Südseite
    // Strassenseite: Parzellenkante, die dem Adresspunkt am nächsten liegt
    const ap = input.addressPoint || [0, 0];
    let street = null;
    for (let i = 0; i < parcel.length; i++) {
      const p = parcel[i], q = parcel[(i + 1) % parcel.length], e = sub(q, p), t = Math.max(0, Math.min(1, dot(sub(ap, p), e) / (dot(e, e) || 1)));
      const d = len(sub(ap, add(p, mul(e, t))));
      if (!street || d < street.d) street = { p, q, d, mid: mul(add(p, q), 0.5) };
    }

    // Erdgeschosshöhe: Gelände in Gebäudemitte + 0.15 m
    const zEG = Math.round((zAt(c[0], c[1]) + 0.15) * 100) / 100;
    const elements = [], storeys = [];

    // Wohnungen pro Geschoss und Kern
    const gross = L * D, net = gross * 0.8;
    const units = Math.max(1, Math.round(net / UNIT_M2));
    const totalUnits = units * floors;
    const hasLift = floors >= 3 || units >= 3;
    const coreL = units === 1 && !hasLift ? 3.2 : 5.6, coreD = Math.min(D - 2 * T_EXT, 6.2);
    const garage = totalUnits >= 4;

    // Untergeschoss
    storeys.push({ name: garage ? "Untergeschoss (Tiefgarage)" : "Untergeschoss (Keller)", elev: zEG - H_FLOOR });
    for (let i = 0; i < floors; i++) storeys.push({ name: i === 0 ? "Erdgeschoss" : `${i}. Obergeschoss`, elev: zEG + i * H_FLOOR });
    storeys.push({ name: "Dach", elev: zEG + floors * H_FLOOR });
    const sUG = 0, sDach = floors + 1;

    const ext = (poly, z, depth) => ({ type: "extrude", poly, z, depth });
    const wallsAround = (u0, v0, u1, v1, t, h, s, name) => {
      const segs = [[u0, v0, u1, v0 + t], [u0, v1 - t, u1, v1], [u0, v0 + t, u0 + t, v1 - t], [u1 - t, v0 + t, u1, v1 - t]];
      segs.forEach((q, k) => elements.push({ ifc: "IFCWALL", predef: "STANDARD", name: `${name} ${["Süd", "Nord", "West", "Ost"][k] || k + 1}`, storey: s, style: "wall", shapes: [ext(quad(...q), 0, h)] }));
    };

    // UG: Bodenplatte, Aussenwände, Raum
    elements.push({ ifc: "IFCSLAB", predef: "BASESLAB", name: "Bodenplatte", storey: sUG, style: "slab", shapes: [ext(outer, -T_SLAB, T_SLAB)] });
    wallsAround(-L / 2, -D / 2, L / 2, D / 2, T_EXT, H_FLOOR - T_SLAB, sUG, "Aussenwand UG");
    const ugIn = quad(-L / 2 + T_EXT, -D / 2 + T_EXT, L / 2 - T_EXT, D / 2 - T_EXT);
    const ugArea = (L - 2 * T_EXT) * (D - 2 * T_EXT);
    const stalls = garage ? Math.max(1, Math.floor(ugArea / STALL_M2)) : 0;
    elements.push({ ifc: "IFCSPACE", predef: garage ? "PARKING" : "INTERNAL", name: garage ? "Tiefgarage" : "Keller und Technik", longName: garage ? `Tiefgarage · ca. ${stalls} Parkplätze` : "Keller und Technik",
      storey: sUG, style: garage ? "parking" : "cellar", shapes: [ext(ugIn, 0, H_FLOOR - T_SLAB - 0.1)],
      props: { "Nutzung": garage ? "Tiefgarage" : "Keller", "Parkplätze": stalls || null, "Fläche m2": Math.round(ugArea) } });

    // Normalgeschosse
    const spaces = [];
    for (let i = 0; i < floors; i++) {
      const s = i + 1;
      elements.push({ ifc: "IFCSLAB", predef: "FLOOR", name: `Decke über ${storeys[s - 1].name.split(" (")[0]}`, storey: s, style: "slab", shapes: [ext(outer, -T_SLAB, T_SLAB)] });
      wallsAround(-L / 2, -D / 2, L / 2, D / 2, T_EXT, H_FLOOR - T_SLAB, s, "Aussenwand");
      // Kern in der Mitte, an der Nordseite (gegenüber Balkonen)
      const vN = -sv * (D / 2 - T_EXT), vCore0 = Math.min(vN, vN + sv * coreD), vCore1 = Math.max(vN, vN + sv * coreD);
      // Kern so platzieren, dass alle Wohnungen gleich breit werden
      const left = Math.ceil(units / 2), right = units - left;
      const avail = L - 2 * T_EXT - coreL - 2 * T_INT, uw = avail / units;
      const uC0 = -L / 2 + T_EXT + left * uw + T_INT, uC1 = uC0 + coreL;
      elements.push({ ifc: "IFCSPACE", predef: "INTERNAL", name: hasLift ? "Treppenhaus und Lift" : "Treppenhaus", longName: hasLift ? "Treppenhaus und Lift" : "Treppenhaus",
        storey: s, style: "core", shapes: [ext(quad(uC0, vCore0, uC1, vCore1), 0, H_FLOOR - T_SLAB - 0.1)], props: { "Nutzung": "Erschliessung" } });
      // Trennwände links und rechts des Kernbandes über die ganze Tiefe, Querwand an der Südseite des Kerns
      const vIn0 = -D / 2 + T_EXT, vIn1 = D / 2 - T_EXT;
      [uC0 - T_INT, uC1].forEach((u, k) => elements.push({ ifc: "IFCWALL", predef: "PARTITIONING", name: `Kernwand ${k ? "Ost" : "West"}`, storey: s, style: "wallInt",
        shapes: [ext(quad(u, vIn0, u + T_INT, vIn1), 0, H_FLOOR - T_SLAB)] }));
      const vCs = sv > 0 ? vCore1 : vCore0;                        // Kernseite Richtung Süden
      elements.push({ ifc: "IFCWALL", predef: "PARTITIONING", name: "Kernwand Süd", storey: s, style: "wallInt",
        shapes: [ext(quad(uC0, Math.min(vCs, vCs + sv * T_INT), uC1, Math.max(vCs, vCs + sv * T_INT)), 0, H_FLOOR - T_SLAB)] });
      // Fläche südlich des Kerns: eigene kleine Wohnung oder Teil des Treppenhauses
      const midV0 = sv > 0 ? vCs + T_INT : vIn0, midV1 = sv > 0 ? vIn1 : vCs - T_INT, midA = (uC1 - uC0) * (midV1 - midV0);
      if (midA >= 30) {
        const nmM = `Wohnung ${s - 1}.M`, arM = Math.round(midA);
        elements.push({ ifc: "IFCSPACE", predef: "SPACE", name: nmM, longName: `${nmM} · ca. ${arM} m² · 1,5 Zimmer`, storey: s, style: "unit",
          shapes: [ext(quad(uC0, midV0, uC1, midV1), 0, H_FLOOR - T_SLAB - 0.1)], props: { "Nutzung": "Wohnen", "Fläche m2": arM, "Zimmer": 1.5 } });
        spaces.push(arM);
      }
      // Wohnungen links und rechts vom Kern, jeweils über die ganze Tiefe
      const uL0 = -L / 2 + T_EXT, uR1 = L / 2 - T_EXT;
      const sides = [[uL0, uC0 - T_INT, left], [uC1 + T_INT, uR1, right]];
      let n = 0;
      for (const [u0, u1, cnt] of sides) {
        if (cnt < 1 || u1 - u0 < 2) continue;
        const w = (u1 - u0) / cnt;
        for (let k = 0; k < cnt; k++) {
          const a0 = u0 + k * w, a1 = a0 + w; n++;
          const poly = quad(a0, -D / 2 + T_EXT, a1, D / 2 - T_EXT);
          const ar = Math.round((a1 - a0) * (D - 2 * T_EXT));
          const zi = Math.max(1.5, Math.round(ar / 25 * 2) / 2 + 0.5);
          const nm = `Wohnung ${s - 1}.${n}`;
          spaces.push(ar);
          elements.push({ ifc: "IFCSPACE", predef: "SPACE", name: nm, longName: `${nm} · ca. ${ar} m² · ${String(zi).replace(".", ",")} Zimmer`, storey: s, style: "unit",
            shapes: [ext(poly, 0, H_FLOOR - T_SLAB - 0.1)], props: { "Nutzung": "Wohnen", "Fläche m2": ar, "Zimmer": zi } });
          if (k < cnt - 1) elements.push({ ifc: "IFCWALL", predef: "PARTITIONING", name: `Wohnungstrennwand ${s - 1}.${n}`, storey: s, style: "wallInt",
            shapes: [ext(quad(a1 - T_INT / 2, -D / 2 + T_EXT, a1 + T_INT / 2, D / 2 - T_EXT), 0, H_FLOOR - T_SLAB)] });
          // Balkon auf der Südseite (ab 1. OG), im EG ein Sitzplatz
          const bw = Math.min(6, (a1 - a0) - 1.2), bu0 = (a0 + a1) / 2 - bw / 2, bu1 = bu0 + bw;
          const vb0 = sv * D / 2, vb1 = sv * (D / 2 + BALC_DEPTH);
          const bpoly = quad(bu0, Math.min(vb0, vb1), bu1, Math.max(vb0, vb1));
          if (i === 0) {
            elements.push({ ifc: "IFCSLAB", predef: "USERDEFINED", objectType: "Sitzplatz", name: `Sitzplatz ${nm}`, storey: s, style: "balcony", shapes: [ext(bpoly, -0.15, 0.15)], props: { "Fläche m2": Math.round(bw * BALC_DEPTH) } });
          } else {
            elements.push({ ifc: "IFCSLAB", predef: "USERDEFINED", objectType: "Balkon", name: `Balkon ${nm}`, storey: s, style: "balcony", shapes: [ext(bpoly, -0.25, 0.25)], props: { "Fläche m2": Math.round(bw * BALC_DEPTH) } });
            const t = 0.06, vo = sv * (D / 2 + BALC_DEPTH);
            const rails = [quad(bu0, Math.min(vo, vo - sv * t), bu1, Math.max(vo, vo - sv * t)),
              quad(bu0, Math.min(vb0, vo), bu0 + t, Math.max(vb0, vo)), quad(bu1 - t, Math.min(vb0, vo), bu1, Math.max(vb0, vo))];
            elements.push({ ifc: "IFCRAILING", predef: "BALUSTRADE", name: `Geländer ${nm}`, storey: s, style: "railing", shapes: rails.map(p => ext(p, 0, 1.0)) });
          }
        }
      }
    }
    // Dach
    elements.push({ ifc: "IFCSLAB", predef: "ROOF", name: "Flachdach", storey: sDach, style: "roof", shapes: [ext(outer, -T_SLAB, T_SLAB + 0.2)] });

    // Rampe zur Tiefgarage von der Strassenseite
    let ramp = null;
    if (garage && street) {
      const dir = norm(sub(c, street.mid)), perp = [-dir[1], dir[0]];
      const proj = outer.map(p => dot(sub(p, c), dir)), projP = outer.map(p => dot(sub(p, c), perp));
      const halfP = (Math.max(...projP) - Math.min(...projP)) / 2;
      const end = add(add(c, mul(dir, Math.min(...proj))), mul(perp, Math.max(0, halfP - RAMP_W / 2 - 0.5)));
      // Rampenlänge aus dem Höhenunterschied (max. 15 % Gefälle plus Übergänge), Start an der Strassenseite
      const outLen = Math.max(0, dot(sub(end, street.mid), dir));
      const z1 = zEG - H_FLOOR;
      let rl = RAMP_L;
      for (let k = 0; k < 3; k++) { const st0 = sub(end, mul(dir, Math.min(rl, outLen))); rl = Math.max(6, Math.min(24, (zAt(st0[0], st0[1]) - z1) / 0.15 + 2)); }
      const start = sub(end, mul(dir, Math.min(rl, outLen)));
      const stop = add(start, mul(dir, rl));
      const z0 = zAt(start[0], start[1]);
      const w2 = mul(perp, RAMP_W / 2);
      const top = [sub(start, w2), add(start, w2), add(stop, w2), sub(stop, w2)];
      const zs = [z0, z0, z1, z1], th = 0.3;
      const pts = top.map((p, k) => [p[0], p[1], zs[k]]).concat(top.map((p, k) => [p[0], p[1], zs[k] - th]));
      const tris = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
      ramp = { length: Math.round(rl * 10) / 10, slope: Math.round((z0 - z1) / rl * 100) };
      elements.push({ ifc: "IFCRAMP", predef: "STRAIGHT_RUN_RAMP", name: "Einfahrt Tiefgarage", storey: "site", style: "ramp", shapes: [{ type: "mesh", pts, tris }],
        props: { "Länge m": ramp.length, "Breite m": RAMP_W, "Gefälle %": ramp.slope } });
    }

    // Gelände: Dreiecksnetz aus dem Höhenraster, Parzellengrenze als Band
    if (input.terrainGrid) {
      const g = input.terrainGrid, pts = [], tris = [];
      for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) pts.push([g.x0 + i * g.dx, g.y0 + j * g.dy, g.z[j * g.nx + i]]);
      for (let j = 0; j < g.ny - 1; j++) for (let i = 0; i < g.nx - 1; i++) {
        const a0 = j * g.nx + i, b = a0 + 1, cc = a0 + g.nx, d = cc + 1;
        tris.push([a0, b, d], [a0, d, cc]);
      }
      elements.push({ ifc: "IFCGEOGRAPHICELEMENT", predef: "TERRAIN", name: "Gelände (swissALTI3D)", storey: "site", style: "terrain", shapes: [{ type: "mesh", pts, tris }] });
    }
    {
      const pts = [], tris = [];
      parcel.forEach((p, k) => { const q = parcel[(k + 1) % parcel.length]; const zp = zAt(p[0], p[1]), zq = zAt(q[0], q[1]); const b = pts.length;
        pts.push([p[0], p[1], zp + 0.02], [q[0], q[1], zq + 0.02], [q[0], q[1], zq + 0.45], [p[0], p[1], zp + 0.45]); tris.push([b, b + 1, b + 2], [b, b + 2, b + 3]); });
      elements.push({ ifc: "IFCGEOGRAPHICELEMENT", predef: "USERDEFINED", objectType: "Parzellengrenze", name: "Parzellengrenze", storey: "site", style: "boundary", shapes: [{ type: "mesh", pts, tris }] });
    }

    const gf = Math.round(L * D * floors);
    const unitCount = spaces.length;
    return {
      storeys, elements,
      summary: {
        "Gebäude (L × T) m": `${(Math.round(L * 10) / 10).toString().replace(".", ",")} × ${(Math.round(D * 10) / 10).toString().replace(".", ",")}`,
        "Geschosse über Terrain": floors, "Geschossfläche oberirdisch m2": gf, "Wohnungen": unitCount, "Wohnfläche total m2": spaces.reduce((t, x) => t + x, 0),
        "Wohnungen pro Geschoss": units, "Lift": hasLift ? "ja" : "nein",
        "Untergeschoss": garage ? `Tiefgarage, ca. ${stalls} Parkplätze` : "Keller", "Rampe": ramp ? `${String(ramp.length).replace(".", ",")} m, ${ramp.slope} % Gefälle` : null,
        "Erdgeschoss Höhe über Adresspunkt m": zEG,
      },
    };
  }

  /* Bilineare Interpolation im Höhenraster {x0,y0,dx,dy,nx,ny,z[]} (z relativ zum Ursprung) */
  function terrainFromGrid(g) {
    return (x, y) => {
      const fx = Math.max(0, Math.min(g.nx - 1.001, (x - g.x0) / g.dx)), fy = Math.max(0, Math.min(g.ny - 1.001, (y - g.y0) / g.dy));
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, Z = (a, b) => g.z[b * g.nx + a];
      return (Z(i, j) * (1 - tx) + Z(i + 1, j) * tx) * (1 - ty) + (Z(i, j + 1) * (1 - tx) + Z(i + 1, j + 1) * tx) * ty;
    };
  }

  global.makeDesign = makeDesign;
  global.terrainFromGrid = terrainFromGrid;
})(typeof window !== "undefined" ? window : globalThis);
