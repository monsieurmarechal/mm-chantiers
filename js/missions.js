import {
  sb, state, q, esc, view, toast, modal, confirmBox, busy, formData, isStaff, isAdmin, callFn,
  STATUS, todayStr, fmtDate, fmtTime, fmtDateTime, fmtH, hoursBetween, toIso, toHHMM, nowHHMM, nameOf, loadProfiles, printDoc,
} from "./core.js";
import { locateFromWorkshop, startTracking, stopTracking, sendPositionOnce } from "./geo.js";

const statusBadge = (s) => `<span class="badge st-${s}">${STATUS[s] || s}</span>`;
const mapsLink = (m) => m.lat
  ? `https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}`;
const wazeLink = (m) => m.lat ? `https://waze.com/ul?ll=${m.lat},${m.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(m.address)}`;

// =====================================================================
// LISTE DES MISSIONS
// =====================================================================
export async function renderList() {
  const v = view();
  const staff = isStaff();
  const saved = JSON.parse(sessionStorage.getItem("mm_filter") || "{}");
  const from = saved.from || todayStr(new Date(Date.now() - 7 * 864e5));
  const to = saved.to || todayStr(new Date(Date.now() + 30 * 864e5));
  const st = saved.status || "";
  v.innerHTML = `
    <div class="page-h"><h2>${staff ? "Ordres de mission" : "Mes chantiers"}</h2>
      ${staff ? `<a class="btn" href="#/mission/new">+ Nouvel ordre de mission</a>` : ""}</div>
    <form class="filters" id="flt">
      <label>Du <input type="date" name="from" value="${from}"></label>
      <label>Au <input type="date" name="to" value="${to}"></label>
      <label>Statut <select name="status"><option value="">Tous</option>
        ${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === st ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button class="btn ghost">Filtrer</button>
    </form>
    <div id="list" class="cards"><p class="muted">Chargement…</p></div>`;

  const load = async () => {
    const f = formData($f);
    sessionStorage.setItem("mm_filter", JSON.stringify(f));
    let query = sb.from("missions").select("*, clients(name), mission_members(user_id)")
      .lte("scheduled_date", f.to).order("scheduled_date").order("start_time");
    // Inclut les chantiers de plusieurs jours encore actifs dans la période
    query = query.or(`scheduled_date.gte.${f.from},end_date.gte.${f.from}`);
    if (f.status) query = query.eq("status", f.status);
    const rows = await q(query);
    const list = v.querySelector("#list");
    if (!rows.length) { list.innerHTML = `<p class="muted">Aucun chantier sur la période.</p>`; return; }
    list.innerHTML = rows.map((m) => `
      <a class="card mission" href="#/mission/${m.id}">
        <div class="card-top"><span class="date">${fmtDate(m.scheduled_date)}${m.end_date && m.end_date !== m.scheduled_date ? ` → ${fmtDate(m.end_date)}` : ""}
          ${m.start_time ? ` · ${m.start_time.slice(0, 5)}` : ""}</span>${statusBadge(m.status)}</div>
        <h3>${esc(m.title)}</h3>
        <div class="muted">${esc(m.clients?.name || "")}</div>
        <div class="addr">📍 ${esc(m.address)}${m.distance_km != null ? ` · <b>${m.distance_km} km</b>` : ""}</div>
        <div class="team">👷 ${m.mission_members.map((x) => esc(nameOf(x.user_id)) + (x.user_id === m.team_leader_id ? " ★" : "")).join(", ") || "<i>Aucun collaborateur</i>"}</div>
      </a>`).join("");
  };
  const $f = v.querySelector("#flt");
  $f.onsubmit = (e) => { e.preventDefault(); load().catch((er) => toast(er.message, "err")); };
  await load();
}

