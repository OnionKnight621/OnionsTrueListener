// User dictionary: fixed replacements applied to the FINAL transcript, after the
// optional LLM pass. Whisper mishears domain words the same way every time
// ("килим" -> "келем"), and prompting doesn't fix it reliably — a literal replace
// at the very end does, for free.
//
// Pure module: no file I/O, no IPC. main.js owns the file, this owns the matching.

const MODES = new Set(['root', 'word', 'anywhere']);
const DEFAULT_MODE = 'root';

// JS `\b` is ASCII-only, so it never fires between a space and a Cyrillic letter.
// Unicode lookarounds are the portable word boundary.
const LEFT_EDGE = '(?<![\\p{L}\\p{N}_])';
const RIGHT_EDGE = '(?![\\p{L}\\p{N}_])';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Read whatever came out of glossary.json into clean entries. Malformed rows are
// dropped, not thrown on: a typo in the file must never break dictation.
function parseEntries(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(data && data.entries) ? data.entries : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const to = typeof row.to === 'string' ? row.to.trim() : '';
    const from = (Array.isArray(row.from) ? row.from : [row.from])
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!to || !from.length) continue;
    entries.push({ to, from, mode: MODES.has(row.mode) ? row.mode : DEFAULT_MODE });
  }
  return entries;
}

// One regex for the whole dictionary, so `apply` is a single left-to-right pass:
// a replacement can never be re-matched by another rule (no cascading).
function compile(entries) {
  const byVariant = new Map(); // lowercased variant -> canonical replacement
  const alternatives = [];

  const variants = [];
  for (const e of entries) for (const from of e.from) variants.push({ from, to: e.to, mode: e.mode });
  variants.sort((a, b) => b.from.length - a.from.length); // longest wins in the alternation

  for (const { from, to, mode } of variants) {
    const key = from.toLowerCase();
    if (byVariant.has(key)) continue; // first entry wins on duplicates
    byVariant.set(key, to);
    // 'root' matches the start of a word and leaves the ending alone, so one rule
    // covers a whole inflection paradigm (келемами -> килимами).
    const left = mode === 'anywhere' ? '' : LEFT_EDGE;
    const right = mode === 'word' ? RIGHT_EDGE : '';
    alternatives.push(left + escapeRe(from) + right);
  }

  if (!alternatives.length) return null;
  return { re: new RegExp(alternatives.join('|'), 'giu'), byVariant };
}

// Upgrade the canonical spelling to the case Whisper produced, never downgrade —
// so "Godot" stays "Godot", while "Келемами" at a sentence start yields "Килимами".
function matchCase(matched, replacement) {
  const isAllCaps = matched.length > 1 && matched === matched.toUpperCase() && matched !== matched.toLowerCase();
  if (isAllCaps) return replacement.toUpperCase();
  const head = matched[0];
  if (head === head.toUpperCase() && head !== head.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// -> { text, hits }, where hits records every substitution made (in text order,
// duplicates included) so the UI can show what the dictionary actually changed.
function apply(text, rules) {
  if (!rules || !text) return { text, hits: [] };
  const hits = [];
  const out = text.replace(rules.re, (matched) => {
    const to = rules.byVariant.get(matched.toLowerCase());
    if (to === undefined) return matched;
    const cased = matchCase(matched, to);
    hits.push({ from: matched, to: cased });
    return cased;
  });
  return { text: out, hits };
}

module.exports = { parseEntries, compile, apply };
