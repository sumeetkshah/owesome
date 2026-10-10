-- Members could never be removed, so a typo or a duplicate join ("Rahul" and "rahul k") stayed in the
-- group for good and was included in every equal split by default.
--
-- Deleting a member row would cascade away their payer and split rows and break every expense they
-- were on, so members are soft-removed instead (`removed_at`) and stay visible by name in history.
--   * remove_member: for someone with no expenses or payments
--   * merge_member: moves everything one member paid, owes or settled onto another, for duplicates
-- Both are logged and can be undone from the activity log.

alter table public.members add column removed_at timestamptz;

-- Names only need to be unique among current members, so a removed name can be reused.
drop index public.members_group_name_key;
create unique index members_group_name_key on public.members (group_id, lower(name)) where removed_at is null;

-- New writes may only reference current members.
create or replace function public._assert_members(p_group uuid, p_ids uuid[]) returns void
language plpgsql stable set search_path = '' as $$
begin
  if exists (
    select 1 from unnest(p_ids) as m(id)
    where not exists (select 1 from public.members where id = m.id and group_id = p_group and removed_at is null)
  ) then
    raise exception 'Unknown member for this group';
  end if;
end $$;

-- Removed members don't count towards the 50-person limit.
create or replace function public._assert_room(p_group uuid, p_what text) returns void
language plpgsql stable set search_path = '' as $$
declare
  n int;
  cap int;
  label text;
begin
  case p_what
    when 'members' then
      select count(*) into n from public.members where group_id = p_group and removed_at is null;
      cap := 50; label := 'people';
    when 'categories' then
      select count(*) into n from public.categories where group_id = p_group; cap := 50; label := 'custom categories';
    when 'expenses' then
      select count(*) into n from public.expenses where group_id = p_group; cap := 2000; label := 'expenses';
    when 'settlements' then
      select count(*) into n from public.settlements where group_id = p_group; cap := 2000; label := 'payments';
  end case;
  if n >= cap then
    raise exception 'This group has reached the limit of % %', cap, label;
  end if;
end $$;

create function public._assert_name_free(p_group uuid, p_name text, p_except uuid default null) returns void
language plpgsql stable set search_path = '' as $$
begin
  if exists (select 1 from public.members
             where group_id = p_group and removed_at is null and id is distinct from p_except
               and lower(name) = lower(btrim(p_name))) then
    raise exception 'Someone called % is already in this group', btrim(p_name);
  end if;
end $$;

