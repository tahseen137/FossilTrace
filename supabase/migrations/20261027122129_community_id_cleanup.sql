create or replace function public.recompute_find(fid uuid)
returns void language plpgsql security definer set search_path = '' as $$
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
    status = case when coalesce(top.n_other, 0) >= 2 and top.n * 3 > total * 2 then 'confirmed' else 'unverified' end
  where id = fid;
end $$;
revoke execute on function public.recompute_find(uuid) from public, anon, authenticated;

create or replace function public.recompute_community_id()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.recompute_find(coalesce(new.find_id, old.find_id));
  return null;
end $$;

create or replace function public.recompute_on_guess()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.recompute_find(new.id);
  return null;
end $$;
