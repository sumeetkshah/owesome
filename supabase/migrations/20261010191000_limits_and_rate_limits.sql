-- Bound how much anyone can store or write. Without accounts, the only things to hang limits on are
-- the group and the caller's IP address:
--   * size caps on free-form fields (check constraints; the UI enforces the same lengths)
--   * count caps per group (friendly errors from the write functions)
--   * per-IP rate limits on every write, applied by a PostgREST pre-request hook
--   * receipt caps per group and across the bucket (Storage doesn't pass the caller's IP to policies)

-- ---------------------------------------------------------------------------
-- Field sizes
-- ---------------------------------------------------------------------------

alter table public.expenses
  add constraint expenses_notes_length check (char_length(notes) <= 500),
  add constraint expenses_category_length check (char_length(category) <= 60),
  add constraint expenses_meta_size check (octet_length(meta::text) <= 65536),
  add constraint expenses_receipts_count check (cardinality(receipts) <= 10);
alter table public.settlements add constraint settlements_note_length check (char_length(note) <= 200);
alter table public.groups add constraint groups_emoji_length check (char_length(emoji) <= 16);
alter table public.categories add constraint categories_emoji_length check (char_length(emoji) <= 16);

-- ---------------------------------------------------------------------------
-- Per-group counts
-- ---------------------------------------------------------------------------

create function public._assert_room(p_group uuid, p_what text) returns void
language plpgsql stable set search_path = '' as $$
declare
  n int;
  cap int;
  label text;
begin
  case p_what
    when 'members' then
      select count(*) into n from public.members where group_id = p_group; cap := 50; label := 'people';
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

revoke all on function public._assert_room(uuid, text) from public, anon, authenticated;

-- Members are created in create_group and add_member; the others in their own functions. Rather than
-- rewriting each one, check counts in triggers that fire before the insert.
create function public._room_trigger() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform public._assert_room(new.group_id, tg_argv[0]);
  return new;
end $$;

revoke all on function public._room_trigger() from public, anon, authenticated;

create trigger members_room before insert on public.members
  for each row execute function public._room_trigger('members');
create trigger categories_room before insert on public.categories
  for each row execute function public._room_trigger('categories');
create trigger expenses_room before insert on public.expenses
  for each row execute function public._room_trigger('expenses');
create trigger settlements_room before insert on public.settlements
  for each row execute function public._room_trigger('settlements');

-- ---------------------------------------------------------------------------
-- Per-IP rate limits
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.rate_limits (
  key text not null, -- '<scope>:<md5 of ip>'; the address itself isn't stored
  at timestamptz not null default now()
);
create index rate_limits_key_at_idx on private.rate_limits (key, at desc);
create index rate_limits_at_idx on private.rate_limits (at);

-- Runs before every Data API request. Reads are skipped (they run read-only and can't record anything);
-- requests without a client IP (e.g. SQL run from the dashboard) aren't limited.
create function public.check_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  headers json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip text := coalesce(
    nullif(headers->>'cf-connecting-ip', ''),
    nullif(btrim(split_part(headers->>'x-forwarded-for', ',', 1)), ''));
  fn text := regexp_replace(coalesce(current_setting('request.path', true), ''), '^.*/', '');
  scope text;
  cap int;
  v_key text;
  n int;
begin
  if ip is null or current_setting('transaction_read_only', true) = 'on'
     or fn in ('get_group', 'get_activity') then
    return;
  end if;

  if fn = 'create_group' then
    scope := 'create_group'; cap := 10;
  elsif fn = 'add_member' then
    scope := 'add_member'; cap := 30;
  else
    scope := 'write'; cap := 120;
  end if;
  v_key := scope || ':' || md5(ip);

  delete from private.rate_limits where at < now() - interval '1 hour';
  select count(*) into n from private.rate_limits where key = v_key;
  if n >= cap then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'message', 'Too many changes from your connection. Wait a few minutes and try again.')::text,
      detail = json_build_object('status', 429, 'status_text', 'Too Many Requests')::text;
  end if;
  insert into private.rate_limits (key) values (v_key);
end $$;

revoke all on function public.check_request() from public;
grant execute on function public.check_request() to anon, authenticated;

alter role authenticator set pgrst.db_pre_request = 'public.check_request';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- Receipts: at most 50 per group, and 300 uploads an hour across the bucket
-- ---------------------------------------------------------------------------

create or replace function public._receipt_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_name ~ '^[a-z0-9]{8,}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|pdf)$'
     and exists (select 1 from public.groups where receipt_folder = split_part(p_name, '/', 1))
     and (select count(*) from storage.objects
          where bucket_id = 'receipts' and name like split_part(p_name, '/', 1) || '/%') < 50
     and (select count(*) from storage.objects
          where bucket_id = 'receipts' and created_at > now() - interval '1 hour') < 300;
$$;
