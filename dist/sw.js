// BUMP THIS every time any file in FILES_TO_CACHE changes.
//
// The fetch handler below is CACHE-FIRST, so a cached copy always beats the
// network. Editing function/auth.js or login.html without bumping this name
// means browsers keep running the OLD file indefinitely -- the activate
// handler only deletes caches whose name differs from CACHE_NAME, so a stale
// cache is never evicted on its own.
//
// v31a: admins resolved to the wrong staff_profiles row. auth.js read
//       `staff_profiles?...&limit=1` and let RLS narrow it to one row, which
//       holds for a doctor/secretary but NOT for an admin (an admin may read
//       every profile in his clinic, so limit=1 returned an arbitrary doctor).
//       Login now self-filters by id, and login.html sends an admin to
//       admin.html. Without this bump the fix would never reach the browser.
// v31b: admin.js saveUser() sent two variables that were never declared
//       (`email` and `licenseNo`), so "create user" threw
//       ReferenceError and was impossible. Editing a user also wiped their
//       stored license_no, and the "Account is active" checkbox was ignored
//       on create and dead on edit. auth-admin now honours is_active on
//       create. Without this bump none of that reaches the browser.
// v31c: added the in-app ticket system - tickets.html, function/tickets.js
//       and style/tickets.css. Without this bump a browser keeps running the
//       old file list, so the new page is not pre-cached offline and a
//       cached tickets.js from a later edit would not be replaced.
// v31e: Settings and My tickets became PANELS inside admin.html instead of
//       links out of it, and the tab strip was pinned to a single row
//       (flex-wrap:nowrap + horizontal scroll). Without this bump the old
//       admin.html and admin.css keep being served and none of it appears.
// v31f: admin.html is now a RAIL (grid 218px + content) instead of a
//       top strip, and the My tickets tab was removed entirely - an admin
//       answers the clinic queue; a doctor or secretary files a ticket.
// v31g: the fetch handler is NETWORK FIRST with the cache as the offline
//       fallback, instead of cache-first for everything. That is what made a
//       fixed admin.js pair with a stale admin.html and look like a dead
//       page, and it is what forced a manual service-worker unregister
//       after every single change. Offline still works; the cache is still
//       filled; you just always get the file that is really on the server.
// v31h: admin.html (restored from the Sept-30 copy) and tickets.html both
//       lost the supabase-js script tag. Without it getClient() throws, ready()
//       returns null and a SIGNED-IN user is bounced straight back to
//       login.html - which reads as 'the login is broken'. Both pages now
//       load it, and test_admin_console.mjs A20/A21 stop it recurring.
// v31i: tickets.html and function/tickets.js are GONE. The report form now
//       lives on index.html (ticketForm.js) for a doctor or a secretary, and
//       the queue lives in the admin console. Also adds the four-way scope
//       (nasal / laryngeal / cf4 / system) and drops the dead links to the
//       page that no longer exists.
// v31j: 'Report a problem' is now the FOURTH card in the quick-action grid
//       beside Nasal / Laryngeal / CF4, so a doctor who notices a broken
//       form is already looking at it. The grid is two columns and the
//       cards are taller, both deliberately rather than left to auto-fit.
// v31k: the ticket form is now a POP-UP opened from the 'Report a problem'
//       card, not a full-width section under the dashboard. Reporting is a
//       detour from the work; a pop-up keeps the dashboard exactly as it was
//       and puts the caret on the first real question.
// v31l: the ticket pop-up was redesigned - scope asked FIRST as 2x2
//       tiles with icons and plain-language hints, a titled header with a
//       close X, grouped fieldsets, and the ticket list ruled off from the
//       form so filing and reading do not read as one job.
// v31m: the ticket dialog could not be scrolled. .ent-tf-card had
//       overflow: hidden, which silently overrode the base
//       .ent-modal-card { overflow: auto }, so the Send button and the whole
//       ticket list sat below the fold with no scrollbar and nothing that
//       looked scrollable. The card is now a bounded flex column with a
//       pinned header and one scrolling region.
// v31n: the one-line title is now OPTIONAL. The four scope tiles
//       already say WHERE, and the form then refused to send until the
//       user also typed a title - so someone who had already answered in
//       four taps was told Please write a short subject, which reads as
//       a broken app. A title is derived from the scope when blank; the
//       DESCRIPTION leads the form and is the only required text field.
// v31o: the admin ticket review now names WHO filed it.
//       category and priority have been collected and stored since day
//       one and were rendered nowhere, so triage meant guessing the urgency
//       from the wording of the complaint. Reporter name, @username, role
//       and clinic are on the panel now.
//       Also 0014: admin_db_usage returned 22003 and never produced a number.
// v31p: the header chip and the admin Settings panel.
//       buildSafeUser hardcoded assigned_doctor_name to '', so EVERY secretary
//       was shown the literal text Dr. assigned only even when tara really
//       is assigned to jess. It is now resolved from the profile, and a
//       secretary with genuinely no doctor is told exactly that.
//       Settings now leads with the clinic's own facts, and the switches
//       are labelled in English instead of as raw camelCase flag keys.
// v31q: the assigned-doctor name now comes from 0015 my_assigned_doctor_name().
//       Reading the doctor's profile row was never going to work - RLS gives a
//       secretary HTTP 200 with an empty array. Confirmed live before changing
//       it, so the chip never asserts a doctor is missing when it just could
//       not read one.
// v31r: the dashboard header. The tagline used to end in a run-on
//       "-- nasal, laryngeal, CF4" welded onto the sentence, and
//       your own patient counts was baked into the HTML - false for an
//       admin and misleading for a secretary. Now: a role-aware sentence
//       and the three report types as coloured chips.
// v31s: a wrong password now ANSWERS.
//       It did not hang on purpose - logActivity and logout called each
//       other without end on the 401 a signed-out caller gets, so login()
//       never returned and the button sat on 'Signing in' forever.
//       Measured now: a wrong password comes back in 0ms.
// v31t: the admin Clinics tab. It opened straight onto cards with no
//       totals, a bare N records of unstated period, and the full clinic
//       UUID as the heading. Now: account-wide totals, every count labelled
//       with its period, per-doctor figures, search that says how much it
//       hid, and a y an admin figure so the card actually adds up.
// v31u: the clinic search clear button.
//       Two bugs, not one ugly style:
//         1. Chrome and Safari draw their OWN x inside input[type=search],
//            so there were TWO x buttons side by side.
//         2. .ent-clinic-searchclear { display: grid } beats the [hidden]
//            attribute - an author display rule always wins over the UA
//            sheet - so the x sat in an empty search box permanently.
// v31v: the ticket panel no longer says Unknown account and stops.
//       Two bugs. The panel was drawn when the thread loaded and never
//       redrawn when the staff list arrived, so it matched nobody.
//       And even correctly drawn, a deleted account had no role shown -
//       yet ticket_messages.author_role is stamped server-side and the
//       clinic is on the ticket row, so both were knowable all along.
//       Verified live: 4 of 4 real tickets now resolve a role and clinic.
// v31w: the ticket panel stopped saying Removed account about Tara, who is
//       very much in the staff list.
//       labels was seeded ONLY from localStorage, so a browser that had
//       never renamed a clinic printed the raw uuid as the clinic name.
//       Real names now come from clinic_settings.
//       Three states, not two: found / still loading / genuinely removed.
//       An empty users array means we have not looked yet, and must not be
//       reported as a deleted colleague.
//       And no more @<uuid> - a hex string there is meaningless and tooling
//       reads it as a version-control ref.
// v31x: the admin ticket queue (.ent-ticket-queue).
//       The row ran four facts together with dots -
//       Tara - CF4 - Something is broken - 2 hours ago - carried no
//       urgency at all, and printed someone whenever the reporter was not
//       in the staff list.
//       Now: an urgency rail, the reporter with role, scope and kind as
//       chips, a reply count, and ordering that means something - open before
//       resolved, urgent before low, with the row being replied to pinned
//       first so it cannot move under the cursor.
// v31y: the ticket panel said Unknown clinic for every real ticket.
//       MY BUG: the panel reads t.clinic_id to show the clinic name, and
//       the column was never in the tickets SELECT - so it arrived as
//       undefined and the fallback fired every single time. Adding one
//       column to the query fixes it; A101 now checks that every column
//       the code reads is actually fetched, so the same mistake in any
//       other column cannot come back quietly.
//       Also: the unavailable-staff-list state said the same thing twice.
// v31z: the admin ticket QUEUE was unreadable - seven small coloured chips
//       crammed into one row (priority, status, avatar, name, @handle in
//       monospace, role, scope, category, replies) with nothing to rest the
//       eye on. The row is now four lines, one question each: urgency and
//       time / subject / who / which part of the app. The subject owns its
//       whole line and clamps at two.
//       MY BUG, and it is the reason it looked broken rather than busy: a
//       stale rule higher up this file still set flex-direction: column on
//       .ent-admin-ticket. The cascade keeps any property a later rule does
//       not restate, so the urgency rail - written and commented as a
//       vertical stripe down the left edge - was stacking ABOVE the text as
//       a 3px coloured line across the top of every card. Removed the dead
//       block and stated flex-direction: row explicitly. Without the bump
//       none of this reaches the browser.
// v31aa: the queue cards were too short for their own text - a two-line
//       clamp cut subjects off mid-sentence and the whole list sat at 66vh.
//       Cards are now min-height 118px, the subject clamps at THREE lines at
//       0.97rem, line gaps are 6px, the queue scrolls at 74vh with a thin
//       scrollbar, the rail is a 4px inset pill, and a hovered card lifts by
//       1px. Without the bump none of this reaches the browser.
// v31ab: the queue cards still did not have room, and - more usefully - this
//       pins down WHY the last change looked half-applied in the browser.
//       The service worker is registered from index.js, so once someone has
//       signed in it controls admin.html too. Bumping CACHE_NAME alone does
//       not help an already-open tab: the old worker keeps serving its cached
//       files until every client closes, and a worker from the old
//       CACHE-FIRST era will serve a stale stylesheet indefinitely.
//       Two defences:
//         1. admin.html now loads style/admin.css and function/admin.js with
//            ?v=v31ab. A changed URL is a new cache entry, so the browser
//            cannot pair new markup with an old stylesheet.
//         2. .ent-tk-top is styled again as a compatibility rule. v31z
//            renamed that element, and a tab still holding the previous
//            admin.js emits .ent-tk-top with no rule for it - which collapsed
//            into badges, timestamp and subject each on its own line, and
//            looks precisely like a broken layout.
//       Cards are now min-height 132px, subject 0.99rem clamped at three
//       lines, padding 15px, queue column 300-380px, queue scrolls at 78vh,
//       and the meta strip is nowrap so it can never stack again.
// v31ac: a doctor or a secretary could not see their own tickets, and could
//       not tell whether the administrator had answered.
//       The list, the thread and the reply box ALL existed already. What was
//       wrong was where they were: the dialog was one long column - four
//       scope tiles, a description box, a title, two dropdowns, the send
//       button, and THEN at the very bottom "Your tickets". Checking for a
//       reply meant scrolling past the entire form every time, which reads as
//       "the feature is missing". It is now two tabs and the LIST is what
//       opens; filing a report is one click away and rarely wanted.
//       Notifications needed no schema at all: tickets.last_message_by
//       already says who wrote last. What was missing was a memory of what had
//       been read, so "not written by me" would have been a permanent badge -
//       that is localStorage (entTkSeenV1), cleared by opening the ticket or
//       the tab, and the list re-reads on visibilitychange and every 60s so a
//       reply that lands while the dashboard is open still shows up.
//       index.html loads the two changed files with ?v=v31ac.
// v31ad: the admin's half of the notification. The queue counted messages but
//       never said which tickets were actually the admin's turn to move, so
//       triage meant opening every thread. The same tickets.last_message_by
//       column now drives a "Needs you" flag: the last word was not the
//       admin, and the ticket is neither resolved nor closed. Words, not a
//       bare coloured dot - a red circle at the end of a long clinic day is
//       not a queue. No localStorage here on purpose: this queue is shared,
//       so "seen" has to mean "handled", and resolved/closed is that signal.
// v31ae: a reporter could read back the DESCRIPTION of their own ticket and
//       nothing else. The scope, the kind of problem and the urgency were
//       chosen on three other controls and then vanished from view, so "the
//       report I filled in" could only be half reconstructed - and a secretary
//       checking back weeks later could not see what urgency they had claimed.
//       The thread now opens with a "What you reported" card carrying all
//       four values, read off the ticket row rather than out of local state so
//       they cannot drift from what the database holds, and the opening
//       message is labelled "Your description" instead of sitting there as an
//       unexplained first bubble.
//       Plus supabase-v2/scripts/seed_clinic_team.mjs: two clinics named for
//       ENT and their doctor, six named staff (jess, tara, kaye, gina /
//       monique, lian), one ticket each, two answered by an admin. Verified
//       that a reporter still cannot read the other clinic's tickets.
//       index.html loads the two changed files with ?v=v31ae.
// v31af: photo compression, and a real bug in opening a stored record.
//       - attach-time compression: every photo now leaves the form as WebP
//       (JPEG where the browser cannot encode WebP), inside a 300-700 KB
//       band. It used to be whatever the input was, and the CROPPER path
//       - the one a doctor uses - called toDataURL('image/jpeg') by hand and
//       so was the single path that skipped compression entirely. The crop
//       is also 1024 square now instead of 512, which is what 48% of an A4
//       width actually needs at 300 dpi.
//       - uploadAll() derives the file extension from the mime instead of
//       naming everything .jpg. validatePhoto() compares extFromName against
//       extFromMime and REJECTS a mismatch, so a WebP named .jpg would have
//       been refused on every upload - the moment photo storage was turned
//       on, every save would have failed. This is the bug that would have
//       landed on the first real user of Storage.
//       - downloadAsBase64() converted the Edge Function's
//       [{path,mime,base64,bytes}] into real data URLs. It returned those
//       objects as they were, and index.js restores a record with
//       data.images.filter(img => typeof img === 'string'), so opening any
//       record with photos in Storage silently dropped every one of them.
//       The report opened empty of its images.
// v33k: two cards that named nobody, fixed at the source.
//       - "Your secretaries" read Auth.readUserCache(), which v2 retired to
//         a permanent [] (no account table in the browser - a cached ROLE is
//         the stale-claim problem PRIV-04 tests). So EVERY doctor saw "No
//         secretary is linked to you yet" while the admin panel showed
//         secretaries assigned and correct. dashboard.js now asks
//         rpc/my_secretaries (migration 0027), the mirror of 0015's
//         my_assigned_doctor_name: no arguments, joined on auth.uid(),
//         secretaries assigned to the signed-in doctor and nothing else.
//       - DB Records showed "Saved by 94978594-afad-..." with the avatar
//         holding "9" - the first CHARACTER of the uuid - because created_by
//         is a server-stamped uuid and the browser cannot resolve it (RLS
//         returns only its own profile row). reports.created_by_name (0028)
//         stamps the display name beside the id, backfills the past, and the
//         cards now also carry a returning-patient chip (N records - N
//         visits, counted across all report types). The queue's "who" and
//         the doctor's own "Me" chip read the same column.
//       index.html loads dashboard.js with ?v=v33k; the three form pages
//       load dbRecords.js with ?v=v33k.
// v33m: TEAM DRAFTS - the second half of a question the app already had
//       the data for. A doctor asked why he could not see what his
//       secretary was working on, and she could not see what he was.
//       The drafts were already being shared automatically; the LIST was
//       narrowed to "drafts I wrote" (created_by = me), on purpose, so the
//       fix is a second tab that drops that ONE filter and lets RLS answer
//       whose shelf a row is on - the doctor reads his secretaries, the
//       secretary reads her doctor, and nothing crosses a clinic. New in
//       the modal: "My Drafts | Team Drafts", a "by <name>" chip on the
//       other half, and NO delete button there (one accidental tap must
//       not delete somebody else's unfinished work).
//       Migration 0029 fixes what that exposed: a secretary could not
//       delete a draft SHE wrote, because 0026 keyed deletion on the row's
//       DOCTOR. It is now allowed, scoped to is_draft so finished records
//       stay exactly as protected as before.
//       The three form pages load draftsBrowser.js with ?v=v33m.
//       - two more found while testing that:
//       - "14 patients today" while three people had actually been through
//         the clinic. TWO causes, found by reading the live rows (read-only
//         probe, no writes): first, the counter read every reports row and a
//         shared DRAFT is a row in that table, so unfinished work was
//         counted as patients handled; it now asks for is_draft = false
//         (0017's honest "reached the database" marker) and the device
//         fallback drops records whose only format is 'Draft'. Second, and
//         this was the bigger one - all 14 rows that remained were REAL
//         final saves, but their procedure_date was August and September: a
//         backfill session. Per user request the buckets are built from
//         created_at (SAVE date), so every finished save counts in the
//         period it was saved: a backfilled September visit typed in
//         October shows up in October. encounterMs() buckets on created_at
//         (falling back to procedure_date only when the save stamp is
//         missing). The queue still reads drafts - that is its
//         whole job.
//       - a draft of another report type had a greyed-out Open button,
//         which on the Team tab read as "these cannot be opened". It now
//         walks to the page that owns that form (?ent_draft=<key>) and
//         opens it there, in either direction of the doctor/secretary
//         pair. And a draft whose form was never uploaded now says WHO can
//         put it back rather than offering a dead button.
//       - and the real reason Team Drafts could not be opened, found by
//         reading the live rows (read-only probe): 20 of the 23 draft rows
//         carried NO FORM at all. Two causes, both fixed.
//         (a) syncEngine.js upserts the local PatientRecords entry under the
//             SAME record_key. That entry holds metadata only, and an upsert
//             replaces the payload column wholesale - so one automatic sync
//             was enough to strip the form off a draft the drafts browser
//             had uploaded, and from that moment nobody could open it. A row
//             with payload->draftShared is now never overwritten by the sync;
//             two writers on one row was the shape of the bug.
//         (b) those 20 rows are what the sync writes on its own: metadata with
//             no form, which is not work anybody can continue. The draft
//             lists now require a row to CARRY A FORM, and the team queue no
//             longer offers them as "waiting for review" either.
//       - Team Drafts cards also say who touched a draft LAST ("last edited
//         by Kaye Santos - 5 Oct, 4:00 PM"). Every re-save stamps sharedBy
//         in the payload, so when a colleague opens and continues somebody
//         else's draft the card shows both names: who drafted it, and who
//         carried it on.
// v33n: VIEW ALL PATIENTS - a layout pass, and one bug it exposed.
//       The page listed eight columns across a laptop, buried the only
//       sentence that matters on it (what this account may see) inside the
//       user chip, showed no counts, and had no filters. It also said
//       "checking..." in the header FOREVER: the connection-pill updater
//       lives in admin.js and never ran here.
//       Now: a two-row header whose second line states the account's reach;
//       a live connection pill that goes quiet when all is well; three
//       counts (listed / accessible / needs permission) so "can I open
//       anything?" needs no row scanning; clinic, report and "only what I
//       can open" filters that never touch a permission decision (can_view
//       is read from the server, and only read); four readable columns with
//       the patient as the headline; and a detail pane that explains itself
//       instead of sitting blank.
//       viewAll.html + view-all.css + viewAllAccess.js load at ?v=v33n.
//       Follow-up, reported off the screen: the table HEAD read
//       "Patient | Clinic & doctor | Date | (nothing)" - the fourth column,
//       the only one carrying a button, had its name as screen-reader text -
//       and that same cell was display:flex, which takes a <td> out of the
//       table's column algorithm, so the headings drifted off the cells.
//       Now every heading is visible, classed, and owns a width on a
//       table-layout:fixed grid; "Access" is right-aligned like its cell.
//       And the sticky header itself was the next report: it was NOT at the
//       top of the table, with rows disappearing under it. Three causes:
//       border-collapse:collapse (a sticky <th> loses its border and paints
//       inconsistently), a hard-coded 124px offset that is wrong as soon as
//       the header wraps or the user chip lands, and a header with no rule
//       or shadow so rows read through it. Now: separate borders, an offset
//       MEASURED from the real header (ResizeObserver + resize), and the
//       page header still paints over it.
//       Both of those were answered again, so: the table header is now
//       STATIC (a sticky header inside a clipping card cannot be placed
//       reliably - it drifts and rows run under it), with the SAME padding
//       as the cells it labels and middle alignment. And the record no
//       longer opens in a side pane: it opens in a <dialog> over the list,
//       so the table keeps the full page width, nothing is blank on screen
//       waiting for a click, and Escape / the backdrop / a Close button all
//       dismiss it without hand-written focus handling.
// v33o: a draft with NO patient name is refused, and every file changed
//       since v33m/v33n gets a fresh ?v= so no browser keeps a stale copy
//       of a build it has already seen.
//       The refusal is not tidiness. extractMeta() falls back to the literal
//       "Unnamed patient", so buildKey() produces `cf4|unnamed patient|<date>`
//       - and two nameless drafts saved on the SAME DAY collide on that key,
//       the second silently overwriting the first. Save Draft now stops
//       before anything is written to this device or to the database, says
//       why, and gives no "Saved" pulse or confirmation toast, because
//       nothing was saved. A last name OR a first name is enough; a middle
//       name alone is not a patient.
//       Files now at ?v=v33o: dashboard.js (index), dbRecords.js,
//       draftsBrowser.js, syncEngine.js (three form pages), view-all.css
//       and viewAllAccess.js (viewAll.html).
// v33r: DB Records grows RMCI / CUMC hospital tabs (All | CUMC Records |
//       RMCI Records), the cards wear the hospital badge, and "Save to
//       Database" asks which hospital the visit belongs to before writing
//       payload.site - the same short code drafts already store, so no
//       migration. FEATURE-FLAGGED to Dr. Jesus Jardin's clinic/team only
//       (clinic-name read with a strict identity fallback); every other
//       clinic sees today's behaviour, no tabs and no prompt.
//       Files now at ?v=v33r: dbRecords.js (three form pages), plus
//       patient-records.css (tabs + prompt styles) and this cache name.
// v33s: the tag was SAVED but not SEEN: the badge hid in the card's top
//       line beside the ID instead of on the RIGHT of the PATIENT'S NAME
//       where the clinic looks, and an untagged (old) record showed
//       nothing at all with no way to fix it short of re-saving the form.
//       The badge now sits beside the name; untagged cards say "No
//       hospital" and every card carries a Set/Move button that PATCHes
//       payload.site directly (startSiteMove, flag-gated, payload merged
//       so formData/photos are never dropped). The save prompt's choice is
//       also stamped into the local record history so a background sync
//       cannot drop it. Files now at ?v=v33s: dbRecords.js (three form
//       pages); patient-records.css (name-row zone, chip + button) and
//       this cache name.
// v33t: the badge SAVED but VANISHED on refresh. PostgREST names a
//       JSON-extracted field after its LAST key, so `select=payload->>site`
//       answers { site: "RMCI" } - the same convention syncEngine.js and
//       dashboard.js already rely on for dbSaved (row.dbSaved). The list
//       read the literal expression key instead (record['payload->>site']),
//       which is undefined on EVERY fresh load: the in-memory Set/Move write
//       showed the badge, the next reload showed "No hospital" again - and
//       the CUMC/RMCI tabs filtered nothing. One siteOf() reader now accepts
//       the real bare key first (plus the expression key and a full payload
//       as fallbacks); isDatabaseRecord reads the bare dbSaved key the same
//       way. Files now at ?v=v33t: dbRecords.js (three form pages) and this
//       cache name.
// v33u: DB Records grows a SORT BAR - Latest (default) | A-Z - sitting
//       right under the search toolbar. Latest makes the server's own
//       updated_at DESC explicit, so the freshest saved patient is always
//       the first card; A-Z orders by patient name (case-insensitive,
//       unnamed rows last). Sorting applies AFTER search and the hospital
//       tabs narrow the set, so all three compose, and the chosen mode
//       survives Refresh (loadRecords never resets it). Deliberately NOT
//       feature-flagged - sorting is basic list hygiene for every clinic,
//       so the bar never carries the tabs' [hidden] rule.
//       Files now at ?v=v33u: dbRecords.js (three form pages),
//       patient-records.css (sortbar + pill chips, shared with the tabs)
//       and this cache name.
// v33v: the card's status toggle could not fit its own label - an inline
//       width:34px (plus the CSS to match) forced "EDITABLE" / "FINAL
//       SAVED" out of a 34px circle - and its Set/Move sibling had no
//       rule at all, so the form pages' page-wide `button` rule (12px/
//       24px padding, 140px min-width, uppercase, gradient) blew it up
//       inside the name row. Both now share ONE compact pill sized by
//       its content (labels always sit inside, never spilling), the site
//       zone wraps on narrow cards instead of overflowing, and the
//       toggle keeps its blue accent so it reads apart from Set/Move.
//       Files now at ?v=v33v: dbRecords.js (three form pages),
//       patient-records.css (same pages, now versioned) and this cache
//       name.
//       Same stamp, second pass: the RECORD LOADED / DRAFT LOADED alerts
//       now use a structured "Next steps" copy, and the shared message
//       modal (#msgModalText) renders with white-space: pre-line on all
//       five pages that embed it - its <p> was collapsing every alert's
//       blank lines, so each message showed as one run-on paragraph.
//       draftsBrowser.js joins these pages at ?v=v33v (was v33o).
// v33w: the dashboard's Report types card was a bare label-and-number
//       list over thin rules. Each type is now its own small card: a
//       tinted icon badge in that type's hue, the name, the count with
//       its share of the month as a pill, and the bar. The card hint
//       now carries the total ("This month", plus the report count) and
//       a month with no saves says so instead of showing three zeroes.
//       index.html moves dashboard.js and dashboard.css to ?v=v33w.
// v33x: the dashboard activity row was Endoscopy (nasal + laryngeal
//       combined) + CF4 + Report types. It is now ONE CHART PER REPORT
//       TYPE - Nasal Activity, Laryngeal Activity, CF4 Activity - in the
//       same sky / indigo / green as the Report types rows, so a quiet
//       week on one form cannot hide a busy one on the other. Report
//       types moved below the full-width Activity Growth chart, and
//       index.html marks dashboard.js / dashboard.css at ?v=v33x.
// v33y: the site carried no copyright / license notice anywhere. The
//       dashboard (index.html) AND the login page now end with the same
//       three line notice: (c) 2026 Johnzynd / All Rights Reserved, the
//       created-by line, and the no-unauthorized-reproduction line - the
//       two entry pages, no more. The styles live in index.css (the one
//       stylesheet BOTH pages already link) as .ent-copy, with a
//       body.ent-login-page override because that card sits on a
//       sky->navy gradient where the muted grays would go unreadable.
//       The footer carries .no-print so it never lands inside a printed
//       patient report. index.html and login.html mark index.css at
//       ?v=v33y; internal probe diagnose.html is deliberately untouched
//       (not a published page).
// v33z: the Activity Growth card drew every day as ONE grey column of
//       total reports - the three forms were indistinguishable - and its
//       month dropdown neither said which month it showed (raw "10/2026")
//       nor actually drew that month: activityRowsForPeriod built the
//       window one month ahead (new Date months are 0-based) and the chart
//       always bucketed "today minus 6", so any non-current month rendered
//       all zeros. The period options now read "October 2026" and sit in
//       the card head; the 7-day window anchors to the selected month
//       (ending today for the current month, its last day for a month that
//       is over, its first days for one not yet started), the combined
//       chart stacks sky / indigo / green segments per nasal / laryngeal /
//       CF4 like the split charts, three cloud counter chips above it
//       total each type over the shown days, and the picker keeps the
//       month the user chose across the 60s refresh. index.html marks
//       dashboard.js / dashboard.css at ?v=v33z.
// v33aa: the Activity Growth card drew only the shown 7 days, so "the
//       month" was never actually visible - just a window of it. The card
//       now draws the WHOLE selected month: 28/29/30/31 stacked columns,
//       one per day, with the day numbers (01..31) shown under every
//       column, in one narrow horizontally-scrollable row (.ent-chart-month
//       - nowrap + overflow-x) so the columns never wrap into rows that
//       look like separate weeks. The three cloud counter chips total each
//       type for the whole month (tooltip: "shown month") and the hint
//       spans the month's first to last day, while the three split charts
//       keep their 7-day view anchored inside that same month. BUT it
//       shipped with a duplicate id: the <select> re-used its host div's
//       "dashPeriod", so getElementById returned the DIV (first match in
//       document order) - the initial "fire once" saw no .value and
//       skipped (the card kept the 7-day fallback, never growing the
//       month grid) and the change handler threw on div.value.split (the
//       picker was dead). index.html marks dashboard.js / dashboard.css
//       at ?v=v33aa.
// v33ab: the month picker gets its OWN id (dashPeriodSelect), so
//       getElementById really returns the <select>: on load the card
//       paints the WHOLE month - all 28/29/30/31 day numbers under their
//       columns - and every change re-renders that month, with the picked
//       month kept across the 60s refresh. The day numbers also grew to
//       0.64rem / weight 700 in full text colour so they read at a
//       glance. supabase-v2/scripts/test_growth_month.mjs locks this down
//       by lifting the real renderActivitySelector / buildPeriodOptions /
//       computeActivityData / renderGrowthChart out of dashboard.js and
//       running the picker against a getElementById-first-match stub -
//       including a load-bearing run against the OLD duplicate-id source
//       that must fail. index.html marks dashboard.js / dashboard.css at
//       ?v=v33ab.
// v33ac: "Save to Database" asked about duplicates it had no business
//       asking about: the prompt keyed on patient name + date ONLY, so a
//       CF4 saved for a patient who already had a nasal record that same
//       day raised "Already a record on this date / Replace?" - and the
//       dialog's per-row "Open & update" button would have loaded the
//       nasal payload into the CF4 form. record_key is `type|patient|
//       date`, so a cross-type pair are two rows that never touch each
//       other: nothing to replace, nothing to ask. The prompt is now
//       gated on SAME TYPE + SAME DATE (typeMatches), the dialog lists
//       only that type's rows and names the type in its subtitle
//       ("already has 1 Nasal Endoscopy record"), its date highlight
//       comes from the caller's reportDate (a CF4's date lives under
//       dateAdmitted, so it was never highlighted before), and the note
//       says "record of the same type". A repeat visit on another day is
//       untouched: saved in silence, mentioned by the post-save toast.
//       supabase-v2/scripts/test_db_records_site.mjs locks it down with
//       X1-X5 (cross-type same day = zero dialogs; same type same day =
//       dialog, and Replace completes the save; earlier day = silent).
//       The three form pages mark dbRecords.js at ?v=v33ac.
// v33ad: the Latest patients card could only say the VISIT date, so a
//       doctor or secretary had no way to tell when an entry was actually
//       written - "10/05/2026" reads the same whether it was saved this
//       morning or three weeks ago. Every row now also carries its save
//       time on the right ("Saved 3:42 PM" for today, "Saved Oct 5, 3:42
//       PM" for an older day), reusing the .ent-recent-when style that was
//       already in the stylesheet. The badge reads updated_at first (the
//       LAST save - a record edited later moves the line), falls back to
//       created_at, handles both cloud ISO strings and device epoch
//       milliseconds, and is OMITTED when neither exists rather than
//       inventing a 12:00 AM. loadCloudRows now selects updated_at and
//       normalise() carries it through - the charts still bucket on _ts
//       (the save DATE from encounterMs), so no counter moves. index.html
//       marks dashboard.js at ?v=v33ad.
// v33ae: "Latest patients" now says WHICH HOSPITAL each patient was seen at
//        (payload.site: RMCI / CUMC) on both the flat index.html list and
//        the admin's per-clinic card, and the admin card finally loads the
//        clinic-name and staff-profile directories so it prints real clinic
//        names plus a Doctor / Secretary role beside the creator - the
//        author name itself now rides on the query (created_by_name, 0028)
//        instead of degrading to "Someone" for every v2 uuid. The admin
//        console gained the matching "Latest patients records" card on its
//        Overview panel (admin.html + admin.js + admin.css). index.html
//        marks dashboard.js / dashboard.css at ?v=v33ae; admin.html marks
//        admin.js / admin.css at ?v=v33s.
// v33s: the Tickets tab is a support inbox now - a hero header, four
//        stat cards (Open / In progress / Urgent / Resolved) counted from
//        the same rows as the queue, a search-led toolbar, the queue as a
//        headed inbox card ("Inbox" + count), and the thread as one
//        conversation card (Ticket # + chat-style messages, mine right).
//        No logic changed: same ids, same queries, same classes the tests
//        assert on. admin.html marks admin.js / admin.css at ?v=v33s.
// v33t: sticky reply removed (it covered the last message) and a CORS
//        circuit breaker: 3 straight origin/offline failures stop the live
//        poll and say the fix once, instead of filling F12 with blocked
//        rows. admin.html marks admin.js at ?v=v33t, admin.css at ?v=v33t.
// v33u: Settings is a control room now - a gradient hero with a kicker, an
//        identity strip (clinic NAME from the stored profile + headcounts),
//        numbered cards with one accent each, name + Save on one row, and
//        the roles table as rows that need no sideways scroll on a phone.
//        Same ids and copy the tests assert on. admin.html marks admin.js /
//        admin.css at ?v=v33u.
// v33v: the Settings hero carries its own gear icon (ent-settings-hero-icon)
//        so the section is recognisable at a glance - no copy or id changed.
// v33w: settings gear shortcut in the user chip (admin only, both headers)
//        + Users tab is a people directory now - hero, role stats, search-led
//        toolbar, icon group headers with reach hints, role badge on avatars.
//        Same ids, same data-act buttons, same classes the tests assert on.
//        index.html marks auth.css at ?v=v33w; admin.html marks admin.js /
//        admin.css / auth.css at ?v=v33w.
// v33x: auth.js cache-bust (?v=v33w) on index + admin so the chip gear
//        actually reaches the browser - every page loaded auth.js
//        unversioned, so a cached copy without the gear kept running.
// v33af: the secretary Lian Tapongot's saved CF4 records vanished from DB
//        Records ("No saved patients yet") even though they were still in
//        the table. The record list asked the server for the newest 200
//        rows INCLUDING drafts, then filtered drafts out in the browser -
//        so once 200 newer drafts piled up, every finished row fell below
//        the limit and the filtered list came back empty. loadRecords now
//        sends is_draft=eq.false to the database (name-tier and flag-tier
//        queries; the pre-0018 plain tier has no such column and stays
//        unfiltered), so the 200-row window is 200 real records. The three
//        form pages mark dbRecords.js at ?v=v33af and this cache name.
// v33ag: the list ALSO stopped at 200 rows flat, so a shelf with more than
//        200 saved records still showed only the newest 200 (and duplicates
//        in the table each got their own card). loadRecords and
//        loadPatientStats now PAGE (limit=500 + offset) until the server
//        returns a short page - every saved row is displayed, whichever
//        report type and however large the shelf - with id.desc as the
//        order tie-break so rows cannot reshuffle between pages, a
//        cross-page dedupe by record_key+updated_at, and one CARD per
//        record_key so a duplicate row never doubles the list. The three
//        form pages mark dbRecords.js at ?v=v33ag and this cache name.
// v33ah: the v33af draft filter was TOO STRICT and hid saved records the
//        card logic would have shown - the secretary again reported only
//        ONE CF4 record. is_draft=eq.false is SQL `is_draft = false`, and
//        NULL = false is UNKNOWN: a legacy row whose flag was never
//        written never came back, and a row whose column still read TRUE
//        while payload.dbSaved said saved (pre-0017 writer, or the old
//        payload-only toggle write) failed it too. loadRecords and
//        loadPatientStats now send
//        or=(is_draft.eq.false,is_draft.is.null,payload->>dbSaved.eq.true)
//        - EXACTLY the rows isDatabaseRecord() accepts - and the Final
//        Saved toggle writes the top-level is_draft column (always false:
//        TRUE would drop the row from the list on the next load) beside
//        the payload copy. Real drafts still match no clause. The three
//        form pages mark dbRecords.js at ?v=v33ah and this cache name.
// v33ai: the soft-delete flow came BACK on request: DB Records cards now
//        carry a Delete button (soft delete - PATCH deleted_at into the
//        recycle bin), the dialog gained a Recycle bin view (admin or
//        secretary, read through ent_deleted_reports) with Restore, and
//        the Admin Console's bin gained "Delete forever" - a two-step
//        armed click whose DELETE can only ever name an already-deleted
//        row (0026's policy; migration 0034 adds the secretary's shelf
//        arm and the JWT stamp for deleted_by). admin.html, admin.js,
//        dbRecords.js and patient-records.css all changed. Without this
//        bump a browser keeps running the old card without the button.
//        Files now at ?v=v33ai: dbRecords.js + patient-records.css (the
//        three form pages), admin.js (admin.html), and this cache name.
// v33aj: the cross-clinic secretary (0037). A secretary assigned to several
//        doctors now picks which clinic she is working at today: auth.js
//        keeps that choice in sessionStorage, scope() shelves her under it,
//        a "Switch clinic" pill in the header chip reopens the picker, and
//        dbRecords.js sends doctor_id on save so the stamp trigger files the
//        record under the chosen doctor (validated by ent_is_my_doctor).
//        auth.js, dbRecords.js, style/auth.css and this cache name changed.
//        Without this bump a browser keeps running the old auth.js, so the
//        picker never appears and every secretary stays pinned to her primary.
// v33ak: one clean bump covering the whole uncommitted batch so a fresh
//        deploy cannot mix an old cached file with a new one. Everything
//        from 0033 (author escape hatch) to 0037 (cross-clinic secretary)
//        lands together:
//          · auth.js          — the cross-clinic secretary picker, the
//                              "Switch clinic" pill, and the scope() shelf
//          · admin.js         — extra-doctor chips on the secretary form
//                              (set_assignments), and "Delete forever" in
//                              the recycle bin (calls patient-photos
//                              purge_report to free the Storage bytes)
//          · dbRecords.js     — sends doctor_id on save; the site-move card
//                              action; NULL-safe draft filter
//          · patientRecords.js— recycle-bin Restore + Delete-forever wiring
//          · patient-records.css — the bin rows and the Delete-forever button
//          · auth.css         — the secretary clinic picker styling
//        Files now at ?v=v33ak: auth.js (index + admin), admin.js (admin),
//        dbRecords.js (the three form pages), patientRecords.js (index +
//        the three form pages), patient-records.css (the three form pages),
//        auth.css (index + admin + the three form pages + login), and this
//        cache name. Without this bump every browser keeps the pre-0033 UI
//        against a 0033-0037 database.
// v33al: the ticket system moved OFF the dashboard and back onto its own
//        page (pages/reportProblem.html + function/ticketsPage.js +
//        style/tickets.css). Two bugs shipped with the first cut and are
//        fixed here together:
//          · the "Report a problem" quick-action card was a <button> whose
//            only handler lived in ticketForm.js and early-returned (the
//            pop-up markup it expected is gone), so the card did NOTHING.
//            It is now a plain <a href="pages/reportProblem.html">.
//          · ticketForm.js stayed on index.html for the unread badge but
//            called byId('tfForm').addEventListener with no guard, which
//            THREW on the dashboard and killed the rest of boot. All its
//            element lookups are guarded now.
//        Also registers the three new ticket files for offline use - the
//        page was network-reachable but not pre-cached, so the tickets
//        screen was the one thing that broke when the wifi dropped.
// v33am: three tickets-page fixes, all CSS (style/tickets.css only):
//          · Back to Menu now wears the same solid slate "black" button
//            as cf4Form's .back-button.back-button-solid, instead of the
//            light .ent-btn chip it was.
//          · .ent-tk-viewbody had NO rule at all - a plain block inside
//            the overflow:hidden pane - so .ent-tk-detail-body's
//            flex/min-height/overflow contract was inert and long tickets
//            got clipped at the bottom with no way to reach them. It is
//            now a bounded flex column (+ [hidden] guard, + the report
//            card relays the same contract) so the content scrolls.
//          · the empty/welcome message SVG had no width/height and painted
//            pane-wide, reading as a logo banner before the text; capped
//            to a 46px icon.
// v33an: the doctor/secretary "Team queue" card (dashboard.js + index.html
//        ?v= + dashboard.css) got a presentational redesign - no behaviour
//        change, same grid, same wiring, same tests:
//          · queue rows wear the REPORT TYPE hue (sky/indigo/green, same
//            as the mix chart) on the avatar and a new .ent-qtype chip,
//            so "which of these are CF4?" is one glance
//          · the by-line shows RELATIVE time; the row title keeps the
//            exact stamp
//          · the status pill gained the pulsing .dot (waiting blinks,
//            "In database" stays calm)
//          · the title keeps its SVG icon after render (was swapped for
//            the 👥 emoji), the secretary's sections are tone-coded
//            (is-wait / is-saved / is-fresh count chips), the "View
//            patients" toggle carries its count, and the "Needs review"
//            tab count turns amber while not zero
//        Without this bump a browser keeps the old flat rows and grey
//        meta line forever (cache-first), and the new .ent-qtype classes
//        never arrive.
// v33ao: the 📅 emoji on the dashboard "Follow-ups" card header went invisible.
//        The card title carries a gradient-text treatment (background-clip:
//        text + -webkit-text-fill-color: transparent) that ALSO hits the emoji
//        - an emoji is not a glyph that can show a gradient, so it disappeared.
//        The 📅 is now wrapped in an .ent-h3-emoji span that opts back OUT of
//        the clip + transparent fill, keeping its own colour and staying
//        visible, while the words keep the gradient. index.html markup + a new
//        dashboard.css rule; dashboard.js untouched. admin.html's 📅 was already
//        fine (auth.css, no gradient) so it is left alone.

