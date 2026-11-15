/* IFC-Vorschau im Browser: liest die erzeugte IFC-Datei mit web-ifc (WebAssembly) und zeigt sie mit three.js.
   Angezeigt wird also genau die Datei, die man herunterlädt. Wird erst beim Klick auf "Vorschau" geladen. */
import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";
import * as WEBIFC from "/vendor/web-ifc-api.js";

let api = null;
async function getApi() {
  if (api) return api;
  const a = new WEBIFC.IfcAPI();
  a.SetWasmPath("/vendor/", true);
  await a.Init();
  api = a;
  return a;
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TYPE_DE = {
  IFCPROJECT: "Projekt", IFCSITE: "Parzelle", IFCBUILDING: "Gebäude", IFCBUILDINGSTOREY: "Geschoss",
  IFCBUILDINGELEMENTPROXY: "Bauvolumen", IFCWALL: "Wand", IFCSLAB: "Platte", IFCSPACE: "Raum", IFCRAILING: "Geländer",
  IFCRAMP: "Rampe", IFCGEOGRAPHICELEMENT: "Gelände",
};
/* Ebenen zum Ein- und Ausblenden */
const CATS = [
  ["terrain", "Gelände"], ["volume", "Bauvolumen"], ["walls", "Wände"], ["slabs", "Decken und Dach"],
  ["spaces", "Räume"], ["balcony", "Balkone"], ["ramp", "Rampe"],
];
function catOf(type, objectType) {
  if (type === "IFCGEOGRAPHICELEMENT") return "terrain";
  if (type === "IFCWALL") return "walls";
  if (type === "IFCSPACE") return "spaces";
  if (type === "IFCRAILING") return "balcony";
  if (type === "IFCRAMP") return "ramp";
  if (type === "IFCSLAB") return /balkon|sitzplatz/i.test(objectType || "") ? "balcony" : "slabs";
  if (type === "IFCBUILDINGELEMENTPROXY") return "volume";
  return "other";
}
const val = v => {
  if (v == null) return "–";
  if (typeof v === "object" && "value" in v) v = v.value;
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("de-CH") : (Math.round(v * 100) / 100).toLocaleString("de-CH");
  return String(v);
};

/**
 * Öffnet die Vorschau im Element host.
 * opts: { ifcText, fileName, onDownload }
 * Rückgabe: { update(ifcText), dispose() }
 */
export async function mountIfcViewer(host, opts) {
  host.innerHTML = `
    <div class="iv">
      <div class="iv-bar">
        <div class="iv-layers" role="group" aria-label="Ebenen"></div>
        <label class="iv-floor">Geschoss <select aria-label="Geschoss anzeigen"><option value="all">Alle</option></select></label>
      </div>
      <div class="iv-stage">
        <canvas class="iv-canvas" aria-label="3D-Vorschau des IFC-Modells"></canvas>
        <div class="iv-load">IFC-Modell wird geladen …</div>
        <div class="iv-tools">
          <button type="button" data-act="fit" title="Ganzes Modell zeigen" aria-label="Ganzes Modell zeigen">⤢</button>
          <button type="button" data-act="top" title="Draufsicht (Grundriss)" aria-label="Draufsicht">⊡</button>
          <button type="button" data-act="full" title="Vollbild" aria-label="Vollbild">⛶</button>
        </div>
        <div class="iv-hint">Ziehen dreht · Scrollen zoomt · Klick wählt ein Element</div>
      </div>
      <aside class="iv-side">
        <div class="iv-h">Modellstruktur</div>
        <ul class="iv-tree" role="tree"></ul>
        <div class="iv-h">Eigenschaften</div>
        <div class="iv-props"><p class="iv-muted">Element im Modell oder in der Struktur anklicken.</p></div>
      </aside>
    </div>`;
  const canvas = host.querySelector(".iv-canvas"), stage = host.querySelector(".iv-stage");
  const load = host.querySelector(".iv-load"), treeEl = host.querySelector(".iv-tree"), propsEl = host.querySelector(".iv-props");

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(css("--paper") || "#F2F4F1");
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2bc, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-40, 80, 60); scene.add(sun);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;

  let modelGroup = null, modelID = null, meshesById = new Map(), selected = null, raf = 0, disposed = false;
  const hidden = new Set(), layersEl = host.querySelector(".iv-layers"), floorSel = host.querySelector(".iv-floor select");
  let storeyElev = new Map(), floorLimit = null;   // expressID -> Elevation des Geschosses
  function labelSprite(text, sub) {
    const c = document.createElement("canvas"), g = c.getContext("2d"), dpr = 2;
    g.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    const w1 = g.measureText(text).width; g.font = `${11 * dpr}px system-ui, sans-serif`; const w2 = sub ? g.measureText(sub).width : 0;
    c.width = Math.ceil(Math.max(w1, w2) + 12 * dpr); c.height = (sub ? 34 : 20) * dpr;
    g.fillStyle = "rgba(255,255,255,.86)"; g.beginPath(); g.roundRect(0, 0, c.width, c.height, 6 * dpr); g.fill();
    g.fillStyle = "#18221E"; g.font = `600 ${12 * dpr}px system-ui, sans-serif`; g.textBaseline = "top"; g.fillText(text, 6 * dpr, 4 * dpr);
    if (sub) { g.fillStyle = "#5B6862"; g.font = `${11 * dpr}px system-ui, sans-serif`; g.fillText(sub, 6 * dpr, 19 * dpr); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.userData.px = [c.width / dpr, c.height / dpr]; sp.renderOrder = 10;
    return sp;
  }
  function addSpaceLabels(a) {
    const byId = new Map();
    modelGroup.children.forEach(o => { if (o.isMesh && o.userData.cat === "spaces") { if (!byId.has(o.userData.expressID)) byId.set(o.userData.expressID, []); byId.get(o.userData.expressID).push(o); } });
    for (const [id, ms] of byId) {
      const line = a.GetLine(modelID, id), ln = line.LongName?.value || line.Name?.value || "";
      const [t, ...rest] = ln.replace(/ca\. /g, "").replace(/ Zimmer/g, " Zi.").replace(/Treppenhaus und Lift/, "Treppe/Lift").split(" · ");
      const box = new THREE.Box3(); ms.forEach(m => box.expandByObject(m));
      const sp = labelSprite(t, rest.join(" · "));
      sp.position.copy(box.getCenter(new THREE.Vector3())); sp.position.y = box.max.y + 0.2;
      sp.userData = { ...sp.userData, cat: "labels", elev: ms[0].userData.elev, label: true };
      modelGroup.add(sp);
    }
  }
  function applyVisibility() {
    if (!modelGroup) return;
    modelGroup.children.forEach(o => {
      const u = o.userData;
      let v = !hidden.has(u.cat);
      if (v && floorLimit != null && u.elev != null && u.elev > floorLimit + 0.01) v = false;
      if (u.label) v = floorLimit != null && !hidden.has("spaces") && Math.abs(u.elev - floorLimit) < 0.01;
      o.visible = v;
    });
  }
  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  const loop = () => {
    if (disposed) return; controls.update();
    // Beschriftungen in konstanter Bildschirmgrösse
    if (modelGroup) { const hPx = stage.clientHeight || 400; modelGroup.children.forEach(o => { if (o.userData.label && o.visible) {
      const dist = camera.position.distanceTo(o.position), k = 2 * Math.tan(camera.fov * Math.PI / 360) * dist / hPx;
      o.scale.set(o.userData.px[0] * k, o.userData.px[1] * k, 1); } }); }
    renderer.render(scene, camera); raf = requestAnimationFrame(loop);
  };
  loop();

  // Gebäude als Bezug für Kamera (ohne Gelände), sonst ganzes Modell
  function focusBox() {
    const box = new THREE.Box3();
    modelGroup.children.forEach(o => { if (o.isMesh && o.visible && o.userData.cat !== "terrain") box.expandByObject(o); });
    return box.isEmpty() ? new THREE.Box3().setFromObject(modelGroup) : box;
  }
  function fit() {
    if (!modelGroup) return;
    const box = focusBox(), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.9 + 5;
    controls.target.copy(c);
    camera.position.set(c.x - r * 0.9, c.y + r * 0.85, c.z + r * 1.1);
    camera.near = r / 100; camera.far = r * 50; camera.updateProjectionMatrix();
  }
  function top() {
    if (!modelGroup) return;
    const box = focusBox(), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.z) * 1.15 + 6;
    controls.target.copy(c);
    camera.position.set(c.x, c.y + r * 1.6, c.z + 0.01);
    camera.near = r / 100; camera.far = r * 50; camera.updateProjectionMatrix();
  }

  function highlight(id) {
    if (selected) selected.forEach(m => { m.material.emissive?.setHex(0x000000); });
    selected = meshesById.get(id) || null;
    if (selected) selected.forEach(m => m.material.emissive?.setHex(0x553311));
    treeEl.querySelectorAll("[data-id]").forEach(li => li.classList.toggle("on", +li.dataset.id === id));
  }

  async function showProps(id) {
    const a = await getApi();
    const line = a.GetLine(modelID, id);
    const type = a.GetNameFromTypeCode(line.type).toUpperCase();
    let html = `<div class="iv-pt"><b>${esc(val(line.Name) !== "–" ? val(line.Name) : TYPE_DE[type] || type)}</b><span>${esc(a.GetNameFromTypeCode(line.type))}</span></div>`;
    if (line.Description?.value) html += `<p class="iv-muted">${esc(line.Description.value)}</p>`;
    const sets = await a.properties.getPropertySets(modelID, id, true);
    for (const ps of sets) {
      const rows = [];
      (ps.HasProperties || []).forEach(p => rows.push([val(p.Name), val(p.NominalValue)]));
      (ps.Quantities || []).forEach(q => {
        const v = q.AreaValue ?? q.VolumeValue ?? q.LengthValue ?? q.CountValue;
        const unit = q.AreaValue != null ? " m²" : q.VolumeValue != null ? " m³" : q.LengthValue != null ? " m" : "";
        rows.push([val(q.Description) !== "–" ? val(q.Description) : val(q.Name), val(v) + unit]);
      });
      if (!rows.length) continue;
      html += `<div class="iv-ps">${esc(val(ps.Name))}</div><dl class="iv-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    }
    propsEl.innerHTML = html;
  }

  async function select(id) { highlight(id); await showProps(id); }

  function buildTree(node, depth = 0) {
    const type = String(node.type || "").toUpperCase();
    const name = node.Name?.value || TYPE_DE[type] || type;
    const label = TYPE_DE[type] || type;
    const li = `<li role="treeitem" data-id="${node.expressID}" style="padding-left:${depth * 14}px">${name === label ? esc(label) : `<span class="iv-tt">${esc(label)}</span>${esc(name)}`}</li>`;
    return li + (node.children || []).map(c => buildTree(c, depth + 1)).join("");
  }

  async function loadModel(ifcText) {
    load.hidden = false; load.textContent = "IFC-Modell wird geladen …";
    const a = await getApi();
    if (modelID != null) { a.CloseModel(modelID); modelID = null; }
    if (modelGroup) { scene.remove(modelGroup); modelGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
    meshesById = new Map(); selected = null;
    modelID = a.OpenModel(new TextEncoder().encode(ifcText), { COORDINATE_TO_ORIGIN: true });
    modelGroup = new THREE.Group();
    // Geschosse und ihre Elemente aus der Modellstruktur
    const tree0 = await a.properties.getSpatialStructure(modelID, false);
    storeyElev = new Map();
    const storeys = [];
    const walk = (n, elev) => {
      let e = elev;
      if (String(n.type).toUpperCase() === "IFCBUILDINGSTOREY") { const st = a.GetLine(modelID, n.expressID); e = st.Elevation?.value ?? 0; storeys.push([e, st.Name?.value || "Geschoss"]); }
      if (e != null) storeyElev.set(n.expressID, e);
      (n.children || []).forEach(c => walk(c, e));
    };
    walk(tree0, null);
    const onMesh = mesh => {
      const pgs = mesh.geometries;
      const line = a.GetLine(modelID, mesh.expressID);
      const cat = catOf(a.GetNameFromTypeCode(line.type).toUpperCase(), line.ObjectType?.value);
      const elev = storeyElev.has(mesh.expressID) ? storeyElev.get(mesh.expressID) : null;
      for (let i = 0; i < pgs.size(); i++) {
        const pg = pgs.get(i), g = a.GetGeometry(modelID, pg.geometryExpressID);
        const v = a.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const idx = a.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
        const geo = new THREE.BufferGeometry();
        const buf = new THREE.InterleavedBuffer(new Float32Array(v), 6);
        geo.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
        geo.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        g.delete();
        const c = pg.color, transparent = c.w < 0.99;
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(c.x, c.y, c.z), transparent, opacity: c.w, side: THREE.DoubleSide, depthWrite: !transparent });
        const m = new THREE.Mesh(geo, mat);
        m.applyMatrix4(new THREE.Matrix4().fromArray(pg.flatTransformation));
        m.userData = { expressID: mesh.expressID, cat, elev };
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x3a2a1e, transparent: true, opacity: 0.55 }));
        edges.applyMatrix4(m.matrix);
        edges.userData = { cat, elev };
        modelGroup.add(m, edges);
        if (!meshesById.has(mesh.expressID)) meshesById.set(mesh.expressID, []);
        meshesById.get(mesh.expressID).push(m);
      }
    };
    a.StreamAllMeshes(modelID, onMesh);
    // Räume (IfcSpace) streamt web-ifc nicht standardmässig: gezielt dazuladen
    try { a.StreamAllMeshesWithTypes(modelID, [WEBIFC.IFCSPACE], onMesh); } catch (e) { console.warn("Räume nicht geladen", e); }
    addSpaceLabels(a);
    scene.add(modelGroup);
    // Ebenen-Schalter für vorhandene Kategorien, Geschossauswahl
    const present = new Set(modelGroup.children.map(o => o.userData.cat));
    layersEl.innerHTML = CATS.filter(([k]) => present.has(k)).map(([k, l]) =>
      `<label class="iv-chip"><input type="checkbox" data-cat="${k}" ${hidden.has(k) ? "" : "checked"}>${esc(l)}</label>`).join("");
    const prevFloor = floorSel.value;
    storeys.sort((x, y) => x[0] - y[0]);
    floorSel.innerHTML = `<option value="all">Alle</option>` + storeys.map(([e, nm]) => `<option value="${e}">${esc(nm)}</option>`).join("");
    if ([...floorSel.options].some(o => o.value === prevFloor)) floorSel.value = prevFloor;
    floorSel.closest(".iv-floor").hidden = storeys.length < 2;
    floorLimit = floorSel.value === "all" ? null : +floorSel.value;
    applyVisibility();
    const tree = await a.properties.getSpatialStructure(modelID, true);
    treeEl.innerHTML = buildTree(tree);
    load.hidden = true;
    fit();
    const bld = a.GetLineIDsWithType(modelID, WEBIFC.IFCBUILDING);
    if (bld.size()) await select(bld.get(0));
  }

  // Auswahl per Klick (nur ohne Ziehen)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  canvas.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !modelGroup) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(modelGroup.children.filter(o => o.isMesh && o.visible && o.userData.cat !== "terrain"), false)[0];
    if (hit) select(hit.object.userData.expressID);
  });
  treeEl.addEventListener("click", e => { const li = e.target.closest("[data-id]"); if (li) select(+li.dataset.id); });
  host.querySelector(".iv-tools").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.act === "fit") fit();
    if (b.dataset.act === "top") top();
    if (b.dataset.act === "full") { const el = host.querySelector(".iv"); (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.())?.catch?.(() => {}); }
  });

  layersEl.addEventListener("change", e => {
    const cb = e.target.closest("[data-cat]"); if (!cb) return;
    cb.checked ? hidden.delete(cb.dataset.cat) : hidden.add(cb.dataset.cat);
    applyVisibility();
  });
  floorSel.addEventListener("change", () => {
    floorLimit = floorSel.value === "all" ? null : +floorSel.value;
    applyVisibility();
    floorLimit == null ? fit() : top();   // einzelnes Geschoss: Grundriss von oben
  });

  try { await loadModel(opts.ifcText); }
  catch (e) { load.hidden = false; load.textContent = "Die Vorschau konnte nicht geladen werden. Der Download funktioniert trotzdem."; console.error(e); }

  return {
    update: t => loadModel(t).catch(e => { load.hidden = false; load.textContent = "Aktualisierung fehlgeschlagen."; console.error(e); }),
    dispose() {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      if (modelID != null && api) api.CloseModel(modelID);
      renderer.dispose(); host.innerHTML = "";
    },
  };
}