revoke all on function public._assert_name_free(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.add_member(p_code text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  m public.members;
begin
  perform public._assert_name_free(gid, p_name);
  insert into public.members (group_id, name, color)
  values (gid, btrim(p_name), (select count(*) % 8 from public.members where group_id = gid))
  returning * into m;
  perform public._log(gid, m.id, 'member.joined', m.id, jsonb_build_object('name', m.name));
  return to_jsonb(m) - 'group_id';
end $$;

create or replace function public.update_member(p_code text, p_id uuid, p_name text, p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  old_name text;
  m public.members;
begin
  perform public._assert_members(gid, array[p_id]);
  perform public._assert_name_free(gid, p_name, p_id);
  select name into old_name from public.members where id = p_id;
  update public.members set name = btrim(p_name) where id = p_id returning * into m;
  if m.name <> old_name then
    perform public._log(gid, p_actor, 'member.renamed', p_id,
                        jsonb_build_object('name', m.name, 'old_name', old_name));
  end if;
  return to_jsonb(m) - 'group_id';
end $$;

create function public.remove_member(p_code text, p_id uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  m public.members;
begin
  perform public._assert_members(gid, array[p_id]);
  select * into m from public.members where id = p_id;
  if exists (select 1 from public.expense_payers where member_id = p_id)
     or exists (select 1 from public.expense_splits where member_id = p_id)
     or exists (select 1 from public.settlements where from_member = p_id or to_member = p_id) then
    raise exception '% is on expenses or payments. Merge them into someone else instead.', m.name;
  end if;
  if not exists (select 1 from public.members where group_id = gid and removed_at is null and id <> p_id) then
    raise exception 'A group needs at least one person';
  end if;
  update public.members set removed_at = now() where id = p_id;
  perform public._log(gid, p_actor, 'member.removed', p_id, jsonb_build_object('name', m.name));
end $$;

-- Moves everything p_from paid, owes or settled onto p_into, then removes p_from. Balances are
-- preserved exactly: p_into ends up with the sum of both positions.
create function public.merge_member(p_code text, p_from uuid, p_into uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  src public.members;
  dst public.members;
  touched uuid[];
  gone uuid[];
  snap jsonb;
begin
  if p_from = p_into then
    raise exception 'Pick someone else to merge into';
  end if;
  perform public._assert_members(gid, array[p_from, p_into]);
  select * into src from public.members where id = p_from;
  select * into dst from public.members where id = p_into;

  select coalesce(array_agg(distinct e.id), '{}') into touched
  from public.expenses e
  where e.group_id = gid and (
    e.created_by = p_from
    or exists (select 1 from public.expense_payers p where p.expense_id = e.id and p.member_id = p_from)
    or exists (select 1 from public.expense_splits s where s.expense_id = e.id and s.member_id = p_from));

  select coalesce(array_agg(id), '{}') into gone from public.settlements
  where (from_member = p_from and to_member = p_into) or (from_member = p_into and to_member = p_from);

  snap := jsonb_build_object(
    'member', to_jsonb(src),
    'expenses', coalesce((select jsonb_agg(public._expense_json(id)) from unnest(touched) id), '[]'::jsonb),
    'settlements', coalesce((select jsonb_agg(to_jsonb(s)) from public.settlements s
                             where s.from_member = p_from or s.to_member = p_from), '[]'::jsonb));

  -- Payers: add to p_into's row where both paid, otherwise hand the row over.
  update public.expense_payers t
  set amount = t.amount + f.amount,
      original_amount = case when t.original_amount is null and f.original_amount is null then null
                             else coalesce(t.original_amount, 0) + coalesce(f.original_amount, 0) end
  from public.expense_payers f
  where f.member_id = p_from and t.member_id = p_into and t.expense_id = f.expense_id;
  delete from public.expense_payers f
  where f.member_id = p_from
    and exists (select 1 from public.expense_payers t where t.expense_id = f.expense_id and t.member_id = p_into);
  update public.expense_payers set member_id = p_into where member_id = p_from;

  -- Equal splits that include both become share splits (p_into gets two shares), so reopening and
  -- saving one doesn't quietly halve p_into's share.
  update public.expenses e set split_type = 'shares'
  where e.id = any(touched) and e.split_type = 'equal'
    and exists (select 1 from public.expense_splits s where s.expense_id = e.id and s.member_id = p_from)
    and exists (select 1 from public.expense_splits s where s.expense_id = e.id and s.member_id = p_into);
  update public.expense_splits s set weight = 1
  from public.expenses e
  where e.id = s.expense_id and e.id = any(touched) and e.split_type = 'shares' and s.weight is null;

  -- Splits: same as payers. Weights (percent, shares, typed foreign amounts) add up too.
  update public.expense_splits t
  set amount = t.amount + f.amount,
      weight = case when t.weight is null and f.weight is null then null
                    else coalesce(t.weight, 0) + coalesce(f.weight, 0) end
  from public.expense_splits f
  where f.member_id = p_from and t.member_id = p_into and t.expense_id = f.expense_id;
  delete from public.expense_splits f
  where f.member_id = p_from
    and exists (select 1 from public.expense_splits t where t.expense_id = f.expense_id and t.member_id = p_into);
  update public.expense_splits set member_id = p_into where member_id = p_from;

  -- Itemised bills keep who had each item in `meta`; point those at p_into too. Where both had an item,
  -- p_into is listed twice, which keeps their two portions.
  update public.expenses e
  set meta = jsonb_set(e.meta, '{items}', (
    select jsonb_agg(jsonb_set(it, '{members}', coalesce((
      select jsonb_agg(case when v = p_from::text then p_into::text else v end)
      from jsonb_array_elements_text(it->'members') v), '[]'::jsonb)))
    from jsonb_array_elements(e.meta->'items') it))
  where e.id = any(touched) and jsonb_typeof(e.meta->'items') = 'array';

  update public.expenses set created_by = p_into where id = any(touched) and created_by = p_from;

  -- Payments between the two would become someone paying themselves; they cancel out, so drop them.
  delete from public.settlements where id = any(gone);
  update public.settlements set from_member = p_into where from_member = p_from;
  update public.settlements set to_member = p_into where to_member = p_from;

  update public.members set removed_at = now() where id = p_from;
  perform public._log(gid, p_actor, 'member.merged', p_from, jsonb_build_object(
    'name', src.name, 'into', p_into, 'into_name', dst.name, 'dropped_settlements', to_jsonb(gone)), snap);
end $$;

-- Restores now cover removals and merges, and refuse to bring back rows that point at someone who has
-- since been removed or merged (that would hide money on a person nobody can see).
create or replace function public.restore_activity(p_code text, p_id uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  a public.activity;
  prev jsonb;
  snap jsonb;
  s jsonb;
  m public.members;
begin
  select * into a from public.activity where id = p_id and group_id = gid for update;
  if a.id is null then
    raise exception 'That change isn''t in this group''s history';
  end if;
  if a.restored_at is not null then
    raise exception 'That change has already been undone';
  end if;

  if a.action in ('expense.deleted', 'expense.updated') then
    if exists (
      select 1 from (
        select (x->>'member_id')::uuid id from jsonb_array_elements(a.before->'payers') x
        union select (x->>'member_id')::uuid from jsonb_array_elements(a.before->'splits') x) r
      join public.members mm on mm.id = r.id where mm.removed_at is not null) then
      raise exception 'This includes someone who has since been removed or merged. Undo that first.';
    end if;
  end if;

  if a.action = 'expense.deleted' then
    if exists (select 1 from public.expenses where id = a.target_id) then
      raise exception 'That expense is already back';
    end if;
    perform public._restore_expense(a.before);
    perform public._log(gid, p_actor, 'expense.restored', a.target_id, a.details);
  elsif a.action = 'expense.updated' then
    if not exists (select 1 from public.expenses where id = a.target_id) then
      raise exception 'That expense has since been deleted — restore the deletion first';
    end if;
    prev := public._expense_json(a.target_id);
    perform public._restore_expense(a.before);
    perform public._log(gid, p_actor, 'expense.restored', a.target_id, jsonb_build_object(
      'description', a.before->>'description', 'amount', (a.before->>'amount')::numeric,
      'kind', a.before->>'kind', 'reverted', true), prev);
  elsif a.action = 'settlement.deleted' then
    if exists (select 1 from public.settlements where id = a.target_id) then
      raise exception 'That payment is already back';
    end if;
    if exists (select 1 from public.members where id in ((a.before->>'from_member')::uuid, (a.before->>'to_member')::uuid)
               and removed_at is not null) then
      raise exception 'This includes someone who has since been removed or merged. Undo that first.';
    end if;
    insert into public.settlements select * from jsonb_populate_record(null::public.settlements, a.before);
    perform public._log(gid, p_actor, 'settlement.restored', a.target_id, a.details);
  elsif a.action in ('member.removed', 'member.merged') then
    select * into m from public.members where id = a.target_id;
    if m.removed_at is null then
      raise exception '% is already back', m.name;
    end if;
    perform public._assert_name_free(gid, m.name);
    perform public._assert_room(gid, 'members');
    update public.members set removed_at = null where id = m.id;

    if a.action = 'member.merged' then
      snap := a.before;
      -- Put back each expense the merge touched, unless it has been deleted since.
      for s in select * from jsonb_array_elements(snap->'expenses') loop
        if exists (select 1 from public.expenses where id = (s->>'id')::uuid) then
          perform public._restore_expense(s);
        end if;
      end loop;
      -- Put back each payment, unless it has been deleted since (the merge's own drops come back).
      for s in select * from jsonb_array_elements(snap->'settlements') loop
        if exists (select 1 from public.settlements where id = (s->>'id')::uuid)
           or (a.details->'dropped_settlements') ? (s->>'id') then
          delete from public.settlements where id = (s->>'id')::uuid;
          insert into public.settlements select * from jsonb_populate_record(null::public.settlements, s);
        end if;
      end loop;
    end if;
    perform public._log(gid, p_actor, 'member.restored', m.id, jsonb_build_object('name', m.name));
  else
    raise exception 'That change can''t be undone';
  end if;

  update public.activity set restored_at = now() where id = a.id;
end $$;

revoke all on function public.remove_member(text, uuid, uuid), public.merge_member(text, uuid, uuid, uuid) from public;
grant execute on function public.remove_member(text, uuid, uuid), public.merge_member(text, uuid, uuid, uuid)
  to anon, authenticated;
