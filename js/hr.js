import {
  sb, state, q, esc, view, toast, modal, confirmBox, busy, formData, isStaff, isAdmin, callFn, ROLES,
  LEAVE_STATUS, todayStr, fmtDate, fmtTime, fmtDateTime, fmtH, hoursBetween, nameOf, loadProfiles, downloadCsv,
  loadLeaveTypes, leaveType, fmtQty, businessDays, printDoc,
} from "./core.js";

const appUrl = () => location.origin + location.pathname;
const yearOf = (d) => +String(d).slice(0, 4);

// Charge allocations, demandes et soldes heures sup. pour une année
async function loadCounters(year, userId = null) {
  let qa = sb.from("leave_allocations").select("*").eq("year", year);
  let qr = sb.from("leave_requests").select("*").gte("start_date", `${year}-01-01`).lte("start_date", `${year}-12-31`).neq("status", "refusee");
  if (userId) { qa = qa.eq("user_id", userId); qr = qr.eq("user_id", userId); }
  const [alloc, reqs, bal] = await Promise.all([q(qa), q(qr), q(sb.from("overtime_balance").select("*"))]);
  // Compteur d'un collaborateur pour un type
  const counter = (uid, code) => {
    const a = alloc.find((x) => x.user_id === uid && x.type_code === code);
    const rs = reqs.filter((r) => r.user_id === uid && r.type === code);
    const taken = rs.filter((r) => r.status === "approuvee").reduce((s, r) => s + (+r.amount || 0), 0);
    const pending = rs.filter((r) => r.status === "en_attente").reduce((s, r) => s + (+r.amount || 0), 0);
    const allowed = a ? +a.amount : 0;
    return { alloc: a, allowed, taken, pending, left: allowed - taken };
  };
  const overtime = (uid) => +(bal.find((b) => b.user_id === uid)?.balance ?? 0);
  return { counter, overtime, alloc };
}

function counterCell(c, unit) {
  const cls = c.left < 0 ? "neg" : "";
  return `<b class="${cls}">${fmtQty(c.left, unit)}</b><br><small class="muted">${fmtQty(c.taken, unit)} pris / ${fmtQty(c.allowed, unit)}${c.pending ? ` · ${fmtQty(c.pending, unit)} en attente` : ""}</small>`;
}

// =====================================================================
// CONGÉS : demandes et compteurs personnels
// =====================================================================
export async function renderLeaves() {
  const v = view();
  const uid = state.session.user.id;
  const staff = isStaff();
  const year = new Date().getFullYear();
  await Promise.all([loadProfiles(), loadLeaveTypes()]);
  const types = state.leaveTypes.filter((t) => t.active);
  const ctr = await loadCounters(year, staff ? null : uid);
  const reqs = await q(sb.from("leave_requests").select("*").order("created_at", { ascending: false }).limit(300));
  const mine = reqs.filter((r) => r.user_id === uid);
  const pending = reqs.filter((r) => r.status === "en_attente" && r.user_id !== uid);
  const counted = state.leaveTypes.filter((t) => t.has_counter);

  v.innerHTML = `
    <div class="page-h"><h2>Congés et heures supplémentaires</h2>
      ${staff ? `<a class="btn ghost" href="#/compteurs">Compteurs de l'équipe</a>` : ""}</div>
    <div class="grid2">
      <section class="panel">
        <h3>Mes compteurs ${year}</h3>
        <div class="kpis">
          <div class="kpi"><span>Heures supplémentaires</span><b class="${ctr.overtime(uid) < 0 ? "neg" : ""}">${fmtH(ctr.overtime(uid))}</b></div>
          ${counted.map((t) => { const c = ctr.counter(uid, t.code); return `<div class="kpi"><span>${esc(t.label)}</span>
            <b class="${c.left < 0 ? "neg" : ""}">${fmtQty(c.left, t.unit)}</b><small>${fmtQty(c.taken, t.unit)} pris sur ${fmtQty(c.allowed, t.unit)}${c.pending ? ` · ${fmtQty(c.pending, t.unit)} en attente` : ""}</small></div>`; }).join("")}
        </div>
        <h3>Nouvelle demande</h3>
        <form id="lf" class="form">
          <label>Type<select name="type" id="ltype">${types.map((t) => `<option value="${t.code}">${esc(t.label)}</option>`).join("")}</select></label>
          <div class="grid2"><label>Du<input type="date" name="start_date" required value="${todayStr()}"></label>
          <label>Au<input type="date" name="end_date" required value="${todayStr()}"></label></div>
          <label><span id="amtl">Nombre de jours</span><input type="number" name="amount" step="0.5" min="0.25" required></label>
          <label>Motif / commentaire<textarea name="reason" rows="2"></textarea></label>
          <button class="btn" id="lsend">Envoyer la demande</button>
        </form>
        <h3>Mes demandes</h3>
        ${leaveTable(mine, { own: true })}
      </section>
      ${staff ? `<section class="panel">
        <h3>Demandes à traiter <span class="badge">${pending.length}</span></h3>
        ${pending.length ? leaveTable(pending, { manage: true }) : `<p class="muted">Aucune demande en attente.</p>`}
        <h3>Historique des demandes</h3>
        ${leaveTable(reqs.filter((r) => r.status !== "en_attente").slice(0, 60), { showUser: true, edit: true })}
      </section>` : ""}
    </div>`;

  // Quantité proposée automatiquement : jours ouvrables ou heures
  const lf = v.querySelector("#lf");
  const syncAmount = () => {
    const t = leaveType(lf.type.value);
    v.querySelector("#amtl").textContent = t.unit === "heures" ? "Nombre d'heures" : "Nombre de jours (ouvrables, 0,5 = demi-journée)";
    lf.amount.step = t.unit === "heures" ? "0.25" : "0.5";
    if (t.unit === "jours") lf.amount.value = businessDays(lf.start_date.value, lf.end_date.value) || "";
    else if (lf.dataset.unit !== "heures") lf.amount.value = "";
    lf.dataset.unit = t.unit;
  };
  lf.type.onchange = syncAmount;
  lf.start_date.onchange = () => { if (lf.end_date.value < lf.start_date.value) lf.end_date.value = lf.start_date.value; syncAmount(); };
  lf.end_date.onchange = syncAmount;
  syncAmount();

  lf.onsubmit = (e) => {
    e.preventDefault();
    busy(lf.querySelector("#lsend"), async () => {
      const d = formData(lf);
      const t = leaveType(d.type);
      if (t.deducts_overtime && +d.amount > ctr.overtime(uid)) {
        if (!(await confirmBox(`Votre solde d'heures sup. (${fmtH(ctr.overtime(uid))}) est inférieur à la demande. Envoyer quand même ?`))) return;
      }
      if (t.has_counter) {
        const c = ctr.counter(uid, t.code);
        if (+d.amount > c.left - c.pending && !(await confirmBox(`Solde ${t.label} insuffisant (${fmtQty(c.left - c.pending, t.unit)} disponible). Envoyer quand même ?`))) return;
      }
      await q(sb.from("leave_requests").insert({
        user_id: uid, type: d.type, start_date: d.start_date, end_date: d.end_date,
        amount: +d.amount, hours: t.unit === "heures" ? +d.amount : null, reason: d.reason,
      }));
      toast("Demande envoyée");
      renderLeaves();
    });
  };

  bindLeaveActions(v, renderLeaves);
}

