import { sb, state, q, esc, $, view, toast, busy, isStaff, isAdmin, ROLES, todayStr, loadProfiles, loadSettings, loadLeaveTypes } from "./core.js";
import { SUPABASE_ANON_KEY, APP_VERSION } from "./config.js";
import * as M from "./missions.js";
import * as H from "./hr.js";
import * as A from "./admin.js";
import { startTracking, stopTracking } from "./geo.js";

// ---------- Navigation selon le rôle ----------
function navItems() {
  const r = state.profile.role;
  const items = [
    ["#/missions", r === "collaborateur" ? "Mes chantiers" : "Ordres de mission", "🏗"],
    ["#/conges", "Congés / heures sup.", "🗓"],
  ];
  if (isStaff()) items.push(["#/compteurs", "Compteurs congés", "🧮"], ["#/types-conges", "Types de congés", "🏷"], ["#/rh", "Récap. prestations", "📊"], ["#/calendrier", "Calendrier", "📅"], ["#/clients", "Clients", "👥"], ["#/outils", "Outils", "🧰"], ["#/utilisateurs", "Utilisateurs", "🔐"]);
  if (isAdmin()) items.push(["#/carte", "Localisation", "📍"], ["#/parametres", "Paramètres", "⚙"]);
  items.push(["#/compte", "Mon compte", "👤"]);
  return items;
}

