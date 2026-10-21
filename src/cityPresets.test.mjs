import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const locations = fs.readFileSync(path.join(ROOT, 'src', 'locations.js'), 'utf8');
const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');

/** Top-level city IDs declared in CITY_POIS, in declaration order. */
function cityPoiIds() {
  const start = locations.indexOf('export const CITY_POIS = {');
  assert.ok(start >= 0, 'CITY_POIS declaration is missing');
  const end = locations.indexOf('\n};', start);
  assert.ok(end > start, 'could not bound CITY_POIS');
  return [...locations.slice(start, end).matchAll(/^ {2}([a-z_]+): \{$/gm)].map((match) => match[1]);
}

test('voice tool locationId enums list every CITY_POIS preset', () => {
  // The realtime tool schemas live server-side in vite.config.js and cannot
  // import locations.js, so a new city preset must be added there by hand.
  const ids = cityPoiIds();
  assert.ok(ids.length >= 8, `expected the city presets, found ${ids.join(', ')}`);
  const enums = [...viteConfig.matchAll(/locationId: \{\s*type: 'string',\s*enum: \[([^\]]*)\]/g)]
    .map((match) => match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')).filter(Boolean));
  assert.ok(enums.length >= 3, 'expected the fly_to_location, select_nearest_aircraft and radio locationId enums');
  for (const values of enums) {
    assert.deepEqual([...values].sort(), [...ids].sort());
  }
});

test('every city preset fits the five QWERTY POI hotkeys and its own view bounds', () => {
  const ids = cityPoiIds();
  for (const id of ids) {
    const start = locations.indexOf(`\n  ${id}: {`);
    const end = locations.indexOf('\n  },', start);
    const block = locations.slice(start, end);
    const bounds = block.match(/southwest: \{ lat: ([-\d.]+), lng: ([-\d.]+) \}, northeast: \{ lat: ([-\d.]+), lng: ([-\d.]+) \}/);
    assert.ok(bounds, `${id} is missing viewBounds`);
    const [south, west, north, east] = bounds.slice(1).map(Number);
    const pois = [...block.matchAll(/lat: ([-\d.]+), lon: ([-\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
    assert.ok(pois.length >= 1 && pois.length <= 5, `${id} has ${pois.length} POIs; Q W E R T bind at most five`);
    for (const [lat, lon] of pois) {
      assert.ok(lat >= south && lat <= north && lon >= west && lon <= east, `${id} POI ${lat},${lon} sits outside its viewBounds`);
    }
  }
});