function leaveTable(rows, { own = false, manage = false, showUser = manage, edit = false } = {}) {
  if (!rows.length) return `<p class="muted">Aucune demande.</p>`;
  return `<div class="table-wrap"><table class="table"><thead><tr>${showUser ? "<th>Collaborateur</th>" : ""}<th>Type</th><th>Période</th><th>Quantité</th><th>Statut</th><th></th></tr></thead><tbody>
  ${rows.map((r) => { const t = leaveType(r.type); return `<tr>${showUser ? `<td>${esc(nameOf(r.user_id))}</td>` : ""}
    <td><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.label)}${r.reason ? `<br><small class="muted">${esc(r.reason)}</small>` : ""}</td>
    <td>${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmtDate(r.end_date)}` : ""}</td>
    <td>${r.amount != null ? fmtQty(r.amount, t.unit) : "-"}</td>
    <td><span class="badge lv-${r.status}">${LEAVE_STATUS[r.status]}</span>${r.admin_comment ? `<br><small class="muted">${esc(r.admin_comment)}</small>` : ""}</td>
    <td class="right">${own && r.status === "en_attente" ? `<button class="btn small ghost" data-cancel="${r.id}">Annuler</button>` : ""}
      ${manage ? `<button class="btn small" data-decide="${r.id}" data-st="approuvee">Approuver</button>
      <button class="btn small danger" data-decide="${r.id}" data-st="refusee">Refuser</button>` : ""}
      ${(manage || edit) && isStaff() ? `<button class="btn small ghost" data-editreq="${r.id}">Modifier</button>` : ""}</td></tr>`; }).join("")}
  </tbody></table></div>`;
}

function bindLeaveActions(v, refresh) {
  v.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Annuler cette demande ?"))) return;
    busy(b, async () => { await q(sb.from("leave_requests").delete().eq("id", b.dataset.cancel)); refresh(); });
  }));
  v.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => decide(b.dataset.decide, b.dataset.st, refresh)));
  v.querySelectorAll("[data-editreq]").forEach((b) => (b.onclick = () => editRequest(b.dataset.editreq, refresh)));
}

function decide(id, status, refresh) {
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
      md.close(); toast("Demande mise à jour"); refresh();
    });
  };
}

// Modification complète d'une demande par admin/RH
async function editRequest(id, refresh) {
  const r = await q(sb.from("leave_requests").select("*").eq("id", id).single());
  const md = modal(`Demande de ${nameOf(r.user_id)}`, `
    <form class="form" id="ef">
      <label>Type<select name="type">${state.leaveTypes.map((t) => `<option value="${t.code}" ${t.code === r.type ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
      <div class="grid2"><label>Du<input type="date" name="start_date" required value="${r.start_date}"></label>
      <label>Au<input type="date" name="end_date" required value="${r.end_date}"></label></div>
      <label>Quantité (jours ou heures selon le type)<input type="number" name="amount" step="0.25" min="0" required value="${r.amount ?? ""}"></label>
      <label>Statut<select name="status">${Object.entries(LEAVE_STATUS).map(([k, l]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Commentaire<textarea name="admin_comment" rows="2">${esc(r.admin_comment || "")}</textarea></label>
      <div class="actions"><button type="button" class="btn danger" id="del">Supprimer</button><button class="btn">Enregistrer</button></div>
    </form>`);
  const f = md.el.querySelector("#ef");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button.btn:not(.danger)"), async () => {
      const d = formData(f);
      const t = leaveType(d.type);
      await q(sb.from("leave_requests").update({
        type: d.type, start_date: d.start_date, end_date: d.end_date, amount: +d.amount,
        hours: t.unit === "heures" ? +d.amount : null, status: d.status, admin_comment: d.admin_comment || null,
        decided_by: state.session.user.id, decided_at: new Date().toISOString(),
      }).eq("id", id));
      md.close(); toast("Demande modifiée"); refresh();
    });
  };
  f.querySelector("#del").onclick = async () => {
    if (!(await confirmBox("Supprimer définitivement cette demande ?"))) return;
    // Le mouvement d'heures sup. lié est supprimé par cascade (leave_request_id)
    await q(sb.from("overtime_adjustments").delete().eq("leave_request_id", id));
    await q(sb.from("leave_requests").delete().eq("id", id));
    md.close(); refresh();
  };
}

