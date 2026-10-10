-- Remove UPI payments (settling up now happens outside the app) and add an activity log so every
-- change to a group is visible, attributed, and — for edits and deletions — reversible.
--
-- Write functions gain an optional `p_actor` (the member id the device says it is). There are no
-- accounts, so this is the member people claim to be rather than a verified identity; the point is a
-- visible trail, not authentication. Unknown actors are recorded as null rather than rejected.

-- ---------------------------------------------------------------------------
-- UPI
-- ---------------------------------------------------------------------------

drop function public.update_member(text, uuid, text, text);
alter table public.members drop column upi_id;

-- ---------------------------------------------------------------------------
-- Activity log
-- ---------------------------------------------------------------------------

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  actor uuid references public.members(id) on delete set null,
  -- group.created, group.updated, member.joined, member.renamed,
  -- expense.added, expense.updated, expense.deleted, expense.restored,
  -- settlement.added, settlement.deleted, settlement.restored
  action text not null,
  target_id uuid,
  -- Small display fields (description, amount, names) so the log reads without the snapshot.
  details jsonb not null default '{}',
  -- Full row as it was before the change, used to restore it.
  before jsonb,
  restored_at timestamptz,
  created_at timestamptz not null default now()
);
create index activity_group_idx on public.activity (group_id, created_at desc);

alter table public.activity enable row level security;
revoke all on public.activity from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (not callable by clients)
-- ---------------------------------------------------------------------------

create function public._log(
  p_group uuid, p_actor uuid, p_action text, p_target uuid, p_details jsonb, p_before jsonb default null
) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.activity (group_id, actor, action, target_id, details, before)
  values (
    p_group,
    (select id from public.members where id = p_actor and group_id = p_group),
    p_action, p_target, coalesce(p_details, '{}'), p_before
  );
end $$;

-- The expense row plus its payers and splits, in a shape `_restore_expense` can reinsert.
create function public._expense_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(e) || jsonb_build_object(
    'payers', coalesce((select jsonb_agg(to_jsonb(p) - 'expense_id')
                        from public.expense_payers p where p.expense_id = e.id), '[]'::jsonb),
    'splits', coalesce((select jsonb_agg(to_jsonb(s) - 'expense_id')
                        from public.expense_splits s where s.expense_id = e.id), '[]'::jsonb))
  from public.expenses e where e.id = p_id;
$$;

-- Replaces the expense (if present) with the snapshot, keeping its original id and timestamps.
create function public._restore_expense(p_snap jsonb) returns void
language plpgsql set search_path = '' as $$
declare eid uuid := (p_snap->>'id')::uuid;
begin
  delete from public.expenses where id = eid;
  insert into public.expenses select * from jsonb_populate_record(null::public.expenses, p_snap);
  insert into public.expense_payers (expense_id, member_id, amount, original_amount)
  select eid, x.member_id, x.amount, x.original_amount
  from jsonb_to_recordset(p_snap->'payers') as x(member_id uuid, amount numeric, original_amount numeric);
  insert into public.expense_splits (expense_id, member_id, amount, weight)
  select eid, x.member_id, x.amount, x.weight
  from jsonb_to_recordset(p_snap->'splits') as x(member_id uuid, amount numeric, weight numeric);
end $$;