//        never arrive.
// v33ap: the dashboard HERO was loud and repetitive. Three "Dr. Jesus
//        Jardin" on one screen (role line + scope pill + tagline), the same
//        sunset emoji twice (greeting AND mood line), and "Updated just
//        now, from the cloud database" right beside "Live, synced just
//        now". The role pill now says the ROLE only, the greeting drops its
//        emoji in favour of the mood pill's, and the clock shows the time
//        while the sync pill keeps the freshness. The side card's own rows
//        (.ent-dash-titlerow / -side-top / -actions / -actions-row) finally
//        have CSS: a stale duplicate .ent-dash-hero-side rule was overriding
//        the card's align-items and un-stretching every button, and
//        .ent-dash-actions was left unclosed in the markup. Two dead
//        duplicates (.ent-dash-subrow, a second .ent-dash-statusrow) are
//        merged into one rule each.
// v33aq: Print / CSV / the Settings gear never fit or aligned in the side
//        card, for two reasons that were both invisible in the markup.
//        .ent-dash-ghost was defined in NO stylesheet, so the two export
//        buttons silently wore plain .ent-btn and shouted at the same weight
//        as the solid Refresh above them; and .ent-btn itself is an
//        inline-block, so the justify-content these rows set was a no-op and
//        every glyph hugged its left padding. Both fixed in dashboard.css:
//        each hero button is a real flex box now, and the ghost style exists.
// v33ar: the streak line never disappeared from the hero. Two bugs stacked:
//        1. .ent-dash-streak sets display:inline-block, and an AUTHOR
//           display rule beats the UA sheet's [hidden] { display:none } -
//           so renderHero's streakEl.hidden = true hid NOTHING and the
//           pill drew even with no entry and no streak.
//        2. the hide branch never cleared innerHTML, so the last
//           "N-day streak ... Keep it going!" stayed in the DOM. A delete
//           that breaks the streak (or any 60s refresh) left the old
//           sentence rendered while computeStreak() already said 0.
//        dashboard.css restates [hidden] (the guard .ent-dash-alert
//        already had) and the hide branch empties the element too.
//        index.html marks dashboard.js / dashboard.css at ?v=v33ar.
// v33as: the streak pill never showed a ONE-day streak. renderHero only
//        drew it from 2 days up, so the first patient saved today (a
//        streak of exactly 1) rendered no line at all - the report:
//        "meron 1 patient na ginawa today dapat lalabas 1 day streak".
//        Threshold is now >= 1. Zero is still hidden AND still cleared:
//        computeStreak() reaches 1 only when a real day holds a record,
//        so the v33ar no-entry fix stands. index.html marks dashboard.js
//        / dashboard.css at ?v=v33as.
// v34b: STREAK ALWAYS VISIBLE. renderHero never hides #dashStreak -
//        zero draws "No streak yet" instead of vanishing, so the doctor
//        and secretary dashboards always show the streak state.
// v34a: NEW SUPABASE PROJECT + DUPLICATE-PATIENT GUARD. The frontend now
//        points at the new project ybnlvfdvfrwnmdvhxeof (supabaseClient.js
//        + the CSP in build-pages.mjs); migration 0041 adds patient-day
//        uniqueness (uniq_reports_patient_day / uniq_reports_case_number_day)
//        plus the read-only ent_possible_duplicates() review function.
//        dbRecords.js adopts an existing row's record_key when the patient
//        ID + type + date already match (merge, not duplicate) and recovers
//        from a 23505 race by merging into the winning row. admin.js/admin
//        .html gained the "Possible duplicates" review card. Files now at
//        ?v=v34b: dashboard.js/css (index.html), dbRecords.js (three form
//        pages), admin.js (admin.html), plus this cache name.
// v34c: cf4.js suggestion popup restyled to look like the browser's native
//        datalist popup; index.js gained PRE-OPERATIVE DIAGNOSIS suggestions
//        (textarea look-alike widget) on the nasal + laryngeal pages.
// v34d: four small UX fixes. (a) cf4.js: the suggestion popup now hides
//        the moment the page scrolls, matching the nasal/laryngeal boxes.
//        (b) patient-records.css: .ent-db-dialog widened 720px->1100px and
//        84vh->94vh so doctors can actually read the record cards.
//        (c) dbRecords.js: closeModal() clears the search box - the modal
//        node is reused, so the old query used to survive a close and keep
//        filtering the next open. (d) login.html: remembers the account
//        that signed in on this device and pre-fills username + password
//        so a repeat visit is one click. Files now at ?v=v34f: cf4.js,
//        dbRecords.js, patient-records.css (three form pages).
// v35d: OFFLINE BUTTONS REPAIR. Another tool pasted the offline-records
//        viewer (an IIFE) into the MIDDLE of index.js's PDF html2canvas
//        fallback try/catch, so index.js failed to parse and every header
//        button it binds died on the nasal + laryngeal pages: Save to
//        Offline Mode, Offline Records, My Drafts, Save PDF, Print,
//        New Form - and window.EntFormBridge, which dbRecords.js needs for
//        Save to Database / DB Records (getBridge() returns null without
//        it). The viewer IIFE now lives at the END of index.js, top level,
//        and exposes closeOfflineModal (the old `close:
//        closeOfflineRecordsModal` named a function that never existed and
//        would throw at load). draftsBrowser.js now decides who owns
//        localDraftsBtn at CLICK time instead of bind time: it loads
//        BEFORE index.js, so its old bind-time offlineBound check never
//        saw the viewer and one click opened TWO modals. pages/records
//        -doctor.html joins the pre-cache (its scripts were already here),
//        and the offline fallback now matches with ignoreSearch:true so
//        ?v=... script URLs and ?ent_draft=... deep links resolve without
//        a connection. The three form pages mark index.js /
//        draftsBrowser.js at ?v=v35b.
// v35e: OFFLINE SAVE UX - "Saved to Offline Mode" toast (amber, with the
//        auto-upload promise), the "All offline records already saved to
//        database" confirmation card when the pending queue drains, and the
//        Offline Records list that drops rows the moment they reach the
//        cloud (plus an immediate on-load flush instead of the 45 s tick).
//        Files now at ?v=v35c (draftsBrowser + index.js), ?v=v35b
//        (syncEngine) and ?v=v33al (auth.css). Without this bump a browser
//        keeps the old trio against the new page markup.
// v36a: TRUE OFFLINE-FIRST REPAIR for the doctor workflow. The audit found
//        three concrete defects and this bump fixes all of them:
//        (1) INSTALL WAS ALL-OR-NOTHING. cache.addAll() rejects the WHOLE
//            install when a single request fails, so one flaky fetch left the
//            device with NO service worker - silently - and every offline
//            navigation then fell through to the network and showed the
//            browser's native "You're offline." page. Each entry is now
//            fetched individually (cache:'reload', so a stale HTTP cache
//            cannot satisfy a versioned deploy) with its own retry loop, in
//            parallel, while progress is POSTED to open pages ("Preparing
//            offline access ... n/total"). If any entry still fails the
//            install REJECTS: the previous working cache survives untouched
//            and activate (which deletes other caches) never runs.
//        (2) NOTHING EVER VERIFIED THE CACHE. The worker now answers an
//            'ent-verify-offline' message with a per-file report, computed
//            WITH NO NETWORK, so the page (function/offlineReady.js) can
//            show "Offline-ready" only after every required resource is
//            really present - and a Retry when one is missing.
//        (3) REGISTRATION LIVED ONLY IN index.js + cf4.js, so login, admin,
//            settings, tickets, viewAll and records-doctor never registered
//            a worker. auth.js - the one script EVERY page loads - now
//            registers it (see function/auth.js), and offlineReady.js on the
//            dashboard + login page drives the preparation status.
//        Files now at ?v=v36a: auth.js (ALL nine pages that reference it),
//        dashboard.css/js (index.html - MUST match this CACHE_NAME), and the
//        new function/offlineReady.js. Offline auth was rebuilt in the same
//        pass: the plaintext entSavedLoginV1 storage and the dead
//        SAVED_LOGIN_KEY guard branch are gone; offline entry now requires
//        re-entering the password, verified against a PBKDF2 grant written
//        only after a successful ONLINE sign-in (see function/auth.js).
// v36b: the login can offer the browser password manager a credential after
//       successful sign-in, and DB Records shows completion progress from
//       the saved form fields. Refreshes the login, record scripts and styles.
// v36c: keep the remembered username separate from the disposable offline
//       grant so it survives logout; redesign the remember-device control.
// v36d: prepare browser credentials during the login gesture, restore them
//       through Credential Management where available, and report support.
// v36j: default Remember me to checked for returning clinic users.
// v36o: tablet and laptop breakpoints for reports and shared content.
// v36p: dismiss offline setup errors after five seconds.
// v36t: polish the dashboard header for phone-sized screens.
// v36u: keep report-page sync and queue flushing out of offline-auth sessions.
// v39a: add formExitGuard.js to the offline app shell. The three report
//       pages use it to keep unfinished CF4, nasal and laryngeal reports in
//       My Drafts before leaving or starting a new form.
// v42: publish offlineWorkspace.html from the Pages allowlist. The worker
//      already required this file in FILES_TO_CACHE, so excluding it from
//      the deployed build returned a 404 and rejected the full SW install.
// v43: keep offline setup status visible until preparation completes. A
//      five-second timer was hiding "Preparing offline access" before the
//      worker could finish caching and verifying the app shell.
// v44: enable password-verified offline grants for assigned secretaries,
//      retaining their primary doctor scope; no other role gets local access.
// v45: cached pages/resources now survive slow-network timeouts, HTTP error
//      responses, and Cloudflare clean-URL navigation.
// v47: report-page requests keep their .html URL; Wrangler disables Cloudflare's
//      automatic .html -> clean-URL redirect for stable hard refreshes.
// v54: replace corrupted report-toolbar emoji with crisp inline SVG icons.
// v55: add the searchable CF4-backed clinical abstract page.
// v56: align the abstract form to its reference and add the medical certificate.
// v57: polish the report-page headers, buttons and abstract field alignment.
// v58: add shared document toolbar styles to the offline shell.
// v59: center abstract labels and print on a standard A4 page.
// v60: bump cache so Cloudflare's new files (abstract/medical certificate) replace stale cached copies.
// v61: refresh abstract and medical certificate hospital branding.
// v62: add print margins around the abstract and medical certificate headers.
// v63: inset the document-page toolbars and tighten printed logo-to-text spacing.
// v64: match abstract and certificate buttons to the endoscopy toolbar styles.
// v65: add endoscopy-style action icons and colored rails to document pages.
// v72: keep synced offline records visible and show their sync status.
// v73: responsive Offline Records spacing for desktop and large monitors.
// v74: widen dashboard and report-form layouts for large monitors.
// v75: align dashboard/report header gutters with their content containers.
// v76: match header and content side margins across desktop, tablet and mobile.
// v77: use a shared responsive gutter for the dashboard header and content.
// v78: align the dashboard title block and report chips to the content's left edge.
// v79: remove extra dashboard-header side padding on tablet and mobile.
// v81: align page headers and content gutters across the app.
// v82: expand application pages to the dashboard's 1600px width and gutters.
// v83: enlarge the on-screen clinical abstract and medical certificate only.
// v84: widen the document toolbars and compact them while scrolling.
// v85: scale document forms to the dashboard content width on screen.
// v86: redesign Report a Problem and View All Patients page layouts.
// v87: rebuild the Report a Problem page with a clearer support flow.
// v88: expand the ticket form to a full-width, naturally scrolling page.
// v89: rebuild the admin console panels and responsive navigation.
// v90: add on-device FFmpeg frame extraction for unsupported video codecs.
// v91: limit Clinical Abstract and Medical Certificate to Doc Jess clinic.
// v92: recognize the JESS clinic code and refresh the dashboard access check.
// v93: recognize Doc Jess profile identity when clinic metadata is unavailable.
// v94: allow secretaries assigned to Doc Jess to access medical documents.
// v95: accept trusted Jess doctor/clinic names in secretary assignments.
// v96: force-refresh secretary doctor assignments before gating the documents.
// v97: resolve secretary assignment before requiring a local clinic ID.
// v98: use the authenticated assigned-doctor name RPC as secretary fallback.
// v99: recognize the assigned physician's Jesus Jardin name.
// v100: refresh dashboard filters, action/quality panels, admin health notes,
//       and the database-record browser deep link.
// v101: move the action list into the former follow-up slot, clarify report
//       reminders, and restyle the recent-record filters.
// v102: remove dashboard report reminders and their unused duplicate checks.
// v103: paginate Latest patients with 10/50/100 report page sizes.
// v110: replace the old ticket page with the fresh reportProblem.html and
//       its own responsive stylesheet; workflows remain in ticketsPage.js.
// v111: polish the medical certificate and clinical abstract workspaces.
// v112: clarify document workspace steps and remove duplicate list numbering.
// v113: align document workspace accents with the system primary color.
// v114: align dashboard and offline workspace accents with the primary palette.
// v115: restore distinct colors for dashboard quick actions.
// v116: display the dashboard notification control as a compact icon-only bell.
// v117: make the bell itself yellow and minimize its click target to the icon.
// v118: reset inherited global button sizing and shadow on the notification icon.
// v119: slightly enlarge the yellow notification bell glyph.
// v120: center the notification panel across viewport sizes.
// v121: compact and right-align the dashboard profile on phones/tablets.
// v122: keep the full profile name under the avatar, wrapped at small widths.
// v123: hide the sign-out label at phone/tablet widths and keep its icon.
// v124: give the dashboard profile avatar a purple-pink gradient.
// v128: add persistent notifications and staff direct/clinic group messaging.
// v143: redesign the admin Growth analytics panel and its summary cards.
// v144: redesign the admin user directory and account cards.
// v145: redesign the active-session, activity-log and support-inbox panels.
// v146: redesign database usage, deleted records and settings.
// v147: apply the system primary color to the admin header and sidebar.
// v148: keep notification and Messenger interface refreshes up to date.
// v149: keep the admin bell visible through load errors and polish Messenger.
// v150: render notifications above header layers, centered on the bell.
// v151: fix dashboard notification overlay and refresh admin activity actors.
// v152: ship Super Secretary network access, dashboard and form permissions.
// v153: refresh the admin script with the valid secretary-assignment filter.
// v154: ship the dedicated Super Secretary network workbench.
// v163: use the normal dashboard and selected-clinic scope for Super Secretaries.
const CACHE_NAME = 'ent-report-system-v164-active-clinic-scope';
const FILES_TO_CACHE = [
    './pages/login.html',
    'pages/offlineWorkspace.html',
    './',
    'index.html',
    // Every page except index.html moved into pages/. These entries are
    // resolved against the APP ROOT (where sw.js itself lives), so they are
    // written with the pages/ prefix and not as "../pages/..." - sw.js is not
    // inside pages/, so a "../" here would escape the app entirely.
    'pages/login.html',
    'pages/offlineWorkspace.html',
    'pages/admin.html',
    'manifest.json',
    'pages/nasalEndoscopy.html',
    'pages/laryngealEndoscopy.html',
    'pages/cf4Form.html',
    'pages/abstract.html',
    'pages/medicalCertificate.html',
    'pages/settings.html',
    'pages/viewAll.html',
    'pages/reportProblem.html',
    'pages/contactSupport.html',
    // Orphaned (no inbound links) but still reachable by direct URL, so it
    // must survive going offline like every other page. Its scripts
    // (supabase.min.js, paths.js, supabaseClient.js, auth.js) are all
    // listed below already - only the document itself was missing.
    'pages/records-doctor.html',
    'style/view-all.css',
    'function/viewAllAccess.js',
    'js/lib/jspdf.umd.min.js',
    'js/lib/html2canvas.min.js',
    'js/lib/cropper.min.js',
    'js/lib/pdf.min.js',
    'js/lib/pdf.worker.min.js',
    'js/lib/supabase.min.js',
    'css/lib/cropper.min.css',
    'style/auth.css',
    'style/offlineWorkspace.css',
    'style/admin.css',
    'style/dashboard.css',
    'style/notifications.css',
    'style/messages.css',
    'style/index.css',
    'style/cf4.css',
    'style/patient-records.css',
    'style/tickets.css',
    'style/reportProblem.css',
    'style/mobile.css',
    'style/medical-documents.css',
    'style/medical-document-workspace.css',
    'function/auth.js',
    'function/admin.js',
    // paths.js resolves every page/asset URL. If it is not pre-cached, an
    // offline load 404s on it and EVERY relative link on the page breaks at
    // once - which looks like the whole app is offline rather than one file.
    'function/paths.js',
    'function/supabaseClient.js',
    'function/syncEngine.js',
    'function/index.js',
    'function/dashboard.js',
    'function/notificationCenter.js',
    'function/messagesPage.js',
    'function/cf4.js',
    'function/abstract.js',
    'function/patientRecords.js',
    'function/dbRecords.js',
    'function/draftsBrowser.js',
    'function/formExitGuard.js',
    // OFFLINE MODE (v35c): the IndexedDB local database + pending sync
    // queue. Missing from the cache means the three form pages lose
    // "Save to Offline Mode" the moment the device goes offline - the
    // very situation the module exists for.
    'function/offlineStore.js',
    'function/offlineReady.js',
    'function/offlineWorkspace.js',
    'function/storageStats.js',
    'function/photoStore.js',
    'function/ticketForm.js',
    'function/ticketsPage.js',
    'image/ent-logo.webp',
    'image/rmci-logo.png',
    'image/cumc-logo.png',
    'image/philhealth-logo.webp'
];

