import {
  sb, state, q, esc, view, toast, modal, confirmBox, busy, formData, isStaff, isAdmin, callFn, fmtDateTime, nameOf, loadProfiles, loadSettings, downloadCsv, printDoc,
} from "./core.js";
import { geocode, locateFromWorkshop } from "./geo.js";

// =====================================================================
// OUTILS DU MAGASIN CENTRAL
// =====================================================================
export async function renderTools() {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  const tools = await q(sb.from("tools").select("*").order("category").order("name"));
  v.innerHTML = `
    <div class="page-h"><h2>Outils du magasin central</h2>
      <div><button class="btn ghost" id="prt">🖨 Imprimer</button> <button class="btn ghost" id="csv">Export CSV</button> <button class="btn" id="add">+ Ajouter un outil</button></div></div>
    <input type="search" id="s" placeholder="Rechercher un outil, une catégorie, une référence…" class="search">
    <div class="table-wrap"><table class="table" id="tt"><thead><tr><th>Outil</th><th>Catégorie</th><th>Référence</th><th>Qté</th><th>Emplacement</th><th></th></tr></thead><tbody>
    ${tools.map((t) => `<tr data-s="${esc(`${t.name} ${t.category || ""} ${t.reference || ""}`.toLowerCase())}">
      <td><b>${esc(t.name)}</b>${t.notes ? `<br><small class="muted">${esc(t.notes)}</small>` : ""}</td><td>${esc(t.category || "")}</td>
      <td>${esc(t.reference || "")}</td><td>${t.quantity}</td><td>${esc(t.location || "")}</td>
      <td class="right"><button class="btn small ghost" data-edit="${t.id}">Modifier</button>
      <button class="btn small danger" data-del="${t.id}">Supprimer</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun outil enregistré.</td></tr>`}
    </tbody></table></div>`;

  v.querySelector("#s").oninput = (e) => {
    const s = e.target.value.toLowerCase();
    v.querySelectorAll("#tt tbody tr[data-s]").forEach((r) => (r.style.display = r.dataset.s.includes(s) ? "" : "none"));
  };
  v.querySelector("#csv").onclick = () => downloadCsv("outils.csv",
    [["Outil", "Catégorie", "Référence", "Quantité", "Emplacement", "Notes"], ...tools.map((t) => [t.name, t.category, t.reference, t.quantity, t.location, t.notes])]);
  v.querySelector("#prt").onclick = () => {
    const s = v.querySelector("#s").value.toLowerCase();
    const list = tools.filter((t) => `${t.name} ${t.category || ""} ${t.reference || ""}`.toLowerCase().includes(s));
    printDoc("Inventaire des outils du magasin central", `<table class="table"><thead><tr><th>Outil</th><th>Catégorie</th><th>Référence</th><th>Qté</th><th>Emplacement</th><th>Notes</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.category || "")}</td><td>${esc(t.reference || "")}</td><td>${t.quantity}</td><td>${esc(t.location || "")}</td><td>${esc(t.notes || "")}</td></tr>`).join("")}
      </tbody></table>`, { subtitle: `${list.length} outil(s)${s ? ` · filtre « ${s} »` : ""}` });
  };
  v.querySelector("#add").onclick = () => toolForm();
  v.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => toolForm(tools.find((t) => String(t.id) === b.dataset.edit))));
  v.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const t = tools.find((x) => String(x.id) === b.dataset.del);
    if (!(await confirmBox(`Supprimer la fiche outil « ${t.name} » ? Elle sera retirée des ordres de mission.`))) return;
    busy(b, async () => { await q(sb.from("tools").delete().eq("id", t.id)); toast("Outil supprimé"); renderTools(); });
  }));
}

function toolForm(t = {}) {
  const md = modal(t.id ? "Modifier l'outil" : "Nouvel outil", `
    <form class="form" id="tf">
      <label>Nom de l'outil *<input name="name" required value="${esc(t.name || "")}"></label>
      <div class="grid2"><label>Catégorie<input name="category" list="cats" value="${esc(t.category || "")}" placeholder="Ex. Terrassement"></label>
      <label>Référence / n° inventaire<input name="reference" value="${esc(t.reference || "")}"></label>
      <label>Quantité disponible<input type="number" min="0" name="quantity" value="${t.quantity ?? 1}"></label>
      <label>Emplacement<input name="location" value="${esc(t.location || "")}" placeholder="Ex. Rayon B2"></label></div>
      <label>Notes<textarea name="notes" rows="2">${esc(t.notes || "")}</textarea></label>
      <datalist id="cats">${["Terrassement", "Pavage", "Clôture", "Espaces verts", "Coupe / sciage", "Électroportatif", "Levage", "Mesure", "Sécurité"].map((c) => `<option>${c}</option>`).join("")}</datalist>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
  const f = md.el.querySelector("#tf");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const d = formData(f); d.quantity = +d.quantity || 0;
      if (t.id) await q(sb.from("tools").update(d).eq("id", t.id));
      else await q(sb.from("tools").insert(d));
      md.close(); renderTools();
    });
  };
}