// =====================================================================
// COMPTEURS DE L'ÉQUIPE (admin / RH)
// =====================================================================
export async function renderCounters() {
  if (!isStaff()) return (location.hash = "#/conges");
  const v = view();
  await Promise.all([loadProfiles(), loadLeaveTypes()]);
  const year = +(sessionStorage.getItem("mm_cyear") || new Date().getFullYear());
  const ctr = await loadCounters(year);
  const users = state.profiles.filter((p) => p.active);
  const counted = state.leaveTypes.filter((t) => t.has_counter && t.active);

  const tableHtml = (forPrint) => `<div class="table-wrap"><table class="table"><thead><tr><th>Collaborateur</th><th>Heures sup.</th>
    ${counted.map((t) => `<th>${esc(t.label)}<br><small>solde · pris / alloué</small></th>`).join("")}</tr></thead><tbody>
    ${users.map((u) => `<tr><td>${forPrint ? `<b>${esc(u.full_name)}</b>` : `<a href="#/compteurs/${u.id}"><b>${esc(u.full_name)}</b></a><br><a class="btn small ghost" href="#/compteurs/${u.id}">Détail</a>`}</td>
      <td><b class="${ctr.overtime(u.id) < 0 ? "neg" : ""}">${fmtH(ctr.overtime(u.id))}</b>
        ${forPrint ? "" : `<br><button class="btn small ghost" data-ot="${u.id}">Ajuster</button> <button class="btn small ghost" data-hist="${u.id}">Mouvements</button>`}</td>
      ${counted.map((t) => `<td>${counterCell(ctr.counter(u.id, t.code), t.unit)}
        ${forPrint ? "" : `<br><button class="btn small ghost" data-alloc="${u.id}|${t.code}">Modifier</button>`}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>`;

  v.innerHTML = `
    <div class="page-h"><h2>Compteurs de congés et heures sup.</h2>
      <div class="row"><label class="inline">Année <select id="yr">${[year - 1, year, year + 1].map((y) => `<option ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      <button class="btn ghost" id="newtype">+ Type de congé</button><button class="btn ghost" id="bulk">Allocation pour tous</button><button class="btn ghost" id="pr">🖨 Imprimer</button></div></div>
    ${counted.length ? "" : `<div class="info warn">Aucun type de congé avec compteur actif. <a href="#/types-conges">Paramétrer les types</a></div>`}
    ${tableHtml(false)}
    <p class="muted small">Solde = alloué − pris (demandes approuvées, année de début). Les demandes en attente sont indiquées à part. Heures sup. : solde cumulé toutes années.</p>`;

  v.querySelector("#yr").onchange = (e) => { sessionStorage.setItem("mm_cyear", e.target.value); renderCounters(); };
  v.querySelector("#pr").onclick = () => printDoc(`Compteurs de congés ${year}`, tableHtml(true), { landscape: counted.length > 3, subtitle: `${users.length} collaborateurs actifs` });
  v.querySelectorAll("[data-ot]").forEach((b) => (b.onclick = () => adjustOvertime(b.dataset.ot, renderCounters)));
  v.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = () => overtimeHistory(b.dataset.hist, renderCounters)));
  v.querySelectorAll("[data-alloc]").forEach((b) => (b.onclick = () => {
    const [uid, code] = b.dataset.alloc.split("|");
    editAllocation(uid, code, year, ctr.counter(uid, code).alloc, renderCounters);
  }));
  v.querySelector("#bulk").onclick = () => bulkAllocation(year, counted, users, renderCounters);
  v.querySelector("#newtype").onclick = () => leaveTypeForm(null, renderCounters);
}

function editAllocation(uid, code, year, a, refresh) {
  const t = leaveType(code);
  const md = modal(`${t.label} ${year} · ${nameOf(uid)}`, `
    <form class="form" id="af">
      <label>Droit annuel (${t.unit})<input type="number" name="amount" step="${t.unit === "heures" ? "0.25" : "0.5"}" min="0" required value="${a ? a.amount : ""}"></label>
      <label>Note (report, prorata, ancienneté…)<input name="note" value="${esc(a?.note || "")}"></label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
  const f = md.el.querySelector("#af");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      await q(sb.from("leave_allocations").upsert({
        user_id: uid, type_code: code, year, amount: +f.amount.value, note: f.note.value || null,
        updated_by: state.session.user.id, updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,type_code,year" }));
      md.close(); toast("Compteur mis à jour"); refresh();
    });
  };
}

function bulkAllocation(year, counted, users, refresh) {
  const md = modal(`Allocation ${year} pour tous`, `
    <form class="form" id="bf">
      <label>Type<select name="code">${counted.map((t) => `<option value="${t.code}">${esc(t.label)} (${t.unit})</option>`).join("")}</select></label>
      <label>Droit annuel<input type="number" name="amount" step="0.5" min="0" required></label>
      <label class="check"><input type="checkbox" name="keep" checked> Ne pas écraser les compteurs déjà définis</label>
      <div class="actions"><button class="btn">Appliquer à ${users.length} collaborateurs</button></div></form>`);
  const f = md.el.querySelector("#bf");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const existing = f.keep.checked
        ? (await q(sb.from("leave_allocations").select("user_id").eq("year", year).eq("type_code", f.code.value))).map((x) => x.user_id) : [];
      const rows = users.filter((u) => !existing.includes(u.id)).map((u) => ({
        user_id: u.id, type_code: f.code.value, year, amount: +f.amount.value, updated_by: state.session.user.id, updated_at: new Date().toISOString(),
      }));
      if (rows.length) await q(sb.from("leave_allocations").upsert(rows, { onConflict: "user_id,type_code,year" }));
      md.close(); toast(`${rows.length} compteur(s) mis à jour`); refresh();
    });
  };
}

