/* temp/probe_select.mjs - READ-ONLY syntax probe.
   Asks PostgREST (anon key) whether chained json operators are accepted in
   `select=`. RLS may return 0 rows - a 200 still proves the SELECT parsed;
   a 400 proves the expression is invalid. */
const URL_BASE = 'https://mkyxtlfapoiboxepkxdz.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXBreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

const tests = {
  baseline_dbSaved: 'reports?select=id,payload->>dbSaved&limit=1',
  chained_nested: 'reports?select=id,payload->formData->>preOpDiagnosis&limit=1',
  chained_nested_json: 'reports?select=id,payload->formData->impression&limit=1',
  payload_docWork: 'reports?select=id,payload->>docWork&limit=1',
  double_arrow_first: 'reports?select=id,payload->>formData&limit=1',
}

for (const [name, q] of Object.entries(tests)) {
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${q}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }
    })
    const text = await res.text()
    console.log(`${name}: HTTP ${res.status} :: ${text.slice(0, 300)}`)
  } catch (e) {
    console.log(`${name}: FETCH ERROR :: ${e.message}`)
  }
}
