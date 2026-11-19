#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = path => readFileSync(join(root, path), 'utf8')
const migration = source('supabase-v2/migrations/0057_doctor_signatures.sql')
const signature = source('function/doctorSignature.js')
const printBuilder = source('function/index.js')
const printStyles = source('style/index.css')
const signatureStyles = source('style/doctor-signature.css')
const pages = [
  source('pages/nasalEndoscopy.html'),
  source('pages/laryngealEndoscopy.html')
]
const nonNameTokensSource = signature.match(/const NON_NAME_TOKENS = new Set\([\s\S]*?\n    \]\);/)
const nameTokenSources = [
  signature.match(/function nameTokens\(value\) \{[\s\S]*?\n    \}/),
  signature.match(/function normalizedName\(value\) \{[\s\S]*?\n    \}/),
  signature.match(/function personNameIdentity\(value\) \{[\s\S]*?\n    \}/),
  signature.match(/function namesMatch\(firstName, secondName\) \{[\s\S]*?\n    \}/)
]
assert.ok(nonNameTokensSource && nameTokenSources.every(Boolean), 'the surgeon-name matcher is available for behavior checks')
const namesMatch = runInNewContext(
  `(() => { ${nonNameTokensSource[0]} ${nameTokenSources.map(match => match[0]).join('\n')}; return namesMatch; })()`
)
assert.equal(
  namesMatch('JESUS RESURRECCION M. JARDIN, MD., FPSO, HNS', 'Jesus M Jardin'),
  true,
  'surgeon names should match when the form includes a full middle name and credentials'
)
assert.equal(
  namesMatch('Jardin, Jesus Resurreccion M., MD., FPSO-HNS', 'Jesus M Jardin'),
  true,
  'surname-first form labels should match the doctor profile'
)
assert.equal(
  namesMatch('Jesus Jardin', 'James Jardin'),
  false,
  'different given names must not share a signature'
)
const escapeHtmlSource = printBuilder.match(/function escapeHtml\(text\) \{[\s\S]*?\n    \}/)
const reportTextFormatterSource = printBuilder.match(/function formatReportText\(value\) \{[\s\S]*?\n    \}/)
assert.ok(escapeHtmlSource && reportTextFormatterSource, 'the safe report text formatter is available for behavior checks')
const formatReportText = runInNewContext(
  `(() => { ${escapeHtmlSource[0]} ${reportTextFormatterSource[0]}; return formatReportText; })()`
)
assert.equal(formatReportText('1\r\n2\n3'), '1<br>2<br>3')
assert.equal(formatReportText('<script>\n3'), '&lt;script&gt;<br>3')
const fitFunctionSource = printBuilder.match(/function fitPrintDocumentToPaper\(printDiv, paperMetrics\) \{[\s\S]*?\n    \}/)
assert.ok(fitFunctionSource, 'the selected-paper fit function is available for behavior checks')
const fitPrintDocumentToPaper = runInNewContext(
  `(() => { ${fitFunctionSource[0]}; return fitPrintDocumentToPaper; })()`,
  { window: { getComputedStyle: () => ({ fontSize: '12px' }) } }
)
const textElement = { style: {} }
const layout = { offsetTop: 300, offsetHeight: 700, style: {} }
const contentPanel = { style: {} }
const signatureSection = { style: {} }
const a4PrintableArea = { printableWidthPx: 748, printableHeightPx: 1068 }
let naturalContentHeightPx = 850
const reportPage = {
  style: {},
  querySelector: selector => ({
    '.print-layout-container': layout,
    '.print-content-panel': contentPanel,
    '.doctor-signature-section': signatureSection
  })[selector] || null,
  querySelectorAll: () => [textElement],
  get scrollHeight() {
    const fontScale = parseFloat(textElement.style.fontSize || '12px') / 12
    const layoutHeight = parseFloat(layout.style.minHeight || '0')
    return Math.max(
      parseFloat(this.style.minHeight || '0'),
      layout.offsetTop + Math.max(layoutHeight, naturalContentHeightPx * fontScale) + 10
    )
  },
  get offsetHeight() {
    return parseFloat(this.style.minHeight || '0')
  }
}
const printDiv = { querySelector: () => reportPage, style: {} }
const fittedFontScale = fitPrintDocumentToPaper(printDiv, a4PrintableArea)
assert.ok(fittedFontScale < 1, 'long report text should use a smaller font')
assert.ok(parseFloat(textElement.style.fontSize) < 12)
assert.equal(reportPage.style.transform, 'none', 'the A4 page itself must not be scaled')
assert.equal(reportPage.style.height, `${a4PrintableArea.printableHeightPx}px`)
assert.equal(printDiv.style.height, `${a4PrintableArea.printableHeightPx}px`)
assert.equal(signatureSection.style.marginTop, 'auto', 'the Surgeon block should stay at the bottom of the page')
assert.ok(parseFloat(layout.style.minHeight) > 0, 'the report layout should fill the printable height')
assert.equal(layout.style.minHeight, contentPanel.style.minHeight)

