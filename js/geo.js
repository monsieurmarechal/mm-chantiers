// Géocodage (OpenStreetMap Nominatim) et calcul d'itinéraire routier (OSRM).
// Services gratuits, sans clé. Usage modéré : 1 requête/seconde maximum.
import { sb, state, toast } from "./core.js";
import { GEO_INTERVAL_MS } from "./config.js";

export async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=be,fr,lu,nl&q=${encodeURIComponent(address)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "fr" } });
  if (!r.ok) throw new Error("Service de géocodage indisponible");
  const j = await r.json();
  if (!j.length) throw new Error("Adresse introuvable : vérifiez rue, numéro, code postal et commune");
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}

// Distance routière atelier -> chantier
export async function route(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.code === "Ok" && j.routes?.length) {
      return { km: Math.round(j.routes[0].distance / 100) / 10, min: Math.round(j.routes[0].duration / 60), approx: false };
    }
  } catch {}
  // Repli : distance à vol d'oiseau x 1,3
  const km = Math.round(haversine(from, to) * 1.3 * 10) / 10;
  return { km, min: Math.round((km / 60) * 60), approx: true };
}

export function haversine(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Géocode une adresse puis calcule la distance depuis l'atelier
export async function locateFromWorkshop(address) {
  const s = state.settings;
  const pos = await geocode(address);
  if (!s?.workshop_lat) {
    toast("Adresse de l'atelier non définie (Paramètres) : distance non calculée", "warn");
    return { ...pos, km: null, min: null };
  }
  const r = await route({ lat: s.workshop_lat, lng: s.workshop_lng }, pos);
  return { ...pos, ...r };
}

// ---------- Suivi de position du collaborateur ----------
// Position envoyée uniquement lors des pointages et pendant une journée de travail en cours
// (application ouverte). Le navigateur ne permet pas de suivi en arrière-plan.
let timer = null;

export function sendPositionOnce() {
  if (!navigator.geolocation || !state.session) return;
  navigator.geolocation.getCurrentPosition(
    async (p) => {
      await sb.from("user_locations").upsert({
        user_id: state.session.user.id,
        lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
        updated_at: new Date().toISOString(),
      });
    },
    () => {},
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

export function startTracking() {
  if (timer) return;
  sendPositionOnce();
  timer = setInterval(sendPositionOnce, GEO_INTERVAL_MS);
}
export function stopTracking() {
  clearInterval(timer);
  timer = null;
}
