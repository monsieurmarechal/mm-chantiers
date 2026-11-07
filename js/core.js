import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const state = { session: null, profile: null, settings: null, profiles: [], leaveTypes: [] };

export const ROLES = { admin: "Administrateur", rh: "Ressources humaines", collaborateur: "Collaborateur de chantier" };
export const STATUS = { planifiee: "Planifiée", en_cours: "En cours", terminee: "Terminée", annulee: "Annulée" };
export const LEAVE_STATUS = { en_attente: "En attente", approuvee: "Approuvée", refusee: "Refusée" };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const view = () => $("#view");

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const isStaff = () => ["admin", "rh"].includes(state.profile?.role);
export const isAdmin = () => state.profile?.role === "admin";

// Exécute une requête Supabase et lève une erreur lisible
export async function q(p) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

export async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- Dates ----------
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const fmtDate = (s) => (s ? new Date(s + (s.length === 10 ? "T12:00:00" : "")).toLocaleDateString("fr-BE") : "-");
export const fmtTime = (s) => (s ? new Date(s).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" }) : "-");
export const fmtDateTime = (s) => (s ? new Date(s).toLocaleString("fr-BE", { dateStyle: "short", timeStyle: "short" }) : "-");
export function hoursBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, (new Date(b) - new Date(a)) / 3600000);
}
export const fmtH = (h) => {
  const t = Math.round((h || 0) * 60), s = t < 0 ? "-" : "";
  const a = Math.abs(t);
  return `${s}${Math.floor(a / 60)}h${String(a % 60).padStart(2, "0")}`;
};
// "HH:MM" + date -> ISO
export function toIso(dateStr, hhmm) {
  if (!hhmm) return null;
  return new Date(`${dateStr}T${hhmm}:00`).toISOString();
}
export function toHHMM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function nowHHMM() { return toHHMM(new Date().toISOString()); }

// ---------- UI ----------
export function toast(msg, type = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), type === "err" ? 6000 : 3000);
}

export function modal(title, html, { wide = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "modal-bg";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}"><div class="modal-h"><h3>${esc(title)}</h3>
    <button class="icon-btn" data-close aria-label="Fermer">✕</button></div><div class="modal-b">${html}</div></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
  return { el: wrap, close };
}

export function confirmBox(text) {
  return new Promise((res) => {
    const m = modal("Confirmation", `<p>${esc(text)}</p><div class="actions">
      <button class="btn ghost" data-no>Annuler</button><button class="btn danger" data-yes>Confirmer</button></div>`);
    m.el.querySelector("[data-yes]").onclick = () => { m.close(); res(true); };
    m.el.querySelector("[data-no]").onclick = () => { m.close(); res(false); };
  });
}

// Désactive le bouton pendant une action asynchrone et affiche l'erreur
export async function busy(btn, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try { return await fn(); }
  catch (e) { toast(e.message, "err"); console.error(e); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

export const nameOf = (id) => state.profiles.find((p) => p.id === id)?.full_name || "?";

export async function loadProfiles() {
  state.profiles = await q(sb.from("profiles").select("id,full_name,email,role,active,phone").order("full_name"));
  return state.profiles;
}
export async function loadSettings() {
  state.settings = await q(sb.from("settings").select("*").eq("id", 1).single());
  return state.settings;
}

// ---------- Types de congés ----------
export async function loadLeaveTypes() {
  state.leaveTypes = await q(sb.from("leave_types").select("*").order("sort").order("label"));
  return state.leaveTypes;
}
export const leaveType = (code) => state.leaveTypes.find((t) => t.code === code) || { code, label: code, unit: "jours", color: "#999" };
export const fmtQty = (n, unit) => unit === "heures" ? fmtH(+n || 0) : `${(+n || 0).toLocaleString("fr-BE", { maximumFractionDigits: 2 })} j`;

// Jours ouvrables (lundi à vendredi) entre deux dates incluses
export function businessDays(d1, d2) {
  if (!d1 || !d2 || d2 < d1) return 0;
  let n = 0;
  for (let d = new Date(d1 + "T12:00:00"); d <= new Date(d2 + "T12:00:00"); d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

// ---------- Impression ----------
// Affiche un document mis en page (en-tête Monsieur Maréchal) et lance l'impression / PDF.
export function printDoc(title, html, { landscape = false, subtitle = "" } = {}) {
  document.getElementById("print-area")?.remove();
  const s = state.settings || {};
  const el = document.createElement("div");
  el.id = "print-area";
  el.className = landscape ? "landscape" : "";
  el.innerHTML = `
    <header class="pr-head">
      <div class="pr-brand"><span class="b1">Monsieur</span><span class="b2">MARECHAL</span></div>
      <div class="pr-meta">${esc(s.company_name || "Monsieur Maréchal")}<br>${esc(s.workshop_address || "")}</div>
    </header>
    <h1 class="pr-title">${esc(title)}</h1>
    ${subtitle ? `<p class="pr-sub">${esc(subtitle)}</p>` : ""}
    <div class="pr-body">${html}</div>
    <footer class="pr-foot">Imprimé le ${new Date().toLocaleString("fr-BE", { dateStyle: "short", timeStyle: "short" })} par ${esc(state.profile?.full_name || "")}</footer>`;
  document.body.appendChild(el);
  document.body.classList.add("printing");
  let style = document.getElementById("print-page-style");
  if (!style) { style = document.createElement("style"); style.id = "print-page-style"; document.head.appendChild(style); }
  style.textContent = `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm; }`;
  const done = () => { document.body.classList.remove("printing"); el.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  // Attend le chargement des images (photos, signatures), 15 s maximum
  const imgs = [...el.querySelectorAll("img")].filter((i) => !i.complete);
  const loaded = Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
  Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]).then(() => setTimeout(() => window.print(), 200));
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
