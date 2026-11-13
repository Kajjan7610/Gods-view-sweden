#!/usr/bin/env node
/**
 * Keep SVERIGE.md's "Källor och omfattning per lager" in step with the table
 * the Data Layers panel reads (src/ui/layerProvenance.js): the section is
 * written from that table, in Swedish, between its two marker comments.
 *
 * Usage (repo root):
 *   node scripts/sweden-sources.mjs          rewrite the section
 *   node scripts/sweden-sources.mjs --check  fail if it is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const START = '<!-- källor:start (scripts/sweden-sources.mjs) -->';
export const END = '<!-- källor:end -->';

const cell = (text) => String(text).replace(/\|/g, '\\|');

/**
 * The section's Markdown.
 * @param {object} provenance LAYER_PROVENANCE.
 * @param {object} names Layer ids to their English names.
 * @param {object} sv The Swedish catalog (English to Swedish).
 */
export function renderSwedenSources(provenance, names, sv) {
  const tr = (text) => sv[text] || text;
  const rows = Object.entries(provenance)
    // A hidden layer is not in the app's list, so not in the table either.
    .filter(([, entry]) => !entry.hidden)
    .map(([id, entry]) => {
    const name = tr(names[id] || id);
    const scope =
      entry.mark === 'se'
        ? tr(entry.coverage)
        : `${tr(entry.sweden)}. Originalet: ${tr(entry.original)}`;
    return `| ${entry.mark === 'se' ? 'SE' : '+SE'} | ${cell(name)} | ${cell(entry.source)} | ${cell(scope)} | ${cell(tr(entry.updates))} | ${cell(tr(entry.licence))} |`;
  });
  return [
    START,
    '',
    'Genereras ur `src/ui/layerProvenance.js`, samma tabell som Datalager visar',
    'under ⓘ. SE = vårt eget lager; +SE = originalets lager där vi lagt till',
    'svenska data. Ändra i tabellen och kör `node scripts/sweden-sources.mjs`.',
    '',
    '| | Lager | Källa | Omfattning | Uppdateras | Licens |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    END,
  ].join('\n');
}

/** SVERIGE.md with the section rewritten, or null when the markers are missing. */
export function withSwedenSources(markdown, section) {
  const from = markdown.indexOf(START);
  const to = markdown.indexOf(END);
  if (from < 0 || to < from) return null;
  return markdown.slice(0, from) + section + markdown.slice(to + END.length);
}

async function main() {
  // The table's module translates through the app's i18n; in Node it keeps
  // the English source text, which the Swedish catalog then translates.
  await import('../src/testSupport/registerDom.mjs');
  const { LAYER_PROVENANCE } = await import('../src/ui/layerProvenance.js');
  const { LAYER_NAME_KEYS, PANEL_LABEL_KEYS } = await import(
    '../src/ui/layerNames.js'
  );
  const sv = JSON.parse(
    readFileSync(path.join(ROOT, 'src/i18n/locales/sv.json'), 'utf8'),
  );
  const file = path.join(ROOT, 'SVERIGE.md');
  const markdown = readFileSync(file, 'utf8');
  const section = renderSwedenSources(
    LAYER_PROVENANCE,
    { ...LAYER_NAME_KEYS, ...PANEL_LABEL_KEYS },
    sv,
  );
  const next = withSwedenSources(markdown, section);
  if (next === null) throw new Error(`SVERIGE.md lacks ${START} … ${END}`);
  if (process.argv.includes('--check')) {
    if (next !== markdown) {
      console.error('SVERIGE.md: run node scripts/sweden-sources.mjs');
      process.exit(1);
    }
    console.log('SVERIGE.md sources are current');
    return;
  }
  writeFileSync(file, next);
  console.log(`SVERIGE.md: ${Object.keys(LAYER_PROVENANCE).length} layers`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
