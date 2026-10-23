/* temp/patch_restore.mjs — swap both direct-PATCH restores for the
   ent_restore_report RPC (migration 0045). dbRecords.js + admin.js. */
import fs from 'node:fs'

function patchFile(p, oldBlock, newBlock, label) {
  const orig = fs.readFileSync(p, 'utf8')
  const eol = orig.includes('\r\n') ? '\r\n' : '\n'
  const t = orig.replace(/\r\n/g, '\n')
  if (!t.includes(oldBlock)) { console.log(label + ': OLD NOT FOUND — skip'); return false }
  const out = t.replace(oldBlock, newBlock)
  fs.writeFileSync(p, eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out)
  console.log(label + ': PATCHED')
  return true
}

// ---- dbRecords.js restore ----
patchFile('function/dbRecords.js',
`            const res = await window.EntSupabase.apiRequest(
                'reports?id=eq.' + encodeURIComponent(id) + '&deleted_at=not.null',
                {
                    method: 'PATCH',
                    headers: { 'Prefer': 'return=representation' },
                    body: JSON.stringify({ deleted_at: null, deleted_by: null, deleted_reason: '' })
                });
            if (!Array.isArray(res) || !res.length) {
                throw new Error('the server refused the restore - you may not have access to this record');
            }`,
`            // 0045: restore through the SECURITY DEFINER RPC (mirror of the
            // delete) - the direct PATCH hit the same 42501 the delete did.
            const res = await window.EntSupabase.apiRequest(
                'rpc/ent_restore_report',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ p_id: id })
                });
            if (!res || res.ok !== true) {
                throw new Error((res && res.error) || 'the server refused the restore - you may not have access to this record');
            }`,
'dbRecords.js restore')

// ---- admin.js restore ----
patchFile('function/admin.js',
`            const res = await api('reports?id=eq.' + encodeURIComponent(id), {
                method: 'PATCH',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    deleted_at: null,
                    deleted_by: null,
                    deleted_reason: ''
                })
            });
            if (!Array.isArray(res) || !res.length) {
                throw new Error('the server returned nothing to restore');
            }`,
`            // 0045: restore through the SECURITY DEFINER RPC (mirror of the
            // delete) - the direct PATCH hit the same 42501 the delete did.
            const res = await api('rpc/ent_restore_report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_id: id })
            });
            if (!res || res.ok !== true) {
                throw new Error((res && res.error) || 'the server returned nothing to restore');
            }`,
'admin.js restore')
