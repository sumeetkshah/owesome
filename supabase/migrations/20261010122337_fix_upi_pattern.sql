-- Tighten the UPI ID handle to at most 128 characters, matching the client-side pattern.
alter table public.members drop constraint members_upi_id_check;
alter table public.members add constraint members_upi_id_check
  check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,128}@[A-Za-z0-9.-]{2,64}$');
