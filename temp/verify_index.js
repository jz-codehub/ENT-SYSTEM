// Verification for the index.js surgery (runs after temp/fix_index.js).
const fs = require('fs');
const lines = fs.readFileSync('function/index.js', 'utf8').split(/\r?\n/);

function show(title, from, to) {
    console.log('=== ' + title + ' ===');
    for (let i = from; i <= to && i < lines.length; i++) {
        console.log((i + 1) + ': ' + lines[i]);
    }
}

const idxCatchLine = lines.findIndex((l) => l.includes('}).catch(async (htmlError) => {'));
show('PDF .catch region (repaired)', idxCatchLine - 7, idxCatchLine + 14);

console.log('=== structure checks ===');
const html2Close = lines.findIndex((l, i) => i > idxCatchLine && l === '                                });');
console.log('html2canvas call close at line ' + (html2Close + 1) + ': ' + lines[html2Close]);
console.log('next line (must be clearTimeout): ' + (html2Close + 2) + ': ' + lines[html2Close + 1]);

console.log('=== EOF tail ===');
for (let i = lines.length - 22; i < lines.length; i++) console.log((i + 1) + ': ' + lines[i]);

console.log('=== references ===');
lines.forEach((l, i) => {
    if (l.includes('closeOfflineRecordsModal') || l.includes('close: closeOfflineModal') ||
        l.includes('OFFLINE RECORDS VIEWER') || l.includes('catch (canvasError)')) {
        console.log((i + 1) + ': ' + l.trim());
    }
});
console.log('total lines: ' + lines.length);
