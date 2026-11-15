# Security Review Summary

**Review date:** 2026-11-15  
**Scope:** Read-only review of the ENT-SYSTEM repository. No exploit attempts or live database inspection were performed.

## Summary

No confirmed cloud-side authorization bypass was identified in the reviewed code. The repository contains Supabase row-level security policies and Edge Function checks, but this review cannot confirm that the live Supabase project has the expected migrations, policies, storage settings, and function secrets deployed.

Frontend files served to a browser can be inspected and copied. This is expected for a web application and does not, by itself, grant access to patient data. Secrets and authorization decisions must remain server-side.

## Findings

| # | Severity | File | Lines | Finding | Confidence |
|---|----------|------|-------|---------|------------|
| 1 | MEDIUM | [function/auth.js](./function/auth.js) | 432-450, 578-585 | Offline access is device-local. A disconnected device cannot receive server-side revocation immediately; access remains until the local grant expires or is removed. | 9/10 |
| 2 | MEDIUM | [supabase-v2/edge-functions/_shared/auth.ts](./supabase-v2/edge-functions/_shared/auth.ts) | 286-294 | Admin MFA enforcement depends on the profile's `admin_mfa_required` flag. The repository alone cannot confirm that every live admin account is flagged. | 9/10 |
| 3 | LOW | [wrangler.jsonc](./wrangler.jsonc) | 6-8 | The browser receives the built frontend assets, so visitors can inspect and copy the HTML, CSS, and JavaScript. This is expected and is not an access-control bypass by itself. | 10/10 |

## Protections observed in the repository

- Migrations revoke anonymous database access and define row-level security for authenticated report access: [0007_privileges.sql](./supabase-v2/migrations/0007_privileges.sql) and [0008_rls_core.sql](./supabase-v2/migrations/0008_rls_core.sql).
- Edge Functions verify the authenticated user and profile, and apply role checks: [_shared/auth.ts](./supabase-v2/edge-functions/_shared/auth.ts).
- The patient-photo function checks report access before using its server-side storage privileges: [patient-photos/index.ts](./supabase-v2/edge-functions/patient-photos/index.ts).
- The frontend publish audit checks for privileged-key exposure and retired authentication patterns. Passing that static audit does not prove that the live backend is configured correctly.

## Recommended follow-up

1. Verify that every active administrator is required to use MFA, and that setup and recovery work for each account.
2. Set an offline-access policy for shared or lost devices, including how local access is removed and how long offline data may remain available.
3. Verify the live Supabase migration state, RLS policies and grants, private photo-storage configuration, and server-side Edge Function secrets.
4. Continue treating all files shipped to browsers as public; keep privileged keys and final authorization checks on the server.
