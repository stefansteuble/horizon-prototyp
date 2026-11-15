/* IFC4-Export des simulierten Bauvolumens (BIM).
   Erzeugt eine georeferenzierte IFC-Datei (CH1903+/LV95, EPSG:2056) mit
   - IfcSite: Parzelle als Fläche (dünne Platte) und Umriss
   - IfcBuilding mit einem IfcBuildingStorey pro Geschoss
   - pro Geschoss ein Bauvolumen (IfcBuildingElementProxy) mit Geschossfläche als Mengenangabe
   - Kennzahlen der Simulation als Eigenschaftssatz (Pset) am Gebäude
   Koordinaten im Modell sind lokal (Meter) relativ zum Adresspunkt; IfcMapConversion verschiebt sie nach LV95. */
(function (global) {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

  function guid() {
    const r = new Uint8Array(22);
    (global.crypto || require("crypto").webcrypto).getRandomValues(r);
    let s = ALPHABET[r[0] % 4];
    for (let i = 1; i < 22; i++) s += ALPHABET[r[i] % 64];
    return s;
  }

  // STEP-Text: Apostroph verdoppeln, Nicht-ASCII als \X2\hhhh\X0\
  function str(v) {
    if (v == null || v === "") return "$";
    let out = "";
    for (const ch of String(v)) {
      const c = ch.codePointAt(0);
      if (ch === "'") out += "''";
      else if (ch === "\\") out += "\\\\";
      else if (c >= 32 && c < 127) out += ch;
      else if (c <= 0xffff) out += "\\X2\\" + c.toString(16).toUpperCase().padStart(4, "0") + "\\X0\\";
    }
    return `'${out}'`;
  }
  function real(n) {
    let s = (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/0+$/, "");
    if (s.endsWith(".")) return s;
    return s.includes(".") ? s : s + ".";
  }

  function closeRing(r) {
    const a = r.slice();
    if (a.length > 1) { const f = a[0], l = a[a.length - 1]; if (f[0] === l[0] && f[1] === l[1]) a.pop(); }
    return a;
  }
  function area(r) { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); }

  function toDms(deg) {
    const s = Math.sign(deg) || 1, a = Math.abs(deg);
    const d = Math.floor(a), m = Math.floor((a - d) * 60), secf = ((a - d) * 60 - m) * 60, sec = Math.floor(secf), mic = Math.round((secf - sec) * 1e6);
    return `(${s * d},${s * m},${s * sec},${s * mic})`;
  }

  /**
   * opts: {
   *   projectName, siteName, buildingName, egrid, parzelle, gemeinde, kanton, address,
   *   e, n, h,                 // LV95-Koordinaten des Ursprungs und Geländehöhe (m ü. M.)
   *   lat, lon,                // WGS84 des Ursprungs (für IfcSite)
   *   parcel: [[x,y],...],     // Parzellenumriss, lokal in Metern
   *   footprint: [[x,y],...],  // Grundriss des Bauvolumens, lokal in Metern
   *   floors, floorHeight,
   *   props: {Name: Wert}      // Kennzahlen für den Eigenschaftssatz
   * }
   */
  function buildIfc(o) {
    const L = [];
    let id = 0;
    const add = s => { L.push(`#${++id}=${s};`); return `#${id}`; };
    const pts2 = r => r.map(([x, y]) => add(`IFCCARTESIANPOINT((${real(x)},${real(y)}))`));

    // Einheiten und Kontext
    const uLen = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    const uArea = add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
    const uVol = add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
    const uAng = add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");
    const units = add(`IFCUNITASSIGNMENT((${uLen},${uArea},${uVol},${uAng}))`);
    const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
    const dz = add("IFCDIRECTION((0.,0.,1.))");
    const dx = add("IFCDIRECTION((1.,0.,0.))");
    const wcs = add(`IFCAXIS2PLACEMENT3D(${origin},${dz},${dx})`);
    const north = add("IFCDIRECTION((0.,1.))");
    const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${wcs},${north})`);
    const ctxBody = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
    const ctxFoot = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('FootPrint','Model',*,*,*,*,${ctx},$,.PLAN_VIEW.,$)`);
    const project = add(`IFCPROJECT('${guid()}',$,${str(o.projectName)},${str("Bebauungssimulation, unverbindliche Schätzung")},$,$,$,(${ctx}),${units})`);

    // Georeferenzierung: lokales System -> LV95
    const crs = add(`IFCPROJECTEDCRS('EPSG:2056',${str("CH1903+ / LV95")},'CH1903+','LN02',${str("Swiss Oblique Mercator")},$,${uLen})`);
    add(`IFCMAPCONVERSION(${ctx},${crs},${real(o.e)},${real(o.n)},${real(o.h || 0)},1.,0.,1.)`);

    // Platzierungen
    const sitePl = add(`IFCLOCALPLACEMENT($,${wcs})`);
    const bldAx = add(`IFCAXIS2PLACEMENT3D(${origin},${dz},${dx})`);
    const bldPl = add(`IFCLOCALPLACEMENT(${sitePl},${bldAx})`);

    // Darstellungsstile
    const style = (name, r, g, b, t) => {
      const c = add(`IFCCOLOURRGB($,${real(r)},${real(g)},${real(b)})`);
      const sh = add(`IFCSURFACESTYLESHADING(${c},${real(t)})`);
      return add(`IFCSURFACESTYLE(${str(name)},.BOTH.,(${sh}))`);
    };
    const stVol = style("Bauvolumen (Simulation)", 0.94, 0.54, 0.29, 0.35);
    const stSite = style("Parzelle", 0.18, 0.83, 0.54, 0.5);

    const extrude = (ring, depth, z) => {
      const ps = pts2(closeRing(ring));
      const poly = add(`IFCPOLYLINE((${ps.concat(ps[0]).join(",")}))`);
      const prof = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${poly})`);
      const p0 = add(`IFCCARTESIANPOINT((0.,0.,${real(z)}))`);
      const ax = add(`IFCAXIS2PLACEMENT3D(${p0},${dz},${dx})`);
      return add(`IFCEXTRUDEDAREASOLID(${prof},${ax},${dz},${real(depth)})`);
    };

    const latlon = o.lat != null && o.lon != null ? `${toDms(o.lat)},${toDms(o.lon)}` : "$,$";
    const parcel = closeRing(o.parcel);
    const fp = pts2(parcel);
    const fpPoly = add(`IFCPOLYLINE((${fp.concat(fp[0]).join(",")}))`);
    const siteFoot = add(`IFCSHAPEREPRESENTATION(${ctxFoot},'FootPrint','Curve2D',(${fpPoly}))`);
    const D = o.design;
    let siteShape;
    if (D) siteShape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${siteFoot}))`);
    else {
      const siteSolid = extrude(parcel, 0.05, -0.05);
      add(`IFCSTYLEDITEM(${siteSolid},(${stSite}),$)`);
      const siteBody = add(`IFCSHAPEREPRESENTATION(${ctxBody},'Body','SweptSolid',(${siteSolid}))`);
      siteShape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${siteFoot},${siteBody}))`);
    }
    const site = add(`IFCSITE('${guid()}',$,${str(o.siteName)},${str(o.address)},$,${sitePl},${siteShape},$,.ELEMENT.,${latlon},${real(o.h || 0)},${str(o.egrid)},$)`);

    const building = add(`IFCBUILDING('${guid()}',$,${str(o.buildingName)},${str(D ? "Schemaprojekt gemäss Simulation, keine Planung" : "Mögliches Bauvolumen gemäss Simulation")},$,${bldPl},$,$,.ELEMENT.,${real(o.h || 0)},${real(o.h || 0)},$)`);
    add(`IFCRELAGGREGATES('${guid()}',$,$,$,${project},(${site}))`);
    add(`IFCRELAGGREGATES('${guid()}',$,$,$,${site},(${building}))`);

    const psetOf = (objs, name, desc, props) => {
      const ps = Object.entries(props || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) =>
        add(typeof v === "number" ? `IFCPROPERTYSINGLEVALUE(${str(k)},$,IFCREAL(${real(v)}),$)`
          : `IFCPROPERTYSINGLEVALUE(${str(k)},$,IFCLABEL(${str(String(v).slice(0, 250))}),$)`));
      if (!ps.length) return;
      const set = add(`IFCPROPERTYSET('${guid()}',$,${str(name)},${str(desc)},(${ps.join(",")}))`);
      add(`IFCRELDEFINESBYPROPERTIES('${guid()}',$,$,$,(${objs.join(",")}),${set})`);
    };

    if (D) {
      // ---------- Schemaprojekt: Geschosse, Wände, Decken, Räume, Balkone, Rampe, Gelände ----------
      const STY = { wall: [0.94, 0.93, 0.9, 0], wallInt: [0.86, 0.85, 0.82, 0], slab: [0.74, 0.74, 0.72, 0], roof: [0.56, 0.58, 0.6, 0],
        unit: [0.55, 0.73, 0.93, 0.6], core: [0.98, 0.83, 0.38, 0.5], parking: [0.62, 0.68, 0.78, 0.6], cellar: [0.72, 0.72, 0.72, 0.6],
        balcony: [0.84, 0.82, 0.78, 0], railing: [0.36, 0.43, 0.5, 0.35], ramp: [0.47, 0.47, 0.49, 0], terrain: [0.82, 0.87, 0.76, 0],
        boundary: [0.18, 0.83, 0.54, 0.1] };
      const STN = { wall: "Aussenwand", wallInt: "Innenwand", slab: "Decke", roof: "Dach", unit: "Wohnung", core: "Erschliessung", parking: "Tiefgarage",
        cellar: "Keller", balcony: "Balkon", railing: "Geländer", ramp: "Rampe", terrain: "Gelände", boundary: "Parzellengrenze" };
      const styles = {};
      const styleOf = k => styles[k] || (styles[k] = style(STN[k] || k, ...(STY[k] || [0.8, 0.8, 0.8, 0])));
      const storeyPl = [], storeyIds = [];
      D.storeys.forEach(st => {
        const pz = add(`IFCCARTESIANPOINT((0.,0.,${real(st.elev)}))`);
        const sAx = add(`IFCAXIS2PLACEMENT3D(${pz},${dz},${dx})`);
        const sPl = add(`IFCLOCALPLACEMENT(${bldPl},${sAx})`);
        storeyPl.push(sPl);
        storeyIds.push(add(`IFCBUILDINGSTOREY('${guid()}',$,${str(st.name)},$,$,${sPl},$,$,.ELEMENT.,${real(st.elev)})`));
      });
      add(`IFCRELAGGREGATES('${guid()}',$,$,$,${building},(${storeyIds.join(",")}))`);
      const contained = new Map(), spacesBy = new Map();
      for (const el of D.elements) {
        const items = [];
        let repType = "SweptSolid";
        for (const sh of el.shapes) {
          let it;
          if (sh.type === "mesh") {
            repType = "Tessellation";
            const cl = add(`IFCCARTESIANPOINTLIST3D((${sh.pts.map(p => `(${real(p[0])},${real(p[1])},${real(p[2])})`).join(",")}))`);
            it = add(`IFCTRIANGULATEDFACESET(${cl},$,.F.,(${sh.tris.map(t => `(${t[0] + 1},${t[1] + 1},${t[2] + 1})`).join(",")}),$)`);
          } else it = extrude(sh.poly, sh.depth, sh.z);
          add(`IFCSTYLEDITEM(${it},(${styleOf(el.style)}),$)`);
          items.push(it);
        }
        const rep = add(`IFCSHAPEREPRESENTATION(${ctxBody},'Body','${repType}',(${items.join(",")}))`);
        const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
        const onSite = el.storey === "site";
        const pl = add(`IFCLOCALPLACEMENT(${onSite ? sitePl : storeyPl[el.storey]},${wcs})`);
        const ot = el.objectType ? str(el.objectType) : "$";
        let id;
        if (el.ifc === "IFCSPACE") {
          id = add(`IFCSPACE('${guid()}',$,${str(el.name)},$,${ot},${pl},${shape},${str(el.longName)},.ELEMENT.,.${el.predef}.,$)`);
          if (!spacesBy.has(el.storey)) spacesBy.set(el.storey, []);
          spacesBy.get(el.storey).push(id);
        } else {
          id = add(`${el.ifc}('${guid()}',$,${str(el.name)},$,${ot},${pl},${shape},$,.${el.predef}.)`);
          const key = onSite ? "site" : el.storey;
          if (!contained.has(key)) contained.set(key, []);
          contained.get(key).push(id);
        }
        if (el.props) psetOf([id], "CH_Schemaprojekt", "Schemaprojekt Grundstück-Check", el.props);
      }
      for (const [k, ids] of contained) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${ids.join(",")}),${k === "site" ? site : storeyIds[k]})`);
      for (const [k, ids] of spacesBy) add(`IFCRELAGGREGATES('${guid()}',$,$,$,${storeyIds[k]},(${ids.join(",")}))`);
      if (D.summary) psetOf([building], "CH_Schemaprojekt", "Kennzahlen Schemaprojekt", D.summary);
    } else {
      // Gebäude und Geschosse

      const fh = o.floorHeight || 3, foot = closeRing(o.footprint), fArea = area(foot);
      const storeys = [], qtyTargets = [];
      for (let i = 0; i < o.floors; i++) {
        const pz = add(`IFCCARTESIANPOINT((0.,0.,${real(i * fh)}))`);
        const sAx = add(`IFCAXIS2PLACEMENT3D(${pz},${dz},${dx})`);
        const sPl = add(`IFCLOCALPLACEMENT(${bldPl},${sAx})`);
        const label = i === 0 ? "Erdgeschoss" : `${i}. Obergeschoss`;
        const storey = add(`IFCBUILDINGSTOREY('${guid()}',$,${str(label)},$,$,${sPl},$,$,.ELEMENT.,${real(i * fh)})`);
        storeys.push(storey);

        const ePl = add(`IFCLOCALPLACEMENT(${sPl},${wcs})`);
        const solid = extrude(foot, fh - 0.3, 0.15);
        add(`IFCSTYLEDITEM(${solid},(${stVol}),$)`);
        const rep = add(`IFCSHAPEREPRESENTATION(${ctxBody},'Body','SweptSolid',(${solid}))`);
        const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
        const el = add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,${str(`Bauvolumen ${label}`)},${str("Simuliertes Geschossvolumen")},${str("Bauvolumen")},${ePl},${shape},$,.USERDEFINED.)`);
        add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${el}),${storey})`);
        qtyTargets.push(el);
      }
      if (storeys.length) add(`IFCRELAGGREGATES('${guid()}',$,$,$,${building},(${storeys.join(",")}))`);

      // Mengen pro Geschoss
      if (qtyTargets.length) {
        const qa = add(`IFCQUANTITYAREA('GrossFloorArea',${str("Geschossfläche")},$,${real(fArea)},$)`);
        const qv = add(`IFCQUANTITYVOLUME('GrossVolume',${str("Bruttovolumen")},$,${real(fArea * fh)},$)`);
        const eq = add(`IFCELEMENTQUANTITY('${guid()}',$,'Qto_Bauvolumen',$,$,(${qa},${qv}))`);
        add(`IFCRELDEFINESBYPROPERTIES('${guid()}',$,$,$,(${qtyTargets.join(",")}),${eq})`);
      }
    }

    // Kennzahlen als Eigenschaftssatz
    const props = Object.entries(o.props || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) =>
      add(typeof v === "number"
        ? `IFCPROPERTYSINGLEVALUE(${str(k)},$,IFCREAL(${real(v)}),$)`
        : `IFCPROPERTYSINGLEVALUE(${str(k)},$,IFCLABEL(${str(String(v).slice(0, 250))}),$)`));
    if (props.length) {
      const ps = add(`IFCPROPERTYSET('${guid()}',$,'CH_Potenzial',${str("Bebauungssimulation Grundstück-Check")},(${props.join(",")}))`);
      add(`IFCRELDEFINESBYPROPERTIES('${guid()}',$,$,$,(${building},${site}),${ps})`);
    }

    const now = new Date().toISOString().slice(0, 19);
    const fname = (o.fileName || "potenzial.ifc").replace(/'/g, "");
    return [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
      `FILE_NAME('${fname}','${now}',('Grundstueck-Check'),('TTMS Schweiz AG'),'','Grundstueck-Check (Prototyp)','');`,
      "FILE_SCHEMA(('IFC4'));",
      "ENDSEC;",
      "DATA;",
      ...L,
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
  }

  global.buildIfc = buildIfc;
})(typeof window !== "undefined" ? window : globalThis);
