# SplitSmart

Split group expenses on trips and work travel. There are no accounts: create a group, share the invite link, and each person picks their name. The device remembers who you are.

- Equal, exact, percentage and share-based splits
- Multiple payers on one expense
- Preset and custom categories, with per-category insights
- Settle up with the fewest transfers

## Stack

Vite, React and TypeScript on the front end, with Supabase Postgres as the back end. It deploys to Vercel as a static SPA (`vercel.json` rewrites routes to `index.html`).

## Security model

All tables have RLS enabled and every client grant is revoked. The client only calls `SECURITY DEFINER` RPCs (`get_group`, `save_expense`, …), and each one is keyed by the group's random 12-character invite code. Anyone holding a group's link can view and edit that group, but nobody can list or reach other groups. The schema is in `supabase/migrations/`.

## Develop

```sh
cp .env.example .env   # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (publishable key)
npm install
npm run dev
```
