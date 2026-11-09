import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAYER_STATE_TOKEN_RESERVATIONS,
  REGISTERED_LAYER_IDS,
} from '../data/layerState.js';
import {
  LAYER_PROVENANCE,
  hasSwedishData,
  presentProvenanceDetails,
  presentProvenanceMark,
  provenanceMetaSource,
} from './layerProvenance.js';

test('every entry names a registered layer, and every fork layer has one', () => {
  for (const id of Object.keys(LAYER_PROVENANCE))
    assert.ok(REGISTERED_LAYER_IDS.includes(id), `${id} is not a layer`);
  // The fork's own layers count down from token 0z; each must say where its
  // data comes from, so a new one cannot be left out of the panel.
  const forkLayers = Object.entries(LAYER_STATE_TOKEN_RESERVATIONS)
    .filter(([, token]) => /^0[a-z]$/.test(token))
    .map(([id]) => id);
  assert.ok(forkLayers.length >= 18);
  for (const id of forkLayers) {
    assert.equal(LAYER_PROVENANCE[id]?.mark, 'se', `${id} lacks its SE entry`);
  }
});

test('own layers show SE and coverage; extended ones keep the original apart', () => {
  assert.equal(presentProvenanceMark('police-stations').text, 'SE');
  assert.deepEqual(
    presentProvenanceDetails('police-stations').map((line) => line.label),
    ['Source', 'Coverage', 'Updates', 'Licence'],
  );
  assert.equal(presentProvenanceMark('transit').text, '+SE');
  const transit = presentProvenanceDetails('transit');
  assert.deepEqual(
    transit.map((line) => line.label),
    ['Source', 'Sweden (this fork)', 'Original app', 'Updates', 'Licence'],
  );
  assert.match(transit[0].text, /Trafiklab/);
  assert.equal(provenanceMetaSource('transit'), 'GTFS-RT · Trafiklab · Trafikverket');
  assert.equal(provenanceMetaSource('police-stations'), null);
  // A licence phrase translates; licence names stay as written.
  assert.equal(
    presentProvenanceDetails('police-stations').at(-1).text,
    'Open data, source credited',
  );
  assert.equal(presentProvenanceDetails('speed-cameras').at(-1).text, 'CC0 1.0');
  assert.equal(hasSwedishData('flights'), false);
  assert.equal(presentProvenanceMark('flights'), null);
  assert.equal(presentProvenanceDetails('flights'), null);
});

test('the Swedish filter keeps Swedish layers and any layer that is on', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const layers = [
    ['flights', false],
    ['satellites', true],
    ['transit', false],
    ['police-stations', false],
    ['earthquakes', false],
  ].map(([id, enabled]) => ({
    id,
    name: id,
    source: 'Test',
    enabled,
    showInTogglePanel: true,
    stats: {},
  }));
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: (id) => layers.find((layer) => layer.id === id).enabled,
    setEnabled() {},
    setLayerParams() {},
    getRowControls: () => null,
    hasRowControls: () => false,
    subscribeRowControls: () => () => {},
  });
  const rowIds = () =>
    [...container.querySelectorAll('[data-layer-id]')].map(
      (node) => node.dataset.layerId,
    );
  const headings = () =>
    [...container.querySelectorAll('.data-layer-group-heading')].map((node) =>
      node.textContent.trim(),
    );
  try {
    panel.setLayerFilter('all');
    panel.mount(container);
    assert.equal(rowIds().length, 5);
    assert.ok(container.querySelector('.data-layer-filter'));
    assert.equal(
      container.querySelector('[data-layer-id="police-stations"] .data-layer-mark')
        .textContent,
      'SE',
    );
    assert.equal(
      container.querySelector('[data-layer-id="transit"] .data-layer-mark')
        .textContent,
      '+SE',
    );
    assert.equal(
      container.querySelector('[data-layer-id="flights"] .data-layer-mark'),
      null,
    );

    panel.setLayerFilter('sweden');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rowIds(), ['satellites', 'transit', 'police-stations']);
    // Events has nothing left to show, so its heading goes too.
    assert.deepEqual(headings(), ['Movement', 'Infrastructure']);

    // The ⓘ button opens the row's sources.
    container
      .querySelector('[data-layer-id="police-stations"] .data-provenance-btn')
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const details = container.querySelector(
      '[data-layer-id="police-stations"] .data-provenance',
    );
    assert.match(details.textContent, /Polismyndigheten/);
  } finally {
    panel.setLayerFilter('all');
    panel.destroy();
    document.body.replaceChildren();
  }
});

test('SVERIGE.md lists the same sources as the panel', () => {
  // scripts/sweden-sources.mjs writes the section from this table.
  const script = fileURLToPath(
    new URL('../../scripts/sweden-sources.mjs', import.meta.url),
  );
  const run = spawnSync(process.execPath, [script, '--check'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
