-- Receipts used to live at `<invite_code>/<uuid>.<ext>` in a public bucket, so anyone holding a
-- receipt's URL could read the invite code off it and get full access to the group. New receipts go in
-- a per-group random folder instead, which is useless for anything except viewing that group's
-- receipts. Existing paths under the invite code stay valid on expenses so nothing breaks.

alter table public.groups
  add column receipt_folder text not null unique
  default encode(extensions.gen_random_bytes(16), 'hex');

-- Uploads must go into a group's receipt folder (the invite code no longer works as a folder).
create or replace function public._receipt_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_name ~ '^[a-z0-9]{8,}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|pdf)$'
     and exists (select 1 from public.groups where receipt_folder = split_part(p_name, '/', 1));
$$;

-- Input checks for save_expense, kept separate so limits can be added without rewriting it.
create function public._validate_expense(p_group uuid, p_expense jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare
  g public.groups;
  total numeric(12, 2) := (p_expense->>'amount')::numeric;
  payer_sum numeric;
  split_sum numeric;
  ids uuid[];
begin
  select * into g from public.groups where id = p_group;

  if jsonb_array_length(coalesce(p_expense->'payers', '[]')) = 0 then
    raise exception 'An expense needs at least one payer';
  end if;
  if jsonb_array_length(coalesce(p_expense->'splits', '[]')) = 0 then
    raise exception 'An expense needs at least one person to split with';
  end if;
  -- Zero-amount payers are dropped on insert, so a negative one could otherwise offset a payer that is
  -- kept and leave the stored payers not adding up to the total.
  if exists (select 1 from jsonb_array_elements(p_expense->'payers') x where (x->>'amount')::numeric < 0) then
    raise exception 'Payer amounts can''t be negative';
  end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(p_expense->'receipts', '[]')) r
             where split_part(r, '/', 1) not in (g.receipt_folder, g.invite_code)) then
    raise exception 'Receipt does not belong to this group';
  end if;

  select sum((x->>'amount')::numeric), array_agg((x->>'member_id')::uuid)
  into payer_sum, ids from jsonb_array_elements(p_expense->'payers') x;
  perform public._assert_members(p_group, ids);
  if payer_sum <> total then
    raise exception 'Payer amounts (%) must add up to the total (%)', payer_sum, total;
  end if;

  select sum((x->>'amount')::numeric), array_agg((x->>'member_id')::uuid)
  into split_sum, ids from jsonb_array_elements(p_expense->'splits') x;
  perform public._assert_members(p_group, ids);
  if split_sum <> total then
    raise exception 'Split amounts (%) must add up to the total (%)', split_sum, total;
  end if;

  if (p_expense->>'created_by') is not null then
    perform public._assert_members(p_group, array[(p_expense->>'created_by')::uuid]);
  end if;
end $$;

revoke all on function public._validate_expense(uuid, jsonb) from public, anon, authenticated;

create or replace function public.save_expense(p_code text, p_expense jsonb, p_actor uuid default null) returns uuid
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
  prev jsonb;
begin
  perform public._validate_expense(gid, p_expense);
  if cur = group_currency then
    rate := 1;
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
