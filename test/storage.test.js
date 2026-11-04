// Run: node test/storage.test.js — option-question rule and backup import, against a fake chrome.storage
const assert = require('node:assert/strict');
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k === null ? { ...store } : { [k]: store[k] }),
      set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
      remove: async (k) => [].concat(k).forEach((x) => delete store[x]),
    },
  },
};
const AnswerStore = require('node:vm').runInThisContext(
  require('node:fs').readFileSync('src/shared/storage.js', 'utf8') + '\nAnswerStore;'
);

(async () => {
  // Picked Bangalore out of Pune/Bangalore: a Noida/Bangalore/Pune set is left to the user.
  await AnswerStore.set('Location?', 'Bangalore', 'radio', ['Pune', 'Bangalore']);
  const rec = await AnswerStore.get('Location?');
  assert.equal(AnswerStore.pickAnswer(rec, ['Bangalore', 'Pune']).answer, 'Bangalore');
  assert.equal(AnswerStore.pickAnswer(rec, ['Noida', 'Bangalore', 'Pune']).answer, null);
  await AnswerStore.set('Location?', 'Noida', 'radio', ['Noida', 'Bangalore', 'Pune']);
  assert.equal(AnswerStore.pickAnswer(await AnswerStore.get('Location?'), ['Noida', 'Bangalore', 'Pune']).answer, 'Noida');

  // Sites stay apart.
  await AnswerStore.set('Notice period?', '30 days', 'text', undefined, 'naukri');
  assert.equal(await AnswerStore.get('Notice period?', 'linkedin'), null);

  // Import: newer lastUsed wins, others are skipped; a foreign file is rejected.
  const mine = await AnswerStore.get('Notice period?', 'naukri');
  const stats = await AnswerStore.importAll({
    app: 'quickapply',
    records: {
      'q::notice period?': { ...mine, answer: '60 days', lastUsed: mine.lastUsed + 1 },
      'li::new question': { question: 'New question', answer: 'x', type: 'text', lastUsed: 1 },
    },
  });
  assert.deepEqual(stats, { added: 1, updated: 1, skipped: 0 });
  await assert.rejects(AnswerStore.importAll({ app: 'other', records: {} }));

  console.log('storage.test: ok');
})().catch((e) => (console.error(e), process.exit(1)));
