-- Retire the owner-rights view: run it with the caller's rights and stop exposing it.
alter view public.public_finds set (security_invoker = true);
revoke select on public.public_finds from anon, authenticated;

-- Public finds inside a map box, snapped to ~10 km. Runs as owner so it can read other people's rows,
-- but it only ever returns public rows and never the exact location or notes.
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
  where f.visibility = 'public'
    and f.public_location operator(extensions.&&) extensions.st_makeenvelope(w, s, e, n, 4326)::extensions.geography
  order by f.created_at desc
  limit 500;
$$;
revoke execute on function public.finds_in_box(double precision, double precision, double precision, double precision) from public;
grant execute on function public.finds_in_box(double precision, double precision, double precision, double precision) to anon, authenticated;
