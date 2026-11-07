-- =====================================================================
-- Monsieur Maréchal - Gestion de chantiers
-- Schéma Supabase complet (à exécuter une seule fois dans SQL Editor)
-- =====================================================================

-- ---------- Types ----------
do $$ begin
  create type user_role as enum ('admin','rh','collaborateur');
exception when duplicate_object then null; end $$;
do $$ begin
  create type mission_status as enum ('planifiee','en_cours','terminee','annulee');
exception when duplicate_object then null; end $$;
do $$ begin
  create type leave_type as enum ('conge','recuperation','maladie','autre');
exception when duplicate_object then null; end $$;
do $$ begin
  create type leave_status as enum ('en_attente','approuvee','refusee');
exception when duplicate_object then null; end $$;

-- ---------- Profils utilisateurs ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  role user_role not null default 'collaborateur',
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Paramètres entreprise (ligne unique) ----------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default 'Monsieur Maréchal',
  workshop_address text,
  workshop_lat double precision,
  workshop_lng double precision,
  report_email text,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- Outils du magasin central ----------
create table if not exists public.tools (
  id bigint generated always as identity primary key,
  name text not null,
  reference text,
  category text,
  quantity int not null default 1,
  location text,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- Clients ----------
create table if not exists public.clients (
  id bigint generated always as identity primary key,
  name text not null,
  contact text,
  phone text,
  email text,
  address text not null,
  lat double precision,
  lng double precision,
  distance_km numeric(7,1),
  duration_min int,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- Ordres de mission ----------
create table if not exists public.missions (
  id bigint generated always as identity primary key,
  client_id bigint references public.clients(id) on delete set null,
  title text not null,
  address text not null,
  lat double precision,
  lng double precision,
  distance_km numeric(7,1),
  duration_min int,
  scheduled_date date not null,
  end_date date,
  start_time time,
  description text,
  materials text,
  status mission_status not null default 'planifiee',
  team_leader_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.mission_members (
  mission_id bigint references public.missions(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  primary key (mission_id, user_id)
);

create table if not exists public.mission_tools (
  mission_id bigint references public.missions(id) on delete cascade,
  tool_id bigint references public.tools(id) on delete cascade,
  qty int not null default 1,
  primary key (mission_id, tool_id)
);

create table if not exists public.mission_files (
  id bigint generated always as identity primary key,
  mission_id bigint references public.missions(id) on delete cascade,
  path text not null,
  name text not null,
  created_at timestamptz not null default now()
);

-- ---------- Pointages ----------
create table if not exists public.time_entries (
  id bigint generated always as identity primary key,
  mission_id bigint not null references public.missions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  workshop_arrival timestamptz,
  site_arrival timestamptz,
  site_end timestamptz,
  note text,
  technical_note text,
  exclusion_note text,
  updated_at timestamptz not null default now(),
  unique (mission_id, user_id, work_date)
);

-- ---------- Rapports journaliers signés ----------
create table if not exists public.day_reports (
  id bigint generated always as identity primary key,
  mission_id bigint not null references public.missions(id) on delete cascade,
  work_date date not null,
  leader_id uuid references public.profiles(id) on delete set null,
  client_name text not null,
  signature_path text not null,
  signed_at timestamptz not null default now(),
  emailed boolean not null default false,
  unique (mission_id, work_date)
);

-- ---------- Congés / récupérations ----------
create table if not exists public.leave_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type leave_type not null default 'conge',
  start_date date not null,
  end_date date not null,
  hours numeric(6,2),
  reason text,
  status leave_status not null default 'en_attente',
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  admin_comment text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

-- ---------- Heures supplémentaires (mouvements) ----------
create table if not exists public.overtime_adjustments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  hours numeric(6,2) not null,
  reason text,
  leave_request_id bigint references public.leave_requests(id) on delete set null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create or replace view public.overtime_balance with (security_invoker = true) as
  select p.id as user_id, coalesce(sum(a.hours), 0)::numeric(8,2) as balance
  from public.profiles p
  left join public.overtime_adjustments a on a.user_id = p.id
  group by p.id;

-- ---------- Dernière position connue ----------
create table if not exists public.user_locations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  updated_at timestamptz not null default now()
);

-- =====================================================================
-- Fonctions d'aide (security definer : évitent la récursion RLS)
-- =====================================================================
create or replace function public.my_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','rh') from profiles where id = auth.uid() and active), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid() and active), false)
$$;

create or replace function public.is_member(m bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from mission_members where mission_id = m and user_id = auth.uid())
$$;

create or replace function public.is_leader(m bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from missions where id = m and team_leader_id = auth.uid())
$$;

-- Création automatique du profil à la création d'un compte.
-- Le rôle vient de app_metadata (non modifiable par l'utilisateur).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, phone, role, must_change_password)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    coalesce((new.raw_app_meta_data->>'role')::user_role, 'collaborateur'),
    true
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Un collaborateur ne peut pas modifier son rôle ni son statut.
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Appels serveur (Edge Functions, service_role) : pas de restriction
  if auth.uid() is null then return new; end if;
  if not is_staff() then
    new.role := old.role;
    new.active := old.active;
    new.email := old.email;
  end if;
  -- Seul un admin peut créer ou modifier un admin
  if (new.role = 'admin' or old.role = 'admin') and new.role is distinct from old.role and not is_admin() then
    new.role := old.role;
  end if;
  return new;
end $$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();

-- Récupération approuvée => débit automatique du compteur d'heures sup.
create or replace function public.leave_overtime_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'recuperation' and coalesce(new.hours,0) > 0 then
    if new.status = 'approuvee' and old.status is distinct from 'approuvee' then
      insert into overtime_adjustments (user_id, hours, reason, leave_request_id, created_by)
      values (new.user_id, -new.hours, 'Récupération du ' || to_char(new.start_date,'DD/MM/YYYY'), new.id, auth.uid());
    elsif old.status = 'approuvee' and new.status <> 'approuvee' then
      delete from overtime_adjustments where leave_request_id = new.id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists leave_overtime on public.leave_requests;
create trigger leave_overtime after update on public.leave_requests
  for each row execute function public.leave_overtime_sync();

-- Verrouillage des pointages après signature client
create or replace function public.lock_signed_entries() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() and exists(select 1 from day_reports d
      where d.mission_id = coalesce(new.mission_id, old.mission_id)
        and d.work_date = coalesce(new.work_date, old.work_date)) then
    raise exception 'Journée déjà signée par le client : pointage verrouillé';
  end if;
  if tg_op <> 'DELETE' then new.updated_at := now(); return new; end if;
  return old;
end $$;

drop trigger if exists time_entries_lock on public.time_entries;
create trigger time_entries_lock before insert or update or delete on public.time_entries
  for each row execute function public.lock_signed_entries();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.tools enable row level security;
alter table public.clients enable row level security;
alter table public.missions enable row level security;
alter table public.mission_members enable row level security;
alter table public.mission_tools enable row level security;
alter table public.mission_files enable row level security;
alter table public.time_entries enable row level security;
alter table public.day_reports enable row level security;
alter table public.leave_requests enable row level security;
alter table public.overtime_adjustments enable row level security;
alter table public.user_locations enable row level security;

-- Nettoyage des politiques existantes (ré-exécution possible)
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles
create policy p_sel on public.profiles for select to authenticated using (true);
create policy p_upd_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy p_upd_staff on public.profiles for update to authenticated using (is_staff()) with check (is_staff());

-- settings
create policy s_sel on public.settings for select to authenticated using (true);
create policy s_upd on public.settings for update to authenticated using (is_admin()) with check (is_admin());

-- tools : lecture pour tous, écriture admin/RH, suppression admin/RH
create policy t_sel on public.tools for select to authenticated using (true);
create policy t_ins on public.tools for insert to authenticated with check (is_staff());
create policy t_upd on public.tools for update to authenticated using (is_staff()) with check (is_staff());
create policy t_del on public.tools for delete to authenticated using (is_staff());

-- clients
create policy c_sel on public.clients for select to authenticated using (true);
create policy c_ins on public.clients for insert to authenticated with check (is_staff());
create policy c_upd on public.clients for update to authenticated using (is_staff()) with check (is_staff());
create policy c_del on public.clients for delete to authenticated using (is_admin());

-- missions
create policy m_sel on public.missions for select to authenticated using (is_staff() or is_member(id));
create policy m_ins on public.missions for insert to authenticated with check (is_staff());
create policy m_upd on public.missions for update to authenticated using (is_staff()) with check (is_staff());
create policy m_del on public.missions for delete to authenticated using (is_admin());

create policy mm_sel on public.mission_members for select to authenticated using (is_staff() or is_member(mission_id));
create policy mm_all on public.mission_members for all to authenticated using (is_staff()) with check (is_staff());

create policy mt_sel on public.mission_tools for select to authenticated using (is_staff() or is_member(mission_id));
create policy mt_all on public.mission_tools for all to authenticated using (is_staff()) with check (is_staff());

create policy mf_sel on public.mission_files for select to authenticated using (is_staff() or is_member(mission_id));
create policy mf_all on public.mission_files for all to authenticated using (is_staff()) with check (is_staff());

-- time_entries
create policy te_sel on public.time_entries for select to authenticated
  using (user_id = auth.uid() or is_staff() or is_leader(mission_id));
create policy te_ins on public.time_entries for insert to authenticated
  with check (is_staff() or ((user_id = auth.uid() and is_member(mission_id)) or is_leader(mission_id)));
create policy te_upd on public.time_entries for update to authenticated
  using (is_staff() or user_id = auth.uid() or is_leader(mission_id))
  with check (is_staff() or user_id = auth.uid() or is_leader(mission_id));
create policy te_del on public.time_entries for delete to authenticated using (is_staff());

-- day_reports : seul le chef d'équipe (ou admin/RH) fait signer
create policy dr_sel on public.day_reports for select to authenticated using (is_staff() or is_member(mission_id));
create policy dr_ins on public.day_reports for insert to authenticated with check (is_staff() or is_leader(mission_id));
create policy dr_upd on public.day_reports for update to authenticated using (is_staff()) with check (is_staff());
create policy dr_del on public.day_reports for delete to authenticated using (is_admin());

-- leave_requests
create policy lr_sel on public.leave_requests for select to authenticated using (user_id = auth.uid() or is_staff());
create policy lr_ins on public.leave_requests for insert to authenticated with check (user_id = auth.uid() and status = 'en_attente');
create policy lr_upd on public.leave_requests for update to authenticated using (is_staff()) with check (is_staff());
create policy lr_del on public.leave_requests for delete to authenticated
  using (is_staff() or (user_id = auth.uid() and status = 'en_attente'));

-- overtime_adjustments : mis à jour par admin/RH uniquement
create policy oa_sel on public.overtime_adjustments for select to authenticated using (user_id = auth.uid() or is_staff());
create policy oa_ins on public.overtime_adjustments for insert to authenticated with check (is_staff());
create policy oa_del on public.overtime_adjustments for delete to authenticated using (is_admin());

-- user_locations : chacun publie sa position, seul l'admin la consulte
create policy ul_sel on public.user_locations for select to authenticated using (is_admin() or user_id = auth.uid());
create policy ul_ins on public.user_locations for insert to authenticated with check (user_id = auth.uid());
create policy ul_upd on public.user_locations for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- Stockage des fichiers (plans, documents, signatures)
-- =====================================================================
insert into storage.buckets (id, name, public) values ('mission-files','mission-files', false) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('signatures','signatures', false) on conflict do nothing;

drop policy if exists mf_read on storage.objects;
drop policy if exists mf_write on storage.objects;
drop policy if exists mf_delete on storage.objects;
drop policy if exists sg_read on storage.objects;
drop policy if exists sg_write on storage.objects;

-- Chemin attendu : <mission_id>/<fichier>
create policy mf_read on storage.objects for select to authenticated
  using (bucket_id = 'mission-files' and (is_staff() or is_member(((storage.foldername(name))[1])::bigint)));
create policy mf_write on storage.objects for insert to authenticated
  with check (bucket_id = 'mission-files' and is_staff());
create policy mf_delete on storage.objects for delete to authenticated
  using (bucket_id = 'mission-files' and is_staff());

create policy sg_read on storage.objects for select to authenticated
  using (bucket_id = 'signatures' and (is_staff() or is_member(((storage.foldername(name))[1])::bigint)));
create policy sg_write on storage.objects for insert to authenticated
  with check (bucket_id = 'signatures' and (is_staff() or is_leader(((storage.foldername(name))[1])::bigint)));

-- =====================================================================
-- Index
-- =====================================================================
create index if not exists idx_missions_date on public.missions(scheduled_date);
create index if not exists idx_te_user_date on public.time_entries(user_id, work_date);
create index if not exists idx_te_mission on public.time_entries(mission_id, work_date);
create index if not exists idx_lr_user on public.leave_requests(user_id);
create index if not exists idx_oa_user on public.overtime_adjustments(user_id);

-- =====================================================================
-- PREMIER ADMINISTRATEUR
-- 1) Authentication > Users > Add user (email + mot de passe, "Auto confirm")
-- 2) Exécuter (en remplaçant l'email) :
--    update public.profiles set role = 'admin', must_change_password = false,
--      full_name = 'Mathieu Maréchal' where email = 'VOTRE_EMAIL';
-- =====================================================================
