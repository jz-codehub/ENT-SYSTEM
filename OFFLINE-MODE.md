# ENT-SYSTEM Offline Mode

## Scope and current behavior

Offline Mode extends the existing application; it does not replace its report forms, online login, Supabase tables, queries, ownership triggers, or RLS policies. It introduces a doctor-only local workspace containing exactly Nasal Endoscopy, Laryngeal Endoscopy, and CF4 Form.

The app is served over HTTPS as a PWA. `sw.js` precaches the workspace and its app-shell dependencies, and the Offline-ready status verifies that the active worker can read every configured file from its cache. Navigation between the report modules stays within the cached app. This does not make `file://` use supported.

The minimal workspace runs only the pending-report queue when connectivity returns; it does not start the regular patient-history sync or download a clinic-wide list.

Each report module's Back to Menu action returns to this workspace during an offline session. It attempts a local draft save first; if the form cannot be safely saved (for example, it has no patient name or browser storage fails), the doctor is warned and must confirm before leaving.

### Preparation before travel

On the device and browser the doctor will use:

1. Enable OS account protection, automatic screen locking, and full-disk encryption. Use a private, individually controlled browser profile.
2. While online, open the deployed HTTPS app, sign in as the doctor, and leave it open until the Offline-ready status confirms the app files are cached and shows the grant expiration date.
3. Use the Offline-ready Retry action if preparation is incomplete. Do not depart until it reports ready.
4. Go offline or enable airplane mode and test a fresh login with the doctor's username and password. Create and reopen a test draft in each report module, including attaching a photo if photos are needed.
5. Keep patient records cloud-only unless a specific record is authorized and explicitly needed. This change does not download all patient records or add a bulk prefetch action; confirm any required record is already available on the device before departure.

The certification baseline is current stable Chrome and Edge on Windows, Chrome on Android, and Safari on iOS/iPadOS. Other browsers or browser versions need separate offline, storage-retention, and restart testing before being relied upon.

## Authentication and expiration

- A successful online doctor sign-in on the target device creates a local grant valid for 180 days. The duration is controlled by `OFFLINE_GRANT_DAYS` in `function/auth.js`; a new successful online sign-in renews it.
- The grant stores a random salt, a PBKDF2-SHA256 verifier (210,000 iterations), and the minimum profile snapshot needed for local doctor ownership. It does not store the password or a Supabase credential. Legacy plaintext remembered-password keys are removed when the auth module loads; “Remember me” now stores only the username.
- Offline login requires the grant's username and the doctor's password. A tab session is limited to 12 hours; log out clears the session marker but intentionally retains the grant and local reports so the doctor can log in again offline.
- Offline access is local-only. The app cannot learn that an account was revoked, disabled, or had permissions changed until it reconnects. Sync requires a live Supabase session and server-side authorization; the offline profile snapshot never authorizes a cloud request.
- The verifier is not hardware-bound. Someone who obtains the browser profile can attempt offline password guesses; PBKDF2 raises the cost but does not make a weak password safe. Local report data and photos are not application-encrypted, so OS protection, screen locking, full-disk encryption, a strong account password, and prompt reporting of a lost device are required. Same-origin script compromise while the profile is unlocked remains a risk. Application-level encryption is not added because browser-held keys would not protect data from code running in that unlocked origin.

## Local reports and sync

- `function/offlineStore.js` persists report snapshots, attached images, a stable retry token, and sync jobs in IndexedDB (`ent-offline-db`). The existing draft shelf also retains its legacy localStorage copy; both browser stores are unencrypted. The existing stable report key remains the identity; no duplicate-prevention key or database schema was changed.
- Draft saves are mirrored locally before any success is reported. A failed local write or queue write is reported as a failure; fallback storage is not treated as successful if it cannot persist the data. Logout does not clear drafts, reports, or photos.
- The Offline Records viewer labels records Local Draft, Pending Sync, Synced, or Sync Failed. Local data is not represented as a cloud save until Supabase confirms the report and, when present, every photo.
- Sync first revalidates through the live Supabase session and existing RLS. It checks the remote draft version before upserting. A finalized or changed remote report is retained as a visible conflict and is not overwritten or retried blindly. Review both copies while online before resolving a conflict; there is no automatic merge.
- Offline report sync is not blocked by photos. Reports can be confirmed as synced while attached photos remain only on the device; the Offline Records viewer explicitly labels that limitation. The existing authenticated `patient-photos` Edge Function and online photo behavior are unchanged. A separate future change can add safe photo synchronization.
- Patient-record downloads remain opt-in; no broad patient-data prefetch was added. Browser storage may be evicted by the OS/browser, especially on mobile devices, so verify readiness and required local records before travel and retain approved backups according to clinic policy.

## Deployment boundary

No migration, schema or RLS change, commit, push, or deployment was performed as part of this change.

No Edge Function change or deployment is required for this scope. The existing online photo flow remains unchanged; offline report synchronization intentionally leaves photos local and indicates that limitation. No service-role key is added to frontend code.

## Test and rollout matrix

| Scenario | Expected result |
|---|---|
| Sign in online on a clean target profile | Doctor gets a 180-day grant; username may be remembered, password is not |
| Offline-ready verification succeeds | All configured app-shell files are present; expiry is visible |
| Offline-ready verification has missing files | Setup is incomplete and offers Retry; it never reports ready |
| Fresh offline login with correct credentials | Offline workspace opens; dashboard and unrelated modules remain blocked |
| Offline login with wrong username/password or expired grant | Login is refused; no Supabase request is needed to verify the local password |
| Navigate to each of the three modules offline | Cached module opens; ordinary dashboard/analytics routes remain unavailable |
| Save/reopen drafts and attach photos offline | Data and images remain in IndexedDB after logout, tab close, and device restart |
| Local storage or queue write fails | UI reports that persistence/queueing failed; it does not claim a local save |
| Log out and log in offline again | Workspace locks on logout; the grant and pending data remain; password is required again |
| Reconnect with valid authorization | Report upsert is confirmed independently of photo upload; photos remain marked local-only |
| Remote report was edited/finalized elsewhere | Local copy remains; job shows Sync Failed/conflict and remote data is not overwritten |
| Account revoked or permissions changed while offline | Existing local access may continue until grant expiry; cloud sync is refused by live auth/RLS after reconnection |
| Browser/OS evicts local storage or device is lost | Data may be unavailable or exposed; verify before travel and follow clinic device-loss procedures |

Automated local regression checks:

```powershell
node supabase-v2\scripts\test_offline_queue.mjs
node supabase-v2\scripts\test_stable_report_identity.mjs
node supabase-v2\scripts\test_duplicate_guard.mjs
node supabase-v2\scripts\test_draft_photo_invariants.mjs
node supabase-v2\scripts\test_photo_validation.mjs
node supabase-v2\scripts\test_drafts_team.mjs
```

Device/browser acceptance testing must still be performed on the stated baseline, particularly airplane-mode navigation, IndexedDB/photo persistence across restart, service-worker updates, and the coordinated Edge Function rollout.