// =====================================================================
// FORMULAIRE ORDRE DE MISSION (admin / RH)
// =====================================================================
export async function renderForm(id, params = {}) {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  const [clients, tools] = await Promise.all([
    q(sb.from("clients").select("*").order("name")),
    q(sb.from("tools").select("*").order("name")),
    loadProfiles(),
  ]);
  let m = { scheduled_date: todayStr(), status: "planifiee" }, members = [], mtools = [];
  const pre = clients.find((c) => String(c.id) === params.client);
  if (pre) Object.assign(m, { client_id: pre.id, address: pre.address, lat: pre.lat, lng: pre.lng, distance_km: pre.distance_km, duration_min: pre.duration_min });
  if (id) {
    m = await q(sb.from("missions").select("*").eq("id", id).single());
    members = (await q(sb.from("mission_members").select("user_id").eq("mission_id", id))).map((x) => x.user_id);
    mtools = await q(sb.from("mission_tools").select("*").eq("mission_id", id));
  }
  const workers = state.profiles.filter((p) => p.active);
  const toolQty = (tid) => mtools.find((t) => t.tool_id === tid)?.qty;

  v.innerHTML = `
    <div class="page-h"><h2>${id ? `Modifier l'ordre #${id}` : "Nouvel ordre de mission"}</h2></div>
    <form id="mf" class="form grid2">
      <fieldset class="span2"><legend>Client et chantier</legend>
        <div class="grid2">
          <label>Client existant
            <select name="client_id" id="client"><option value="">- Sélectionner -</option>
            ${clients.map((c) => `<option value="${c.id}" ${c.id === m.client_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
            </select><small><a href="#/clients">Gérer la base clients</a></small></label>
          <label>Intitulé du chantier *<input name="title" required value="${esc(m.title || "")}" placeholder="Ex. Pose de clôture 25 m"></label>
          <label class="span2">Adresse du chantier *
            <div class="row"><input name="address" id="addr" required value="${esc(m.address || "")}" placeholder="Rue, n°, code postal, commune">
            <button type="button" class="btn ghost" id="calc">Calculer la distance</button></div></label>
          <div class="span2 info" id="distinfo">${m.distance_km != null ? `Distance depuis l'atelier : <b>${m.distance_km} km</b> · ~${m.duration_min} min de trajet` : "Distance non calculée"}</div>
        </div>
      </fieldset>
      <fieldset><legend>Planning</legend>
        <label>Date de début *<input type="date" name="scheduled_date" required value="${m.scheduled_date}"></label>
        <label>Date de fin (si plusieurs jours)<input type="date" name="end_date" value="${m.end_date || ""}"></label>
        <label>Heure de présence sur place<input type="time" name="start_time" value="${(m.start_time || "").slice(0, 5)}"></label>
        <label>Statut<select name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === m.status ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </fieldset>
      <fieldset><legend>Équipe</legend>
        <div class="checks" id="members">${workers.map((p) => `
          <label class="check"><input type="checkbox" name="m_${p.id}" value="${p.id}" ${members.includes(p.id) ? "checked" : ""}> ${esc(p.full_name || p.email)}</label>`).join("")}</div>
        <label>Chef d'équipe (fait signer le client)<select name="team_leader_id" id="leader"></select></label>
      </fieldset>
      <fieldset class="span2"><legend>Travail à réaliser</legend>
        <label>Description du travail<textarea name="description" rows="4">${esc(m.description || "")}</textarea></label>
        <label>Matériel à emporter (matériaux, fournitures)<textarea name="materials" rows="3">${esc(m.materials || "")}</textarea></label>
      </fieldset>
      <fieldset class="span2"><legend>Outillage spécifique (magasin central)</legend>
        <input type="search" id="toolsearch" placeholder="Filtrer les outils…">
        <div class="tools-pick">${tools.length ? tools.map((t) => `
          <label class="check tool" data-name="${esc((t.name + " " + (t.category || "")).toLowerCase())}">
            <input type="checkbox" name="t_${t.id}" ${toolQty(t.id) ? "checked" : ""}> ${esc(t.name)}
            <span class="muted">${esc(t.category || "")}</span>
            <input type="number" min="1" max="${t.quantity}" name="q_${t.id}" value="${toolQty(t.id) || 1}" class="qty"></label>`).join("")
            : `<p class="muted">Aucun outil. <a href="#/outils">Créer la liste d'outils</a></p>`}</div>
      </fieldset>
      <fieldset class="span2"><legend>Plans et documents</legend>
        <input type="file" name="files" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.dwg">
        <div id="existingfiles"></div>
      </fieldset>
      <input type="hidden" name="lat" value="${m.lat ?? ""}"><input type="hidden" name="lng" value="${m.lng ?? ""}">
      <input type="hidden" name="distance_km" value="${m.distance_km ?? ""}"><input type="hidden" name="duration_min" value="${m.duration_min ?? ""}">
      <div class="actions span2"><a class="btn ghost" href="${id ? `#/mission/${id}` : "#/missions"}">Annuler</a>
        <button class="btn" id="save">Enregistrer l'ordre de mission</button></div>
    </form>`;

  const f = v.querySelector("#mf");
  const addrInput = f.querySelector("#addr");

  // Liste des chefs d'équipe = membres cochés
  const refreshLeader = () => {
    const sel = [...f.querySelectorAll("#members input:checked")].map((i) => i.value);
    const cur = f.querySelector("#leader").value || m.team_leader_id;
    f.querySelector("#leader").innerHTML = sel.length
      ? sel.map((uid) => `<option value="${uid}" ${uid === cur ? "selected" : ""}>${esc(nameOf(uid))}</option>`).join("")
      : `<option value="">- Cocher au moins un collaborateur -</option>`;
  };
  f.querySelector("#members").addEventListener("change", refreshLeader);
  refreshLeader();

  f.querySelector("#toolsearch").oninput = (e) => {
    const s = e.target.value.toLowerCase();
    f.querySelectorAll(".tool").forEach((el) => (el.style.display = el.dataset.name.includes(s) ? "" : "none"));
  };

  const calc = async () => {
    const r = await locateFromWorkshop(addrInput.value);
    f.lat.value = r.lat; f.lng.value = r.lng;
    f.distance_km.value = r.km ?? ""; f.duration_min.value = r.min ?? "";
    f.querySelector("#distinfo").innerHTML = r.km != null
      ? `Distance depuis l'atelier : <b>${r.km} km</b> · ~${r.min} min de trajet${r.approx ? " (estimation)" : ""}<br><small class="muted">${esc(r.label)}</small>`
      : `<small>${esc(r.label)}</small>`;
  };
  f.querySelector("#calc").onclick = (e) => busy(e.target, calc);
  addrInput.addEventListener("change", () => { f.lat.value = ""; });

  f.querySelector("#client").onchange = async (e) => {
    const c = clients.find((x) => String(x.id) === e.target.value);
    if (!c) return;
    addrInput.value = c.address;
    if (c.lat) {
      f.lat.value = c.lat; f.lng.value = c.lng; f.distance_km.value = c.distance_km ?? ""; f.duration_min.value = c.duration_min ?? "";
      f.querySelector("#distinfo").innerHTML = c.distance_km != null
        ? `Distance depuis l'atelier : <b>${c.distance_km} km</b> · ~${c.duration_min} min de trajet` : "Distance non calculée";
    } else busy(null, calc);
  };

  if (id) renderFiles(id, f.querySelector("#existingfiles"), true);

  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("#save"), async () => {
      if (!f.lat.value && addrInput.value) await calc().catch((er) => toast(er.message, "warn"));
      const d = formData(f);
      const memberIds = [...f.querySelectorAll("#members input:checked")].map((i) => i.value);
      const row = {
        client_id: d.client_id ? +d.client_id : null, title: d.title, address: d.address,
        lat: d.lat ? +d.lat : null, lng: d.lng ? +d.lng : null,
        distance_km: d.distance_km ? +d.distance_km : null, duration_min: d.duration_min ? +d.duration_min : null,
        scheduled_date: d.scheduled_date, end_date: d.end_date || null, start_time: d.start_time || null,
        description: d.description, materials: d.materials, status: d.status,
        team_leader_id: memberIds.length ? (d.team_leader_id || memberIds[0]) : null,
      };
      let mid = id;
      if (id) await q(sb.from("missions").update(row).eq("id", id));
      else mid = (await q(sb.from("missions").insert({ ...row, created_by: state.session.user.id }).select("id").single())).id;

      await q(sb.from("mission_members").delete().eq("mission_id", mid));
      if (memberIds.length) await q(sb.from("mission_members").insert(memberIds.map((u) => ({ mission_id: mid, user_id: u }))));

      const toolRows = tools.filter((t) => f[`t_${t.id}`]?.checked).map((t) => ({ mission_id: mid, tool_id: t.id, qty: +f[`q_${t.id}`].value || 1 }));
      await q(sb.from("mission_tools").delete().eq("mission_id", mid));
      if (toolRows.length) await q(sb.from("mission_tools").insert(toolRows));

      for (const file of f.files.files) await uploadFile(mid, file);
      toast("Ordre de mission enregistré");
      location.hash = `#/mission/${mid}`;
    });
  };
}