function adjustOvertime(userId, refresh) {
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
      md.close(); toast("Compteur mis à jour"); refresh();
    });
  };
}

async function overtimeHistory(userId, refresh) {
  const rows = await q(sb.from("overtime_adjustments").select("*").eq("user_id", userId).order("created_at", { ascending: false }));
  const md = modal(`Heures sup. · ${nameOf(userId)}`, rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Heures</th><th>Motif</th><th>Par</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td class="${r.hours < 0 ? "neg" : ""}">${fmtH(+r.hours)}</td><td>${esc(r.reason || "")}</td><td>${esc(nameOf(r.created_by))}</td>
      <td class="right">${r.leave_request_id ? `<small class="muted">lié à une demande</small>` : `<button class="btn small ghost" data-e="${r.id}">Modifier</button> <button class="btn small danger" data-d="${r.id}">Suppr.</button>`}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">Aucun mouvement.</p>`, { wide: true });
  md.el.querySelectorAll("[data-d]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Supprimer ce mouvement ?"))) return;
    await q(sb.from("overtime_adjustments").delete().eq("id", b.dataset.d)); md.close(); refresh();
  }));
  md.el.querySelectorAll("[data-e]").forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => String(x.id) === b.dataset.e);
    md.close();
    const m2 = modal("Modifier le mouvement", `<form class="form" id="mf">
      <label>Heures<input type="number" step="0.25" name="hours" required value="${r.hours}"></label>
      <label>Motif<input name="reason" value="${esc(r.reason || "")}"></label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
    const f = m2.el.querySelector("#mf");
    f.onsubmit = (e) => { e.preventDefault(); busy(f.querySelector("button"), async () => {
      await q(sb.from("overtime_adjustments").update({ hours: +f.hours.value, reason: f.reason.value }).eq("id", r.id)); m2.close(); refresh(); }); };
  }));
}

// =====================================================================
// FICHE COMPLÈTE D'UN TRAVAILLEUR (admin / RH)
// =====================================================================
export async function renderWorkerSheet(uid) {
  if (!isStaff()) return (location.hash = "#/conges");
  const v = view();
  await Promise.all([loadProfiles(), loadLeaveTypes()]);
  const p = state.profiles.find((x) => x.id === uid);
  if (!p) { v.innerHTML = `<div class="panel"><p>Collaborateur introuvable.</p><a class="btn ghost" href="#/compteurs">Retour</a></div>`; return; }
  const year = +(sessionStorage.getItem("mm_cyear") || new Date().getFullYear());
  const [ctr, reqs, moves, allocs] = await Promise.all([
    loadCounters(year, uid),
    q(sb.from("leave_requests").select("*").eq("user_id", uid).gte("start_date", `${year}-01-01`).lte("start_date", `${year}-12-31`).order("start_date", { ascending: false })),
    q(sb.from("overtime_adjustments").select("*").eq("user_id", uid).order("created_at", { ascending: false })),
    q(sb.from("leave_allocations").select("*").eq("user_id", uid).order("year", { ascending: false })),
  ]);
  const active = state.leaveTypes.filter((t) => t.active || reqs.some((r) => r.type === t.code));
  // Quantité prise / en attente pour tout type (avec ou sans compteur)
  const used = (code, st) => reqs.filter((r) => r.type === code && r.status === st).reduce((s, r) => s + (+r.amount || 0), 0);

  const typesTable = (forPrint) => `<div class="table-wrap"><table class="table"><thead><tr><th>Type de congé</th><th>Droit ${year}</th><th>Pris</th><th>En attente</th><th>Solde disponible</th>${forPrint ? "" : "<th></th>"}</tr></thead><tbody>
    ${active.map((t) => { const c = ctr.counter(uid, t.code); return `<tr>
      <td><span class="dot" style="background:${esc(t.color)}"></span><b>${esc(t.label)}</b><br><small class="muted">${t.unit}${t.deducts_overtime ? " · débite les heures sup." : ""}${c.alloc?.note ? " · " + esc(c.alloc.note) : ""}</small></td>
      <td>${t.has_counter ? fmtQty(c.allowed, t.unit) : t.deducts_overtime ? "Heures sup." : "Sans plafond"}</td>
      <td>${fmtQty(used(t.code, "approuvee"), t.unit)}</td>
      <td>${fmtQty(used(t.code, "en_attente"), t.unit)}</td>
      <td>${t.has_counter ? `<b class="${c.left < 0 ? "neg" : ""}">${fmtQty(c.left, t.unit)}</b>` : t.deducts_overtime ? `<b>${fmtH(ctr.overtime(uid))}</b>` : "-"}</td>
      ${forPrint ? "" : `<td class="right">${t.has_counter ? `<button class="btn small ghost" data-alloc="${t.code}">Modifier le droit</button>` : ""}</td>`}</tr>`; }).join("")}
    </tbody></table></div>`;

  const movesTable = (forPrint) => moves.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Heures</th><th>Motif</th><th>Par</th>${forPrint ? "" : "<th></th>"}</tr></thead><tbody>
    ${moves.map((r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td class="${r.hours < 0 ? "neg" : ""}">${fmtH(+r.hours)}</td><td>${esc(r.reason || "")}</td><td>${esc(nameOf(r.created_by))}</td>
      ${forPrint ? "" : `<td class="right">${r.leave_request_id ? `<small class="muted">lié à une demande</small>` : `<button class="btn small ghost" data-mv="${r.id}">Modifier</button> <button class="btn small danger" data-mvdel="${r.id}">Suppr.</button>`}</td>`}</tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">Aucun mouvement.</p>`;

  v.innerHTML = `
    <div class="page-h"><div><a href="#/compteurs" class="back">← Compteurs</a><h2>${esc(p.full_name)}</h2></div>
      <div class="row"><label class="inline">Année <select id="yr">${[year - 1, year, year + 1].map((y) => `<option ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      <button class="btn ghost" id="pr">🖨 Imprimer la fiche</button></div></div>
    <div class="grid2">
      <section class="panel">
        <h3>Identité</h3>
        <dl class="dl"><dt>Rôle</dt><dd>${ROLES[p.role]}</dd><dt>E-mail</dt><dd><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></dd>
          <dt>Téléphone</dt><dd>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : "-"}</dd>
          <dt>Statut</dt><dd>${p.active ? "Actif" : "Désactivé"}</dd></dl>
        <div class="kpis" style="margin-top:12px">
          <div class="kpi"><span>Heures supplémentaires</span><b class="${ctr.overtime(uid) < 0 ? "neg" : ""}">${fmtH(ctr.overtime(uid))}</b></div>
          ${active.filter((t) => t.has_counter).map((t) => { const c = ctr.counter(uid, t.code); return `<div class="kpi"><span>${esc(t.label)}</span><b class="${c.left < 0 ? "neg" : ""}">${fmtQty(c.left, t.unit)}</b><small>sur ${fmtQty(c.allowed, t.unit)}</small></div>`; }).join("")}
        </div>
      </section>
      <section class="panel">
        <div class="row between"><h3>Heures supplémentaires</h3><button class="btn small" id="ot">+ Ajuster</button></div>
        ${movesTable(false)}
      </section>
    </div>
    <section class="panel">
      <div class="row between"><h3>Congés disponibles ${year}</h3>
        <button class="btn small ghost" id="newtype">+ Nouveau type de congé</button></div>
      ${typesTable(false)}
    </section>
    <section class="panel">
      <h3>Demandes ${year}</h3>
      ${leaveTable(reqs, { edit: true })}
    </section>`;

  const refresh = () => renderWorkerSheet(uid);
  v.querySelector("#yr").onchange = (e) => { sessionStorage.setItem("mm_cyear", e.target.value); refresh(); };
  v.querySelector("#ot").onclick = () => adjustOvertime(uid, refresh);
  v.querySelector("#newtype").onclick = () => leaveTypeForm(null, refresh);
  v.querySelectorAll("[data-alloc]").forEach((b) => (b.onclick = () => editAllocation(uid, b.dataset.alloc, year, ctr.counter(uid, b.dataset.alloc).alloc, refresh)));
  v.querySelectorAll("[data-mvdel]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Supprimer ce mouvement d'heures sup. ?"))) return;
    busy(b, async () => { await q(sb.from("overtime_adjustments").delete().eq("id", b.dataset.mvdel)); refresh(); });
  }));
  v.querySelectorAll("[data-mv]").forEach((b) => (b.onclick = () => {
    const r = moves.find((x) => String(x.id) === b.dataset.mv);
    const m2 = modal("Modifier le mouvement", `<form class="form" id="mf">
      <label>Heures<input type="number" step="0.25" name="hours" required value="${r.hours}"></label>
      <label>Motif<input name="reason" value="${esc(r.reason || "")}"></label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
    const f = m2.el.querySelector("#mf");
    f.onsubmit = (e) => { e.preventDefault(); busy(f.querySelector("button"), async () => {
      await q(sb.from("overtime_adjustments").update({ hours: +f.hours.value, reason: f.reason.value }).eq("id", r.id)); m2.close(); refresh(); }); };
  }));
  bindLeaveActions(v, refresh);
  v.querySelector("#pr").onclick = () => printDoc(`Fiche congés ${year} · ${p.full_name}`, `
    <div class="kpis">${v.querySelector(".kpis").innerHTML}</div>
    <h3>Congés disponibles ${year}</h3>${typesTable(true)}
    <h3>Demandes ${year}</h3>${leaveTable(reqs, {}).replace(/<button[^>]*>.*?<\/button>/g, "")}
    <h3>Mouvements d'heures supplémentaires</h3>${movesTable(true)}`, { subtitle: `${ROLES[p.role]} · ${p.email}` });
}

