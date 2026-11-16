const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

function loadBackgroundHelpers() {
  const listeners = () => ({ addListener() {} });
  const chrome = {
    storage: {
      onChanged: listeners(),
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: { onInstalled: listeners(), onMessage: listeners(), onStartup: listeners() },
    alarms: { onAlarm: listeners(), create: async () => {}, clear: async () => {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const context = vm.createContext({ chrome, URL, Date, Math, String, Number, Object, Array, Set, Map, crypto: webcrypto });
  vm.runInContext(`${source}\nglobalThis.helpers = { canonical, normTitle, inferPath, savePage };`, context);
  return context.helpers;
}

const helpers = loadBackgroundHelpers();

test('canonical URL ignores fragments and trailing path slashes', () => {
  assert.equal(helpers.canonical('https://docs.example/guide///?lang=en#part'), 'https://docs.example/guide?lang=en');
  assert.equal(helpers.canonical('https://docs.example/#top'), 'https://docs.example/');
});

test('title normalization folds accents, punctuation and file extensions', () => {
  assert.equal(helpers.normTitle('Référence API.html'), 'reference api');
});

test('inferPath chooses the deeper available navigation path and removes adjacent duplicates', () => {
  const path = helpers.inferPath({
    breadcrumbs: [{ title: 'Docs' }],
    navPath: [{ title: 'Docs' }, { title: 'API' }, { title: 'API.html' }, { title: 'Methods' }],
  });
  assert.deepEqual(Array.from(path, item => item.title), ['Docs', 'API', 'Methods']);
});

test('savePage reuses matching hierarchy sections and skips duplicate URLs', () => {
  const collection = { items: [] };
  const first = { title: 'Overview', url: 'https://docs.example/v1/overview#intro', breadcrumbs: [{ title: 'Guides' }] };
  assert.equal(helpers.savePage(collection, first, false), 'added');
  assert.equal(collection.items.length, 2);
  assert.equal(helpers.savePage(collection, { ...first, title: 'Changed' }, false), 'skipped');
  assert.equal(collection.items.length, 2);
  assert.equal(helpers.savePage(collection, { ...first, title: 'Updated' }, true), 'updated');
  assert.equal(collection.items.length, 2);
  assert.equal(collection.items.find(item => item.kind !== 'section').title, 'Updated');
});

test('savePage keeps same-named sections separate under different parents', () => {
  const collection = { items: [] };
  for (const [url, branch] of [['a', 'Alpha'], ['b', 'Beta']]) {
    helpers.savePage(collection, { title: url, url: `https://docs.example/${url}`, breadcrumbs: [{ title: branch }, { title: 'Reference' }] }, false);
  }
  const references = collection.items.filter(item => item.kind === 'section' && item.title === 'Reference');
  assert.equal(references.length, 2);
  assert.notEqual(references[0].parentId, references[1].parentId);
});