async function uploadFile(mid, file) {
  const safe = file.name.normalize("NFD").replace(/[^\w.\-]/g, "_");
  const path = `${mid}/${Date.now()}_${safe}`;
  const { error } = await sb.storage.from("mission-files").upload(path, file);
  if (error) throw new Error(`Envoi de ${file.name} : ${error.message}`);
  await q(sb.from("mission_files").insert({ mission_id: mid, path, name: file.name }));
}

async function renderFiles(mid, el, canDelete) {
  const files = await q(sb.from("mission_files").select("*").eq("mission_id", mid).order("created_at"));
  if (!files.length) { el.innerHTML = `<p class="muted">Aucun document joint.</p>`; return; }
  const { data: urls } = await sb.storage.from("mission-files").createSignedUrls(files.map((x) => x.path), 3600);
  el.innerHTML = `<ul class="files">${files.map((x, i) => `<li><a href="${urls?.[i]?.signedUrl || "#"}" target="_blank" rel="noopener">📎 ${esc(x.name)}</a>
    ${canDelete ? `<button type="button" class="icon-btn" data-del="${x.id}" title="Supprimer">🗑</button>` : ""}</li>`).join("")}</ul>`;
  el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const x = files.find((y) => String(y.id) === b.dataset.del);
    if (!(await confirmBox(`Supprimer ${x.name} ?`))) return;
    await sb.storage.from("mission-files").remove([x.path]);
    await sb.from("mission_files").delete().eq("id", x.id);
    renderFiles(mid, el, canDelete);
  }));
}

