import { readFileSync, writeFileSync } from 'node:fs'
const p = 'c:/Users/USER/Documents/Web Development/ENT-SYSTEM/function/dashboard.js'
let c = readFileSync(p, 'utf8')

const oldTiles = `        const tiles = [
            { cls: 'ent-tile-today', label: 'Today', bucket: data.today, key: 'today' },
            { cls: 'ent-tile-week', label: 'This Week', bucket: data.week, key: 'week' },
            { cls: 'ent-tile-month', label: 'This Month', bucket: data.month, key: 'month' },
            { cls: 'ent-tile-year', label: 'This Year', bucket: data.year, key: 'year' }
        ];`

const newTiles = `        const tiles = [
            { cls: 'ent-tile-today', icon: '\uD83D\uDCC5', label: 'Today', bucket: data.today, key: 'today' },
            { cls: 'ent-tile-week', icon: '\uD83D\uDCC8', label: 'This Week', bucket: data.week, key: 'week' },
            { cls: 'ent-tile-month', icon: '\uD83D\uDCCA', label: 'This Month', bucket: data.month, key: 'month' },
            { cls: 'ent-tile-year', icon: '\uD83C\uDFC6', label: 'This Year', bucket: data.year, key: 'year' }
        ];`

if (!c.includes(oldTiles)) { console.error('TILES NOT FOUND'); process.exit(1) }
c = c.replace(oldTiles, newTiles)

const oldBody = `            const n = tile.bucket.patientCount;
            return '<div class="ent-tile ' + tile.cls + '">'
                + '<div class="ent-tile-label">' + esc(tile.label) + '</div>'
                + '<div class="ent-tile-n">' + n
                + '<small>' + (n === 1 ? 'patient' : 'patients') + '</small></div>'
                + '<div class="ent-tile-sub">' + esc(tileSub(tile.bucket)) + '</div>'`

const newBody = `            const n = tile.bucket.patientCount;
            return '<div class="ent-tile ' + tile.cls + '">'
                + '<div class="ent-tile-top">'
                + '<span class="ent-tile-icon" aria-hidden="true">' + tile.icon + '</span>'
                + '<span class="ent-tile-label">' + esc(tile.label) + '</span>'
                + '</div>'
                + '<div class="ent-tile-n" data-count="0">' + n
                + '<small>' + (n === 1 ? 'patient' : 'patients') + '</small></div>'
                + '<div class="ent-tile-sub">' + esc(tileSub(tile.bucket)) + '</div>'`

if (!c.includes(oldBody)) { console.error('BODY NOT FOUND'); process.exit(1) }
c = c.replace(oldBody, newBody)

const oldFoot = `        }).join('');

        const foot = byId('dashStatsFoot');`
const newFoot = `        }).join('');

        // Count-up the big numbers (presentational only). data-count holds the
        // target; countUp() rolls the visible text toward it and stores it back
        // so the next refresh animates from where it landed.
        requestAnimationFrame(function () {
            const numEls = box.querySelectorAll('.ent-tile-n');
            tiles.forEach(function (tile, i) {
                if (numEls[i]) countUp(numEls[i].firstChild, tile.bucket.patientCount);
            });
        });

        const foot = byId('dashStatsFoot');`
if (!c.includes(oldFoot)) { console.error('FOOT NOT FOUND'); process.exit(1) }
c = c.replace(oldFoot, newFoot)

writeFileSync(p, c)
console.log('tiles patched')
