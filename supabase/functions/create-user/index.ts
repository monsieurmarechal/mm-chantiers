// Edge Function : gestion des comptes (création avec mot de passe provisoire,
// réinitialisation, activation/désactivation).
// Appelable uniquement par un admin ou un RH connecté.
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function tempPassword(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("") + "!";
}

async function sendMail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { sent: false, reason: "RESEND_API_KEY absent" };
  const from = Deno.env.get("MAIL_FROM") ?? "Monsieur Maréchal <onboarding@resend.dev>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return { sent: r.ok, reason: r.ok ? undefined : await r.text() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = serviceKey();
    const admin = createClient(url, service, { auth: { persistSession: false } });

    // Vérification de l'appelant
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "Non authentifié" }, 401);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", caller.user.id).single();
    if (!me || !me.active || !["admin", "rh"].includes(me.role)) return json({ error: "Accès refusé" }, 403);

    const body = await req.json();
    const appUrl = body.appUrl ?? "";

    if (body.action === "create") {
      const { email, full_name, phone, role } = body;
      if (!email || !full_name) return json({ error: "Email et nom requis" }, 400);
      if (role === "admin" && me.role !== "admin") return json({ error: "Seul un admin peut créer un admin" }, 403);
      const password = tempPassword();
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name, phone },
        app_metadata: { role: role ?? "collaborateur" },
      });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ role: role ?? "collaborateur", full_name, phone, must_change_password: true })
        .eq("id", data.user.id);
      const mail = await sendMail(email, "Votre accès à l'application Monsieur Maréchal",
        `<p>Bonjour ${full_name},</p>
         <p>Un compte a été créé pour vous sur l'application de gestion de chantiers.</p>
         <p><b>Lien :</b> <a href="${appUrl}">${appUrl}</a><br>
         <b>Identifiant :</b> ${email}<br><b>Mot de passe provisoire :</b> ${password}</p>
         <p>Vous devrez choisir un nouveau mot de passe à la première connexion.</p>`);
      return json({ ok: true, user_id: data.user.id, tempPassword: password, mail });
    }

    if (body.action === "reset") {
      const { user_id } = body;
      const { data: target } = await admin.from("profiles").select("email,full_name,role").eq("id", user_id).single();
      if (!target) return json({ error: "Utilisateur introuvable" }, 404);
      if (target.role === "admin" && me.role !== "admin") return json({ error: "Accès refusé" }, 403);
      const password = tempPassword();
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ must_change_password: true }).eq("id", user_id);
      const mail = await sendMail(target.email, "Réinitialisation de votre mot de passe",
        `<p>Bonjour ${target.full_name},</p><p>Lien : <a href="${appUrl}">${appUrl}</a><br>
         Mot de passe provisoire : <b>${password}</b></p><p>À modifier à la prochaine connexion.</p>`);
      return json({ ok: true, tempPassword: password, email: target.email, mail });
    }

    if (body.action === "set-active") {
      const { user_id, active } = body;
      if (user_id === caller.user.id) return json({ error: "Impossible de vous désactiver vous-même" }, 400);
      const { data: target } = await admin.from("profiles").select("role").eq("id", user_id).single();
      if (target?.role === "admin" && me.role !== "admin") return json({ error: "Accès refusé" }, 403);
      await admin.auth.admin.updateUserById(user_id, { ban_duration: active ? "none" : "876000h" });
      await admin.from("profiles").update({ active }).eq("id", user_id);
      return json({ ok: true });
    }

    if (body.action === "set-role") {
      const { user_id, role } = body;
      if (me.role !== "admin" && role === "admin") return json({ error: "Accès refusé" }, 403);
      await admin.auth.admin.updateUserById(user_id, { app_metadata: { role } });
      const { error } = await admin.from("profiles").update({ role }).eq("id", user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