// =====================================================================
// FICHE MISSION + POINTAGE
// =====================================================================
export async function renderDetail(id) {
  const v = view();
  const uid = state.session.user.id;
  const m = await q(sb.from("missions").select("*, clients(*)").eq("id", id).single());
  const [members, mtools, reports] = await Promise.all([
    q(sb.from("mission_members").select("user_id").eq("mission_id", id)),
    q(sb.from("mission_tools").select("qty, tools(name, category, location)").eq("mission_id", id)),
    q(sb.from("day_reports").select("*").eq("mission_id", id).order("work_date", { ascending: false })),
  ]);
  if (!state.profiles.length) await loadProfiles();
  const memberIds = members.map((x) => x.user_id);
  const isMember = memberIds.includes(uid);
  const isLeader = m.team_leader_id === uid;
  const staff = isStaff();

  // Date de travail : aujourd'hui si dans la période, sinon date de début
  const t = todayStr();
  const last = m.end_date || m.scheduled_date;
  let workDate = sessionStorage.getItem(`mm_wd_${id}`) || (t >= m.scheduled_date && t <= last ? t : m.scheduled_date);

  v.innerHTML = `
    <div class="page-h"><div><a href="#/missions" class="back">← Chantiers</a>
      <h2>${esc(m.title)} <small class="muted">#${m.id}</small></h2></div>${statusBadge(m.status)}</div>
    <div class="grid2">
      <section class="panel">
        <h3>Ordre de mission</h3>
        <dl class="dl">
          <dt>Client</dt><dd>${esc(m.clients?.name || "-")}${m.clients?.phone ? ` · <a href="tel:${esc(m.clients.phone)}">${esc(m.clients.phone)}</a>` : ""}</dd>
          <dt>Adresse</dt><dd>${esc(m.address)}<br><a href="${mapsLink(m)}" target="_blank" rel="noopener">Itinéraire Google Maps</a> · <a href="${wazeLink(m)}" target="_blank" rel="noopener">Waze</a></dd>
          <dt>Distance atelier</dt><dd>${m.distance_km != null ? `${m.distance_km} km · ~${m.duration_min} min` : "-"}</dd>
          <dt>Date</dt><dd>${fmtDate(m.scheduled_date)}${m.end_date && m.end_date !== m.scheduled_date ? ` → ${fmtDate(m.end_date)}` : ""}</dd>
          <dt>Présence sur place</dt><dd><b>${m.start_time ? m.start_time.slice(0, 5) : "-"}</b></dd>
          <dt>Équipe</dt><dd>${memberIds.map((u) => esc(nameOf(u)) + (u === m.team_leader_id ? ` <span class="badge leader">Chef d'équipe</span>` : "")).join("<br>") || "-"}</dd>
        </dl>
        <h4>Description du travail</h4><p class="pre">${esc(m.description || "-")}</p>
        <h4>Matériel à emporter</h4><p class="pre">${esc(m.materials || "-")}</p>
        <h4>Outillage spécifique</h4>
        ${mtools.length ? `<ul>${mtools.map((x) => `<li>${x.qty} × ${esc(x.tools?.name)} <span class="muted">${esc(x.tools?.location || "")}</span></li>`).join("")}</ul>` : `<p class="muted">Aucun</p>`}
        <h4>Plans et documents</h4><div id="files"></div>
        <div class="actions"><button class="btn ghost" id="print">🖨 Imprimer l'ordre de mission</button></div>
        ${staff ? `<div class="actions">
          <a class="btn ghost" href="#/mission/${id}/edit">Modifier</a>
          <button class="btn ghost" id="share">Envoyer l'ordre</button>
          ${isAdmin() ? `<button class="btn danger" id="del">Supprimer</button>` : ""}</div>` : ""}
      </section>
      <section class="panel">
        <div class="row between"><h3>Pointage</h3>
          <label class="inline">Jour <input type="date" id="wd" value="${workDate}" min="${m.scheduled_date}" max="${last}"></label></div>
        <div id="pointage"></div>
        <div id="photos"></div>
        <div id="team"></div>
        <h3>Rapports signés</h3>
        ${reports.length ? `<ul class="files">${reports.map((r) => `<li>${fmtDate(r.work_date)} · ${esc(r.client_name)} · ${fmtDateTime(r.signed_at)}
          ${r.emailed ? `<span class="badge st-terminee">Envoyé</span>` : `<span class="badge st-annulee">Non envoyé</span>`}</li>`).join("")}</ul>` : `<p class="muted">Aucun rapport signé.</p>`}
      </section>
    </div>`;

  renderFiles(id, v.querySelector("#files"), false);

  v.querySelector("#wd").onchange = (e) => {
    workDate = e.target.value;
    sessionStorage.setItem(`mm_wd_${id}`, workDate);
    drawPointage();
  };

  v.querySelector("#print").onclick = async () => {
    const files = await q(sb.from("mission_files").select("name").eq("mission_id", id));
    printDoc(`Ordre de mission n° ${m.id}`, orderPrintHtml(m, memberIds, mtools, files), { subtitle: m.title });
  };

  if (staff) {
    v.querySelector("#share").onclick = () => shareOrder(m, memberIds, mtools);
    const del = v.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!(await confirmBox("Supprimer définitivement cet ordre de mission, ses pointages et rapports ?"))) return;
      busy(del, async () => { await q(sb.from("missions").delete().eq("id", id)); toast("Supprimé"); location.hash = "#/missions"; });
    };
  }

  async function drawPointage() {
    const signed = reports.find((r) => r.work_date === workDate);
    const entries = await q(sb.from("time_entries").select("*").eq("mission_id", id).eq("work_date", workDate));
    const mine = entries.find((e) => e.user_id === uid);
    const pz = v.querySelector("#pointage");

    if (!isMember && !staff) { pz.innerHTML = ""; return; }
    if (isMember) {
      const locked = !!signed && !staff;
      pz.innerHTML = `
        ${signed ? `<div class="info ok">Journée signée par ${esc(signed.client_name)} le ${fmtDateTime(signed.signed_at)}. Pointages verrouillés.</div>` : ""}
        <form id="pf" class="form">
          <div class="punch">
            ${punchField("workshop_arrival", "Arrivée à l'atelier", mine, locked)}
            ${punchField("site_arrival", "Arrivée sur chantier", mine, locked)}
            ${punchField("site_end", "Fin de chantier", mine, locked)}
          </div>
          <div class="info">Temps sur chantier : <b>${fmtH(hoursBetween(mine?.site_arrival, mine?.site_end))}</b> ·
            Journée (atelier → fin) : <b>${fmtH(hoursBetween(mine?.workshop_arrival, mine?.site_end))}</b></div>
          <label>Note<textarea name="note" rows="2" ${locked ? "disabled" : ""}>${esc(mine?.note || "")}</textarea></label>
          <label>Remarque technique<textarea name="technical_note" rows="2" ${locked ? "disabled" : ""}>${esc(mine?.technical_note || "")}</textarea></label>
          <label>Note d'exclusion (travaux non réalisés / hors prestation)<textarea name="exclusion_note" rows="2" ${locked ? "disabled" : ""}>${esc(mine?.exclusion_note || "")}</textarea></label>
          ${locked ? "" : `<button class="btn" id="psave">Enregistrer le pointage</button>`}
        </form>`;
      const pf = pz.querySelector("#pf");
      pf.querySelectorAll("[data-now]").forEach((b) => (b.onclick = () => {
        pf[b.dataset.now].value = nowHHMM();
        save(b);
      }));
      const save = (btn) => busy(btn, async () => {
        const d = formData(pf);
        const row = {
          mission_id: +id, user_id: uid, work_date: workDate,
          workshop_arrival: toIso(workDate, d.workshop_arrival), site_arrival: toIso(workDate, d.site_arrival),
          site_end: toIso(workDate, d.site_end), note: d.note, technical_note: d.technical_note, exclusion_note: d.exclusion_note,
        };
        await q(sb.from("time_entries").upsert(row, { onConflict: "mission_id,user_id,work_date" }));
        sendPositionOnce();
        if (row.workshop_arrival && !row.site_end) startTracking(); else if (row.site_end) stopTracking();
        if (m.status === "planifiee" && staff) await sb.from("missions").update({ status: "en_cours" }).eq("id", id);
        toast("Pointage enregistré");
        drawPointage();
      });
      if (!locked) pf.onsubmit = (e) => { e.preventDefault(); save(pf.querySelector("#psave")); };
    } else pz.innerHTML = "";

    // Photos de réalisation de la journée
    const phz = v.querySelector("#photos");
    if (isMember || staff) renderPhotos(phz, +id, workDate, !!signed && !staff);
    else phz.innerHTML = "";

    // Vue équipe : chef d'équipe et admin/RH
    const tz = v.querySelector("#team");
    if (isLeader || staff) {
      tz.innerHTML = `<h4>Pointages de l'équipe · ${fmtDate(workDate)}</h4>
        <div class="table-wrap"><table class="table"><thead><tr><th>Collaborateur</th><th>Atelier</th><th>Chantier</th><th>Fin</th><th>H. chantier</th>${staff ? "<th></th>" : ""}</tr></thead><tbody>
        ${memberIds.map((u) => { const e = entries.find((x) => x.user_id === u); return `<tr><td>${esc(nameOf(u))}</td>
          <td>${fmtTime(e?.workshop_arrival)}</td><td>${fmtTime(e?.site_arrival)}</td><td>${fmtTime(e?.site_end)}</td>
          <td>${fmtH(hoursBetween(e?.site_arrival, e?.site_end))}${e?.edited_by ? ` <span class="badge" title="${esc(e.edit_reason || "")}">corrigé</span>` : ""}</td>
          ${staff ? `<td class="right"><button class="btn small ghost" data-fix="${u}">${e ? "Corriger" : "Saisir"}</button></td>` : ""}</tr>`; }).join("")}
        </tbody></table></div>
        ${!signed && (isLeader || staff) ? `<a class="btn wide" href="#/mission/${id}/sign/${workDate}">✍ Faire signer le client</a>` : ""}`;
      tz.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = () => editEntryModal({
        entry: entries.find((x) => x.user_id === b.dataset.fix), missionId: id, userId: b.dataset.fix, workDate, onDone: drawPointage,
      })));
    } else tz.innerHTML = isMember && m.team_leader_id ? `<p class="muted small">La signature client est recueillie par ${esc(nameOf(m.team_leader_id))} (chef d'équipe).</p>` : "";
  }
  await drawPointage();
}

