// Worker: liefert die statischen Dateien aus public/ und beantwortet /api/lead.
import { handleLead } from "./lead.js";
import { handleExtras } from "./extras.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      // Zeigt nur, ob Ziele konfiguriert sind, nie die Werte selbst.
      return Response.json({
        ok: true,
        version: "2026-11-02-extras",
        email: !!(env.RESEND_API_KEY && env.LEAD_EMAIL_TO),
        webhook: !!env.LEAD_WEBHOOK_URL,
        kv: !!env.LEADS,
      }, { headers: { "cache-control": "no-store" } });
    }
    if (/^\/api\/(oereb|oev|umgebung|lwz)$/.test(url.pathname)) return handleExtras(request, env, ctx);
    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      }
      return handleLead(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