revoke all on function public._log(uuid, uuid, text, uuid, jsonb, jsonb), public._expense_json(uuid),
  public._restore_expense(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client API (signatures change, so drop and recreate; `p_actor` defaults to null so a client that
-- doesn't send it keeps working)
-- ---------------------------------------------------------------------------

drop function public.create_group(text, text, text, text, text[]);
drop function public.add_member(text, text);
drop function public.update_group(text, text, text);
drop function public.save_expense(text, jsonb);
drop function public.delete_expense(text, uuid);
drop function public.add_settlement(text, uuid, uuid, numeric, date, text);
drop function public.delete_settlement(text, uuid);

create function public.create_group(
  p_name text, p_emoji text, p_currency text, p_creator text, p_others text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
  code text;
  creator_id uuid;
  n text;
  i int := 1;
begin
  loop
    code := public._new_invite_code();
    exit when not exists (select 1 from public.groups where invite_code = code);
  end loop;

  insert into public.groups (name, emoji, currency, invite_code)
  values (btrim(p_name), coalesce(nullif(btrim(p_emoji), ''), '✈️'), upper(p_currency), code)
  returning id into gid;

  insert into public.members (group_id, name, color)
  values (gid, btrim(p_creator), 0)
  returning id into creator_id;

  foreach n in array coalesce(p_others, '{}') loop
    if btrim(n) <> '' then
      insert into public.members (group_id, name, color)
      values (gid, btrim(n), i % 8)
      on conflict do nothing;
      i := i + 1;
    end if;
  end loop;

  perform public._log(gid, creator_id, 'group.created', gid, jsonb_build_object('name', btrim(p_name)));
  return jsonb_build_object('invite_code', code, 'member_id', creator_id);
end $$;

create function public.add_member(p_code text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  m public.members;
begin
  if exists (select 1 from public.members where group_id = gid and lower(name) = lower(btrim(p_name))) then
    raise exception 'Someone called % is already in this group', btrim(p_name);
  end if;
  insert into public.members (group_id, name, color)
  values (gid, btrim(p_name), (select count(*) % 8 from public.members where group_id = gid))
  returning * into m;
  perform public._log(gid, m.id, 'member.joined', m.id, jsonb_build_object('name', m.name));
  return to_jsonb(m) - 'group_id';
end $$;

create function public.update_member(p_code text, p_id uuid, p_name text, p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  old_name text;
  m public.members;
begin
  if exists (select 1 from public.members
             where group_id = gid and id <> p_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'Someone called % is already in this group', btrim(p_name);
  end if;
  select name into old_name from public.members where id = p_id and group_id = gid;
  if old_name is null then
    raise exception 'Unknown member for this group';
  end if;
  update public.members set name = btrim(p_name) where id = p_id returning * into m;
  if m.name <> old_name then
    perform public._log(gid, p_actor, 'member.renamed', p_id,
                        jsonb_build_object('name', m.name, 'old_name', old_name));
  end if;
  return to_jsonb(m) - 'group_id';
end $$;

create function public.update_group(p_code text, p_name text, p_emoji text, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  g public.groups;
begin
  select * into g from public.groups where id = gid;
  update public.groups
  set name = btrim(p_name), emoji = coalesce(nullif(btrim(p_emoji), ''), emoji)
  where id = gid;
  perform public._log(gid, p_actor, 'group.updated', gid,
                      jsonb_build_object('name', btrim(p_name), 'old_name', g.name));
end $$;

-- p_expense: { id?, kind?, description, amount, category, split_type, spent_on, notes?, created_by?,
--              currency?, fx_rate?, original_amount?, meta?, receipts?,
--              payers: [{member_id, amount, original_amount?}], splits: [{member_id, amount, weight?}] }
create function public.save_expense(p_code text, p_expense jsonb, p_actor uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  group_currency text := (select currency from public.groups where id = gid);
  eid uuid := nullif(p_expense->>'id', '')::uuid;
  total numeric(12, 2) := (p_expense->>'amount')::numeric;
  cur text := coalesce(nullif(upper(p_expense->>'currency'), ''), group_currency);
  rate numeric := coalesce((p_expense->>'fx_rate')::numeric, 1);
  v_receipts text[] := coalesce(
    (select array_agg(r) from jsonb_array_elements_text(coalesce(p_expense->'receipts', '[]')) r), '{}');
  payer_sum numeric;
  split_sum numeric;
  ids uuid[];
  prev jsonb;
begin
  if jsonb_array_length(coalesce(p_expense->'payers', '[]')) = 0 then
    raise exception 'An expense needs at least one payer';
  end if;
  if jsonb_array_length(coalesce(p_expense->'splits', '[]')) = 0 then
    raise exception 'An expense needs at least one person to split with';
  end if;
  -- Zero-amount payers are dropped below, so a negative one could otherwise offset a payer that is
  -- kept and leave the stored payers not adding up to the total.
  if exists (select 1 from jsonb_array_elements(p_expense->'payers') x where (x->>'amount')::numeric < 0) then
    raise exception 'Payer amounts can''t be negative';
  end if;
  if cur = group_currency then
    rate := 1;
  end if;
  if exists (select 1 from unnest(v_receipts) r where split_part(r, '/', 1) <> p_code) then
    raise exception 'Receipt does not belong to this group';
  end if;

  select sum((x->>'amount')::numeric), array_agg((x->>'member_id')::uuid)
  into payer_sum, ids from jsonb_array_elements(p_expense->'payers') x;
  perform public._assert_members(gid, ids);
  if payer_sum <> total then
    raise exception 'Payer amounts (%) must add up to the total (%)', payer_sum, total;
  end if;

  select sum((x->>'amount')::numeric), array_agg((x->>'member_id')::uuid)
  into split_sum, ids from jsonb_array_elements(p_expense->'splits') x;
  perform public._assert_members(gid, ids);
  if split_sum <> total then
    raise exception 'Split amounts (%) must add up to the total (%)', split_sum, total;
  end if;

  if (p_expense->>'created_by') is not null then
    perform public._assert_members(gid, array[(p_expense->>'created_by')::uuid]);
  end if;

  if eid is null then
    insert into public.expenses (group_id, kind, description, amount, category, split_type, spent_on, notes,
                                 created_by, currency, fx_rate, original_amount, meta, receipts)
    values (gid, coalesce(p_expense->>'kind', 'expense'), btrim(p_expense->>'description'), total,
            p_expense->>'category', p_expense->>'split_type',
            coalesce((p_expense->>'spent_on')::date, current_date), nullif(btrim(p_expense->>'notes'), ''),
            (p_expense->>'created_by')::uuid, cur, rate,
            coalesce((p_expense->>'original_amount')::numeric, total), p_expense->'meta', v_receipts)
    returning id into eid;
  else
    if not exists (select 1 from public.expenses where id = eid and group_id = gid) then
      raise exception 'Expense not found';
    end if;
    prev := public._expense_json(eid);
    update public.expenses
    set kind = coalesce(p_expense->>'kind', kind), description = btrim(p_expense->>'description'), amount = total,
        category = p_expense->>'category', split_type = p_expense->>'split_type',
        spent_on = coalesce((p_expense->>'spent_on')::date, spent_on),
        notes = nullif(btrim(p_expense->>'notes'), ''), currency = cur, fx_rate = rate,
        original_amount = coalesce((p_expense->>'original_amount')::numeric, total),
        meta = p_expense->'meta', receipts = v_receipts, updated_at = now()
    where id = eid;
    delete from public.expense_payers where expense_id = eid;
    delete from public.expense_splits where expense_id = eid;
  end if;

  insert into public.expense_payers (expense_id, member_id, amount, original_amount)
  select eid, (x->>'member_id')::uuid, (x->>'amount')::numeric, (x->>'original_amount')::numeric
  from jsonb_array_elements(p_expense->'payers') x
  where (x->>'amount')::numeric > 0;

  insert into public.expense_splits (expense_id, member_id, amount, weight)
  select eid, (x->>'member_id')::uuid, (x->>'amount')::numeric, (x->>'weight')::numeric
  from jsonb_array_elements(p_expense->'splits') x;

  if prev is null then
    perform public._log(gid, p_actor, 'expense.added', eid, jsonb_build_object(
      'description', btrim(p_expense->>'description'), 'amount', total,
      'kind', coalesce(p_expense->>'kind', 'expense')));
  else
    perform public._log(gid, p_actor, 'expense.updated', eid, jsonb_build_object(
      'description', btrim(p_expense->>'description'), 'amount', total,
      'kind', coalesce(p_expense->>'kind', prev->>'kind'),
      'old_description', prev->>'description', 'old_amount', (prev->>'amount')::numeric), prev);
  end if;
  return eid;
end $$;

create function public.delete_expense(p_code text, p_id uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  prev jsonb;
begin
  if not exists (select 1 from public.expenses where id = p_id and group_id = gid) then
    return;
  end if;
  prev := public._expense_json(p_id);
  delete from public.expenses where id = p_id;
  perform public._log(gid, p_actor, 'expense.deleted', p_id, jsonb_build_object(
    'description', prev->>'description', 'amount', (prev->>'amount')::numeric, 'kind', prev->>'kind'), prev);
end $$;

create function public.add_settlement(
  p_code text, p_from uuid, p_to uuid, p_amount numeric, p_paid_on date default current_date,
  p_note text default null, p_actor uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  sid uuid;
begin
  perform public._assert_members(gid, array[p_from, p_to]);
  insert into public.settlements (group_id, from_member, to_member, amount, paid_on, note)
  values (gid, p_from, p_to, round(p_amount, 2), coalesce(p_paid_on, current_date), nullif(btrim(p_note), ''))
  returning id into sid;
  perform public._log(gid, p_actor, 'settlement.added', sid, jsonb_build_object(
    'from', p_from, 'to', p_to, 'amount', round(p_amount, 2)));
  return sid;
end $$;

create function public.delete_settlement(p_code text, p_id uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  s public.settlements;
begin
  delete from public.settlements where id = p_id and group_id = gid returning * into s;
  if s.id is not null then
    perform public._log(gid, p_actor, 'settlement.deleted', p_id, jsonb_build_object(
      'from', s.from_member, 'to', s.to_member, 'amount', s.amount), to_jsonb(s));
  end if;
end $$;

-- Newest first, without the restore snapshots.
create function public.get_activity(p_code text, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare gid uuid := public._group_id(p_code);
begin
  return coalesce((
    select jsonb_agg(to_jsonb(a) - 'group_id' - 'before' order by a.created_at desc)
    from (select * from public.activity where group_id = gid
          order by created_at desc limit least(greatest(p_limit, 1), 500)) a), '[]'::jsonb);
end $$;

-- Undo a deletion, or put an expense back the way it was before an edit. The restore is itself
-- logged with the state it replaced.
create function public.restore_activity(p_code text, p_id uuid, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  a public.activity;
  prev jsonb;
begin
  select * into a from public.activity where id = p_id and group_id = gid for update;
  if a.id is null then
    raise exception 'That change isn''t in this group''s history';
  end if;
  if a.restored_at is not null then
    raise exception 'That change has already been undone';
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
    insert into public.settlements select * from jsonb_populate_record(null::public.settlements, a.before);
    perform public._log(gid, p_actor, 'settlement.restored', a.target_id, a.details);
  else
    raise exception 'That change can''t be undone';
  end if;

  update public.activity set restored_at = now() where id = a.id;
end $$;

revoke all on function
  public.create_group(text, text, text, text, text[]),
  public.add_member(text, text),
  public.update_member(text, uuid, text, uuid),
  public.update_group(text, text, text, uuid),
  public.save_expense(text, jsonb, uuid),
  public.delete_expense(text, uuid, uuid),
  public.add_settlement(text, uuid, uuid, numeric, date, text, uuid),
  public.delete_settlement(text, uuid, uuid),
  public.get_activity(text, int),
  public.restore_activity(text, uuid, uuid)
from public;

grant execute on function
  public.create_group(text, text, text, text, text[]),
  public.add_member(text, text),
  public.update_member(text, uuid, text, uuid),
  public.update_group(text, text, text, uuid),
  public.save_expense(text, jsonb, uuid),
  public.delete_expense(text, uuid, uuid),
  public.add_settlement(text, uuid, uuid, numeric, date, text, uuid),
  public.delete_settlement(text, uuid, uuid),
  public.get_activity(text, int),
  public.restore_activity(text, uuid, uuid)
to anon, authenticated;