// =====================================================================
// TYPES DE CONGÉS (admin / RH)
// =====================================================================
export async function renderLeaveTypes() {
  if (!isStaff()) return (location.hash = "#/conges");
  const v = view();
  const types = await loadLeaveTypes();
  v.innerHTML = `
    <div class="page-h"><h2>Types de congés et absences</h2><button class="btn" id="add">+ Nouveau type</button></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Libellé</th><th>Unité</th><th>Compteur annuel</th><th>Débite heures sup.</th><th>Ordre</th><th>Statut</th><th></th></tr></thead><tbody>
    ${types.map((t) => `<tr class="${t.active ? "" : "inactive"}"><td><span class="dot" style="background:${esc(t.color)}"></span><b>${esc(t.label)}</b><br><small class="muted">${esc(t.code)}</small></td>
      <td>${t.unit}</td><td>${t.has_counter ? "Oui" : "Non"}</td><td>${t.deducts_overtime ? "Oui" : "Non"}</td><td>${t.sort}</td>
      <td>${t.active ? `<span class="badge st-terminee">Actif</span>` : `<span class="badge st-annulee">Inactif</span>`}</td>
      <td class="right"><button class="btn small ghost" data-edit="${esc(t.code)}">Modifier</button> <button class="btn small danger" data-del="${esc(t.code)}">Supprimer</button></td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted small">Exemples : congé annuel (20 j), jours fériés compensatoires, petit chômage, congé sans solde, formation. Un type déjà utilisé ne peut pas être supprimé : désactivez-le.</p>`;
  v.querySelector("#add").onclick = () => leaveTypeForm();
  v.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => leaveTypeForm(types.find((t) => t.code === b.dataset.edit))));
  v.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Supprimer ce type de congé ?"))) return;
    const { error } = await sb.from("leave_types").delete().eq("code", b.dataset.del);
    if (error) toast("Type utilisé par des demandes : désactivez-le plutôt que de le supprimer", "warn");
    renderLeaveTypes();
  }));
}

