# OweSome

Split group expenses on trips and work travel. There are no accounts: create a group, share the invite link, and each person picks their name. The device remembers who you are.

- Equal, exact, percentage, share-based and **itemised** splits (with tax, service charge, tip and discount spread in proportion)
- Multiple payers on one expense
- **Foreign-currency expenses**, converted at a live or manually entered rate
- **Refunds and income** that flow back to the group
- **Receipt photos and PDFs** attached to expenses
- Preset and custom categories, with per-category insights
- Settle up with the fewest transfers and **WhatsApp/SMS nudges** (payments happen outside the app; you record them here)
- **Activity history** of every change, with deleted items restorable and edits revertible
- **CSV and PDF export**, filtered by person and date range, for reimbursement claims
- Installable to the home screen (PWA)

## Stack

Vite, React and TypeScript on the front end, with Supabase Postgres as the back end. It deploys to Vercel as a static SPA (`vercel.json` rewrites routes to `index.html`).

## Security model

All tables have RLS enabled and every client grant is revoked. The client only calls `SECURITY DEFINER` RPCs (`get_group`, `save_expense`, …), and each one is keyed by the group's random 12-character invite code. Anyone holding a group's link can view and edit that group, but nobody can list or reach other groups. Since there are no accounts, every change is written to an `activity` log (attributed to the member the device says it is) so the group can see who did what and undo deletions or edits. Receipts go to a public-read `receipts` storage bucket, in a random per-group folder that is unrelated to the invite code, so a receipt link never reveals how to reach the group. Anyone can upload into an existing group's folder, but nobody can list the bucket, and each file path contains a random UUID. Because anyone can write, storage is bounded: free-form fields have length caps, each group holds at most 50 people, 50 custom categories, 2,000 expenses, 2,000 payments and 50 receipts, and a PostgREST pre-request hook (`check_request`) rate-limits writes per IP (10 new groups, 30 joins and 120 other changes an hour). Receipt uploads are also capped at 300 an hour across the app, since Storage doesn't pass the caller's IP to policies. The schema is in `supabase/migrations/`.

## Develop

```sh
cp .env.example .env   # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (publishable key)
npm install
npm run dev
```
