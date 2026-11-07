// Edge Function : envoi par e-mail du rapport journalier signé par le client.
// Appelée par l'application juste après la signature.
import { createClient } from "npm:@supabase/supabase-js@2";

// Clé serveur : variable historique, ou nouvelle clé secrète (sb_secret_…) selon le projet
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return k.default ?? Object.values(k)[0]; } catch { return ""; }
}


const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const fmtT = (v: string | null) =>
  v ? new Date(v).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }) : "-";
const hrs = (a: string | null, b: string | null) =>
  a && b ? ((new Date(b).getTime() - new Date(a).getTime()) / 3600000).toFixed(2) : "-";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function toBase64(buf: ArrayBuffer) {
  // Encodage par blocs de 32 Ko (rapide, compatible limite CPU des Edge Functions)
  const b = new Uint8Array(buf); const parts: string[] = [];
  for (let i = 0; i < b.length; i += 0x8000) parts.push(String.fromCharCode(...b.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(),
      { auth: { persistSession: false } });
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "Non authentifié" }, 401);

    const { report_id } = await req.json();
    const { data: rep } = await admin.from("day_reports").select("*").eq("id", report_id).single();
    if (!rep) return json({ error: "Rapport introuvable" }, 404);
    const { data: m } = await admin.from("missions").select("*, clients(name)").eq("id", rep.mission_id).single();
    if (m.team_leader_id !== caller.user.id) {
      const { data: me } = await admin.from("profiles").select("role").eq("id", caller.user.id).single();
      if (!me || !["admin", "rh"].includes(me.role)) return json({ error: "Accès refusé" }, 403);
    }
    const { data: entries } = await admin.from("time_entries").select("*, profiles(full_name)")
      .eq("mission_id", rep.mission_id).eq("work_date", rep.work_date);
    const { data: settings } = await admin.from("settings").select("*").eq("id", 1).single();
    const { data: leader } = await admin.from("profiles").select("full_name").eq("id", rep.leader_id).single();
    const to = settings?.report_email;
    if (!to) return json({ error: "Adresse e-mail de rapport non définie dans Paramètres" }, 400);

    const rows = (entries ?? []).map((e: any) => `<tr>
      <td>${esc(e.profiles?.full_name)}</td><td>${fmtT(e.workshop_arrival)}</td><td>${fmtT(e.site_arrival)}</td>
      <td>${fmtT(e.site_end)}</td><td>${hrs(e.site_arrival, e.site_end)}</td><td>${hrs(e.workshop_arrival, e.site_end)}</td></tr>
      ${e.note || e.technical_note || e.exclusion_note ? `<tr><td colspan="6" style="font-size:12px;color:#555">
        ${e.note ? `<b>Note :</b> ${esc(e.note)}<br>` : ""}${e.technical_note ? `<b>Remarque technique :</b> ${esc(e.technical_note)}<br>` : ""}
        ${e.exclusion_note ? `<b>Exclusion :</b> ${esc(e.exclusion_note)}` : ""}</td></tr>` : ""}`).join("");

    const html = `<div style="font-family:Arial,sans-serif;color:#222">
      <div style="background:#3D3836;color:#fff;padding:14px 18px"><b style="color:#95C11F;font-size:18px">MONSIEUR MARÉCHAL</b>
      <div>Rapport de prestation du ${new Date(rep.work_date).toLocaleDateString("fr-BE")}</div></div>
      <p><b>Chantier :</b> ${esc(m.title)} (#${m.id})<br><b>Client :</b> ${esc(m.clients?.name ?? "")}<br>
      <b>Adresse :</b> ${esc(m.address)}<br><b>Chef d'équipe :</b> ${esc(leader?.full_name)}</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:13px" border="1">
      <tr style="background:#95C11F;color:#fff"><th>Collaborateur</th><th>Arrivée atelier</th><th>Arrivée chantier</th>
      <th>Fin chantier</th><th>H. chantier</th><th>H. totales</th></tr>${rows}</table>
      <p><b>Accord client :</b> ${esc(rep.client_name)}, signé le ${new Date(rep.signed_at).toLocaleString("fr-BE", { timeZone: "Europe/Brussels" })}.<br>
      Signature en pièce jointe.</p></div>`;

    const attachments: any[] = [];
    const { data: sig } = await admin.storage.from("signatures").download(rep.signature_path);
    if (sig) attachments.push({ filename: "signature-client.png", content: toBase64(await sig.arrayBuffer()) });

    // Photos de réalisation de la journée (max 20, ~8 Mo au total)
    const { data: photos } = await admin.from("mission_photos").select("path, caption")
      .eq("mission_id", rep.mission_id).eq("work_date", rep.work_date).order("created_at").limit(20);
    let total = 0, n = 0;
    for (const p of photos ?? []) {
      const { data: img } = await admin.storage.from("mission-photos").download(p.path);
      if (!img) continue;
      const buf = await img.arrayBuffer();
      if (total + buf.byteLength > 8_000_000) break;
      total += buf.byteLength; n++;
      const label = (p.caption ?? "").normalize("NFD").replace(/[^\w-]+/g, "_").slice(0, 40);
      attachments.push({ filename: `photo-${String(n).padStart(2, "0")}${label ? "-" + label : ""}.jpg`, content: toBase64(buf) });
    }
    const photoNote = (photos?.length ?? 0)
      ? `<p><b>Photos de réalisation :</b> ${n} jointe(s)${(photos?.length ?? 0) > n ? ` sur ${photos!.length} (les autres sont consultables dans l'application)` : ""}.</p>`
      : "";

    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ error: "RESEND_API_KEY non configurée" }, 500);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("MAIL_FROM") ?? "Monsieur Maréchal <onboarding@resend.dev>",
        to: [to], subject: `Rapport chantier #${m.id} ${m.title} - ${rep.work_date}`,
        html: html + photoNote, attachments,
      }),
    });
    if (!r.ok) return json({ error: await r.text() }, 502);
    await admin.from("day_reports").update({ emailed: true }).eq("id", rep.id);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
