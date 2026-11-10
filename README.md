# ENT-SYSTEM

Browser-based ENT clinic reporting system with offline support.

## Source of truth

- `pages/`, `function/`, `style/`, `js/`, and `image/` contain the application
  source.
- `build-pages.mjs` copies the explicit runtime allowlist into `dist/`. Build
  before publishing; the checked-in `dist/` folder is generated output.
- `supabase-v2/migrations/` is the database migration source of truth.
- `supabase-v2/edge-functions/` contains the v2 Edge Function source. The
  checked-in frontend uses the v2 auth, reports, account-admin, and photo
  interfaces.

## Local checks

```powershell
node build-pages.mjs
cd supabase-v2\scripts
npm ci
npm test
node parse_check.mjs
node bundle_for_dashboard.mjs
```

These are local/static and stubbed-browser checks; they do **not** prove the
live Supabase database, deployed Edge Functions, migrations, backup, or restore
are healthy. Confirm those separately in a test project before production
changes. See [SETUP.md](./SETUP.md) for deployment steps and migration safety.
