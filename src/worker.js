// Worker: liefert die statischen Dateien aus public/ und beantwortet /api/lead.
import { handleLead } from "./lead.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      }
      return handleLead(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
