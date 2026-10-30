import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = resolve(root, 'packages/shared/src/catalogue-seed.json');
const netherlandsPath = resolve(root, 'packages/shared/src/netherlands-2025-male.json');
const westernEuropePath = resolve(root, 'packages/shared/src/western-europe-2024-2025-male.json');
const westernCountriesPath = resolve(
  root,
  'packages/shared/src/western-countries-historical-male.json',
);
const outputPath = resolve(root, 'packages/shared/src/catalogue.json');
const baseSeed = JSON.parse(await readFile(seedPath, 'utf8'));
const netherlands = JSON.parse(await readFile(netherlandsPath, 'utf8'));
const westernEurope = JSON.parse(await readFile(westernEuropePath, 'utf8'));
const westernCountries = JSON.parse(await readFile(westernCountriesPath, 'utf8'));
const seed = [
  ...baseSeed,
  ...netherlands.names,
  ...westernEurope.names,
  ...westernCountries.names,
];
const normalize = (value) => value.normalize('NFC').trim().toLocaleLowerCase('en-US');

const male = seed.filter((name) => name.category === 'male');
const neutral = seed.filter((name) => name.category === 'neutral');
const normalized = seed.map((name) => normalize(name.displayName));
if (
  baseSeed.length !== 1500 ||
  netherlands.names.length !== 250 ||
  westernEurope.names.length !== 1000 ||
  westernCountries.names.length !== 99 ||
  seed.length !== 2849 ||
  male.length !== 2699 ||
  neutral.length !== 150
) {
  throw new Error(
    `Catalogue must contain 2,699 male and 150 neutral names; found ${male.length} and ${neutral.length}.`,
  );
}
if (new Set(normalized).size !== seed.length) {
  throw new Error('Catalogue seed contains normalized duplicate names.');
}

const records = seed
  .map(({ displayName, category }) => ({
    id: `builtin-${createHash('sha256').update(`${category}:${normalize(displayName)}`).digest('hex').slice(0, 16)}`,
    displayName: displayName.normalize('NFC').trim(),
    category,
  }))
  .sort((left, right) => left.displayName.localeCompare(right.displayName, 'en'));

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      version: '2026.4',
      generatedAt: '2026-09-05',
      sources: [
        {
          name: 'US Social Security Administration — Baby Names from Social Security Card Applications',
          url: 'https://www.ssa.gov/oact/babynames/limits.html',
          license: 'CC0 / US public-domain data',
        },
        {
          name: 'Office for National Statistics — Baby names in England and Wales',
          url: 'https://www.ons.gov.uk/peoplepopulationandcommunity/birthsdeathsandmarriages/livebirths/datasets/babynamesenglandandwalesbabynamesstatisticsboys',
          license: 'Open Government Licence v3.0; used for manual cross-checking',
        },
        {
          name: '@faker-js/faker European locale name datasets',
          url: 'https://fakerjs.dev/',
          license: 'MIT; used during the one-time regional balancing and review pass',
        },
        netherlands.source,
        ...westernEurope.sources,
        ...westernCountries.sources,
      ],
      names: records,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Generated ${records.length} reviewed names from the frozen sources.`);