// =====================================================================
// BASE CLIENTS
// =====================================================================
export async function renderClients() {
  if (!isStaff()) return (location.hash = "#/missions");
  const v = view();
  const clients = await q(sb.from("clients").select("*").order("name"));
  v.innerHTML = `
    <div class="page-h"><h2>Clients</h2><div><button class="btn ghost" id="prt">🖨 Imprimer</button> <button class="btn" id="add">+ Nouveau client</button></div></div>
    <input type="search" id="s" placeholder="Rechercher un client, une commune…" class="search">
    <div class="table-wrap"><table class="table" id="ct"><thead><tr><th>Client</th><th>Contact</th><th>Adresse</th><th>Distance atelier</th><th></th></tr></thead><tbody>
    ${clients.map((c) => `<tr data-s="${esc(`${c.name} ${c.address} ${c.contact || ""}`.toLowerCase())}">
      <td><b>${esc(c.name)}</b></td>
      <td>${esc(c.contact || "")}${c.phone ? `<br><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ""}${c.email ? `<br><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}</td>
      <td>${esc(c.address)}</td><td>${c.distance_km != null ? `${c.distance_km} km · ${c.duration_min} min` : "-"}</td>
      <td class="right"><a class="btn small ghost" href="#/mission/new?client=${c.id}">Ordre de mission</a>
        <button class="btn small ghost" data-edit="${c.id}">Modifier</button>
        ${isAdmin() ? `<button class="btn small danger" data-del="${c.id}">Supprimer</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Aucun client.</td></tr>`}
    </tbody></table></div>`;
  v.querySelector("#s").oninput = (e) => {
    const s = e.target.value.toLowerCase();
    v.querySelectorAll("#ct tbody tr[data-s]").forEach((r) => (r.style.display = r.dataset.s.includes(s) ? "" : "none"));
  };
  v.querySelector("#prt").onclick = () => {
    const s = v.querySelector("#s").value.toLowerCase();
    const list = clients.filter((c) => `${c.name} ${c.address} ${c.contact || ""}`.toLowerCase().includes(s));
    printDoc("Liste des clients", `<table class="table"><thead><tr><th>Client</th><th>Contact</th><th>Téléphone</th><th>E-mail</th><th>Adresse</th><th>Distance</th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.contact || "")}</td><td>${esc(c.phone || "")}</td><td>${esc(c.email || "")}</td><td>${esc(c.address)}</td><td>${c.distance_km != null ? c.distance_km + " km" : ""}</td></tr>`).join("")}
      </tbody></table>`, { landscape: true, subtitle: `${list.length} client(s)${s ? ` · filtre « ${s} »` : ""}` });
  };
  v.querySelector("#add").onclick = () => clientForm();
  v.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => clientForm(clients.find((c) => String(c.id) === b.dataset.edit))));
  v.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Supprimer ce client ? Les ordres de mission existants sont conservés."))) return;
    busy(b, async () => { await q(sb.from("clients").delete().eq("id", b.dataset.del)); renderClients(); });
  }));
}

