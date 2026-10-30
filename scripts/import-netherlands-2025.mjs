import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = resolve(root, 'packages/shared/src/catalogue-seed.json');
const outputPath = resolve(root, 'packages/shared/src/netherlands-2025-male.json');
const sourceUrl = 'https://www.svb.nl/nl/media/jongensnamen-2025-10-populair-json.txt';
const sourcePage = 'https://www.svb.nl/nl/kindernamen/namen/jongens-populariteit';
const additionCount = 250;
const normalize = (value) => value.normalize('NFC').trim().toLocaleLowerCase('nl-NL');

const baseSeed = JSON.parse(await readFile(seedPath, 'utf8'));
const response = await fetch(sourceUrl, {
  headers: {
    accept: 'application/json,text/plain,*/*',
    referer: sourcePage,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  },
});
if (!response.ok) {
  throw new Error(`SVB name data returned HTTP ${response.status}.`);
}

const payload = await response.json();
if (!Array.isArray(payload.data)) {
  throw new Error('SVB name data did not contain the expected data array.');
}

const existing = new Set(baseSeed.map((name) => normalize(name.displayName)));
const additions = payload.data
  .map((row) => {
    if (
      !Array.isArray(row) ||
      typeof row[0] !== 'string' ||
      typeof row[1] !== 'number' ||
      typeof row[2] !== 'number'
    ) {
      throw new Error('SVB name data contained an invalid row.');
    }
    return {
      displayName: row[0].normalize('NFC').trim(),
      category: 'male',
      popularityRank: row[2],
      birthCount: row[1],
    };
  })
  .filter((name) => !existing.has(normalize(name.displayName)))
  .sort(
    (left, right) =>
      left.popularityRank - right.popularityRank ||
      left.displayName.localeCompare(right.displayName, 'nl'),
  )
  .slice(0, additionCount);

if (additions.length !== additionCount) {
  throw new Error(`Expected ${additionCount} missing Dutch names; found ${additions.length}.`);
}
if (new Set(additions.map((name) => normalize(name.displayName))).size !== additions.length) {
  throw new Error('The selected Dutch names contain a normalized duplicate.');
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      source: {
        name: 'Sociale Verzekeringsbank — populairste jongensnamen van 2025',
        url: sourcePage,
        license: 'Official public statistical publication; source attribution retained',
      },
      selection: {
        year: 2025,
        selected: additionCount,
        method: 'The 250 highest-ranked SVB boy names not already present in the base catalogue',
        minimumPublishedFrequency: 10,
      },
      names: additions,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const finalEntry = additions.at(-1);
console.log(
  `Selected ${additions.length} additional Dutch names (through SVB rank ${finalEntry.popularityRank}, ${finalEntry.birthCount} births).`,
);