// =====================================================================
// PHOTOS DE RÉALISATION
// =====================================================================
const PHOTO_MAX_PX = 1600;   // côté le plus long après compression
const PHOTO_QUALITY = 0.8;   // JPEG : ~200 à 400 Ko par photo

// Redimensionne et compresse la photo dans le téléphone avant envoi
async function compressImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res) => c.toBlob(res, "image/jpeg", PHOTO_QUALITY));
}

async function loadPhotos(missionId, workDate) {
  const rows = await q(sb.from("mission_photos").select("*").eq("mission_id", missionId).eq("work_date", workDate).order("created_at"));
  if (!rows.length) return [];
  const { data: urls } = await sb.storage.from("mission-photos").createSignedUrls(rows.map((p) => p.path), 3600);
  return rows.map((p, i) => ({ ...p, url: urls?.[i]?.signedUrl }));
}

function galleryHtml(photos, { canDelete = () => false } = {}) {
  if (!photos.length) return `<p class="muted small">Aucune photo pour cette journée.</p>`;
  return `<div class="gallery">${photos.map((p) => `
    <figure><a href="${p.url}" target="_blank" rel="noopener"><img src="${p.url}" alt="${esc(p.caption || "Photo chantier")}" loading="lazy"></a>
      <figcaption>${esc(p.caption || "")}<small>${esc(nameOf(p.user_id))} · ${fmtTime(p.created_at)}</small></figcaption>
      ${canDelete(p) ? `<button type="button" class="icon-btn del" data-delphoto="${p.id}" title="Supprimer">🗑</button>` : ""}
    </figure>`).join("")}</div>`;
}