function clientForm(c = {}) {
  const md = modal(c.id ? "Modifier le client" : "Nouveau client", `
    <form class="form" id="cf">
      <label>Nom / raison sociale *<input name="name" required value="${esc(c.name || "")}"></label>
      <div class="grid2"><label>Personne de contact<input name="contact" value="${esc(c.contact || "")}"></label>
      <label>Téléphone<input name="phone" type="tel" value="${esc(c.phone || "")}"></label></div>
      <label>E-mail<input name="email" type="email" value="${esc(c.email || "")}"></label>
      <label>Adresse complète *<input name="address" required value="${esc(c.address || "")}" placeholder="Rue, n°, code postal, commune"></label>
      <label>Notes<textarea name="notes" rows="2">${esc(c.notes || "")}</textarea></label>
      <p class="muted small">La distance depuis l'atelier est calculée automatiquement à l'enregistrement.</p>
      <div class="actions"><button class="btn">Enregistrer</button></div></form>`);
  const f = md.el.querySelector("#cf");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const d = formData(f);
      if (d.address !== c.address || c.lat == null) {
        try {
          const r = await locateFromWorkshop(d.address);
          Object.assign(d, { lat: r.lat, lng: r.lng, distance_km: r.km, duration_min: r.min });
        } catch (er) { toast(`${er.message} - client enregistré sans distance`, "warn"); }
      }
      if (c.id) await q(sb.from("clients").update(d).eq("id", c.id));
      else await q(sb.from("clients").insert(d));
      md.close(); renderClients();
    });
  };
}

// =====================================================================
// PARAMÈTRES (admin)
// =====================================================================
export async function renderSettings() {
  if (!isAdmin()) return (location.hash = "#/missions");
  const v = view();
  const s = await loadSettings();
  v.innerHTML = `
    <div class="page-h"><h2>Paramètres</h2></div>
    <section class="panel narrow">
      <form class="form" id="sf">
        <label>Nom de l'entreprise<input name="company_name" value="${esc(s.company_name || "")}"></label>
        <label>Adresse de l'atelier *<input name="workshop_address" required value="${esc(s.workshop_address || "")}" placeholder="Rue, n°, code postal, commune"></label>
        <div class="info" id="wsinfo">${s.workshop_lat ? `Position enregistrée : ${s.workshop_lat.toFixed(5)}, ${s.workshop_lng.toFixed(5)}` : "Position non géolocalisée"}</div>
        <label>E-mail de réception des rapports signés *<input type="email" name="report_email" required value="${esc(s.report_email || "")}"></label>
        <button class="btn">Enregistrer</button>
      </form>
      <button class="btn ghost" id="recalc">Recalculer les distances de tous les clients</button>
      <p class="muted small">À utiliser après un changement d'adresse de l'atelier (1 client par seconde).</p>
    </section>
    <section class="panel narrow" id="backup">
      <h3>Sauvegardes</h3>
      <p>Une <b>sauvegarde automatique</b> est réalisée chaque <b>lundi vers 3 h</b> : archive ZIP de toutes les données au format CSV, conservée 12 semaines ci-dessous et envoyée à l'e-mail des rapports si l'envoi d'e-mails est configuré.</p>
      <h4>Sauvegarde manuelle</h4>
      <div class="row"><button class="btn" id="bk-zip">⬇ Tout télécharger (ZIP de CSV)</button>
        <button class="btn ghost" id="bk-now">Lancer une sauvegarde serveur maintenant</button></div>
      <div class="row" style="margin-top:10px"><select id="bk-table" style="width:auto">${BACKUP_TABLES.map(([t, l]) => `<option value="${t}">${l}</option>`).join("")}</select>
        <button class="btn ghost" id="bk-csv">⬇ Télécharger ce CSV</button></div>
      <div id="bk-prog" class="muted small"></div>
      <h4>Sauvegardes conservées</h4>
      <div id="bk-list"><p class="muted">Chargement…</p></div>
    </section>`;
  const f = v.querySelector("#sf");
  f.onsubmit = (e) => {
    e.preventDefault();
    busy(f.querySelector("button"), async () => {
      const d = formData(f);
      const g = await geocode(d.workshop_address);
      await q(sb.from("settings").update({ ...d, workshop_lat: g.lat, workshop_lng: g.lng, updated_at: new Date().toISOString() }).eq("id", 1));
      await loadSettings();
      v.querySelector("#wsinfo").innerHTML = `Position enregistrée : ${esc(g.label)}`;
      toast("Paramètres enregistrés");
    });
  };
  v.querySelector("#recalc").onclick = (e) => busy(e.target, async () => {
    const clients = await q(sb.from("clients").select("id,address"));
    let n = 0;
    for (const c of clients) {
      try {
        const r = await locateFromWorkshop(c.address);
        await sb.from("clients").update({ lat: r.lat, lng: r.lng, distance_km: r.km, duration_min: r.min }).eq("id", c.id);
        n++;
      } catch {}
      await new Promise((r) => setTimeout(r, 1100));
    }
    toast(`${n} / ${clients.length} clients mis à jour`);
  });
  bindBackup(v);
}

