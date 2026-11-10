// The speed camera card: road in the title, direction and county on one line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpeedCameraCard } from './cards.js';

const site = (over = {}) => ({
  id: '1',
  name: 'Rotebro',
  road: 'E4',
  bearing: 182,
  county: 'Stockholms län',
  point: [17.9, 59.47],
  ...over,
});

test('the card names the road, the site, its direction and its county', () => {
  const card = buildSpeedCameraCard(site());
  assert.equal(card.id, 'speed-camera-card:1');
  assert.equal(card.interactive, true);
  assert.equal(card.title, 'SPEED CAMERA · E4');
  assert.equal(card.details[0], 'Rotebro');
  assert.equal(card.details[1], 'facing 182° (south) · Stockholms län');
  assert.equal(buildSpeedCameraCard(site({ road: null })).title, 'SPEED CAMERA');
});

test('a site without a direction says nothing about one', () => {
  const lines = buildSpeedCameraCard(site({ bearing: null })).details;
  assert.equal(lines[1], 'Stockholms län');
  assert.ok(!lines.some((line) => /facing/.test(line)));

  // Neither direction nor county: the line is left out, not left empty.
  const bare = buildSpeedCameraCard(site({ bearing: null, county: null }));
  assert.equal(bare.details.length, lines.length - 1);
  assert.ok(bare.details.every((line) => line.trim() !== ''));
});
