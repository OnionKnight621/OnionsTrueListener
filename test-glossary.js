// Unit tests for the pure dictionary module. Run: node test-glossary.js
const test = require('node:test');
const assert = require('node:assert');
const { parseEntries, compile, apply } = require('./glossary');

const run = (text, rows) => apply(text, compile(parseEntries({ entries: rows })));
const fix = (text, rows) => run(text, rows).text;

const CARPET = [{ to: 'килим', from: ['келем', 'кілем'], mode: 'root' }];

test('root mode keeps the inflection ending', () => {
  assert.equal(fix('келеми і келемів', CARPET), 'килими і килимів');
  assert.equal(fix('гра про кілемами', CARPET), 'гра про килимами');
});

test('root mode only matches at a word start', () => {
  assert.equal(fix('прокелем', CARPET), 'прокелем');
  assert.equal(fix('(келем)', CARPET), '(килим)'); // punctuation is a boundary
});

test('case is upgraded, never downgraded', () => {
  assert.equal(fix('Келемами', CARPET), 'Килимами');
  assert.equal(fix('КЕЛЕМ', CARPET), 'КИЛИМ');
  assert.equal(fix('гадо', [{ to: 'Godot', from: ['гадо'], mode: 'word' }]), 'Godot');
});

test('word mode does not match a longer word', () => {
  const rows = [{ to: 'Godot', from: ['гадо'], mode: 'word' }];
  assert.equal(fix('гадошний', rows), 'гадошний');
  assert.equal(fix('пишу на гадо.', rows), 'пишу на Godot.');
});

test('anywhere mode matches mid-word', () => {
  assert.equal(fix('прокелем', [{ to: 'килим', from: ['келем'], mode: 'anywhere' }]), 'прокилим');
});

test('multi-word variants work', () => {
  assert.equal(fix('пишу на гад от зараз', [{ to: 'Godot', from: ['гад от'], mode: 'word' }]),
    'пишу на Godot зараз');
});

test('single pass — a replacement is never re-matched', () => {
  const rows = [
    { to: 'келем', from: ['ковер'], mode: 'root' },
    { to: 'килим', from: ['келем'], mode: 'root' },
  ];
  assert.equal(fix('ковер', rows), 'келем'); // not chained into "килим"
});

test('longer variants win over shorter ones', () => {
  const rows = [
    { to: 'килим', from: ['келем'], mode: 'root' },
    { to: 'килимок', from: ['келемок'], mode: 'word' },
  ];
  assert.equal(fix('келемок', rows), 'килимок');
});

test('malformed rows are dropped, not thrown on', () => {
  const entries = parseEntries({ entries: [
    { to: 'ok', from: ['x'] },
    { to: '', from: ['y'] },
    { to: 'z', from: [] },
    null,
    'nonsense',
    { to: 'm', from: 'string-instead-of-array' },
  ] });
  assert.deepEqual(entries.map((e) => e.to), ['ok', 'm']);
  assert.equal(entries[0].mode, 'root'); // default
});

test('hits report every substitution, cased as inserted', () => {
  // In root mode only the root is consumed, so a hit reports the rule that fired.
  const { hits } = run('Келеми і келемів, але прокелем', CARPET);
  assert.deepEqual(hits, [
    { from: 'Келем', to: 'Килим' },
    { from: 'келем', to: 'килим' },
  ]);
});

test('an empty dictionary is a no-op', () => {
  assert.deepEqual(apply('текст', compile([])), { text: 'текст', hits: [] });
  assert.deepEqual(apply('текст', null), { text: 'текст', hits: [] });
});
