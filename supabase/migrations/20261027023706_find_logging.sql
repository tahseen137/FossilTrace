create extension if not exists postgis with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  created_at timestamptz not null default now()
);

create table public.finds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade default auth.uid(),
  location extensions.geography(point, 4326) not null,
  public_location extensions.geography(point, 4326) generated always as (
    extensions.st_snaptogrid(location::extensions.geometry, 0.1)::extensions.geography
  ) stored,
  found_on date,
  taxon_guess text,
  period_guess text,
  rock_unit text,
  notes text check (char_length(notes) <= 2000),
  photo_paths text[] not null default '{}',
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  notable boolean not null default false,
  created_at timestamptz not null default now()
);
create index finds_public_location_idx on public.finds using gist (public_location);
create index finds_user_id_idx on public.finds (user_id);

alter table public.profiles enable row level security;
alter table public.finds enable row level security;

create policy "profiles are readable" on public.profiles for select using (true);
create policy "own profile" on public.profiles for all using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "own finds" on public.finds for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create view public.public_finds with (security_invoker = false) as
  select f.id, p.display_name,
         extensions.st_y(f.public_location::extensions.geometry) as lat,
         extensions.st_x(f.public_location::extensions.geometry) as lng,
         f.found_on, f.taxon_guess, f.period_guess, f.rock_unit, f.photo_paths, f.notable, f.created_at
  from public.finds f join public.profiles p on p.id = f.user_id
  where f.visibility = 'public';
revoke all on public.public_finds from anon, authenticated;
grant select on public.public_finds to anon, authenticated;

insert into storage.buckets (id, name, public) values ('find-photos', 'find-photos', true)
  on conflict (id) do nothing;
create policy "upload own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'find-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "delete own photos" on storage.objects for delete to authenticated
  using (bucket_id = 'find-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create or replace function public.my_finds()
returns table (
  id uuid, display_name text, lat double precision, lng double precision, found_on date,
  taxon_guess text, period_guess text, rock_unit text, notes text, photo_paths text[],
  visibility text, notable boolean, created_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select f.id, 'You'::text,
         extensions.st_y(f.location::extensions.geometry), extensions.st_x(f.location::extensions.geometry),
         f.found_on, f.taxon_guess, f.period_guess, f.rock_unit, f.notes, f.photo_paths,
         f.visibility, f.notable, f.created_at
  from public.finds f
  where f.user_id = auth.uid()
  order by f.created_at desc;
$$;
revoke execute on function public.my_finds() from anon, public;
grant execute on function public.my_finds() to authenticated;