// Install service worker: pre-cache the app shell, one file at a time.
//
// WHY NOT cache.addAll(): it is one all-or-nothing transaction. A single 404
// or one flaky request on a bad hotel wifi rejects the WHOLE install, the
// previous worker stays in place (or none exists yet), and the device
// silently has no offline support - which is exactly how a doctor ends up on
// the browser's native "You're offline." page. Each entry is fetched here
// with cache:'reload' (bypassing the HTTP cache so a versioned deploy cannot
// be satisfied with stale bytes), retried up to 3x, in parallel, and progress
// is posted to any open page for the "Preparing offline access" status.
// If ANY entry still cannot be fetched the install promise REJECTS: the new
// worker never activates, activate - which deletes other caches - never
// runs, and the previous working cache stays exactly as it was. That is the
// "never delete the old cache until the new shell installed" rule, and it
// costs nothing.
const INSTALL_ATTEMPTS = 3;

function broadcastToPages(msg) {
    // Progress is best-effort: a page may not be open during a background
    // update, and that must never fail the install itself.
    try {
        self.clients.matchAll({ type: 'window' }).then(function (list) {
            list.forEach(function (client) {
                try { client.postMessage(msg); } catch (e) { /* detached */ }
            });
        }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
}

function precacheWithRetry(cache) {
    let done = 0;
    const total = FILES_TO_CACHE.length;
    return Promise.all(FILES_TO_CACHE.map(function (url) {
        return (async function () {
            let lastError = null;
            for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt++) {
                try {
                    const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
                    if (res && res.ok) {
                        await cache.put(url, res);
                        done++;
                        broadcastToPages({ type: 'ent-precache-progress', done: done, total: total, cacheName: CACHE_NAME });
                        return;
                    }
                    lastError = new Error('HTTP ' + (res ? res.status : '?') + ' for ' + url);
                } catch (err) {
                    lastError = err;
                }
            }
            throw lastError || new Error('could not cache ' + url);
        })();
    })).then(function () {
        console.log('[ServiceWorker] Pre-cached ' + total + ' offline resources');
    }, function (err) {
        console.error('[ServiceWorker] Pre-cache failed, keeping the old cache:', err);
        throw new Error('Offline pre-cache failed: ' + ((err && err.message) || err));
    });
}

self.addEventListener('install', (evt) => {
    evt.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[ServiceWorker] Pre-caching offline pages');
            return precacheWithRetry(cache);
        }).then(() => self.skipWaiting())
    );
});

