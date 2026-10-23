/* temp/patch_dbdelete.mjs — swap direct PATCH soft-delete for the RPC.
   Anchors on the EXACT live text (dumped from the file), LF-normalised,
   then restores the file's own EOL. */
import fs from 'node:fs'
const p = 'function/dbRecords.js'
const orig = fs.readFileSync(p, 'utf8')
const eol = orig.includes('\r\n') ? '\r\n' : '\n'
let t = orig.replace(/\r\n/g, '\n')

const oldBlock =
`            const res = await window.EntSupabase.apiRequest(
                'reports?' + target + '&deleted_at=is.null',
                {
                    method: 'PATCH',
                    headers: { 'Prefer': 'return=representation' },
                    body: JSON.stringify({
                        deleted_at: new Date().toISOString(),
                        deleted_by: currentUserId() || null,
                        deleted_reason: 'Deleted from DB Records'
                    })
                });
            // An empty array is PostgREST's "no row matched" - the policy
            // said no (or the row was already deleted). Saying "deleted"
            // over that would be a lie the user discovers later.
            if (!Array.isArray(res) || !res.length) {
                throw new Error('the server refused the delete - you may not have access to this record');
            }`

const newBlock =
`            // 0045: route the soft delete through the SECURITY DEFINER RPC.
            // A direct PATCH of deleted_at was refused (42501) even on a
            // permissive policy whose predicate answered true - the two
            // OR-ed UPDATE policies could not be made to agree from the
            // policy side. The RPC re-checks the SAME ent_may_soft_delete
            // predicate server-side and stamps deleted_by from the JWT, so
            // this is not a security change, only a reliable door.
            const res = await window.EntSupabase.apiRequest(
                'rpc/ent_soft_delete_report',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ p_id: record.id })
                });
            if (!res || res.ok !== true) {
                throw new Error((res && res.error) || 'the server refused the delete - you may not have access to this record');
            }`

if (!t.includes(oldBlock)) {
  console.log('OLD BLOCK NOT FOUND — aborting.')
  const i = t.indexOf("'reports?' + target")
  console.log('context:', JSON.stringify(t.slice(i - 30, i + 140)))
  process.exit(1)
}
t = t.replace(oldBlock, newBlock)
fs.writeFileSync(p, eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t)
console.log('PATCHED. rpc/ent_soft_delete_report occurrences:',
  (t.match(/rpc\/ent_soft_delete_report/g) || []).length)