async function renderPhotos(el, missionId, workDate, locked) {
  const uid = state.session.user.id;
  const photos = await loadPhotos(missionId, workDate);
  el.innerHTML = `
    <h4>Photos de réalisation · ${fmtDate(workDate)} <span class="badge">${photos.length}</span></h4>
    ${locked ? "" : `<div class="photo-add">
      <label class="btn ghost small">📷 Prendre une photo<input type="file" accept="image/*" capture="environment" hidden data-ph></label>
      <label class="btn ghost small">🖼 Galerie<input type="file" accept="image/*" multiple hidden data-ph></label>
      <input type="text" id="phcap" placeholder="Légende (facultatif) : avant, après, détail…">
    </div><div id="phprog" class="muted small"></div>`}
    ${galleryHtml(photos, { canDelete: (p) => isStaff() || (!locked && p.user_id === uid) })}`;

  el.querySelectorAll("[data-ph]").forEach((inp) => (inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    const prog = el.querySelector("#phprog");
    const caption = el.querySelector("#phcap").value.trim() || null;
    let ok = 0;
    for (const [i, f] of files.entries()) {
      prog.textContent = `Envoi ${i + 1} / ${files.length}…`;
      try {
        const blob = await compressImage(f);
        const path = `${missionId}/${workDate}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
        const up = await sb.storage.from("mission-photos").upload(path, blob, { contentType: "image/jpeg" });
        if (up.error) throw new Error(up.error.message);
        await q(sb.from("mission_photos").insert({ mission_id: missionId, work_date: workDate, user_id: uid, path, caption }));
        ok++;
      } catch (e) { toast(`${f.name} : ${e.message}`, "err"); }
    }
    sendPositionOnce();
    toast(`${ok} photo(s) ajoutée(s)`);
    renderPhotos(el, missionId, workDate, locked);
  }));

  el.querySelectorAll("[data-delphoto]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Supprimer cette photo ?"))) return;
    const p = photos.find((x) => String(x.id) === b.dataset.delphoto);
    busy(b, async () => {
      await q(sb.from("mission_photos").delete().eq("id", p.id));
      await sb.storage.from("mission-photos").remove([p.path]);
      renderPhotos(el, missionId, workDate, locked);
    });
  }));
}

// =====================================================================
// CORRECTION D'UN POINTAGE PAR ADMIN / RH (y compris après signature)
// =====================================================================
export async function editEntryModal({ entry = null, missionId, userId, workDate, onDone }) {
  if (!isStaff()) return;
  if (!state.profiles.length) await loadProfiles();
  const mid = entry?.mission_id ?? +missionId, uid = entry?.user_id ?? userId, wd = entry?.work_date ?? workDate;
  const [rep] = await q(sb.from("day_reports").select("client_name, signed_at").eq("mission_id", mid).eq("work_date", wd));
  const md = modal(`Pointage · ${nameOf(uid)} · ${fmtDate(wd)}`, `
    ${rep ? `<div class="info warn">Journée signée par ${esc(rep.client_name)} le ${fmtDateTime(rep.signed_at)}. La correction est tracée ; le rapport déjà envoyé n'est pas modifié.</div>` : ""}
    ${entry?.edited_by ? `<p class="muted small">Dernière correction par ${esc(nameOf(entry.edited_by))} le ${fmtDateTime(entry.edited_at)}${entry.edit_reason ? ` : ${esc(entry.edit_reason)}` : ""}</p>` : ""}
    <form class="form" id="ef">
      <div class="grid2">
        <label>Arrivée à l'atelier<input type="time" name="workshop_arrival" value="${toHHMM(entry?.workshop_arrival)}"></label>
        <label>Arrivée sur chantier<input type="time" name="site_arrival" value="${toHHMM(entry?.site_arrival)}"></label>
        <label>Fin de chantier<input type="time" name="site_end" value="${toHHMM(entry?.site_end)}"></label>
      </div>
      <label>Note<textarea name="note" rows="2">${esc(entry?.note || "")}</textarea></label>
      <label>Remarque technique<textarea name="technical_note" rows="2">${esc(entry?.technical_note || "")}</textarea></label>
      <label>Note d'exclusion<textarea name="exclusion_note" rows="2">${esc(entry?.exclusion_note || "")}</textarea></label>
      <label>Motif de la correction${rep ? " *" : ""}<input name="edit_reason" ${rep ? "required" : ""} placeholder="Ex. oubli de pointage de fin, erreur d'heure"></label>
      <div class="actions">${entry ? `<button type="button" class="btn danger" id="del">Supprimer le pointage</button>` : ""}<button class="btn" id="sv">Enregistrer</button></div>
    </form>`, { wide: true });
  const f = md.el.querySelector("#ef");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("#sv"), async () => {
      const d = formData(f);
      const row = {
        workshop_arrival: toIso(wd, d.workshop_arrival), site_arrival: toIso(wd, d.site_arrival), site_end: toIso(wd, d.site_end),
        note: d.note || null, technical_note: d.technical_note || null, exclusion_note: d.exclusion_note || null,
        edit_reason: d.edit_reason || null,
      };
      if (row.site_arrival && row.site_end && row.site_end < row.site_arrival) throw new Error("La fin de chantier est antérieure à l'arrivée");
      if (row.workshop_arrival && row.site_arrival && row.site_arrival < row.workshop_arrival) throw new Error("L'arrivée sur chantier est antérieure à l'arrivée à l'atelier");
      if (entry) await q(sb.from("time_entries").update(row).eq("id", entry.id));
      else await q(sb.from("time_entries").insert({ ...row, mission_id: mid, user_id: uid, work_date: wd }));
      md.close(); toast("Pointage corrigé"); onDone?.();
    });
  };
  const del = f.querySelector("#del");
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Supprimer le pointage de ${nameOf(uid)} du ${fmtDate(wd)} ?`))) return;
    busy(del, async () => { await q(sb.from("time_entries").delete().eq("id", entry.id)); md.close(); toast("Pointage supprimé"); onDone?.(); });
  };
}