// =====================================================================
// SAUVEGARDES CSV (admin)
// =====================================================================
const BACKUP_TABLES = [
  ["export_prestations", "Prestations (lisible)"], ["profiles", "Utilisateurs"], ["clients", "Clients"], ["tools", "Outils"],
  ["missions", "Ordres de mission"], ["mission_members", "Équipes des chantiers"], ["mission_tools", "Outillage des chantiers"],
  ["mission_files", "Documents joints (liste)"], ["time_entries", "Pointages (brut)"], ["day_reports", "Rapports signés"],
  ["mission_photos", "Photos (liste)"], ["leave_types", "Types de congés"], ["leave_requests", "Demandes de congé"],
  ["leave_allocations", "Droits aux congés"], ["overtime_adjustments", "Mouvements d'heures sup."], ["settings", "Paramètres"],
];

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const data = await q(sb.from(table).select("*").range(from, from + 999));
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// CSV compatible Excel (séparateur point-virgule, UTF-8 avec BOM)
function toCsv(rows) {
  if (!rows.length) return "\ufeff";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\ufeff" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function loadBackupList(el) {
  const { data: folders, error } = await sb.storage.from("backups").list("", { limit: 100, sortBy: { column: "name", order: "desc" } });
  if (error) { el.innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
  const dated = (folders || []).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.name)).slice(0, 12);
  if (!dated.length) { el.innerHTML = `<p class="muted">Aucune sauvegarde serveur pour l'instant.</p>`; return; }
  const items = [];
  for (const f of dated) {
    const { data: inner } = await sb.storage.from("backups").list(f.name);
    for (const x of inner || []) {
      const { data: u } = await sb.storage.from("backups").createSignedUrl(`${f.name}/${x.name}`, 600, { download: x.name });
      items.push({ date: f.name, name: x.name, size: x.metadata?.size, url: u?.signedUrl });
    }
  }
  el.innerHTML = `<ul class="files">${items.map((i) => `<li><a href="${i.url}">📦 ${esc(i.name)}</a>
    <span class="muted small">${new Date(i.date + "T12:00:00").toLocaleDateString("fr-BE", { dateStyle: "full" })}${i.size ? ` · ${(i.size / 1024).toFixed(0)} Ko` : ""}</span></li>`).join("")}</ul>`;
}

function bindBackup(v) {
  const prog = v.querySelector("#bk-prog");
  const list = v.querySelector("#bk-list");
  const date = () => new Date().toISOString().slice(0, 10);
  loadBackupList(list).catch((e) => (list.innerHTML = `<p class="muted">${esc(e.message)}</p>`));

  v.querySelector("#bk-zip").onclick = (e) => busy(e.target, async () => {
    const { default: JSZip } = await import("https://esm.sh/jszip@3.10.1");
    const zip = new JSZip();
    const counts = [];
    for (const [t, label] of BACKUP_TABLES) {
      prog.textContent = `Export : ${label}…`;
      const rows = await fetchAll(t);
      zip.file(`${t}.csv`, toCsv(rows));
      counts.push(`${t} : ${rows.length} ligne(s)`);
    }
    zip.file("LISEZ-MOI.txt", `Sauvegarde manuelle Monsieur Maréchal du ${date()}.\r\nFichiers CSV (séparateur point-virgule, UTF-8), ouvrables dans Excel.\r\n\r\n${counts.join("\r\n")}`);
    prog.textContent = "Compression…";
    saveBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `sauvegarde-mm-${date()}.zip`);
    prog.textContent = `Sauvegarde téléchargée (${BACKUP_TABLES.length} fichiers CSV).`;
  });

  v.querySelector("#bk-csv").onclick = (e) => busy(e.target, async () => {
    const t = v.querySelector("#bk-table").value;
    const rows = await fetchAll(t);
    saveBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), `${t}-${date()}.csv`);
    prog.textContent = `${rows.length} ligne(s) exportée(s).`;
  });

  v.querySelector("#bk-now").onclick = (e) => busy(e.target, async () => {
    prog.textContent = "Sauvegarde serveur en cours…";
    const r = await callFn("backup", {});
    prog.textContent = `Sauvegarde enregistrée (${(r.size / 1024).toFixed(0)} Ko)${r.emailed ? ", envoyée par e-mail" : r.mailError ? " ; e-mail non envoyé" : ""}.`;
    toast("Sauvegarde réalisée");
    loadBackupList(list);
  });
}

