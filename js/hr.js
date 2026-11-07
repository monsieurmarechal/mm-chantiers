import {
  sb, state, q, esc, view, toast, modal, confirmBox, busy, formData, isStaff, isAdmin, callFn, ROLES,
  LEAVE_TYPES, LEAVE_STATUS, todayStr, fmtDate, fmtDateTime, fmtH, hoursBetween, nameOf, loadProfiles, downloadCsv,
} from "./core.js";

const appUrl = () => location.origin + location.pathname;

// =====================================================================
// CONGÉS, RÉCUPÉRATIONS ET HEURES SUPPLÉMENTAIRES
// =====================================================================
export async function renderLeaves() {
  const v = view();
  const uid = state.session.user.id;
  const staff = isStaff();
  await loadProfiles();

  const balRows = await q(sb.from("overtime_balance").select("*"));
  const myBal = balRows.find((b) => b.user_id === uid)?.balance ?? 0;
  const reqs = await q(sb.from("leave_requests").select("*").order("created_at", { ascending: false }).limit(300));
  const mine = reqs.filter((r) => r.user_id === uid);
  const pending = reqs.filter((r) => r.status === "en_attente" && r.user_id !== uid);

  v.innerHTML = `
    <div class="page-h"><h2>Congés et heures supplémentaires</h2></div>
    <div class="grid2">
      <section class="panel">
        <div class="kpi"><span>Mon compteur d'heures supplémentaires</span><b class="${myBal < 0 ? "neg" : ""}">${fmtH(+myBal)}</b></div>
        <h3>Nouvelle demande</h3>
        <form id="lf" class="form">
          <label>Type<select name="type" id="ltype">${Object.entries(LEAVE_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
          <div class="grid2"><label>Du<input type="date" name="start_date" required value="${todayStr()}"></label>
          <label>Au<input type="date" name="end_date" required value="${todayStr()}"></label></div>
          <label id="hrsl" hidden>Nombre d'heures à récupérer<input type="number" name="hours" step="0.25" min="0.25"></label>
          <label>Motif / commentaire<textarea name="reason" rows="2"></textarea></label>
          <button class="btn" id="lsend">Envoyer la demande</button>
        </form>
        <h3>Mes demandes</h3>
        ${leaveTable(mine, { own: true })}
      </section>
      ${staff ? `<section class="panel">
        <h3>Demandes à traiter <span class="badge">${pending.length}</span></h3>
        ${pending.length ? leaveTable(pending, { manage: true }) : `<p class="muted">Aucune demande en attente.</p>`}
        <h3>Compteurs d'heures supplémentaires</h3>
        <div class="table-wrap"><table class="table"><thead><tr><th>Collaborateur</th><th>Solde</th><th></th></tr></thead><tbody>
        ${state.profiles.filter((p) => p.active).map((p) => { const b = balRows.find((x) => x.user_id === p.id)?.balance ?? 0;
          return `<tr><td>${esc(p.full_name)}</td><td class="${b < 0 ? "neg" : ""}"><b>${fmtH(+b)}</b></td>
          <td class="right"><button class="btn small ghost" data-ot="${p.id}">Ajuster</button> <button class="btn small ghost" data-hist="${p.id}">Historique</button></td></tr>`; }).join("")}
        </tbody></table></div>
        <h3>Historique des demandes</h3>
        ${leaveTable(reqs.filter((r) => r.status !== "en_attente").slice(0, 50), { showUser: true })}
      </section>` : ""}
    </div>`;

  const lf = v.querySelector("#lf");
  lf.querySelector("#ltype").onchange = (e) => {
    const rec = e.target.value === "recuperation";
    lf.querySelector("#hrsl").hidden = !rec;
    lf.hours.required = rec;
  };
  lf.onsubmit = (e) => {
    e.preventDefault();
    busy(lf.querySelector("#lsend"), async () => {
      const d = formData(lf);
      if (d.type === "recuperation" && +d.hours > +myBal) {
        if (!(await confirmBox(`Votre solde (${fmtH(+myBal)}) est inférieur à la demande. Envoyer quand même ?`))) return;
      }
      await q(sb.from("leave_requests").insert({
        user_id: uid, type: d.type, start_date: d.start_date, end_date: d.end_date,
        hours: d.type === "recuperation" ? +d.hours : null, reason: d.reason,
      }));
      toast("Demande envoyée");
      renderLeaves();
    });
  };

  v.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Annuler cette demande ?"))) return;
    busy(b, async () => { await q(sb.from("leave_requests").delete().eq("id", b.dataset.cancel)); renderLeaves(); });
  }));
  v.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => decide(b.dataset.decide, b.dataset.st)));
  v.querySelectorAll("[data-ot]").forEach((b) => (b.onclick = () => adjustOvertime(b.dataset.ot)));
  v.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = () => overtimeHistory(b.dataset.hist)));
}

