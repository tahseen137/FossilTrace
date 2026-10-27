-- The finder's guess resolved to a scientific name (from PBDB) so votes can be compared.
alter table public.finds add column if not exists taxon_name text check (char_length(taxon_name) <= 120);
-- Set only by the community-ID trigger.
alter table public.finds add column if not exists status text not null default 'unverified' check (status in ('unverified', 'confirmed'));
alter table public.finds add column if not exists community_taxon text;
alter table public.finds add column if not exists id_count integer not null default 0;
grant insert (taxon_name) on public.finds to authenticated;
grant update (taxon_name) on public.finds to authenticated;

create table if not exists public.identifications (
  find_id uuid not null references public.finds on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  taxon_label text not null check (char_length(taxon_label) between 1 and 120),
  taxon_name text check (char_length(taxon_name) <= 120),
  created_at timestamptz not null default now(),
  primary key (find_id, user_id)
);
create index if not exists identifications_user_idx on public.identifications (user_id);
alter table public.identifications enable row level security;
create policy "own identifications" on public.identifications for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, update on public.identifications from anon, authenticated;
grant insert (find_id, taxon_label, taxon_name) on public.identifications to authenticated;
grant update (taxon_label, taxon_name) on public.identifications to authenticated;

-- No IDs on your own find, on hidden or private finds, or from banned accounts.
create or replace function public.check_identification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare f record;
begin
  select user_id, visibility, hidden into f from public.finds where id = new.find_id;
  if f.user_id = new.user_id then raise exception 'You can''t identify your own find.'; end if;
  if f.visibility <> 'public' or f.hidden then raise exception 'This find isn''t open for identification.'; end if;
  if exists (select 1 from public.profiles where id = new.user_id and banned) then
    raise exception 'This account can no longer add identifications.';
  end if;
  return new;
end $$;
revoke execute on function public.check_identification() from public, anon, authenticated;
create trigger identifications_check before insert or update on public.identifications
  for each row execute function public.check_identification();

-- Recompute the community ID. Votes: the finder's guess plus one per identifier.
-- Confirmed when at least two other people back the leading name and it has over two thirds of all votes.
create or replace function public.recompute_community_id()
returns trigger language plpgsql security definer set search_path = '' as $$
declare fid uuid := coalesce(new.find_id, old.find_id);
declare top record; total int; n_ids int;
begin
  with votes as (
    select lower(coalesce(nullif(f.taxon_name, ''), f.taxon_guess)) as k, coalesce(nullif(f.taxon_name, ''), f.taxon_guess) as label, false as other
      from public.finds f where f.id = fid and coalesce(nullif(f.taxon_name, ''), f.taxon_guess) is not null
    union all
    select lower(coalesce(nullif(i.taxon_name, ''), i.taxon_label)), coalesce(nullif(i.taxon_name, ''), i.taxon_label), true
      from public.identifications i where i.find_id = fid
  )
  select k, min(label) as label, count(*) as n, count(*) filter (where other) as n_other
    into top from votes group by k order by count(*) filter (where other) desc, count(*) desc limit 1;
  select count(*) into n_ids from public.identifications where find_id = fid;
  total := n_ids + (select case when coalesce(nullif(taxon_name, ''), taxon_guess) is null then 0 else 1 end from public.finds where id = fid);
  update public.finds set
    id_count = n_ids,
    community_taxon = case when n_ids > 0 then top.label end,
    status = case when top.n_other >= 2 and top.n * 3 > total * 2 then 'confirmed' else 'unverified' end
  where id = fid;
  return null;
end $$;
revoke execute on function public.recompute_community_id() from public, anon, authenticated;
create trigger identifications_recompute after insert or update or delete on public.identifications
  for each row execute function public.recompute_community_id();

-- The finder changing their guess also changes the vote.
create or replace function public.recompute_on_guess()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.identifications where find_id = new.id) then
    perform 1; -- fall through to a fake identification-row recompute
    update public.identifications set taxon_label = taxon_label where find_id = new.id and user_id = (select user_id from public.identifications where find_id = new.id limit 1);
  end if;
  return null;
end $$;
revoke execute on function public.recompute_on_guess() from public, anon, authenticated;
create trigger finds_guess_changed after update of taxon_guess, taxon_name on public.finds
  for each row when (old.taxon_guess is distinct from new.taxon_guess or old.taxon_name is distinct from new.taxon_name)
  execute function public.recompute_on_guess();

-- Public map v2: photo required to be public, plus ID status.
create or replace function public.map_finds(w double precision, s double precision, e double precision, n double precision)
returns table (
  id uuid, display_name text, lat double precision, lng double precision, found_on date,
  taxon_guess text, taxon_name text, period_guess text, rock_unit text, photo_paths text[], notable boolean,
  status text, community_taxon text, id_count integer, created_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select f.id, p.display_name,
         extensions.st_y(f.public_location::extensions.geometry), extensions.st_x(f.public_location::extensions.geometry),
         f.found_on, f.taxon_guess, f.taxon_name, f.period_guess, f.rock_unit, f.photo_paths, f.notable,
         f.status, f.community_taxon, f.id_count, f.created_at
  from public.finds f join public.profiles p on p.id = f.user_id
  where f.visibility = 'public' and not f.hidden and not p.banned
    and coalesce(array_length(f.photo_paths, 1), 0) > 0
    and f.public_location operator(extensions.&&) extensions.st_makeenvelope(w, s, e, n, 4326)::extensions.geography
  order by f.created_at desc
  limit 500;
$$;
revoke execute on function public.map_finds(double precision, double precision, double precision, double precision) from public;
grant execute on function public.map_finds(double precision, double precision, double precision, double precision) to anon, authenticated;

-- The caller's own finds, exact spot, with ID status and moderation state.
create or replace function public.own_finds()
returns table (
  id uuid, display_name text, lat double precision, lng double precision, found_on date,
  taxon_guess text, taxon_name text, period_guess text, rock_unit text, notes text, photo_paths text[],
  visibility text, notable boolean, status text, community_taxon text, id_count integer, hidden boolean, created_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select f.id, 'You'::text,
         extensions.st_y(f.location::extensions.geometry), extensions.st_x(f.location::extensions.geometry),
         f.found_on, f.taxon_guess, f.taxon_name, f.period_guess, f.rock_unit, f.notes, f.photo_paths,
         f.visibility, f.notable, f.status, f.community_taxon, f.id_count, f.hidden, f.created_at
  from public.finds f
  where f.user_id = auth.uid()
  order by f.created_at desc;
$$;
revoke execute on function public.own_finds() from public, anon;
grant execute on function public.own_finds() to authenticated;

-- Identifications on a find anyone can see (or your own find).
create or replace function public.find_identifications(fid uuid)
returns table (display_name text, taxon_label text, taxon_name text, created_at timestamptz, mine boolean)
language sql stable security definer set search_path = ''
as $$
  select p.display_name, i.taxon_label, i.taxon_name, i.created_at, i.user_id = auth.uid()
  from public.identifications i
  join public.profiles p on p.id = i.user_id
  join public.finds f on f.id = i.find_id
  join public.profiles fp on fp.id = f.user_id
  where i.find_id = fid and not p.banned
    and (f.user_id = auth.uid() or (f.visibility = 'public' and not f.hidden and not fp.banned))
  order by i.created_at;
$$;
revoke execute on function public.find_identifications(uuid) from public;
grant execute on function public.find_identifications(uuid) to anon, authenticated;