function leaveTypeForm(t = null, onDone = renderLeaveTypes) {
  const md = modal(t ? `Modifier « ${t.label} »` : "Nouveau type de congé", `
    <form class="form" id="tf">
      <label>Libellé *<input name="label" required value="${esc(t?.label || "")}" placeholder="Ex. Petit chômage"></label>
      <div class="grid2">
        <label>Unité<select name="unit"><option value="jours" ${t?.unit !== "heures" ? "selected" : ""}>Jours</option><option value="heures" ${t?.unit === "heures" ? "selected" : ""}>Heures</option></select></label>
        <label>Couleur<input type="color" name="color" value="${esc(t?.color || "#95C11F")}"></label>
        <label>Ordre d'affichage<input type="number" name="sort" value="${t?.sort ?? 10}"></label>
      </div>
      <label class="check"><input type="checkbox" name="has_counter" ${t?.has_counter ?? true ? "checked" : ""}> Suivre un compteur annuel (droit alloué / pris / solde)</label>
      <label class="check"><input type="checkbox" name="deducts_overtime" ${t?.deducts_overtime ? "checked" : ""}> Débite le compteur d'heures supplémentaires</label>
      <label class="check"><input type="checkbox" name="active" ${t?.active ?? true ? "checked" : ""}> Actif (proposé dans les demandes)</label>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
  const f = md.el.querySelector("#tf");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const row = {
        label: f.label.value.trim(), unit: f.unit.value, color: f.color.value, sort: +f.sort.value || 10,
        has_counter: f.has_counter.checked, deducts_overtime: f.deducts_overtime.checked, active: f.active.checked,
      };
      if (t) await q(sb.from("leave_types").update(row).eq("code", t.code));
      else {
        const code = row.label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
        await q(sb.from("leave_types").insert({ ...row, code }));
      }
      md.close(); toast(t ? "Type de congé modifié" : "Type de congé créé"); onDone();
    });
  };
}

// =====================================================================
// RÉCAPITULATIF RH DES PRESTATIONS : une ligne par jour et par chantier
// =====================================================================
// Bornes de la période affichée (jour, semaine ISO lundi-dimanche, mois)
function periodRange(ref, mode) {
  const d = new Date(ref + "T12:00:00");
  if (mode === "jour") return { from: ref, to: ref, label: d.toLocaleDateString("fr-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) };
  if (mode === "semaine") {
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const thu = new Date(mon); thu.setDate(mon.getDate() + 3);
    const wk = 1 + Math.round(((thu - new Date(thu.getFullYear(), 0, 4)) / 864e5 - 3 + ((new Date(thu.getFullYear(), 0, 4).getDay() + 6) % 7)) / 7);
    return { from: todayStr(mon), to: todayStr(sun), label: `Semaine ${wk} · du ${fmtDate(todayStr(mon))} au ${fmtDate(todayStr(sun))}` };
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: todayStr(first), to: todayStr(last), label: first.toLocaleDateString("fr-BE", { month: "long", year: "numeric" }) };
}
function shiftRef(ref, mode, dir) {
  const d = new Date(ref + "T12:00:00");
  if (mode === "jour") d.setDate(d.getDate() + dir);
  else if (mode === "semaine") d.setDate(d.getDate() + 7 * dir);
  else d.setMonth(d.getMonth() + dir, 1);
  return todayStr(d);
}

export async function renderRecap() {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  await loadProfiles();
  const saved = JSON.parse(sessionStorage.getItem("mm_recap2") || "{}");
  let mode = saved.mode || "semaine";
  let ref = saved.ref || todayStr();
  let who = saved.who || "";

  v.innerHTML = `
    <div class="page-h"><h2>Récapitulatif des prestations</h2>
      <div><button type="button" class="btn ghost" id="csv">Export CSV</button> <button type="button" class="btn ghost" id="prt">🖨 Imprimer</button></div></div>
    <div class="filters">
      <div class="seg" id="mode">${["jour", "semaine", "mois"].map((m) => `<button type="button" data-m="${m}" class="${m === mode ? "on" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
      <div class="row nav-period"><button type="button" class="btn ghost small" id="prev">◀</button>
        <input type="date" id="ref" value="${ref}"><button type="button" class="btn ghost small" id="next">▶</button>
        <button type="button" class="btn ghost small" id="today">Aujourd'hui</button></div>
      <label>Collaborateur<select id="who"><option value="">Tous</option>${state.profiles.map((p) => `<option value="${p.id}" ${p.id === who ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select></label>
    </div>
    <h3 id="plabel"></h3>
    <div id="out"><p class="muted">Chargement…</p></div>`;

  let rows = [], range = null;

  const load = async () => {
    sessionStorage.setItem("mm_recap2", JSON.stringify({ mode, ref, who }));
    range = periodRange(ref, mode);
    v.querySelector("#plabel").textContent = range.label.charAt(0).toUpperCase() + range.label.slice(1);
    v.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
    v.querySelector("#ref").value = ref;
    let qy = sb.from("time_entries").select("*, missions(id, title, clients(name))")
      .gte("work_date", range.from).lte("work_date", range.to).order("work_date").order("site_arrival");
    if (who) qy = qy.eq("user_id", who);
    const data = await q(qy);
    rows = data.map((e) => ({
      e, date: e.work_date, user: e.user_id,
      travel: hoursBetween(e.workshop_arrival, e.site_arrival),
      site: hoursBetween(e.site_arrival, e.site_end),
      total: hoursBetween(e.workshop_arrival, e.site_end),
    })).sort((a, b) => a.date.localeCompare(b.date) || nameOf(a.user).localeCompare(nameOf(b.user)));

    // Totaux par collaborateur sur la période
    const per = new Map();
    for (const r of rows) {
      const t = per.get(r.user) || { site: 0, total: 0, days: new Set() };
      t.site += r.site; t.total += r.total; t.days.add(r.date); per.set(r.user, t);
    }
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);

    v.querySelector("#out").innerHTML = rows.length ? `
      <div class="kpis">${[...per.entries()].sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0]))).map(([u, t]) => `<div class="kpi"><span>${esc(nameOf(u))}</span><b>${fmtH(t.total)}</b>
        <small>${t.days.size} j · chantier ${fmtH(t.site)}</small></div>`).join("")}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Collaborateur</th><th>Chantier</th><th>Arrivée atelier</th><th>Arrivée chantier</th><th>Fin</th>
        <th>Trajet</th><th>Sur chantier</th><th>Total</th><th>Remarques</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${i && rows[i - 1].date !== r.date ? "day-sep" : ""}">
        <td>${new Date(r.date + "T12:00:00").toLocaleDateString("fr-BE", { weekday: "short", day: "2-digit", month: "2-digit" })}</td>
        <td>${esc(nameOf(r.user))}</td>
        <td><a href="#/mission/${r.e.mission_id}">${esc(r.e.missions?.title || "#" + r.e.mission_id)}</a><br><small class="muted">${esc(r.e.missions?.clients?.name || "")}</small></td>
        <td>${fmtTime(r.e.workshop_arrival)}</td><td>${fmtTime(r.e.site_arrival)}</td>
        <td>${r.e.site_end ? fmtTime(r.e.site_end) : `<span class="badge st-annulee">En cours / incomplet</span>`}</td>
        <td>${fmtH(r.travel)}</td><td>${fmtH(r.site)}</td><td><b>${fmtH(r.total)}</b></td>
        <td class="small">${[r.e.note, r.e.technical_note && "Tech. : " + r.e.technical_note, r.e.exclusion_note && "Excl. : " + r.e.exclusion_note].filter(Boolean).map(esc).join("<br>")}</td></tr>`).join("")}
      </tbody><tfoot><tr><th colspan="6">Total période (${rows.length} prestation${rows.length > 1 ? "s" : ""})</th><th>${fmtH(sum("travel"))}</th><th>${fmtH(sum("site"))}</th><th>${fmtH(sum("total"))}</th><th></th></tr></tfoot></table></div>
      <p class="muted small">Total = arrivée atelier → fin de chantier. Trajet = atelier → arrivée chantier.</p>`
      : `<p class="muted">Aucune prestation sur cette période.</p>`;
  };

  const reload = () => load().catch((er) => toast(er.message, "err"));
  v.querySelectorAll("#mode button").forEach((b) => (b.onclick = () => { mode = b.dataset.m; reload(); }));
  v.querySelector("#prev").onclick = () => { ref = shiftRef(ref, mode, -1); reload(); };
  v.querySelector("#next").onclick = () => { ref = shiftRef(ref, mode, 1); reload(); };
  v.querySelector("#today").onclick = () => { ref = todayStr(); reload(); };
  v.querySelector("#ref").onchange = (e) => { if (e.target.value) { ref = e.target.value; reload(); } };
  v.querySelector("#who").onchange = (e) => { who = e.target.value; reload(); };

  v.querySelector("#csv").onclick = () => downloadCsv(`prestations_${range.from}_${range.to}.csv`, [
    ["Date", "Collaborateur", "Chantier", "Client", "Arrivée atelier", "Arrivée chantier", "Fin chantier", "Trajet (h)", "Sur chantier (h)", "Total (h)", "Note", "Remarque technique", "Exclusion"],
    ...rows.map((r) => [fmtDate(r.date), nameOf(r.user), r.e.missions?.title, r.e.missions?.clients?.name, fmtTime(r.e.workshop_arrival), fmtTime(r.e.site_arrival),
      fmtTime(r.e.site_end), r.travel.toFixed(2), r.site.toFixed(2), r.total.toFixed(2), r.e.note, r.e.technical_note, r.e.exclusion_note]),
  ]);
  v.querySelector("#prt").onclick = () => printDoc("Récapitulatif des prestations", v.querySelector("#out").innerHTML, {
    landscape: true, subtitle: `${v.querySelector("#plabel").textContent}${who ? " · " + nameOf(who) : ""}`,
  });
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
