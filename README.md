# Monsieur Maréchal · Gestion de chantiers

Application web installable sur Android (PWA) : ordres de mission, pointages, signature client, congés, heures supplémentaires, récapitulatif RH, localisation des équipes.

- **Front-end** : HTML/CSS/JavaScript sans compilation, hébergé gratuitement sur **GitHub Pages**.
- **Back-end** : **Supabase** (offre gratuite) : base PostgreSQL, authentification, stockage des fichiers, Edge Functions.
- **Cartographie** : OpenStreetMap (géocodage Nominatim, itinéraires OSRM, carte Leaflet). Gratuit, sans clé.
- **E-mails** : Resend (offre gratuite, 3 000 e-mails/mois), facultatif.

## 1. Fonctionnalités par rôle

| Fonction | Admin | RH | Collaborateur |
|---|---|---|---|
| Créer / modifier les ordres de mission (adresse, distance atelier auto, heure, travail, matériel, outillage, pièces jointes) | Oui | Oui | Consultation de ses chantiers |
| Base clients (sélection directe avec adresse et distance) | Oui | Oui | Non |
| Liste des outils du magasin central (création, suppression) | Oui | Oui | Non |
| Adresse de l'atelier, e-mail de réception des rapports | Oui | Non | Non |
| Pointage : arrivée atelier, arrivée chantier, fin chantier + note, remarque technique, note d'exclusion | Si affecté | Si affecté | Oui |
| Photos de réalisation (appareil photo ou galerie, légende, compression auto) | Oui | Oui | Si affecté, jusqu'à la signature |
| Signature client en fin de journée + rapport e-mail (photos jointes) | Oui | Oui | **Chef d'équipe uniquement** |
| Demande de congé / récupération | Oui | Oui | Oui |
| Approbation des demandes, mise à jour du compteur d'heures sup. | Oui | Oui | Non |
| Récapitulatif des prestations par personne / jour / semaine / mois + export CSV | Oui | Oui | Non |
| Gestion des utilisateurs (création avec mot de passe provisoire, réinitialisation, désactivation, rôle) | Oui | Oui (sauf comptes admin) | Non |
| Carte de localisation des collaborateurs | Oui | Non | Non |

Règles de gestion intégrées :
- Plusieurs collaborateurs sur un chantier : un **chef d'équipe** est désigné dans l'ordre de mission ; lui seul peut faire signer la feuille de prestation.
- Après signature client, les pointages de la journée sont **verrouillés** (seuls admin et RH peuvent corriger).
- Une récupération approuvée **débite automatiquement** le compteur d'heures supplémentaires ; un refus ultérieur la recrédite.
- Première connexion : changement de mot de passe **obligatoire**.
- Sécurité par règles RLS côté base : un collaborateur ne voit que les chantiers auxquels il est affecté et ses propres pointages.

## 2. Mise en place Supabase

> **État au 07/11/2026** (projet `hewmclzsohtrneywqwvw`) : schéma installé (§2.1), fonctions `create-user` et `send-report` déployées (§2.4), clé publique renseignée dans `js/config.js` (§2.6). **Restent à faire : §2.2, §2.3, §2.5.**
>
> Si la création d'utilisateur renvoie « Invalid JWT » : Edge Functions > create-user (puis send-report) > Settings > désactiver « Verify JWT with legacy secret » > Save. Les deux fonctions vérifient elles-mêmes l'identité et le rôle de l'appelant.

### 2.1 Base de données
1. Supabase > **SQL Editor** > New query.
2. Coller le contenu de `supabase/schema.sql` > **Run**. Le script est ré-exécutable.

### 2.2 Authentification
Authentication > **Sign In / Providers** :
- **Allow new users to sign up : désactivé** (seuls admin/RH créent les comptes).
- Email provider : actif. « Confirm email » peut rester actif (les comptes créés par l'admin sont confirmés d'office).

Authentication > **URL Configuration** > Site URL : l'adresse GitHub Pages (voir §3), par ex. `https://VOTRE-COMPTE.github.io/mm-chantiers/`.

### 2.3 Premier administrateur
1. Authentication > Users > **Add user** > Create new user (e-mail + mot de passe, cocher Auto Confirm).
2. SQL Editor :
```sql
update public.profiles
set role = 'admin', must_change_password = false, full_name = 'Mathieu Maréchal'
where email = 'VOTRE_EMAIL';
```

### 2.4 Edge Functions
Edge Functions > **Deploy a new function** > Via Editor :
- nom `create-user` : coller `supabase/functions/create-user/index.ts` > Deploy.
- nom `send-report` : coller `supabase/functions/send-report/index.ts` > Deploy.

Laisser « Verify JWT » activé.

Alternative en ligne de commande :
```bash
npx supabase login
npx supabase functions deploy create-user --project-ref hewmclzsohtrneywqwvw
npx supabase functions deploy send-report --project-ref hewmclzsohtrneywqwvw
```