function punchField(name, label, e, locked) {
  return `<div class="punch-item"><span>${label}</span>
    <div class="row"><input type="time" name="${name}" value="${toHHMM(e?.[name])}" ${locked ? "disabled" : ""}>
    ${locked ? "" : `<button type="button" class="btn small" data-now="${name}">Maintenant</button>`}</div></div>`;
}

function orderPrintHtml(m, memberIds, mtools, files) {
  const row = (k, val) => `<tr><th>${k}</th><td>${val}</td></tr>`;
  return `
    <table class="pr-kv">
      ${row("Client", `${esc(m.clients?.name || "-")}${m.clients?.phone ? ` · ${esc(m.clients.phone)}` : ""}${m.clients?.contact ? ` · ${esc(m.clients.contact)}` : ""}`)}
      ${row("Adresse du chantier", esc(m.address))}
      ${row("Distance depuis l'atelier", m.distance_km != null ? `${m.distance_km} km · ~${m.duration_min} min` : "-")}
      ${row("Date", `${fmtDate(m.scheduled_date)}${m.end_date && m.end_date !== m.scheduled_date ? ` au ${fmtDate(m.end_date)}` : ""}`)}
      ${row("Présence sur place", `<b>${m.start_time ? m.start_time.slice(0, 5) : "-"}</b>`)}
      ${row("Équipe", memberIds.map((u) => esc(nameOf(u)) + (u === m.team_leader_id ? " <b>(chef d'équipe)</b>" : "")).join(", ") || "-")}
      ${row("Statut", STATUS[m.status] || m.status)}
    </table>
    <h3>Description du travail</h3><p class="pre">${esc(m.description || "-")}</p>
    <h3>Matériel à emporter</h3><p class="pre">${esc(m.materials || "-")}</p>
    <h3>Outillage spécifique</h3>
    ${mtools.length ? `<table class="table"><thead><tr><th style="width:30px">✓</th><th>Qté</th><th>Outil</th><th>Emplacement</th></tr></thead><tbody>
      ${mtools.map((x) => `<tr><td>☐</td><td>${x.qty}</td><td>${esc(x.tools?.name)}</td><td>${esc(x.tools?.location || "")}</td></tr>`).join("")}</tbody></table>` : "<p>Aucun</p>"}
    ${files.length ? `<h3>Documents joints (dans l'application)</h3><ul>${files.map((f) => `<li>${esc(f.name)}</li>`).join("")}</ul>` : ""}
    <h3>Pointage et observations</h3>
    <table class="table pr-fill"><thead><tr><th>Collaborateur</th><th>Arrivée atelier</th><th>Arrivée chantier</th><th>Fin chantier</th></tr></thead><tbody>
      ${(memberIds.length ? memberIds : [null, null]).map((u) => `<tr><td>${u ? esc(nameOf(u)) : ""}</td><td></td><td></td><td></td></tr>`).join("")}</tbody></table>
    <div class="pr-box">Remarques / exclusions :</div>
    <div class="pr-sign"><div>Nom du client :</div><div>Signature pour accord :</div></div>`;
}

function orderText(m, memberIds, mtools) {
  return [
    `ORDRE DE MISSION #${m.id} - Monsieur Maréchal`,
    `Chantier : ${m.title}`,
    `Client : ${m.clients?.name || "-"}`,
    `Adresse : ${m.address}`,
    `Itinéraire : ${mapsLink(m)}`,
    m.distance_km != null ? `Distance atelier : ${m.distance_km} km (~${m.duration_min} min)` : "",
    `Date : ${fmtDate(m.scheduled_date)}${m.end_date ? " au " + fmtDate(m.end_date) : ""}`,
    `Présence sur place : ${m.start_time ? m.start_time.slice(0, 5) : "-"}`,
    `Équipe : ${memberIds.map((u) => nameOf(u) + (u === m.team_leader_id ? " (chef d'équipe)" : "")).join(", ")}`,
    "", `Travail : ${m.description || "-"}`,
    `Matériel : ${m.materials || "-"}`,
    `Outillage : ${mtools.map((x) => `${x.qty} x ${x.tools?.name}`).join(", ") || "-"}`,
    "", `Détail et documents : ${location.origin + location.pathname}#/mission/${m.id}`,
  ].filter((l) => l !== null).join("\n");
}