function leaveTable(rows, { own = false, manage = false, showUser = manage } = {}) {
  if (!rows.length) return `<p class="muted">Aucune demande.</p>`;
  return `<div class="table-wrap"><table class="table"><thead><tr>${showUser ? "<th>Collaborateur</th>" : ""}<th>Type</th><th>Période</th><th>Heures</th><th>Statut</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr>${showUser ? `<td>${esc(nameOf(r.user_id))}</td>` : ""}
    <td>${LEAVE_TYPES[r.type]}${r.reason ? `<br><small class="muted">${esc(r.reason)}</small>` : ""}</td>
    <td>${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmtDate(r.end_date)}` : ""}</td>
    <td>${r.hours ? fmtH(+r.hours) : "-"}</td>
    <td><span class="badge lv-${r.status}">${LEAVE_STATUS[r.status]}</span>${r.admin_comment ? `<br><small class="muted">${esc(r.admin_comment)}</small>` : ""}</td>
    <td class="right">${own && r.status === "en_attente" ? `<button class="btn small ghost" data-cancel="${r.id}">Annuler</button>` : ""}
      ${manage ? `<button class="btn small" data-decide="${r.id}" data-st="approuvee">Approuver</button>
      <button class="btn small danger" data-decide="${r.id}" data-st="refusee">Refuser</button>` : ""}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function decide(id, status) {
  const md = modal(status === "approuvee" ? "Approuver la demande" : "Refuser la demande", `
    <form class="form" id="df"><label>Commentaire (facultatif)<textarea name="c" rows="2"></textarea></label>
    <div class="actions"><button class="btn">Confirmer</button></div></form>`);
  const f = md.el.querySelector("#df");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      await q(sb.from("leave_requests").update({
        status, admin_comment: f.c.value || null, decided_by: state.session.user.id, decided_at: new Date().toISOString(),
      }).eq("id", id));
      md.close(); toast("Demande mise à jour"); renderLeaves();
    });
  };
}

function adjustOvertime(userId) {
  const md = modal(`Heures supplémentaires · ${nameOf(userId)}`, `
    <form class="form" id="of">
      <label>Heures (positif = ajout, négatif = retrait)<input type="number" step="0.25" name="hours" required></label>
      <label>Motif<input name="reason" required placeholder="Ex. Heures sup. semaine 45"></label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
  const f = md.el.querySelector("#of");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      await q(sb.from("overtime_adjustments").insert({ user_id: userId, hours: +f.hours.value, reason: f.reason.value, created_by: state.session.user.id }));
      md.close(); toast("Compteur mis à jour"); renderLeaves();
    });
  };
}

async function overtimeHistory(userId) {
  const rows = await q(sb.from("overtime_adjustments").select("*").eq("user_id", userId).order("created_at", { ascending: false }));
  modal(`Historique · ${nameOf(userId)}`, rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Heures</th><th>Motif</th><th>Par</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td class="${r.hours < 0 ? "neg" : ""}">${fmtH(+r.hours)}</td><td>${esc(r.reason || "")}</td><td>${esc(nameOf(r.created_by))}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">Aucun mouvement.</p>`, { wide: true });
}

