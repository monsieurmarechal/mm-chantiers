// Edge Function : sauvegarde complète des données en CSV (archive ZIP).
// Déclenchée chaque semaine par pg_cron (en-tête x-backup-secret) ou à la demande par un administrateur.
// L'archive est rangée dans le stockage privé "backups" (12 dernières semaines) et envoyée par e-mail si possible.
import { createClient } from "npm:@supabase/supabase-js@2";
import { zipSync, strToU8 } from "npm:fflate@0.8.2";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return k.default ?? Object.values(k)[0]; } catch { return ""; }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-backup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Tables exportées (la position GPS n'est pas sauvegardée)
const TABLES = [
  "export_prestations", "profiles", "clients", "tools", "missions", "mission_members", "mission_tools", "mission_files",
  "time_entries", "day_reports", "mission_photos", "leave_types", "leave_requests", "leave_allocations",
  "overtime_adjustments", "settings",
];
const KEEP_DAYS = 84; // 12 semaines

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "﻿";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
}

function toBase64(u8: Uint8Array) {
  const parts: string[] = [];
  for (let i = 0; i < u8.length; i += 0x8000) parts.push(String.fromCharCode(...u8.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

    // Autorisation : secret de la tâche planifiée, ou administrateur connecté
    let source = "manuelle";
    const secret = req.headers.get("x-backup-secret");
    if (secret) {
      const { data: ok } = await admin.rpc("check_backup_secret", { s: secret });
      if (!ok) return json({ error: "Secret invalide" }, 403);
      source = "automatique";
    } else {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Non authentifié" }, 401);
      const { data: me } = await admin.from("profiles").select("role,active").eq("id", caller.user.id).single();
      if (!me?.active || me.role !== "admin") return json({ error: "Réservé à l'administrateur" }, 403);
    }

    // Export de chaque table, par pages de 1000 lignes
    const date = new Date().toISOString().slice(0, 10);
    const files: Record<string, Uint8Array> = {};
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from(t).select("*").range(from, from + 999);
        if (error) throw new Error(`${t} : ${error.message}`);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      counts[t] = rows.length;
      files[`${t}.csv`] = strToU8(toCsv(rows));
    }
    files["LISEZ-MOI.txt"] = strToU8(
      `Sauvegarde Monsieur Maréchal du ${date} (${source}).\r\n` +
      `Fichiers CSV séparés par des points-virgules, encodage UTF-8, ouvrables dans Excel.\r\n` +
      `export_prestations.csv = récapitulatif lisible des pointages.\r\n\r\n` +
      Object.entries(counts).map(([t, n]) => `${t} : ${n} ligne(s)`).join("\r\n"));
    const zip = zipSync(files, { level: 6 });

    // Stockage privé + nettoyage des archives de plus de 12 semaines
    const path = `${date}/sauvegarde-mm-${date}.zip`;
    const up = await admin.storage.from("backups").upload(path, zip, { contentType: "application/zip", upsert: true });
    if (up.error) throw new Error(`Stockage : ${up.error.message}`);
    const { data: folders } = await admin.storage.from("backups").list("", { limit: 1000 });
    const limit = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const f of folders ?? []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.name) && f.name < limit) {
        const { data: inner } = await admin.storage.from("backups").list(f.name);
        if (inner?.length) await admin.storage.from("backups").remove(inner.map((x) => `${f.name}/${x.name}`));
      }
    }

    // Envoi par e-mail (si Resend configuré et archive < 30 Mo)
    let emailed = false, mailError: string | undefined;
    const key = Deno.env.get("RESEND_API_KEY");
    const { data: settings } = await admin.from("settings").select("report_email").eq("id", 1).single();
    if (key && settings?.report_email && zip.length < 30_000_000) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("MAIL_FROM") ?? "Monsieur Maréchal <onboarding@resend.dev>",
          to: [settings.report_email],
          subject: `Sauvegarde ${source} Monsieur Maréchal - ${date}`,
          html: `<p>Sauvegarde ${source} du ${date} en pièce jointe (${(zip.length / 1024).toFixed(0)} Ko).</p>` +
            `<p>${Object.entries(counts).map(([t, n]) => `${t} : ${n}`).join("<br>")}</p>`,
          attachments: [{ filename: `sauvegarde-mm-${date}.zip`, content: toBase64(zip) }],
        }),
      });
      emailed = r.ok;
      if (!r.ok) mailError = await r.text();
    }
    return json({ ok: true, source, path, size: zip.length, counts, emailed, mailError });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
