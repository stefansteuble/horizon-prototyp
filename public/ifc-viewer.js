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
  IFCBUILDINGELEMENTPROXY: "Bauvolumen",
};
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
      <div class="iv-stage">
        <canvas class="iv-canvas" aria-label="3D-Vorschau des IFC-Modells"></canvas>
        <div class="iv-load">IFC-Modell wird geladen …</div>
        <div class="iv-tools">
          <button type="button" data-act="fit" title="Ganzes Modell zeigen" aria-label="Ganzes Modell zeigen">⤢</button>
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
  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  const loop = () => { if (disposed) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();

  function fit() {
    if (!modelGroup) return;
    const box = new THREE.Box3().setFromObject(modelGroup), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.9 + 5;
    controls.target.copy(c);
    camera.position.set(c.x - r * 0.9, c.y + r * 0.85, c.z + r * 1.1);
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
    a.StreamAllMeshes(modelID, mesh => {
      const pgs = mesh.geometries;
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
        m.userData.expressID = mesh.expressID;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x3a2a1e, transparent: true, opacity: 0.55 }));
        edges.applyMatrix4(m.matrix);
        modelGroup.add(m, edges);
        if (!meshesById.has(mesh.expressID)) meshesById.set(mesh.expressID, []);
        meshesById.get(mesh.expressID).push(m);
      }
    });
    scene.add(modelGroup);
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
    const hit = ray.intersectObjects(modelGroup.children.filter(o => o.isMesh), false)[0];
    if (hit) select(hit.object.userData.expressID);
  });
  treeEl.addEventListener("click", e => { const li = e.target.closest("[data-id]"); if (li) select(+li.dataset.id); });
  host.querySelector(".iv-tools").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.act === "fit") fit();
    if (b.dataset.act === "full") { const el = host.querySelector(".iv"); (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.())?.catch?.(() => {}); }
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