// =====================================================================
// CARTE DE LOCALISATION DES COLLABORATEURS (admin)
// =====================================================================
let mapInst = null, mapTimer = null;

async function loadLeaflet() {
  if (window.L) return;
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(css);
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = res; s.onerror = () => rej(new Error("Carte indisponible (hors ligne ?)"));
    document.head.appendChild(s);
  });
}

export function stopMap() { clearInterval(mapTimer); mapTimer = null; mapInst?.remove(); mapInst = null; }

export async function renderMap() {
  if (!isAdmin()) return (location.hash = "#/missions");
  const v = view();
  await loadProfiles();
  v.innerHTML = `
    <div class="page-h"><h2>Localisation des équipes</h2><span class="muted small">Actualisation automatique toutes les 60 s</span></div>
    <div class="grid-map"><div id="map"></div><div id="who" class="panel"></div></div>
    <p class="muted small">Position transmise par le téléphone du collaborateur lors des pointages et pendant une journée en cours, application ouverte.</p>`;
  await loadLeaflet();
  stopMap();
  const s = state.settings;
  mapInst = L.map("map").setView(s?.workshop_lat ? [s.workshop_lat, s.workshop_lng] : [50.5, 4.6], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(mapInst);
  if (s?.workshop_lat) L.circleMarker([s.workshop_lat, s.workshop_lng], { radius: 9, color: "#F18E15", fillOpacity: 0.9 }).addTo(mapInst).bindPopup("Atelier");
  const layer = L.layerGroup().addTo(mapInst);

  const refresh = async () => {
    if (!document.getElementById("map")) return stopMap();
    const locs = await q(sb.from("user_locations").select("*"));
    layer.clearLayers();
    const pts = [];
    locs.forEach((l) => {
      const age = (Date.now() - new Date(l.updated_at)) / 60000;
      const color = age < 30 ? "#95C11F" : age < 240 ? "#F18E15" : "#999";
      L.circleMarker([l.lat, l.lng], { radius: 10, color: "#3D3836", weight: 2, fillColor: color, fillOpacity: 0.95 })
        .addTo(layer).bindPopup(`<b>${esc(nameOf(l.user_id))}</b><br>${fmtDateTime(l.updated_at)}<br>± ${Math.round(l.accuracy || 0)} m`);
      pts.push([l.lat, l.lng]);
    });
    if (pts.length && !mapInst._fitted) { mapInst.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); mapInst._fitted = true; }
    v.querySelector("#who").innerHTML = `<h3>Dernières positions</h3>${locs.length ? `<ul class="plain">${locs
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .map((l) => `<li><a href="#" data-ll="${l.lat},${l.lng}">${esc(nameOf(l.user_id))}</a><br><small class="muted">${fmtDateTime(l.updated_at)}</small></li>`).join("")}</ul>`
      : `<p class="muted">Aucune position reçue.</p>`}`;
    v.querySelectorAll("[data-ll]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); mapInst.setView(a.dataset.ll.split(",").map(Number), 15); }));
  };
  await refresh();
  mapTimer = setInterval(() => refresh().catch(() => {}), 60000);
}