function shareOrder(m, memberIds, mtools) {
  const txt = orderText(m, memberIds, mtools);
  const emails = memberIds.map((u) => state.profiles.find((p) => p.id === u)?.email).filter(Boolean).join(",");
  const md = modal("Envoyer l'ordre de mission", `
    <p class="muted small">Les collaborateurs affectés voient déjà cet ordre dans leur application. Vous pouvez aussi le transmettre :</p>
    <textarea rows="12" readonly class="mono">${esc(txt)}</textarea>
    <div class="actions">
      <a class="btn ghost" href="mailto:${esc(emails)}?subject=${encodeURIComponent(`Ordre de mission #${m.id} - ${m.title}`)}&body=${encodeURIComponent(txt)}">E-mail</a>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn" id="cp">Copier</button></div>`);
  md.el.querySelector("#cp").onclick = () => navigator.clipboard.writeText(txt).then(() => toast("Copié"));
}

// =====================================================================
// SIGNATURE CLIENT (chef d'équipe uniquement)
// =====================================================================
export async function renderSign(id, date) {
  const v = view();
  const uid = state.session.user.id;
  const m = await q(sb.from("missions").select("*, clients(name)").eq("id", id).single());
  if (m.team_leader_id !== uid && !isStaff()) {
    v.innerHTML = `<div class="panel"><p>Seul le chef d'équipe (${esc(nameOf(m.team_leader_id))}) peut faire signer le client.</p>
      <a class="btn ghost" href="#/mission/${id}">Retour</a></div>`;
    return;
  }
  const existing = await q(sb.from("day_reports").select("id").eq("mission_id", id).eq("work_date", date));
  if (existing.length) { toast("Cette journée est déjà signée", "warn"); location.hash = `#/mission/${id}`; return; }
  const entries = await q(sb.from("time_entries").select("*").eq("mission_id", id).eq("work_date", date));
  if (!state.profiles.length) await loadProfiles();
  const total = entries.reduce((s, e) => s + hoursBetween(e.site_arrival, e.site_end), 0);
  const photos = await loadPhotos(+id, date);

  v.innerHTML = `
    <div class="page-h"><div><a href="#/mission/${id}" class="back">← Retour au chantier</a>
      <h2>Feuille de prestation · ${fmtDate(date)}</h2></div></div>
    <section class="panel">
      <p><b>${esc(m.title)}</b><br>${esc(m.clients?.name || "")} · ${esc(m.address)}</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Collaborateur</th><th>Arrivée chantier</th><th>Fin</th><th>Durée</th></tr></thead><tbody>
      ${entries.map((e) => `<tr><td>${esc(nameOf(e.user_id))}</td><td>${fmtTime(e.site_arrival)}</td><td>${fmtTime(e.site_end)}</td>
        <td>${fmtH(hoursBetween(e.site_arrival, e.site_end))}</td></tr>
        ${e.technical_note || e.exclusion_note ? `<tr class="sub"><td colspan="4">${e.technical_note ? `Remarque : ${esc(e.technical_note)} ` : ""}${e.exclusion_note ? `· Exclusion : ${esc(e.exclusion_note)}` : ""}</td></tr>` : ""}`).join("")}
      </tbody><tfoot><tr><th colspan="3">Total heures prestées sur chantier</th><th>${fmtH(total)}</th></tr></tfoot></table></div>
      ${entries.some((e) => !e.site_end) ? `<div class="info warn">Attention : certains collaborateurs n'ont pas encore pointé la fin de chantier.</div>` : ""}
      <h4>Photos de réalisation (${photos.length})</h4>
      ${galleryHtml(photos)}
      <p class="small"><a href="#/mission/${id}">Ajouter des photos avant signature</a></p>
      <form id="sf" class="form">
        <label>Nom et prénom du client *<input name="client_name" required autocomplete="off"></label>
        <label>Signature du client *</label>
        <div class="sigwrap"><canvas id="sig"></canvas></div>
        <div class="row"><button type="button" class="btn ghost small" id="clr">Effacer</button>
          <span class="muted small">Le client signe pour accord sur les prestations de la journée.</span></div>
        <button class="btn wide" id="ok">Valider et envoyer le rapport</button>
      </form>
    </section>`;

  const canvas = v.querySelector("#sig");
  const pad = signaturePad(canvas);
  v.querySelector("#clr").onclick = () => pad.clear();
  const f = v.querySelector("#sf");
  f.onsubmit = (e) => {
    e.preventDefault();
    if (pad.isEmpty()) return toast("Signature manquante", "err");
    busy(f.querySelector("#ok"), async () => {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const path = `${id}/${date}_${Date.now()}.png`;
      const up = await sb.storage.from("signatures").upload(path, blob, { contentType: "image/png" });
      if (up.error) throw new Error(up.error.message);
      const rep = await q(sb.from("day_reports").insert({
        mission_id: +id, work_date: date, leader_id: uid, client_name: f.client_name.value.trim(), signature_path: path,
      }).select().single());
      try {
        await callFn("send-report", { report_id: rep.id });
        toast("Rapport signé et envoyé par e-mail à l'administrateur");
      } catch (er) {
        toast(`Rapport signé et enregistré. E-mail non envoyé : ${er.message}`, "warn");
      }
      location.hash = `#/mission/${id}`;
    });
  };
}

function signaturePad(canvas) {
  const ctx = canvas.getContext("2d");
  let drawing = false, empty = true, last = null;
  const resize = () => {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, r.width, r.height);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
    empty = true;
  };
  resize();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; empty = false;
  });
  const end = () => (drawing = false);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  return { clear: resize, isEmpty: () => empty };
}