naturalContentHeightPx = 300
const shortReportFontScale = fitPrintDocumentToPaper(printDiv, a4PrintableArea)
assert.equal(shortReportFontScale, 1, 'short reports should keep their original font size')
assert.equal(signatureSection.style.marginTop, 'auto', 'short reports must keep the Surgeon block at the page bottom')
assert.ok(parseFloat(layout.style.minHeight) > 0, 'short reports should still fill the printable height')

const assertions = [
  ['one bounded PNG signature is stored per doctor account',
    /doctor_id\s+uuid\s+PRIMARY KEY REFERENCES public\.staff_profiles\(id\)/.test(migration)
      && /length\(signature_data_url\) <= 150000[\s\S]*?data:image\/png;base64/.test(migration)],
  ['signatures are RLS protected and never available to anon',
    migration.includes('ALTER TABLE public.doctor_signatures ENABLE ROW LEVEL SECURITY')
      && /REVOKE ALL ON TABLE public\.doctor_signatures FROM PUBLIC, anon, authenticated/.test(migration)
      && /GRANT ALL ON TABLE public\.doctor_signatures TO service_role/.test(migration)],
  ['only the active doctor can insert, update, or delete a signature',
    ['insert_own', 'update_own', 'delete_own'].every(name => {
      const policy = migration.match(new RegExp('CREATE POLICY doctor_signatures_' + name + '[\\s\\S]*?;'))
      return policy && policy[0].includes('doctor_id = public.ent_auth_uid()')
        && policy[0].includes("profile.role = 'doctor'")
        && policy[0].includes('profile.is_active')
    })],
  ['secretary read policy permits only the doctor owner or an assigned doctor',
    /CREATE POLICY doctor_signatures_select_assigned[\s\S]*?doctor_id = public\.ent_auth_uid\(\)[\s\S]*?public\.ent_is_my_doctor\(doctor_id\)/.test(migration)],
  ['secretaries resolve only assigned doctors and request signatures by doctor id',
    /auth\.fetchAssignedDoctors\(false, true\)/.test(signature)
      && /doctor_signatures\?select=signature_data_url&doctor_id=eq\./.test(signature)],
  ['surgeon names match despite order, punctuation, and medical credentials',
    /name\.normalize\('NFD'\)/.test(signature)
      && /NON_NAME_TOKENS\.has\(token\)/.test(signature)
      && /\.sort\(\)\s*\.join\(' '\)/.test(signature)
      && /namesMatch\(doctorName\(doctor\), surgeonName\)/.test(signature)
      && /compatibleMatches\.length === 1 \? compatibleMatches\[0\] : null/.test(signature)],
  ['only a matching logged-in doctor can manage a signature',
    /profile\.role !== 'doctor'[\s\S]*?scope\.role === 'doctor'[\s\S]*?scope\.doctorId/.test(signature)
      && /if \(!profileIsDoctor\(profile\)\) throw new Error\('Sign in with your own doctor account to save a signature\.'\)/.test(signature)],
  ['removing a saved signature uses the app confirmation modal above the signature pad',
    (() => {
      const deleteFunction = signature.match(/async function deleteSignature\(\) \{[\s\S]*?\n    \}/)
      return !!deleteFunction
        && /await bridge\.confirm\([\s\S]*?'Remove Saved Signature'[\s\S]*?zIndex: 20000/.test(deleteFunction[0])
        && !/\bwindow\.confirm\b/.test(deleteFunction[0])
        && /confirm: \(message, title, options\) => showCustomConfirmAsync\(message, title, options\)/.test(printBuilder)
        && /messageModal\.classList\.add\('confirmation-modal-front'\)/.test(printBuilder)
        && /#messageModal\.confirmation-modal-front\s*\{\s*z-index: 20000 !important/.test(printStyles)
        && pages.every(page => /doctorSignature\.js\?v=v5-remove-signature-confirm/.test(page)
          && /index\.js\?v=v37-signature-confirm-bridge/.test(page)
          && /index\.css\?v=v39-signature-confirm-front/.test(page))
    })()],
  ['opening the signature pad does not reference the preview request token',
    !/\brequest\b/.test(signature.slice(
      signature.indexOf('async function loadSavedSignature'),
      signature.indexOf('async function refreshPreview')
    ))],
  ['both endoscopy forms show an inline signature preview',
    pages.every(page => /id="doctorSignaturePreview"/.test(page)
      && /id="doctorSignaturePreviewImage"/.test(page)
      && /id="doctorSignaturePreviewStatus"/.test(page)
      && /Surgeon signature preview/.test(page))],
  ['signature buttons are grouped clearly and Set my signature uses the primary color',
    pages.every(page => /class="doctor-signature-manage-button"/.test(page)
      && /class="doctor-signature-tool-actions"/.test(page)
      && /class="doctor-signature-primary-actions"/.test(page)
      && /doctor-signature\.css\?v=v5-signature-action-layout/.test(page))
      && /doctor-signature-manage-button\s*\{[\s\S]*?background: linear-gradient\(135deg, var\(--primary-color/.test(signatureStyles)
      && /doctor-signature-actions #saveSignatureBtn/.test(signatureStyles)
      && /doctor-signature-actions \.btn-signature-danger/.test(signatureStyles)
      && /@media \(max-width: 520px\)[\s\S]*?doctor-signature-actions/.test(signatureStyles)],
  ['signature preview and printed signature are large enough to inspect',
    /max-width: min\(100%, 320px\)/.test(signatureStyles)
      && /max-height: 100px/.test(signatureStyles)
      && /max-width:220px;max-height:60px/.test(printBuilder)],
  ['preview refreshes when the surgeon changes and after saved reports load',
    /physician\.addEventListener\('change', function \(\) \{ refreshPreview\(true\); \}\)/.test(signature)
      && /EntDoctorSignature\.refresh\(\)/.test(printBuilder)],
  ['print resolves the selected surgeon and inserts the signature above the surgeon name',
    /resolveSurgeon\(surgeonName, profile\)[\s\S]*?readSignature\(doctor/.test(signature)
      && /signatureImage[\s\S]*?class="physician-name"/.test(printBuilder)
      && /EntDoctorSignature\.forSurgeon\(data\.physician\)/.test(printBuilder)],
  ['native and PDF printing default to A4 portrait without a header paper-size control and keep the hospital name on one line',
    pages.every(page => !page.includes('print-paper-size-control')
      && !/<option value="(?:Letter|Legal|A3|A5|Tabloid)"/.test(page))
      && /size: A4 portrait/.test(printStyles)
      && /const A4_PAGE_SIZE = \{ widthMm: 210, heightMm: 297 \}/.test(printBuilder)
      && /\.hospital-name-span\s*\{[\s\S]*?white-space: nowrap !important/.test(printStyles)
      && /adjustFontSizeToFit\(hospitalNameSpan(?:Native|ForPdf)?, textBlockContainer(?:Native|ForPdf)?, true\)/.test(printBuilder)],
  ['native and PDF output use only A4 with the same physical page dimensions',
    !/Letter: \{ widthMm:|Legal: \{ widthMm:|Tabloid: \{ widthMm:/.test(printBuilder)
      && /setNativePrintPaperFormat\(\)/.test(printBuilder)
      && /format: \[paperMetrics\.widthMm, paperMetrics\.heightMm\]/.test(printBuilder)],
  ['long report content flows instead of being clipped by fixed-height panels',
    /min-height: \$\{containerHeightPx\}px; overflow: visible/.test(printBuilder)
      && /\.print-content-panel\s*\{[\s\S]*?overflow: visible !important/.test(printStyles)
      && /\.print-layout-container\s*\{[\s\S]*?overflow: visible !important/.test(printStyles)
      && /height:auto;box-sizing:border-box;background-color:#ffffff;color:#111111;position:fixed;top:0;left:0;z-index:9999;overflow:visible/.test(printBuilder)
      && !/selectedImages\.filter\([\s\S]{0,100}\)\.slice\(0,\s*6\)/.test(printBuilder)
      && !/max-height:30%;[^`]*overflow:hidden/.test(printBuilder)],
  ['doctor-entered newlines stay on separate lines in every printed field',
    /function getNasalFindingsHtml[\s\S]*?formatReportText\(data\.septum\)/.test(printBuilder)
      && /function getLaryngealFindingsHtml[\s\S]*?formatReportText\(data\.epiglottis\)/.test(printBuilder)
      && /function buildReportSections[\s\S]*?formatReportText\(data\.preOpDiagnosis\)[\s\S]*?formatReportText\(data\.recommendation\)/.test(printBuilder)],
  ['long text shrinks to fit the fixed A4 page without scaling the page itself',
    /minimumFontScale = 0\.6/.test(printBuilder)
      && /fontElements\.forEach[\s\S]*?item\.fontSize \* fontScale/.test(printBuilder)
      && /reportPage\.style\.transform = 'none'/.test(printBuilder)
      && /signature\.style\.marginTop = 'auto'/.test(printBuilder)
      && (printBuilder.match(/fitPrintDocumentToPaper\(printDiv, paperMetrics\);/g) || []).length === 2],
  ['signature read failures stay visible without aborting the report print',
    /Could not load the saved signature for printing/.test(printBuilder)
      && /Unable to load the selected surgeon signature for printing/.test(printBuilder)],
  ['signature images are not copied into shared browser storage',
    !/localStorage\.(?:setItem|getItem)\([^)]*signature/i.test(signature)]
]

for (const [label, passed] of assertions) {
  assert.ok(passed, label)
  console.log(`  PASS  ${label}`)
}

for (const page of pages) {
  assert.match(page, /function\/doctorSignature\.js\?v=/)
  assert.match(page, /id="signatureModal"/)
  assert.match(page, /id="doctorSignatureStatus"/)
}

console.log(`\n==== DOCTOR SIGNATURE CHECKS PASSED — ${assertions.length + 6} passed ====`)
