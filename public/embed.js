/* Grundstück-Check: Einbettung für Webflow und andere Seiten.
   Verwendung: <div data-grundstueck-check></div>
               <script src="https://DEINE-DOMAIN/embed.js" defer></script> */
(function () {
  var script = document.currentScript;
  var base = script ? new URL(script.src).origin : "";
  document.querySelectorAll("[data-grundstueck-check]").forEach(function (box) {
    if (box.dataset.loaded) return;
    box.dataset.loaded = "1";
    var f = document.createElement("iframe");
    f.src = base + "/";
    f.title = "Grundstück-Potenzial-Check";
    f.loading = "lazy";
    f.style.cssText = "width:100%;border:0;display:block;min-height:900px;overflow:hidden";
    f.setAttribute("scrolling", "no");
    box.appendChild(f);
    window.addEventListener("message", function (e) {
      if (e.origin !== base || e.source !== f.contentWindow || !e.data) return;
      if (e.data.type === "grundstueck-check:height") f.style.height = e.data.height + "px";
      if (e.data.type === "grundstueck-check:scroll") box.scrollIntoView({ behavior: "smooth", block: "start" });
      if (e.data.type === "grundstueck-check:lead") {
        // Optional: Conversion-Tracking, z.B. gtag("event", "generate_lead", { value: e.data.score })
        box.dispatchEvent(new CustomEvent("grundstueck-check:lead", { detail: e.data, bubbles: true }));
      }
    });
  });
})();