// =====================================================================
// RÉCAPITULATIF RH DES PRESTATIONS
// =====================================================================
function periodKey(dateStr, mode) {
  if (mode === "jour") return dateStr;
  if (mode === "mois") return dateStr.slice(0, 7);
  // Semaine ISO
  const d = new Date(dateStr + "T12:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThu = new Date(d.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((d - firstThu) / 864e5 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-S${String(wk).padStart(2, "0")}`;
}
const periodLabel = (k, mode) => mode === "jour" ? fmtDate(k)
  : mode === "mois" ? new Date(k + "-15").toLocaleDateString("fr-BE", { month: "long", year: "numeric" }) : k.replace("-S", " · sem. ");

export async function renderRecap() {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  await loadProfiles();
  const now = new Date();
  const saved = JSON.parse(sessionStorage.getItem("mm_recap") || "{}");
  const from = saved.from || todayStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = saved.to || todayStr();
  const mode = saved.mode || "semaine";
  const who = saved.who || "";

  v.innerHTML = `
    <div class="page-h"><h2>Récapitulatif des prestations</h2></div>
    <form class="filters" id="rf">
      <label>Du<input type="date" name="from" value="${from}"></label>
      <label>Au<input type="date" name="to" value="${to}"></label>
      <label>Regrouper par<select name="mode">${["jour", "semaine", "mois"].map((x) => `<option ${x === mode ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Collaborateur<select name="who"><option value="">Tous</option>${state.profiles.map((p) => `<option value="${p.id}" ${p.id === who ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select></label>
      <button class="btn ghost">Afficher</button><button type="button" class="btn ghost" id="csv">Export CSV</button>
    </form>
    <div id="out"><p class="muted">Chargement…</p></div>`;
  const rf = v.querySelector("#rf");
  let lastRows = [];

  const load = async () => {
    const d = formData(rf);
    sessionStorage.setItem("mm_recap", JSON.stringify(d));
    let qy = sb.from("time_entries").select("*, missions(title, clients(name))").gte("work_date", d.from).lte("work_date", d.to).order("work_date");
    if (d.who) qy = qy.eq("user_id", d.who);
    const rows = await q(qy);
    // Agrégation : personne x période
    const agg = new Map();
    for (const e of rows) {
      const key = `${e.user_id}|${periodKey(e.work_date, d.mode)}`;
      const a = agg.get(key) || { user: e.user_id, period: periodKey(e.work_date, d.mode), days: new Set(), site: 0, total: 0, travel: 0, missions: new Set(), open: 0 };
      a.days.add(e.work_date);
      a.site += hoursBetween(e.site_arrival, e.site_end);
      a.total += hoursBetween(e.workshop_arrival, e.site_end);
      a.travel += hoursBetween(e.workshop_arrival, e.site_arrival);
      a.missions.add(e.missions?.title || e.mission_id);
      if (!e.site_end) a.open++;
      agg.set(key, a);
    }
    const list = [...agg.values()].sort((a, b) => nameOf(a.user).localeCompare(nameOf(b.user)) || a.period.localeCompare(b.period));
    lastRows = list.map((a) => [nameOf(a.user), periodLabel(a.period, d.mode), a.days.size, a.travel.toFixed(2), a.site.toFixed(2), a.total.toFixed(2), [...a.missions].join(" / ")]);

    // Totaux par personne
    const perUser = new Map();
    for (const a of list) {
      const t = perUser.get(a.user) || { site: 0, total: 0, days: 0 };
      t.site += a.site; t.total += a.total; t.days += a.days.size; perUser.set(a.user, t);
    }

    v.querySelector("#out").innerHTML = list.length ? `
      <div class="kpis">${[...perUser.entries()].map(([u, t]) => `<div class="kpi"><span>${esc(nameOf(u))}</span><b>${fmtH(t.total)}</b>
        <small>${t.days} j · chantier ${fmtH(t.site)}</small></div>`).join("")}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Collaborateur</th><th>Période</th><th>Jours</th><th>Trajet aller</th><th>Sur chantier</th><th>Total journée</th><th>Chantiers</th></tr></thead><tbody>
      ${list.map((a) => `<tr><td>${esc(nameOf(a.user))}</td><td>${periodLabel(a.period, d.mode)}</td><td>${a.days.size}</td>
        <td>${fmtH(a.travel)}</td><td>${fmtH(a.site)}</td><td><b>${fmtH(a.total)}</b>${a.open ? ` <span class="badge st-annulee" title="Pointage incomplet">${a.open} incomplet</span>` : ""}</td>
        <td class="small">${esc([...a.missions].join(", "))}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">Total journée = arrivée atelier → fin de chantier. Trajet aller = atelier → arrivée chantier.</p>`
      : `<p class="muted">Aucun pointage sur la période.</p>`;
  };
  rf.onsubmit = (e) => { e.preventDefault(); load().catch((er) => toast(er.message, "err")); };
  v.querySelector("#csv").onclick = () => downloadCsv(`prestations_${formData(rf).from}_${formData(rf).to}.csv`,
    [["Collaborateur", "Période", "Jours", "Trajet aller (h)", "Sur chantier (h)", "Total journée (h)", "Chantiers"], ...lastRows]);
  await load();
}

// =====================================================================
// GESTION DES UTILISATEURS (admin + RH)
// =====================================================================
export async function renderUsers() {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  const users = await loadProfiles();
  const me = state.session.user.id;
  const roleOpts = (cur) => Object.entries(ROLES)
    .filter(([k]) => isAdmin() || k !== "admin" || cur === "admin")
    .map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${l}</option>`).join("");

  v.innerHTML = `
    <div class="page-h"><h2>Utilisateurs</h2><button class="btn" id="add">+ Nouvel utilisateur</button></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Nom</th><th>E-mail</th><th>Téléphone</th><th>Rôle</th><th>Statut</th><th></th></tr></thead><tbody>
    ${users.map((u) => { const locked = u.id === me || (u.role === "admin" && !isAdmin()); return `<tr class="${u.active ? "" : "inactive"}">
      <td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td>
      <td><select data-role="${u.id}" ${locked ? "disabled" : ""}>${roleOpts(u.role)}</select></td>
      <td>${u.active ? `<span class="badge st-terminee">Actif</span>` : `<span class="badge st-annulee">Désactivé</span>`}</td>
      <td class="right">${locked ? "" : `<button class="btn small ghost" data-edit="${u.id}">Modifier</button>
        <button class="btn small ghost" data-reset="${u.id}">Nouveau mot de passe</button>
        <button class="btn small ${u.active ? "danger" : ""}" data-act="${u.id}" data-v="${!u.active}">${u.active ? "Désactiver" : "Réactiver"}</button>`}</td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="muted small">Un compte désactivé ne peut plus se connecter ; son historique (pointages, rapports) est conservé.</p>`;

  v.querySelector("#add").onclick = () => {
    const md = modal("Nouvel utilisateur", `
      <form class="form" id="uf">
        <label>Nom et prénom *<input name="full_name" required></label>
        <label>E-mail *<input type="email" name="email" required></label>
        <label>Téléphone<input name="phone" type="tel"></label>
        <label>Rôle<select name="role">${roleOpts("collaborateur")}</select></label>
        <p class="muted small">Un mot de passe provisoire est généré. L'utilisateur devra le changer à sa première connexion.</p>
        <div class="actions"><button class="btn">Créer le compte</button></div></form>`);
    const f = md.el.querySelector("#uf");
    f.onsubmit = (e) => {
      e.preventDefault();
      busy(f.querySelector("button"), async () => {
        const d = formData(f);
        const r = await callFn("create-user", { action: "create", ...d, appUrl: appUrl() });
        md.close();
        showCredentials(d.full_name, d.email, r.tempPassword, r.mail?.sent);
        renderUsers();
      });
    };
  };

  v.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.reset);
    if (!(await confirmBox(`Générer un nouveau mot de passe provisoire pour ${u.full_name} ?`))) return;
    busy(b, async () => {
      const r = await callFn("create-user", { action: "reset", user_id: u.id, appUrl: appUrl() });
      showCredentials(u.full_name, u.email, r.tempPassword, r.mail?.sent);
    });
  }));
  v.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
    const active = b.dataset.v === "true";
    if (!active && !(await confirmBox("Désactiver ce compte ? L'utilisateur ne pourra plus se connecter."))) return;
    busy(b, async () => { await callFn("create-user", { action: "set-active", user_id: b.dataset.act, active }); renderUsers(); });
  }));
  v.querySelectorAll("[data-role]").forEach((s) => (s.onchange = () =>
    busy(null, async () => { await callFn("create-user", { action: "set-role", user_id: s.dataset.role, role: s.value }); toast("Rôle modifié"); })));
  v.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    const md = modal(`Modifier ${u.full_name}`, `<form class="form" id="ef">
      <label>Nom et prénom<input name="full_name" required value="${esc(u.full_name)}"></label>
      <label>Téléphone<input name="phone" value="${esc(u.phone || "")}"></label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
    const f = md.el.querySelector("#ef");
    f.onsubmit = (e) => { e.preventDefault(); busy(f.querySelector("button"), async () => {
      await q(sb.from("profiles").update(formData(f)).eq("id", u.id)); md.close(); renderUsers(); }); };
  }));
}

function showCredentials(name, email, pwd, mailed) {
  const txt = `Bonjour ${name},\n\nVoici votre accès à l'application Monsieur Maréchal :\nLien : ${appUrl()}\nIdentifiant : ${email}\nMot de passe provisoire : ${pwd}\n\nVous devrez choisir votre mot de passe personnel à la première connexion.\nSur Android : ouvrez le lien dans Chrome puis "Ajouter à l'écran d'accueil".`;
  const md = modal("Accès créé", `
    ${mailed ? `<div class="info ok">E-mail d'invitation envoyé à ${esc(email)}.</div>` : `<div class="info warn">E-mail automatique non configuré : transmettez le message ci-dessous.</div>`}
    <textarea rows="10" readonly class="mono">${esc(txt)}</textarea>
    <div class="actions">
      <a class="btn ghost" href="mailto:${esc(email)}?subject=${encodeURIComponent("Votre accès Monsieur Maréchal")}&body=${encodeURIComponent(txt)}">E-mail</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(txt)}">WhatsApp</a>
      <button class="btn" id="cp">Copier</button></div>
    <p class="muted small">Le mot de passe provisoire n'est affiché qu'une seule fois.</p>`);
  md.el.querySelector("#cp").onclick = () => navigator.clipboard.writeText(txt).then(() => toast("Copié"));
}

// =====================================================================
// MON COMPTE + CHANGEMENT DE MOT DE PASSE
// =====================================================================
export function passwordForm(forced) {
  return `<form class="form" id="pwf">
    ${forced ? `<div class="info warn">Première connexion : choisissez votre mot de passe personnel.</div>` : ""}
    <label>Nouveau mot de passe (8 caractères minimum)<input type="password" name="p1" minlength="8" required autocomplete="new-password"></label>
    <label>Confirmer<input type="password" name="p2" minlength="8" required autocomplete="new-password"></label>
    <button class="btn wide">Enregistrer le mot de passe</button></form>`;
}

export function bindPasswordForm(root, onDone) {
  const f = root.querySelector("#pwf");
  f.onsubmit = (e) => {
    e.preventDefault();
    if (f.p1.value !== f.p2.value) return toast("Les mots de passe ne correspondent pas", "err");
    if (!/[A-Za-z]/.test(f.p1.value) || !/\d/.test(f.p1.value)) return toast("Utilisez au moins une lettre et un chiffre", "err");
    busy(f.querySelector("button"), async () => {
      const { error } = await sb.auth.updateUser({ password: f.p1.value });
      if (error) throw new Error(error.message);
      await q(sb.from("profiles").update({ must_change_password: false }).eq("id", state.session.user.id));
      state.profile.must_change_password = false;
      toast("Mot de passe modifié");
      onDone?.();
    });
  };
}

export async function renderAccount() {
  const v = view();
  const p = state.profile;
  const bal = (await q(sb.from("overtime_balance").select("balance").eq("user_id", p.id)))[0]?.balance ?? 0;
  v.innerHTML = `
    <div class="page-h"><h2>Mon compte</h2></div>
    <div class="grid2">
      <section class="panel">
        <dl class="dl"><dt>Nom</dt><dd>${esc(p.full_name)}</dd><dt>E-mail</dt><dd>${esc(p.email)}</dd>
        <dt>Rôle</dt><dd>${ROLES[p.role]}</dd><dt>Heures sup.</dt><dd><b>${fmtH(+bal)}</b></dd></dl>
        <form class="form" id="pf"><label>Téléphone<input name="phone" value="${esc(p.phone || "")}"></label>
          <button class="btn ghost">Enregistrer</button></form>
      </section>
      <section class="panel"><h3>Changer de mot de passe</h3>${passwordForm(false)}</section>
    </div>`;
  bindPasswordForm(v);
  const pf = v.querySelector("#pf");
  pf.onsubmit = (e) => { e.preventDefault(); busy(pf.querySelector("button"), async () => {
    await q(sb.from("profiles").update({ phone: pf.phone.value }).eq("id", p.id)); p.phone = pf.phone.value; toast("Enregistré"); }); };
}
