import { inflateRawSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseSeedPath = resolve(root, 'packages/shared/src/catalogue-seed.json');
const netherlandsPath = resolve(root, 'packages/shared/src/netherlands-2025-male.json');
const outputPath = resolve(root, 'packages/shared/src/western-europe-2024-2025-male.json');
const selectionCount = 1000;
const sources = {
  belgium: {
    name: 'Statbel — voornamen van jongens geboren in België in 2025',
    pageUrl:
      'https://statbel.fgov.be/nl/themas/bevolking/namen-en-voornamen/voornamen-van-meisjes-en-jongens',
    dataUrl:
      'https://statbel.fgov.be/sites/default/files/files/documents/bevolking/5.10%20Namen%20en%20voornamen/5.10.%203%20Voornamen%20meisjes%20en%20jongens/Voornamen_Jongens_1995-.xlsx',
    license: 'Official public statistical publication; mandatory Statbel attribution retained',
  },
  spain: {
    name: 'Instituto Nacional de Estadística — nombres de recién nacidos en España, 2024',
    pageUrl:
      'https://www.ine.es/dyngs/INEbase/operacion.htm?c=Estadistica_C&cid=1254736177009&idp=1254735572981&menu=resultados',
    dataUrl: 'https://www.ine.es/daco/daco42/nombyapel/nomnac24.xlsx',
    license: 'Official public statistical publication; source attribution retained',
  },
  italy: {
    name: 'Istat — nomi più diffusi tra i bambini nati nel 2024',
    pageUrl: 'https://www.istat.it/dati/calcolatori/contanomi/',
    dataUrl:
      'https://www.istat.it/wp-content/themes/EGPbs5-child/contanomi/nati/index2022.php?type=list&limit=50&year=2024&callback=callback',
    license: 'Official public statistical publication; source attribution retained',
  },
  france: {
    name: 'Insee — fichier national des prénoms, millésime 2024',
    pageUrl: 'https://www.insee.fr/fr/statistiques/8894961?sommaire=8894974',
    dataUrl:
      'https://www.insee.fr/fr/statistiques/fichier/8894961/prenoms-2024-nat_csv.zip',
    license: 'Licence Ouverte / Open Licence 2.0 (Etalab)',
  },
};

const normalize = (value) => value.normalize('NFC').trim().toLocaleLowerCase('en-US');
const titleCase = (value, locale) =>
  value
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase(locale)
    .replace(/(^|[-'’ .])(\p{L})/gu, (_, prefix, letter) =>
      `${prefix}${letter.toLocaleUpperCase(locale)}`,
    );

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'BabyNameMatcher catalogue importer/1.0' },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function readZip(buffer) {
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Downloaded file is not a supported ZIP archive.');

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP central directory is invalid.');
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP entry ${fileName} has an invalid local header.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const contents =
      compression === 0
        ? compressed
        : compression === 8
          ? inflateRawSync(compressed)
          : undefined;
    if (!contents) throw new Error(`ZIP entry ${fileName} uses unsupported compression ${compression}.`);
    if (contents.length !== uncompressedSize) {
      throw new Error(`ZIP entry ${fileName} did not expand to its declared size.`);
    }
    entries.set(fileName.replaceAll('\\', '/'), contents);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function workbookRows(buffer, sheetName) {
  const entries = readZip(buffer);
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const relationships = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !relationships) throw new Error('Workbook metadata is missing.');

  const sheet = [...workbook.matchAll(/<sheet\b([^>]*)\/>/g)].find((match) => {
    const name = match[1].match(/\bname="([^"]+)"/)?.[1];
    return name && decodeXml(name) === sheetName;
  });
  const relationshipId = sheet?.[1].match(/\br:id="([^"]+)"/)?.[1];
  if (!relationshipId) throw new Error(`Workbook sheet ${sheetName} is missing.`);
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*)\/>/g)].find(
    (match) => match[1].match(/\bId="([^"]+)"/)?.[1] === relationshipId,
  );
  const target = relationship?.[1].match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) throw new Error(`Workbook relationship for ${sheetName} is missing.`);
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const worksheet = entries.get(sheetPath)?.toString('utf8');
  if (!worksheet) throw new Error(`Workbook data for ${sheetName} is missing.`);

  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sharedStrings = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeXml(
      [...match[1].matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((text) => text[1])
        .join(''),
    ),
  );

  return [...worksheet.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map(
    (row) => ({
      row: Number(row[1]),
      cells: Object.fromEntries(
        [...row[2].matchAll(/<c\b[^>]*r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)].map(
          (cell) => {
            const raw = cell[3].match(/<v>(.*?)<\/v>/)?.[1];
            const inline = cell[3].match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/)?.[1];
            const value = cell[2].includes('t="s"')
              ? sharedStrings[Number(raw)]
              : inline === undefined
                ? raw
                : decodeXml(inline);
            return [cell[1], value];
          },
        ),
      ),
    }),
  );
}

function parseBelgium(buffer) {
  return workbookRows(buffer, '2025')
    .filter(({ cells }) => /^\d+$/.test(cells.A ?? '') && cells.B && /^\d+$/.test(cells.C ?? ''))
    .map(({ cells }) => ({
      displayName: cells.B.normalize('NFC').trim(),
      rank: Number(cells.A),
      count: Number(cells.C),
    }))
    .filter((name) => name.rank <= 100)
    .sort((left, right) => left.rank - right.rank);
}

