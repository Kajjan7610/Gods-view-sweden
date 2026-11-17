// The city dossier's sights on the map: one set of dots coloured by kind,
// the chosen one gold and larger, names above them, and a click on a dot or
// a name picking that sight.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { SIGHT_COLORS, createSightsLayer } from './citySights.js';

const SIGHTS = [
  {
    id: 'a',
    name: 'Arboga kyrka',
    kind: 'church',
    lat: 59.394,
    lon: 15.838,
    rank: 0,
  },
  {
    id: 'b',
    name: 'Runsten',
    kind: 'runestone',
    lat: 59.401,
    lon: 15.82,
    rank: 1,
  },
  { id: 'c', name: 'Något', kind: 'unknown', lat: 59.41, lon: 15.81, rank: 2 },
];

function harness() {
  const state = {
    labels: null,
    visible: null,
    cleared: false,
    picks: [],
    click: null,
    picked: null,
    labelHit: null,
  };
  const host = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const { draw } = bindFakeDraw(host);
  const layer = createSightsLayer({
    viewer: host,
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, 'city-sight-labels');
        state.labels = entries;
      },
      setVisible: (sourceId, visible) => (state.visible = visible),
      clearSource: () => (state.cleared = true),
      hitTest: (x, y, options) => {
        assert.equal(options.sourceId, 'city-sight-labels');
        return state.labelHit ? { entryId: state.labelHit } : null;
      },
    },
    onPick: (id) => state.picks.push(id),
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({ screenPosition: { x: 4, y: 2 }, topHit: state.picked });
        return () => (state.click = null);
      },
    }),
  });
  return { state, layer, dots: () => draw.set('city-sights') };
}

test("each sight is a dot in its kind's colour, the chosen one gold and larger", () => {
  const { state, layer, dots } = harness();
  assert.equal(dots().kind, 'points');
  assert.equal(dots().items.size, 0);
  layer.show(SIGHTS, 'b');
  const items = [...dots().items.values()];
  assert.deepEqual(
    items.map((item) => item.id),
    ['city-sight:a', 'city-sight:b', 'city-sight:c'],
  );
  const [church, chosen, other] = items;
  assert.deepEqual(church.pos, { lon: 15.838, lat: 59.394, height: 30 });
  assert.equal(church.color, SIGHT_COLORS.church);
  assert.equal(church.pixelSize, 8);
  assert.equal(church.outlineColor, '#04101a');
  assert.equal(church.outlineWidth, 2);
  assert.equal(church.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(chosen.color, '#ffc94d');
  assert.equal(chosen.pixelSize, 13);
  assert.equal(other.color, '#ffffff', 'a kind without a colour is white');
  // The names above them, at the same points, the chosen one first.
  assert.deepEqual(
    state.labels.map((label) => [label.title, label.priority]),
    [
      ['Arboga kyrka', 100],
      ['Runsten', 1000],
      ['Något', 98],
    ],
  );
  assert.deepEqual(state.labels[0].position, fromDegrees(15.838, 59.394, 30));
  assert.equal(state.labels[1].accent, '#ffc94d');
  assert.equal(state.visible, true);
  // Hidden: nothing drawn, no names.
  layer.hide();
  assert.equal(dots().items.size, 0);
  assert.deepEqual(state.labels, []);
  assert.equal(state.visible, false);
});

test('a click on a dot or a name picks the sight; anything else does not', () => {
  const { state, layer, dots } = harness();
  // Nothing shown: a click is not ours.
  state.picked = { set: 'city-sights', id: 'city-sight:a', surface: false };
  state.click();
  assert.deepEqual(state.picks, []);
  layer.show(SIGHTS);
  state.click();
  // The name first, before the dot under it.
  state.labelHit = 'city-sight:c';
  state.click();
  assert.deepEqual(state.picks, ['a', 'c']);
  // Another layer's dot, or the map.
  state.labelHit = null;
  state.picked = { set: 'hospitals', id: 'se-hospital:1', surface: false };
  state.click();
  state.picked = null;
  state.click();
  assert.deepEqual(state.picks, ['a', 'c']);
  // Gone: the set, the names and the click.
  layer.destroy();
  assert.equal(dots(), undefined);
  assert.equal(state.cleared, true);
  assert.equal(state.click, null);
});
