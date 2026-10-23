// Repairs function/index.js: another tool pasted an OFFLINE RECORDS VIEWER
// IIFE + a bogus "catch (canvasError) {...});" into the middle of the PDF
// html2canvas fallback try/catch, which makes the whole file fail to parse
// (SyntaxError: Unexpected token 'catch' at the far "catch (err)").
// Fix: delete the intrusion, restore the .catch indentation, and re-append
// the (self-contained) IIFE at the very end of the file, top level.
// Also fixes its `close: closeOfflineRecordsModal` -> `closeOfflineModal`.
const fs = require('fs');
const FILE = 'function/index.js';

let source = fs.readFileSync(FILE, 'utf8');
const hadCR = source.includes('\r\n');
const lines = source.replace(/\r\n/g, '\n').split('\n');
const originalCount = lines.length;

function fail(msg) { console.error('ABORT: ' + msg); process.exit(1); }

// --- locate markers -----------------------------------------------------
const idxCatch = lines.findIndex((l) => l === '                            } catch (canvasError) {');
if (idxCatch < 0) fail('start marker "} catch (canvasError) {" not found');

const idxViewer = lines.findIndex((l, i) => i > idxCatch && l.includes('OFFLINE RECORDS VIEWER'));
if (idxViewer < 0) fail('OFFLINE RECORDS VIEWER comment not found');
// include both banner comment lines above/around it
let iifeStart = idxViewer;
while (iifeStart - 1 >= 0 && lines[iifeStart - 1].trim().startsWith('//')) iifeStart--;

const idxIifeFn = lines.findIndex((l, i) => i > iifeStart && l === '(function (window) {');
if (idxIifeFn < 0) fail('IIFE opening "(function (window) {" not found');
const idxIifeEnd = lines.findIndex((l, i) => i > idxIifeFn && l === '})(window);');
if (idxIifeEnd < 0) fail('IIFE closing "})(window);" not found');

// --- sanity: what we are about to cut out -------------------------------
// Between the html2canvas call close and the banner there must only be the
// 4 intruded lines + 1 blank line:
const between = lines.slice(idxCatch + 1, iifeStart);
if (between.length !== 4 && between.length !== 5) {
    fail('unexpected lines between catch block and IIFE: ' + JSON.stringify(between));
}
if (lines[idxCatch - 1] !== '                                });') {
    fail('line before catch block is not the html2canvas close: ' + JSON.stringify(lines[idxCatch - 1]));
}
if (lines[idxIifeEnd + 1] !== '                                clearTimeout(safetyTimeout);') {
    fail('line after IIFE is not the original continuation: ' + JSON.stringify(lines[idxIifeEnd + 1]));
}

// --- extract the IIFE (banner comment .. closing "})(window);") ---------
const iifeLines = lines.slice(iifeStart, idxIifeEnd + 1);

// --- delete the intrusion (bogus catch block .. end of IIFE) ------------
lines.splice(idxCatch, idxIifeEnd + 1 - idxCatch);

// --- restore the de-indented ".catch" line (was 24 spaces at HEAD) ------
const idxCatchLine = lines.findIndex((l) => l === '}).catch(async (htmlError) => {');
if (idxCatchLine < 0) fail('de-indented ".catch" line not found');
lines[idxCatchLine] = '                        }).catch(async (htmlError) => {';

// --- fix the undefined `closeOfflineRecordsModal` reference -------------
let iifeText = iifeLines.join('\n');
const before = iifeText;
iifeText = iifeText.replace('close: closeOfflineRecordsModal', 'close: closeOfflineModal');
if (iifeText === before) fail('closeOfflineRecordsModal reference not found inside IIFE');

// --- append the IIFE at end of file, top level --------------------------
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
lines.push('');
lines.push('');
for (const l of iifeLines.length ? iifeText.split('\n') : []) lines.push(l);
lines.push('');

let out = lines.join('\n');
if (hadCR) out = out.replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, out, 'utf8');

console.log('original lines: ' + originalCount);
console.log('new lines:      ' + lines.length);
console.log('removed:        ' + (idxIifeEnd + 1 - idxCatch) + ' (bogus catch + IIFE)');
console.log('re-appended:    ' + iifeText.split('\n').length + ' lines at EOF');
console.log('OK');