function renderShell() {
  $("#app").innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menu" aria-label="Menu">☰</button>
      <a href="#/missions" class="brand"><span class="b1">Monsieur</span><span class="b2">MARECHAL</span></a>
      <div class="who"><span>${esc(state.profile.full_name || state.profile.email)}</span><small>${ROLES[state.profile.role]}</small></div>
      <button class="icon-btn" id="logout" title="Se déconnecter">⎋</button>
    </header>
    <nav class="sidenav" id="nav">${navItems().map(([h, l, i]) => `<a href="${h}" data-h="${h}"><span>${i}</span>${l}</a>`).join("")}</nav>
    <main id="view"></main>`;
  $("#logout").onclick = async () => { stopTracking(); await sb.auth.signOut(); };
  $("#menu").onclick = () => $("#nav").classList.toggle("open");
  $("#nav").onclick = () => $("#nav").classList.remove("open");
}

// ---------- Routeur ----------
async function route() {
  if (!state.profile) return;
  A.stopMap();
  const raw = location.hash.replace(/^#\/?/, "") || "missions";
  const [path, qs] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  const p = path.split("/");
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", raw.startsWith(a.dataset.h.slice(2))));
  view().innerHTML = `<p class="muted">Chargement…</p>`;
  window.scrollTo(0, 0);
  try {
    if (p[0] === "missions") await M.renderList();
    else if (p[0] === "mission" && p[1] === "new") await M.renderForm(null, params);
    else if (p[0] === "mission" && p[2] === "edit") await M.renderForm(p[1]);
    else if (p[0] === "mission" && p[2] === "sign") await M.renderSign(p[1], p[3]);
    else if (p[0] === "mission") await M.renderDetail(p[1]);
    else if (p[0] === "conges") await H.renderLeaves();
    else if (p[0] === "compteurs" && p[1]) await H.renderWorkerSheet(p[1]);
    else if (p[0] === "compteurs") await H.renderCounters();
    else if (p[0] === "types-conges") await H.renderLeaveTypes();
    else if (p[0] === "rh") await H.renderRecap();
    else if (p[0] === "calendrier") await H.renderCalendar();
    else if (p[0] === "utilisateurs") await H.renderUsers();
    else if (p[0] === "compte") await H.renderAccount();
    else if (p[0] === "outils") await A.renderTools();
    else if (p[0] === "clients") await A.renderClients();
    else if (p[0] === "parametres") await A.renderSettings();
    else if (p[0] === "carte") await A.renderMap();
    else location.hash = "#/missions";
  } catch (e) {
    console.error(e);
    view().innerHTML = `<div class="panel"><p class="err">Erreur : ${esc(e.message)}</p><a class="btn ghost" href="#/missions">Retour</a></div>`;
  }
}

// ---------- Connexion ----------
function renderLogin() {
  $("#app").innerHTML = `
    <div class="login">
      <div class="login-card">
        <div class="brand big"><span class="b1">Monsieur</span><span class="b2">MARECHAL</span><span class="b3">by Mathieu</span></div>
        <p class="tag">Gestion des chantiers</p>
        ${SUPABASE_ANON_KEY.includes("COLLER") ? `<div class="info warn">Configuration incomplète : renseigner la clé anon dans js/config.js</div>` : ""}
        <form class="form" id="lg">
          <label>E-mail<input type="email" name="email" required autocomplete="username"></label>
          <label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label>
          <button class="btn wide">Se connecter</button>
        </form>
        <p class="muted small center">Mot de passe oublié ? Contactez l'administrateur : il vous enverra un mot de passe provisoire.</p>
      </div>
    </div>`;
  const f = $("#lg");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "Identifiants incorrects" : error.message);
    });
  };
}

function renderForcedPassword() {
  $("#app").innerHTML = `<div class="login"><div class="login-card">
    <div class="brand big"><span class="b1">Monsieur</span><span class="b2">MARECHAL</span></div>
    <p class="tag">Bienvenue ${esc(state.profile.full_name)}</p>${H.passwordForm(true)}
    <button class="btn ghost wide" id="out">Se déconnecter</button></div></div>`;
  H.bindPasswordForm($("#app"), () => start());
  $("#out").onclick = () => sb.auth.signOut();
}

// ---------- Démarrage ----------
async function start() {
  const uid = state.session.user.id;
  const prof = await q(sb.from("profiles").select("*").eq("id", uid).maybeSingle());
  if (!prof || !prof.active) {
    await sb.auth.signOut();
    toast("Compte inexistant ou désactivé", "err");
    return;
  }
  state.profile = prof;
  if (prof.must_change_password) return renderForcedPassword();
  await Promise.all([loadSettings(), loadProfiles(), loadLeaveTypes()]);
  renderShell();
  route();
  // Reprise du suivi de position si une journée est en cours
  const open = await q(sb.from("time_entries").select("id").eq("user_id", uid).eq("work_date", todayStr())
    .not("workshop_arrival", "is", null).is("site_end", null));
  if (open.length) startTracking();
}

window.addEventListener("hashchange", route);

let lastUid = null;
sb.auth.onAuthStateChange((event, session) => {
  state.session = session;
  const uid = session?.user?.id || null;
  if (event === "TOKEN_REFRESHED" || (uid && uid === lastUid && event !== "SIGNED_IN")) return;
  if (uid === lastUid && uid) return;
  lastUid = uid;
  if (!session) { state.profile = null; stopTracking(); renderLogin(); return; }
  setTimeout(() => start().catch((e) => { toast(e.message, "err"); renderLogin(); }), 0);
});

// Service worker (installation Android / hors ligne de l'interface)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

// ---------- Détection des nouvelles versions ----------
// Une application ouverte garde son code en mémoire : on compare régulièrement la version
// chargée à celle publiée et on propose un rechargement propre.
const APP_FILES = ["index.html", "css/app.css", "js/app.js", "js/core.js", "js/config.js", "js/geo.js", "js/missions.js", "js/hr.js", "js/admin.js", "sw.js"];

async function forceUpdate() {
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
    // Rafraîchit le cache HTTP du navigateur pour chaque fichier de l'application
    await Promise.all(APP_FILES.map((f) => fetch(f, { cache: "reload" }).catch(() => {})));
  } catch {}
  location.reload();
}

function showUpdateBanner(v) {
  if (document.getElementById("upd")) return;
  const b = document.createElement("div");
  b.id = "upd";
  b.className = "update-banner";
  b.innerHTML = `<span>Nouvelle version de l'application disponible.</span><button class="btn small">Mettre à jour</button>`;
  b.querySelector("button").onclick = (e) => { e.target.disabled = true; e.target.textContent = "Mise à jour…"; forceUpdate(); };
  document.body.appendChild(b);
}

async function checkUpdate() {
  try {
    const t = await (await fetch(`js/config.js?nc=${Date.now()}`, { cache: "no-store" })).text();
    const v = (t.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];
    if (v && v !== APP_VERSION) showUpdateBanner(v);
  } catch {}
}
checkUpdate();
setInterval(checkUpdate, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
