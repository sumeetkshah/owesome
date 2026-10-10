-- Foreign-currency expenses, itemised bills, refunds/income, receipts and member UPI IDs.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.expenses
  -- 'refund' = money coming back into the group (refund, deposit returned, cashback).
  add column kind text not null default 'expense' check (kind in ('expense', 'refund')),
  -- The currency the expense was paid in, and the rate used to convert it into the group's currency.
  -- `amount` (and every payer/split amount) is always in the group currency.
  add column currency text check (currency ~ '^[A-Z]{3}$'),
  add column fx_rate numeric(18, 8) not null default 1 check (fx_rate > 0),
  add column original_amount numeric(14, 2),
  -- Editor state needed to reopen an expense (e.g. itemised bill lines, tax %, tip).
  add column meta jsonb,
  -- Storage object paths in the `receipts` bucket.
  add column receipts text[] not null default '{}';

update public.expenses e set currency = g.currency, original_amount = e.amount
from public.groups g where g.id = e.group_id;

alter table public.expenses drop constraint expenses_split_type_check;
alter table public.expenses add constraint expenses_split_type_check
  check (split_type in ('equal', 'exact', 'percent', 'shares', 'itemized'));

alter table public.expense_payers add column original_amount numeric(14, 2);

alter table public.members
  add column upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$');

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

create or replace function public.get_group(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare gid uuid := public._group_id(p_code);
begin
  return jsonb_build_object(
    'group', (select to_jsonb(g) - 'id' from public.groups g where g.id = gid),
    'members', coalesce((
      select jsonb_agg(to_jsonb(m) - 'group_id' order by m.created_at)
      from public.members m where m.group_id = gid), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(c) - 'group_id' order by c.created_at)
      from public.categories c where c.group_id = gid), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(
        (to_jsonb(e) - 'group_id') || jsonb_build_object(
          'payers', coalesce((select jsonb_agg(jsonb_build_object(
                                'member_id', p.member_id, 'amount', p.amount, 'original_amount', p.original_amount))
                              from public.expense_payers p where p.expense_id = e.id), '[]'::jsonb),
          'splits', coalesce((select jsonb_agg(jsonb_build_object('member_id', s.member_id, 'amount', s.amount, 'weight', s.weight))
                              from public.expense_splits s where s.expense_id = e.id), '[]'::jsonb))
        order by e.spent_on desc, e.created_at desc)
      from public.expenses e where e.group_id = gid), '[]'::jsonb),
    'settlements', coalesce((
      select jsonb_agg(to_jsonb(s) - 'group_id' order by s.paid_on desc, s.created_at desc)
      from public.settlements s where s.group_id = gid), '[]'::jsonb)
  );
end $$;

-- p_expense: { id?, kind?, description, amount, category, split_type, spent_on, notes?, created_by?,
--              currency?, fx_rate?, original_amount?, meta?, receipts?,
--              payers: [{member_id, amount, original_amount?}], splits: [{member_id, amount, weight?}] }
create or replace function public.save_expense(p_code text, p_expense jsonb) returns uuid
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
begin
  if jsonb_array_length(coalesce(p_expense->'payers', '[]')) = 0 then
    raise exception 'An expense needs at least one payer';
  end if;
  if jsonb_array_length(coalesce(p_expense->'splits', '[]')) = 0 then
    raise exception 'An expense needs at least one person to split with';
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
    update public.expenses
    set kind = coalesce(p_expense->>'kind', kind), description = btrim(p_expense->>'description'), amount = total,
        category = p_expense->>'category', split_type = p_expense->>'split_type',
        spent_on = coalesce((p_expense->>'spent_on')::date, spent_on),
        notes = nullif(btrim(p_expense->>'notes'), ''), currency = cur, fx_rate = rate,
        original_amount = coalesce((p_expense->>'original_amount')::numeric, total),
        meta = p_expense->'meta', receipts = v_receipts, updated_at = now()
    where id = eid and group_id = gid;
    if not found then
      raise exception 'Expense not found';
    end if;
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

  return eid;
end $$;

create function public.update_member(p_code text, p_id uuid, p_name text, p_upi text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  m public.members;
begin
  if exists (select 1 from public.members
             where group_id = gid and id <> p_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'Someone called % is already in this group', btrim(p_name);
  end if;
  update public.members
  set name = btrim(p_name), upi_id = nullif(btrim(p_upi), '')
  where id = p_id and group_id = gid
  returning * into m;
  if m.id is null then
    raise exception 'Unknown member for this group';
  end if;
  return to_jsonb(m) - 'group_id';
end $$;

revoke all on function public.update_member(text, uuid, text, text) from public;
grant execute on function public.update_member(text, uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Receipts storage
-- Objects live at `<invite_code>/<uuid>.<ext>`. Uploads are allowed only into a folder named
-- after an existing group's invite code. The bucket is public-read so images load by URL; paths
-- contain a random UUID and there is no SELECT policy, so nobody can list the bucket.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

create function public._receipt_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_name ~ '^[a-z0-9]{8,}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|pdf)$'
     and exists (select 1 from public.groups where invite_code = split_part(p_name, '/', 1));
$$;
revoke all on function public._receipt_path_ok(text) from public;
grant execute on function public._receipt_path_ok(text) to anon, authenticated;

create policy "receipts: upload into a group folder" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'receipts' and public._receipt_path_ok(name));

create policy "receipts: delete from a group folder" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'receipts' and public._receipt_path_ok(name));