### 2.5 E-mails (facultatif mais recommandé)
1. Créer un compte gratuit sur https://resend.com, générer une clé API.
2. Supabase > Edge Functions > **Secrets** : ajouter `RESEND_API_KEY`.
3. Sans domaine vérifié, Resend n'envoie qu'à l'adresse du compte Resend : suffisant pour les **rapports signés** (envoyés à l'admin). Pour envoyer les **invitations** aux collaborateurs, vérifier le domaine `monsieurmarechal.be` dans Resend (ajout de 3 enregistrements DNS chez l'hébergeur du site), puis ajouter le secret `MAIL_FROM` = `Monsieur Maréchal <chantiers@monsieurmarechal.be>`.

Sans Resend, l'application fonctionne : les identifiants provisoires s'affichent à l'écran avec boutons E-mail / WhatsApp / Copier, et les rapports restent consultables dans l'application.

### 2.6 Clé publique dans l'application
Project Settings > **API Keys** > copier la **Publishable key** (`sb_publishable_…`, ou à défaut la clé `anon` legacy) dans `js/config.js` :
```js
export const SUPABASE_ANON_KEY = "sb_publishable_xxx";
```
Cette clé est faite pour être publique ; la protection des données repose sur les règles RLS. **Ne jamais** placer la clé secrète / service_role dans le code.

## 3. Publication sur GitHub Pages

1. GitHub > **New repository** > nom `mm-chantiers`, visibilité au choix (Public requis pour GitHub Pages gratuit).
2. « uploading an existing file » > glisser **tout le contenu** du dossier (index.html, css, js, icons, supabase, manifest.webmanifest, sw.js, README.md) > Commit.
3. Settings > **Pages** > Source : Deploy from a branch > `main` / `(root)` > Save.
4. Après 1 à 2 min, l'application est en ligne : `https://VOTRE-COMPTE.github.io/mm-chantiers/`.
5. Reporter cette adresse dans Supabase (§2.2 Site URL).

Mise à jour ultérieure : modifier ou ré-uploader les fichiers dans GitHub ; les téléphones prennent la nouvelle version au prochain lancement.

## 4. Installation sur Android
Ouvrir l'adresse dans **Chrome** > menu ⋮ > **Ajouter à l'écran d'accueil** (ou « Installer l'application »). L'application s'ouvre ensuite en plein écran comme une app native. Autoriser la **localisation** lors du premier pointage.

## 5. Premier paramétrage (admin)
1. **Paramètres** : adresse de l'atelier (géolocalisée automatiquement), e-mail de réception des rapports.
2. **Outils** : saisir l'outillage du magasin central (nom, catégorie, référence, quantité, emplacement).
3. **Clients** : créer les clients ; la distance atelier est calculée à l'enregistrement.
4. **Utilisateurs** : créer les comptes (RH, collaborateurs) et transmettre les identifiants provisoires.
5. **Ordres de mission** : créer le premier chantier, affecter l'équipe, désigner le chef d'équipe.

## 6. Limites connues et points d'attention
- **Localisation** : un navigateur ne permet pas le suivi en arrière-plan. La position est transmise à chaque pointage et toutes les 5 minutes pendant une journée en cours **tant que l'application est ouverte**. Un suivi permanent nécessiterait une application Android native (Capacitor), possible en évolution.
- **RGPD / droit du travail belge** : la géolocalisation du personnel doit être annoncée par écrit (finalité, durée, personnes ayant accès), limitée aux heures de travail et proportionnée. Seule la dernière position est conservée. Prévoir une mention dans le règlement de travail.
- **Offre gratuite Supabase** : 500 Mo de base, 1 Go de fichiers, projet mis en pause après 7 jours sans activité (réactivation en un clic dans le tableau de bord). Usage quotidien = pas de pause.
- **Distances** : itinéraire routier via le serveur public OSRM ; en cas d'indisponibilité, estimation à vol d'oiseau × 1,3 (signalée « estimation »).
- **Pièces jointes** : 50 Mo maximum par fichier (limite Supabase gratuite).
- **Photos** : compressées dans le téléphone (1600 px, ~300 Ko). 1 Go de stockage gratuit = environ 3 000 photos. Rapport e-mail : 20 photos / 8 Mo maximum en pièces jointes, les suivantes restent consultables dans l'application.
- **Migration 002** (photos) : `supabase/migration_002_photos.sql`, déjà appliquée au projet et intégrée à `schema.sql` pour une nouvelle installation.

## 7. Structure du projet
```
index.html, manifest.webmanifest, sw.js   Application et installation PWA
css/app.css                               Charte graphique Monsieur Maréchal
js/config.js                              URL et clé publique Supabase
js/core.js                                Client Supabase, utilitaires, interface
js/geo.js                                 Géocodage, distances, localisation
js/missions.js                            Ordres de mission, pointage, signature
js/hr.js                                  Congés, heures sup., récap RH, utilisateurs, compte
js/admin.js                               Outils, clients, paramètres, carte
supabase/schema.sql                       Tables, sécurité RLS, triggers, stockage
supabase/functions/create-user            Création de comptes / mot de passe provisoire
supabase/functions/send-report            Envoi e-mail du rapport signé
```
