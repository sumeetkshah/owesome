-- OweSome schema.
-- There is no login: every read/write goes through SECURITY DEFINER functions
-- keyed by a group's unguessable invite code. Tables have RLS on with no
-- policies, so the public anon key cannot read or write them directly.

create extension if not exists pgcrypto with schema extensions;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  emoji text not null default '✈️',
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  color smallint not null default 0,
  created_at timestamptz not null default now()
);
create unique index members_group_name_key on public.members (group_id, lower(name));

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  emoji text not null default '🏷️',
  created_at timestamptz not null default now()
);
create unique index categories_group_name_key on public.categories (group_id, lower(name));

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  description text not null check (char_length(btrim(description)) between 1 and 120),
  amount numeric(12, 2) not null check (amount > 0),
  category text not null,
  split_type text not null check (split_type in ('equal', 'exact', 'percent', 'shares')),
  spent_on date not null default current_date,
  notes text,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index expenses_group_idx on public.expenses (group_id, spent_on desc, created_at desc);

create table public.expense_payers (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  primary key (expense_id, member_id)
);

create table public.expense_splits (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  -- The raw input for percent/shares splits (e.g. 25 for 25%, or 2 shares).
  weight numeric(12, 4),
  primary key (expense_id, member_id)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  from_member uuid not null references public.members(id) on delete cascade,
  to_member uuid not null references public.members(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  paid_on date not null default current_date,
  note text,
  created_at timestamptz not null default now(),
  check (from_member <> to_member)
);
create index settlements_group_idx on public.settlements (group_id, paid_on desc);

alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.categories enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_payers enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlements enable row level security;

revoke all on public.groups, public.members, public.categories, public.expenses,
  public.expense_payers, public.expense_splits, public.settlements
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (not callable by clients)
-- ---------------------------------------------------------------------------

create function public._new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  bytes bytea := extensions.gen_random_bytes(12);
  code text := '';
begin
  for i in 0..11 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
  end loop;
  return code;
end $$;

create function public._group_id(p_code text) returns uuid
language plpgsql stable set search_path = '' as $$
declare gid uuid;
begin
  select id into gid from public.groups where invite_code = p_code;
  if gid is null then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  return gid;
end $$;

create function public._assert_members(p_group uuid, p_ids uuid[]) returns void
language plpgsql stable set search_path = '' as $$
begin
  if exists (
    select 1 from unnest(p_ids) as m(id)
    where not exists (select 1 from public.members where id = m.id and group_id = p_group)
  ) then
    raise exception 'Unknown member for this group';
  end if;
end $$;

revoke all on function public._new_invite_code(), public._group_id(text),
  public._assert_members(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client API
-- ---------------------------------------------------------------------------

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

  return jsonb_build_object('invite_code', code, 'member_id', creator_id);
end $$;

create function public.get_group(p_code text) returns jsonb
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
          'payers', coalesce((select jsonb_agg(jsonb_build_object('member_id', p.member_id, 'amount', p.amount))
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
  return to_jsonb(m) - 'group_id';
end $$;

create function public.update_group(p_code text, p_name text, p_emoji text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.groups
  set name = btrim(p_name), emoji = coalesce(nullif(btrim(p_emoji), ''), emoji)
  where id = public._group_id(p_code);
end $$;

create function public.add_category(p_code text, p_name text, p_emoji text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  c public.categories;
begin
  insert into public.categories (group_id, name, emoji)
  values (gid, btrim(p_name), coalesce(nullif(btrim(p_emoji), ''), '🏷️'))
  on conflict (group_id, lower(name)) do update set emoji = excluded.emoji
  returning * into c;
  return to_jsonb(c) - 'group_id';
end $$;

-- p_expense: { id?, description, amount, category, split_type, spent_on, notes?,
--              created_by?, payers: [{member_id, amount}], splits: [{member_id, amount, weight?}] }
create function public.save_expense(p_code text, p_expense jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public._group_id(p_code);
  eid uuid := nullif(p_expense->>'id', '')::uuid;
  total numeric(12, 2) := (p_expense->>'amount')::numeric;
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
    insert into public.expenses (group_id, description, amount, category, split_type, spent_on, notes, created_by)
    values (gid, btrim(p_expense->>'description'), total, p_expense->>'category', p_expense->>'split_type',
            coalesce((p_expense->>'spent_on')::date, current_date), nullif(btrim(p_expense->>'notes'), ''),
            (p_expense->>'created_by')::uuid)
    returning id into eid;
  else
    update public.expenses
    set description = btrim(p_expense->>'description'), amount = total, category = p_expense->>'category',
        split_type = p_expense->>'split_type', spent_on = coalesce((p_expense->>'spent_on')::date, spent_on),
        notes = nullif(btrim(p_expense->>'notes'), ''), updated_at = now()
    where id = eid and group_id = gid;
    if not found then
      raise exception 'Expense not found';
    end if;
    delete from public.expense_payers where expense_id = eid;
    delete from public.expense_splits where expense_id = eid;
  end if;

  insert into public.expense_payers (expense_id, member_id, amount)
  select eid, (x->>'member_id')::uuid, (x->>'amount')::numeric
  from jsonb_array_elements(p_expense->'payers') x
  where (x->>'amount')::numeric > 0;

  insert into public.expense_splits (expense_id, member_id, amount, weight)
  select eid, (x->>'member_id')::uuid, (x->>'amount')::numeric, (x->>'weight')::numeric
  from jsonb_array_elements(p_expense->'splits') x;

  return eid;
end $$;

create function public.delete_expense(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.expenses where id = p_id and group_id = public._group_id(p_code);
end $$;

create function public.add_settlement(
  p_code text, p_from uuid, p_to uuid, p_amount numeric, p_paid_on date default current_date, p_note text default null
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
  return sid;
end $$;

create function public.delete_settlement(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.settlements where id = p_id and group_id = public._group_id(p_code);
end $$;

revoke all on function
  public.create_group(text, text, text, text, text[]),
  public.get_group(text),
  public.add_member(text, text),
  public.update_group(text, text, text),
  public.add_category(text, text, text),
  public.save_expense(text, jsonb),
  public.delete_expense(text, uuid),
  public.add_settlement(text, uuid, uuid, numeric, date, text),
  public.delete_settlement(text, uuid)
from public;

grant execute on function
  public.create_group(text, text, text, text, text[]),
  public.get_group(text),
  public.add_member(text, text),
  public.update_group(text, text, text),
  public.add_category(text, text, text),
  public.save_expense(text, jsonb),
  public.delete_expense(text, uuid),
  public.add_settlement(text, uuid, uuid, numeric, date, text),
  public.delete_settlement(text, uuid)
to anon, authenticated;