// Activate service worker: replace only this app's previous versioned caches.
self.addEventListener('activate', (evt) => {
    evt.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME && key.indexOf('ent-report-system-v') === 0) {
                    console.log('[ServiceWorker] Removing old cache', key);
                    return caches.delete(key);
                }
            }));
        }).then(() => self.clients.claim())
    );
});

// =====================================================================
//  OFFLINE VERIFICATION (v36a)
//
//  A page asks the worker which of FILES_TO_CACHE are really in the
//  versioned cache. The answer needs NO NETWORK - caches.open/match work
//  while the radio is off - which is the whole point: a prepared device can
//  PROVE it is prepared in airplane mode, and an unprepared device reports
//  honestly instead of pretending. function/offlineReady.js shows
//  "Offline-ready" only when ok === true.
//
//  MessageChannel when the caller passed a port (targeted reply), else fall
//  back to evt.source so a plain postMessage still gets an answer.
// =====================================================================
self.addEventListener('message', (evt) => {
    const data = evt.data || {};
    if (data.type !== 'ent-verify-offline') return;

    const report = {
        type: 'ent-offline-report',
        cacheName: CACHE_NAME,
        total: FILES_TO_CACHE.length,
        missing: [],
        ok: false
    };

    const work = caches.open(CACHE_NAME)
        .then(function (cache) {
            return Promise.all(FILES_TO_CACHE.map(function (url) {
                return cache.match(url, { ignoreSearch: true }).then(function (hit) {
                    return hit ? null : url;
                });
            }));
        })
        .then(function (miss) {
            report.missing = miss.filter(Boolean);
            report.ok = report.missing.length === 0;
            return report;
        })
        .catch(function () { return report; });

    if (typeof evt.waitUntil === 'function') evt.waitUntil(work);
    work.then(function (result) {
        try {
            if (evt.ports && evt.ports[0]) evt.ports[0].postMessage(result);
            else if (evt.source) evt.source.postMessage(result);
        } catch (e) { /* the page went away; nothing to report to */ }
    });
});

