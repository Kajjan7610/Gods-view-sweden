// The Swedish fork's "Sweden Right Now" tour: registered layers only, one
// Swedish layer per shot, and every shot title translated.
import assert from 'node:assert/strict';
import test from 'node:test';
import { REGISTERED_LAYER_IDS } from '../data/layerState.js';
import { recipeToScene, refreshUneditedBuiltInScenes } from './project.js';
import { SCENE_RECIPES } from './recipes.js';
import sv from '../i18n/locales/sv.json' with { type: 'json' };

const tour = SCENE_RECIPES.find((recipe) => recipe.id === 'sweden-now');

test('the tour follows the original scenes and installs into saved projects', () => {
  assert.ok(tour);
  assert.equal(SCENE_RECIPES.at(-1), tour);
  assert.equal(tour.installAlongsideSceneId, 'omniscience-pullback');
  assert.equal(sv[tour.title], 'Sverige just nu');
});

test('each shot turns on its own Swedish layers and turns the others off', () => {
  const scene = recipeToScene(tour);
  const enabled = scene.shots.map((shot) =>
    Object.entries(shot.layers)
      .filter(([, target]) => target.enabled)
      .map(([id]) => id),
  );
  assert.deepEqual(enabled, [
    ['smhi-warnings'],
    ['smhi-weather'],
    ['transit', 'transit-alerts'],
    ['power-grid'],
    ['aurora'],
    ['sea-weather'],
    ['river-flow'],
    ['gamma-radiation'],
    ['flights'],
  ]);
  for (const shot of scene.shots) {
    for (const id of Object.keys(shot.layers))
      assert.ok(REGISTERED_LAYER_IDS.includes(id), id);
    assert.ok(sv[shot.title], `untranslated shot title ${shot.title}`);
  }
});

test('a saved tour gains new shots only while nobody edited it', () => {
  const scene = recipeToScene(tour);
  const saved = (shots) => ({
    scenes: [{ ...scene, shots: shots.map((shot) => structuredClone(shot)) }],
  });
  const older = saved(scene.shots.slice(0, 7));
  assert.equal(refreshUneditedBuiltInScenes(older, SCENE_RECIPES), true);
  assert.equal(older.scenes[0].shots.length, tour.cameraPath.length);
  const edited = saved([
    ...scene.shots.slice(0, 6),
    { ...scene.shots[6], title: 'My own shot' },
  ]);
  assert.equal(refreshUneditedBuiltInScenes(edited, SCENE_RECIPES), false);
  const current = saved(scene.shots);
  assert.equal(refreshUneditedBuiltInScenes(current, SCENE_RECIPES), false);
});

test('the withdrawn Nepal scene is not offered and leaves saved projects', async () => {
  const { SCENE_RECIPES, SCENE_APPEND_RECIPES, WITHDRAWN_BUILT_IN_SCENE_IDS } =
    await import('./recipes.js');
  const { dropWithdrawnBuiltInScenes } = await import('./project.js');
  assert.ok(
    !SCENE_RECIPES.some((recipe) => /nepal|bhote/i.test(recipe.id)),
    'no Nepal recipe among the built-in scenes',
  );
  assert.deepEqual(SCENE_APPEND_RECIPES, []);
  const project = {
    scenes: [
      { id: 'sweden-now', shots: [] },
      { id: 'bhote-koshi-nepal-scene', shots: [] },
    ],
  };
  assert.equal(
    dropWithdrawnBuiltInScenes(project, WITHDRAWN_BUILT_IN_SCENE_IDS),
    true,
  );
  assert.deepEqual(
    project.scenes.map((scene) => scene.id),
    ['sweden-now'],
  );
  assert.equal(
    dropWithdrawnBuiltInScenes(project, WITHDRAWN_BUILT_IN_SCENE_IDS),
    false,
  );
});
