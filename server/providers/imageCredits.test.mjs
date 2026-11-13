import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageCredits,
  normalizeImageCredits,
  plainAuthor,
  wikiFileOf,
} from './imageCredits.js';

test('an image address names its wiki and file', () => {
  assert.deepEqual(
    wikiFileOf(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Uppsala%20vapen.svg?width=120',
    ),
    { host: 'commons.wikimedia.org', title: 'File:Uppsala vapen.svg' },
  );
  assert.deepEqual(
    wikiFileOf(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Uppsala_domkyrka.jpg/320px-Uppsala_domkyrka.jpg',
    ),
    { host: 'commons.wikimedia.org', title: 'File:Uppsala domkyrka.jpg' },
  );
  // A file the Swedish Wikipedia hosts itself is asked of that wiki.
  assert.deepEqual(
    wikiFileOf('https://upload.wikimedia.org/wikipedia/sv/a/ab/Lokal.jpg'),
    { host: 'sv.wikipedia.org', title: 'File:Lokal.jpg' },
  );
  assert.equal(wikiFileOf('https://example.com/a.jpg'), null);
  assert.equal(wikiFileOf(null), null);
});

test('the author is plain text, kept short', () => {
  assert.equal(
    plainAuthor('<a href="//commons.wikimedia.org/wiki/User:X">Arild&nbsp;Vågen</a>'),
    'Arild Vågen',
  );
  assert.equal(plainAuthor('x'.repeat(200)).length, 80);
  assert.equal(plainAuthor(undefined), '');
});

const ANSWER = {
  query: {
    normalized: [{ from: 'File:Uppsala_domkyrka.jpg', to: 'File:Uppsala domkyrka.jpg' }],
    pages: [
      {
        title: 'File:Uppsala domkyrka.jpg',
        imageinfo: [
          {
            extmetadata: {
              Artist: { value: '<span>Arild Vågen</span>' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
            },
          },
        ],
      },
      { title: 'File:No licence.jpg', imageinfo: [{ extmetadata: {} }] },
    ],
  },
};

test('a file without a licence to name has no credit', () => {
  const credits = normalizeImageCredits(ANSWER, 'commons.wikimedia.org');
  assert.deepEqual(credits.get('File:Uppsala domkyrka.jpg'), {
    author: 'Arild Vågen',
    licence: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Uppsala_domkyrka.jpg',
  });
  // Answered under the normalized title, found under the one asked for.
  assert.equal(
    credits.get('File:Uppsala_domkyrka.jpg'),
    credits.get('File:Uppsala domkyrka.jpg'),
  );
  assert.equal(credits.get('File:No licence.jpg'), null);
});

test('credits are asked once per wiki, kept, and asked again after a failure', async () => {
  const asked = [];
  let fail = true;
  const credits = createImageCredits({
    async getJson(url) {
      asked.push(new URL(url).host);
      if (fail) throw new Error('down');
      return ANSWER;
    },
  });
  const photo =
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Uppsala_domkyrka.jpg';
  const first = await credits.lookup([photo, 'https://example.com/a.jpg']);
  assert.equal(first.failed, true);
  assert.equal(first.credits.get(photo), null);
  fail = false;
  const second = await credits.lookup([photo]);
  assert.equal(second.failed, false);
  assert.equal(second.credits.get(photo).licence, 'CC BY-SA 4.0');
  await credits.lookup([photo]);
  assert.deepEqual(asked, ['commons.wikimedia.org', 'commons.wikimedia.org']);
});
