// Paramètres de connexion Supabase.
// La clé "anon" (publique) se trouve dans Supabase > Project Settings > API.
// Elle est conçue pour être visible côté navigateur : la sécurité repose sur les règles RLS.
export const SUPABASE_URL = "https://hewmclzsohtrneywqwvw.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_VqdFfYGTk9rX_XUEchJ0rw_QnPvcQ5j";

// Intervalle d'envoi de la position pendant un pointage actif (ms)
export const GEO_INTERVAL_MS = 5 * 60 * 1000;

// Version de l'application : à incrémenter à chaque mise en ligne.
// Les appareils comparent cette valeur au fichier en ligne et proposent la mise à jour.
export const APP_VERSION = "2026.11.07-5";
