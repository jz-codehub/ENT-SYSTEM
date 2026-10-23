# Migration 0023 — what it was, and why there is no `0023_*.sql`

**Status: intentionally absent. Do not create a `0023` file.**

## What the number was

`0023_grant_attribution_and_revoke.sql` was written on 2026-10-02 and
committed in `116d0e4` (Initial commit). It bundled four changes:

1. `report_access_grants.granted_by` → `NOT NULL`
2. a backfill `UPDATE` for existing rows
3. a new `ent_may_revoke_grant(uuid)` predicate
4. its own assertion block

Before it was ever applied, the author marked it **SUPERSEDED** in place. Its
own header (recovered with
`git show 116d0e4:supabase-v2/migrations/0023_grant_attribution_and_revoke.sql`)
opens with:

```
##  DO NOT APPLY THIS FILE.  IT IS SUPERSEDED.
Status : SUPERSEDED, never applied to any database. Safe to delete.
Replaced by:
    0024_grant_stamp_reaches_the_stamp.sql   <- the actual fix, APPLY THIS
    0025 (not written yet)                   <- the NOT NULL decision
```

## Why it was superseded

Three of its four parts were wrong or premature, and applying it would have
done all of them at once with no way to tell which caused a failure:

- **`granted_by` → `NOT NULL`** collided with the existing
  `ON DELETE SET NULL` foreign key. 0025 resolved the design decision the
  other way: keep the column **nullable** and add `granted_by_name` alongside
  it, so deleting an approver preserves their grants instead of failing.
  0025's own guard asserts the column is *still* nullable — so a `0023` that
  forced `NOT NULL` would make 0025 refuse to apply.
- **the backfill** was ordered before the fix that makes new grants
  attributable (0024), so it would have attributed rows the broken trigger
  never stamped.
- **`ent_may_revoke_grant`** as 0023 wrote it derived revoke from a
  read/membership rule. It is now defined by **0032**, deliberately separated
  from `ent_may_grant_report_access` so changing one decision cannot quietly
  change the other.

The real root cause of the original defect was in **0022**, not here: inside a
`SECURITY DEFINER` function `current_user` is the function owner, so the
"trusted writer" guard was true for every caller and the trigger returned
before reaching `NEW.granted_by := me.id`. **0024** replaced that guard with
`ent_auth_uid()`. 0023 did not touch the defect at all.

## Verified: every part of 0023 landed elsewhere

| 0023 wanted | Delivered by | Verified on the live project |
|---|---|---|
| grants record who approved | 0024 (`ent_auth_uid()` in `ent_stamp_grant`) | `ent_stamp_grant` deployed |
| `granted_by_name` for attribution | 0025 (adds the column, backfills it) | `granted_by` + `granted_by_name` columns exist |
| `granted_by` NOT NULL | **rejected by 0025 on purpose** — stays nullable | correct as shipped |
| only an owner may revoke | 0032 (`ent_may_revoke_grant`) | deployed |

`ent_may_revoke_grant` exists and is reachable, and `report_access_grants`
carries both `granted_by` and `granted_by_name`. Nothing from 0023 is missing.

## Decision

**Do not renumber, do not recreate, do not renumber anything after it.**

- The number was never applied to any database, so no migration-tracking row
  can reference it. Re-using it would be harmless *only* if the content were
  identical to something already applied — and it is not.
- Creating a `0023` that forces `granted_by NOT NULL` would break 0025's
  guard and change live behaviour.
- Creating an empty or no-op `0023` to "fill the gap" would be a file that
  claims to do something and does nothing.
- Renumbering 0024→0023 (and everything after) would break the apply order of
  any environment that already ran them.

The sequence therefore runs `0022` → `0024` **with a deliberate gap at 0023**.
The folder simply contains no `0023_*.sql` (the old copy-builder
`build_fresh_setup.mjs` was removed 2026-10-11 when `migrations/` became
the single source of truth), and this file documents why, so the
gap reads as a decision rather than an oversight.
`scripts/validate_migrations.mjs` V4 asserts exactly this: no 0023 SQL
file exists anywhere in the set, and this note says do-not-create.

`0032`'s header still says `DEPENDS ON: 0019, 0021, 0023, 0031`. That is a
historical citation of where the revoke idea came from, not an apply-order
requirement — 0032 defines `ent_may_revoke_grant` itself with
`CREATE OR REPLACE` and has no forward dependency on a file that does not
exist.