// =====================================================================
//  Fetch strategy: NETWORK FIRST, cache as the offline fallback.
//
//  This used to be CACHE FIRST for every file, and that is a trap. A cached
//  admin.html is served forever, so a fixed admin.js never arrives with it,
//  and the page then boots against markup it does not have. It cost an
//  "unregister the service worker" step after almost every change, and the
//  failure presents as a broken app rather than as a stale one - which is
//  exactly how a page ends up looking like it "will not open".
//
//  Network first means you always get the file that is actually on the
//  server. The cache is still filled and still answers when there is no
//  connection, so the offline / installable behaviour this service worker
//  exists for is preserved. What is given up is the millisecond saved on a
//  repeat visit, which is worth nothing next to serving a page that
//  matches its own scripts.
// =====================================================================
const NETWORK_TIMEOUT_MS = 4000;

async function fetchWithTimeout(req) {
    let timer = null;
    try {
        return await Promise.race([
            fetch(req),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Network request timed out.')), NETWORK_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

async function matchCachedNavigation(req) {
    const exact = await caches.match(req, { ignoreSearch: true });
    if (exact) return exact;

    const requestedUrl = new URL(req.url);
    const scopeUrl = new URL(self.registration.scope);
    const scopePath = scopeUrl.pathname.replace(/\/+$/, '');
    const requestedPath = requestedUrl.pathname.replace(/\/+$/, '');
    const hasTrailingSlash = requestedUrl.pathname.endsWith('/');

    // Scope prefix used to test whether a navigation is within the worker's
    // scope, and to strip the scope when building candidate cache keys.
    //   - Root scope '/'  -> scopePath is '', prefix is '/'
    //   - Sub-path scope  -> scopePath is '/app', prefix is '/app/'
    const scopePrefix = scopePath === '' ? '/' : scopePath + '/';
    if (requestedPath !== scopePath && !requestedPath.startsWith(scopePrefix)) return null;

    const candidates = [];

    // Root: / or /index.html
    if (requestedPath === scopePath || requestedPath === scopePrefix + 'index.html') {
        candidates.push(new URL('index.html', scopeUrl).href);
    }
    // Trailing-slash directory: /pages/ -> /pages/index.html
    else if (hasTrailingSlash) {
        const rel = requestedPath.slice(scopePrefix.length);
        candidates.push(new URL(rel + 'index.html', scopeUrl).href);
    }
    // Clean URL without extension: /pages/nasalEndoscopy -> /pages/nasalEndoscopy.html
    else if (!/\.[^/]+$/.test(requestedPath)) {
        candidates.push(new URL(requestedPath.slice(scopePrefix.length) + '.html', scopeUrl).href);
    }
    // URL WITH .html that failed exact match: try the clean URL cache key too
    else if (/\.html?$/i.test(requestedPath)) {
        const rel = requestedPath.replace(/\.html?$/i, '').slice(scopePrefix.length);
        candidates.push(new URL(rel, scopeUrl).href);
    }

    for (const candidate of candidates) {
        const cached = await caches.match(candidate, { ignoreSearch: true });
        if (cached) return cached;
    }
    return null;
}

self.addEventListener('fetch', (evt) => {
    const req = evt.request;
    if (req.method !== 'GET') return;

    const isNav = req.mode === 'navigate';
    let sameOrigin = false;
    try { sameOrigin = new URL(req.url).origin === self.location.origin; }
    catch (e) { sameOrigin = false; }
    evt.respondWith((async function () {
        let fresh = null;
        let networkError = null;
        try {
            fresh = await fetchWithTimeout(req);
            // Refresh the cache from the copy we just received, so the next
            // offline load is still warm. Only successful same-origin GETs
            // are stored; an HTTP error is treated like a network failure so
            // it cannot replace a working offline copy.
            if (fresh && fresh.ok && sameOrigin) {
                const copy = fresh.clone();
                caches.open(CACHE_NAME)
                    .then(function (cache) { return cache.put(req, copy); })
                    .catch(function () { /* a full disk must not fail the page */ });
            }
            if (fresh && fresh.ok) return fresh;
        } catch (err) {
            networkError = err;
        }

        // Offline, slow connection, or an HTTP error: serve the cached
        // resource. ignoreSearch supports versioned script/style URLs.
        const cached = sameOrigin
            ? (isNav ? await matchCachedNavigation(req) : await caches.match(req, { ignoreSearch: true }))
            : null;
        if (cached) return cached;

        if (isNav) {
            const loginUrl = new URL('pages/login.html', self.registration.scope);
            const loginPage = await caches.match(loginUrl.href, { ignoreSearch: true });

            // A cold offline entry or uncached route must go to the cached
            // sign-in page rather than the browser's network error screen.
            if (loginPage) return Response.redirect(loginUrl.href, 302);
        }

        if (fresh) return fresh;
        throw networkError || new Error('Network request failed and no cached response exists.');
    })());
});