function parseSpain(buffer) {
  return workbookRows(buffer, 'TOTAL')
    .filter(
      ({ row, cells }) =>
        row >= 5 &&
        cells.A &&
        /^[A-ZÁÉÍÓÚÜÑ]+(?:[ '-][A-ZÁÉÍÓÚÜÑ]+)*$/u.test(cells.A) &&
        /^\d+$/.test(cells.B ?? ''),
    )
    .map(({ cells }, index) => ({
      displayName: titleCase(cells.A, 'es-ES'),
      rank: index + 1,
      count: Number(cells.B),
    }))
    .slice(0, 100);
}

function parseItaly(buffer) {
  const jsonp = buffer.toString('utf8').trim();
  const open = jsonp.indexOf('(');
  const close = jsonp.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error('Italian name response was not valid JSONP.');
  const payload = JSON.parse(jsonp.slice(open + 1, close));
  const displayOverrides = new Map([["NICOLO'", 'Nicolò']]);
  return Object.entries(payload)
    .filter(([key, value]) => key !== 'years' && Array.isArray(value))
    .flatMap(([, value]) => value)
    .filter((name) => name.gender === 'm' && name.year === 2024)
    .map((name, index) => ({
      displayName: displayOverrides.get(name.name) ?? titleCase(name.name, 'it-IT'),
      rank: index + 1,
      count: Number(name.count),
    }))
    .slice(0, 50);
}

function parseFrance(buffer) {
  const entries = readZip(buffer);
  const csvEntry = [...entries.entries()].find(([fileName]) => fileName.toLowerCase().endsWith('.csv'));
  if (!csvEntry) throw new Error('French name archive did not contain a CSV file.');
  const totals = new Map();
  for (const line of csvEntry[1].toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1)) {
    const [sex, rawName, year, rawCount] = line.split(';');
    if (sex !== '1' || Number(year) < 2020 || Number(year) > 2024 || !rawName) continue;
    totals.set(rawName, (totals.get(rawName) ?? 0) + Number(rawCount));
  }
  return [...totals]
    .map(([rawName, count]) => ({ displayName: titleCase(rawName, 'fr-FR'), count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.displayName.localeCompare(right.displayName, 'fr'),
    )
    .map((name, index) => ({ ...name, rank: index + 1 }));
}

const [baseSeed, netherlands, belgianData, spanishData, italianData, frenchData] = await Promise.all([
  readFile(baseSeedPath, 'utf8').then(JSON.parse),
  readFile(netherlandsPath, 'utf8').then(JSON.parse),
  download(sources.belgium.dataUrl),
  download(sources.spain.dataUrl),
  download(sources.italy.dataUrl),
  download(sources.france.dataUrl),
]);
const existing = new Set(
  [...baseSeed, ...netherlands.names].map((name) => normalize(name.displayName)),
);
const selected = new Map();

function consider(names, country, year, limit = Number.POSITIVE_INFINITY) {
  for (const name of names) {
    const key = normalize(name.displayName);
    if (existing.has(key)) continue;
    const popularity = { country, year, rank: name.rank, birthCount: name.count };
    const found = selected.get(key);
    if (found) {
      found.popularity.push(popularity);
    } else if (selected.size < limit) {
      selected.set(key, {
        displayName: name.displayName,
        category: 'male',
        selectedFrom: country,
        popularity: [popularity],
      });
    }
  }
}

consider(parseBelgium(belgianData), 'Belgium', 2025);
consider(parseItaly(italianData), 'Italy', 2024);
consider(parseSpain(spanishData), 'Spain', 2024);
consider(parseFrance(frenchData), 'France', '2020–2024', selectionCount);

if (selected.size !== selectionCount) {
  throw new Error(`Expected ${selectionCount} missing Western European names; found ${selected.size}.`);
}
const names = [...selected.values()];
if (new Set(names.map((name) => normalize(name.displayName))).size !== names.length) {
  throw new Error('The selected Western European names contain a normalized duplicate.');
}
const contributionCounts = Object.fromEntries(
  ['Belgium', 'Italy', 'Spain', 'France'].map((country) => [
    country,
    names.filter((name) => name.selectedFrom === country).length,
  ]),
);
const selectedFrenchCounts = names
  .filter((name) => name.selectedFrom === 'France')
  .map(
    (name) =>
      name.popularity.find((popularity) => popularity.country === 'France')?.birthCount,
  )
  .filter((count) => count !== undefined);

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      sources: Object.values(sources).map(({ dataUrl: _dataUrl, pageUrl, ...source }) => ({
        ...source,
        url: pageUrl,
      })),
      selection: {
        selected: selectionCount,
        method:
          'Missing names from the Belgium 2025 and Spain 2024 national top 100 lists and the Italy 2024 national top 50, followed by the highest-frequency missing male names aggregated across France 2020–2024 until 1,000 unique additions were selected',
        contributionCounts,
        minimumFiveYearBirthCountForNamesSelectedFromFrance: Math.min(...selectedFrenchCounts),
      },
      names,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(
  `Selected ${names.length} additional names (${Object.entries(contributionCounts)
    .map(([country, count]) => `${country}: ${count}`)
    .join(', ')}; minimum selected French five-year count: ${Math.min(...selectedFrenchCounts)}).`,
);
