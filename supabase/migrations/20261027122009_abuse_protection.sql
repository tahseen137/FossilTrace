alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.finds add column if not exists hidden boolean not null default false;
alter table public.finds add column if not exists report_count integer not null default 0;
alter table public.finds add constraint finds_max_photos check (coalesce(array_length(photo_paths, 1), 0) <= 4);
alter table public.finds add constraint finds_taxon_len check (char_length(taxon_guess) <= 120);
alter table public.finds add constraint finds_period_len check (char_length(period_guess) <= 60);
alter table public.finds add constraint finds_rock_len check (char_length(rock_unit) <= 160);

revoke insert, update on public.profiles from anon, authenticated;
revoke insert, update on public.finds from anon, authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant insert (location, found_on, taxon_guess, period_guess, rock_unit, notes, photo_paths, visibility, notable)
  on public.finds to authenticated;
grant update (location, found_on, taxon_guess, period_guess, rock_unit, notes, photo_paths, visibility, notable)
  on public.finds to authenticated;

create or replace function public.check_find_limits()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where id = new.user_id and banned) then
    raise exception 'This account can no longer log finds.';
  end if;
  if (select count(*) from public.finds where user_id = new.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Daily limit reached (20 finds a day). Try again tomorrow.';
  end if;
  return new;
end $$;
revoke execute on function public.check_find_limits() from public, anon, authenticated;
create trigger finds_limits before insert on public.finds for each row execute function public.check_find_limits();

create table if not exists public.reports (
  find_id uuid not null references public.finds on delete cascade,
  reporter_id uuid not null default auth.uid() references auth.users on delete cascade,
  reason text not null check (reason in ('spam', 'fake', 'wrong_id', 'inappropriate', 'sensitive_site')),
  created_at timestamptz not null default now(),
  primary key (find_id, reporter_id)
);
create index if not exists reports_reporter_idx on public.reports (reporter_id);
alter table public.reports enable row level security;
create policy "report as yourself" on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));
create policy "see own reports" on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()));

create or replace function public.count_report()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.finds
     set report_count = report_count + 1,
         hidden = hidden or report_count + 1 >= 3
   where id = new.find_id;
  return new;
end $$;
revoke execute on function public.count_report() from public, anon, authenticated;
create trigger reports_count after insert on public.reports for each row execute function public.count_report();

create or replace function public.finds_in_box(w double precision, s double precision, e double precision, n double precision)
returns table (
  id uuid, display_name text, lat double precision, lng double precision, found_on date,
  taxon_guess text, period_guess text, rock_unit text, photo_paths text[], notable boolean, created_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select f.id, p.display_name,
         extensions.st_y(f.public_location::extensions.geometry), extensions.st_x(f.public_location::extensions.geometry),
         f.found_on, f.taxon_guess, f.period_guess, f.rock_unit, f.photo_paths, f.notable, f.created_at
  from public.finds f join public.profiles p on p.id = f.user_id
  where f.visibility = 'public' and not f.hidden and not p.banned
    and f.public_location operator(extensions.&&) extensions.st_makeenvelope(w, s, e, n, 4326)::extensions.geography
  order by f.created_at desc
  limit 500;
$$;

update storage.buckets set file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'] where id = 'find-photos';
alter policy "upload own photos" on storage.objects
  with check (
    bucket_id = 'find-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.banned)
  );
