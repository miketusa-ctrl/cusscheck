// CussCheck (codename SwearGuard) word filter: obscenity 0.4.6 (MIT) englishDataset + englishRecommendedTransformers, fully in memory.
// No network, no storage. Positions are JavaScript string (UTF-16 code unit) indices into the ORIGINAL text:
// start inclusive, end exclusive, so text.slice(start, end) is the matched span.
import {
  RegExpMatcher, DataSet, englishDataset, englishRecommendedTransformers,
  englishRecommendedBlacklistMatcherTransformers, parseRawPattern,
} from 'obscenity';

export const LIBRARY = 'obscenity@0.4.6 (englishDataset)';
export const MAX_LIST_ITEMS = 50;
export const MAX_LIST_ITEM_LEN = 40;

// Whitelist: common innocent words/names that contain a listed term. Whitelisted spans are matched on the
// transformed text, so a blacklisted match fully inside one is dropped. Real profanity next to them is still
// caught ("shit cockpit fuck" -> shit, fuck).
export const CLEAN_WORDS = [
  'shiitake', 'shiite', 'shiites', 'mishit', 'mishits', 'penistone', 'cockpit', 'cockpits', 'cumin', 'fukushima',
  'fukuoka', 'dickinson', 'dickens', 'moby dick', 'retardant', 'retardants', 'pissarro',
  // wider probes (scripts/fp-probe.mjs); every entry below is flagged by the bare englishDataset
  'booby trap', 'booby-trap', 'niggard', 'cocksure', 'cockscomb', 'spotted dick', 'dick van dyke',
  'philip k dick', 'philip k. dick', 'dick tracy', 'dick whittington', 'dick cheney', 'dickson', 'dickerson', 'dickey',
  'dickeys', 'fukuyama', 'fukui', 'rapeseed', 'wankel', 'dyke road', "offa's dyke", 'shittim', 'pussycat',
  'pussycats', 'pussy willow', 'pussy willows', 'cummings',
  'cum laude', 'cum dividend', 'analgesic', 'analgesics', 'analgesia', 'retardation', 'retarder', 'retarding', 'dickcissel',
  // NOT whitelisted on purpose: 'cumming' and standalone 'fu'. Standalone fu is handled narrowly in check().
];
const dataset = new DataSet().addAll(englishDataset)
  .addPhrase((p) => { p.setMetadata({ originalWord: '__clean' }); for (const w of CLEAN_WORDS) p.addWhitelistedTerm(w); return p; });
const builtDataset = dataset.build();
const matcher = new RegExpMatcher({ ...builtDataset, ...englishRecommendedTransformers });

const termCache = new Map(); // termId -> canonical word
function termOf(match) {
  let t = termCache.get(match.termId);
  if (t === undefined) {
    const md = dataset.getPayloadWithPhraseMetadata(match);
    t = (md.phraseMetadata && md.phraseMetadata.originalWord) || 'unknown';
    termCache.set(match.termId, t);
  }
  return t;
}

// ---------- pre-normalization (detection only; the text itself is never altered) ----------
// Stage 1: drop invisible characters (soft hyphen, zero-width space/joiners, word joiner, invisible operators, BOM)
//   and combining marks (NFD-aware: "fu\u0301ck" and precomposed accents both become base letters).
// Stage 2: collapse "runs": >= 3 single characters joined by the SAME 1-2 char separator (". - _ ~ + *", space,
//   tab; never newlines), bounded by non-word characters: f.u.c.k, s-h-i-t, b i t c h, F. U. C. K.
//   Suffix form (non-space separators only): >= 2 single characters + a final character that continues as a word:
//   f.u.c.king, s.h.i.tty, f-u-cking. Spaced letters followed by a word ("a b c kingston") are NOT joined.
// Every normalized code unit keeps the index of the original character it came from, so matches map back exactly.
// every format char (\p{Cf}: soft hyphen, zero-width, LRM/RLM, bidi embeddings/isolates, U+180E, word joiner, BOM,
// tag chars U+E0000-E007F), Hangul fillers, and nonspacing + enclosing marks.
const INVISIBLE_RE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/u;
const MARK_RE = /[\p{Mn}\p{Me}]/u;
const MARKS_G = /[\p{Mn}\p{Me}]/gu;
const NON_ASCII = /[^\x00-\x7f]/;
const RUN_RE = /(?<![\p{L}\p{N}])[\p{L}\p{N}@$!](?:([.\-_~+*\t ]{1,2})[\p{L}\p{N}@$!])(?:\1[\p{L}\p{N}@$!])+(?![\p{L}\p{N}])/gu;
const SUFFIX_RE = /(?<![\p{L}\p{N}])(?<![\p{L}\p{N}@$!][.\-_~+*]{1,2})[\p{L}\p{N}@$!](?:([.\-_~+*]{1,2})[\p{L}\p{N}@$!])(?:\1[\p{L}\p{N}@$!])*\1[\p{L}\p{N}@$!]\p{L}+(?![\p{L}\p{N}])/gu;

function stripInvisible(text) {
  if (!NON_ASCII.test(text)) return null;
  let out = ''; const map = []; let changed = false;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i); const len = cp > 0xffff ? 2 : 1; const ch = text.slice(i, i + len);
    if (cp > 0x7f) {
      if (INVISIBLE_RE.test(ch) || MARK_RE.test(ch)) { changed = true; i += len; continue; }
      const d = ch.normalize('NFD');
      if (d !== ch && MARK_RE.test(d)) {
        const base = d.replace(MARKS_G, ''); changed = true;
        for (let k = 0; k < base.length; k++) { out += base[k]; map.push(i); }
        i += len; continue;
      }
    }
    for (let k = 0; k < len; k++) { out += text[i + k]; map.push(i + k); }
    i += len;
  }
  return changed ? { out, map } : null;
}

function collectRuns(re, text, runs) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const sep = m[1]; const tokens = m[0].split(sep);
    let collapsed = ''; const map = []; let off = m.index;
    for (const t of tokens) {
      for (let k = 0; k < t.length; k++) { collapsed += t[k]; map.push(off + k); }
      off += t.length + sep.length;
    }
    runs.push({ start: m.index, end: m.index + m[0].length, collapsed, map });
  }
}

export function findRuns(text) {
  const all = [];
  collectRuns(RUN_RE, text, all);
  collectRuns(SUFFIX_RE, text, all);
  if (all.length < 2) return all;
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const runs = []; let lastEnd = -1;
  for (const r of all) { if (r.start >= lastEnd) { runs.push(r); lastEnd = r.end; } }
  return runs;
}

/** Returns { norm, map }: map[i] is the ORIGINAL index of norm[i]; map is null when nothing changed. */
export function normalize(text) {
  const st = stripInvisible(text);
  const s1 = st ? st.out : text;
  const runs = findRuns(s1);
  if (!runs.length) return { norm: s1, map: st ? st.map : null };
  let norm = ''; const map2 = []; let pos = 0;
  for (const r of runs) {
    for (let i = pos; i < r.start; i++) map2.push(i);
    norm += s1.slice(pos, r.start) + r.collapsed;
    for (const i of r.map) map2.push(i);
    pos = r.end;
  }
  for (let i = pos; i < s1.length; i++) map2.push(i);
  norm += s1.slice(pos);
  return { norm, map: st ? map2.map((i) => st.map[i]) : map2 };
}

/** Original end (exclusive) of the character at original index j, extended over trailing combining marks. */
function origEnd(text, j) {
  const c = text.charCodeAt(j);
  let e = (c >= 0xd800 && c <= 0xdbff) ? j + 2 : j + 1;
  while (e < text.length) {
    const cp = text.codePointAt(e);
    if (cp > 0x7f && MARK_RE.test(String.fromCodePoint(cp))) e += cp > 0xffff ? 2 : 1; else break;
  }
  return e;
}

function fixEnd(text, endIncl) {
  // obscenity endIndex is inclusive; extend over a trailing surrogate pair.
  const c = text.charCodeAt(endIncl);
  return (c >= 0xd800 && c <= 0xdbff) ? endIncl + 2 : endIncl + 1;
}

// ---------- custom lists ----------
const LIST_ITEM_RE = /^[a-z][a-z' -]*[a-z]$|^[a-z]$/;
export class ListError extends Error { constructor(field, msg) { super(msg); this.field = field; } }

export function normalizeList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ListError(field, `"${field}" must be an array of strings`);
  if (value.length > MAX_LIST_ITEMS) throw new ListError(field, `"${field}" may contain at most ${MAX_LIST_ITEMS} entries`);
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') throw new ListError(field, `"${field}" entries must be strings`);
    const w = v.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!w) continue;
    if (w.length > MAX_LIST_ITEM_LEN) throw new ListError(field, `"${field}" entries must be at most ${MAX_LIST_ITEM_LEN} characters`);
    if (!LIST_ITEM_RE.test(w)) throw new ListError(field, `"${field}" entries may contain only letters a-z, spaces, hyphens and apostrophes`);
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// Mirror the dataset's collapse-duplicates thresholds so deny patterns line up with the transformed input.
const KEEP_TWO = new Set(['b', 'e', 'o', 'l', 's', 'g']);
function collapseLikeTransformer(w) {
  let out = ''; let prev = ''; let run = 0;
  for (const ch of w) {
    run = ch === prev ? run + 1 : 1; prev = ch;
    if (run <= (KEEP_TWO.has(ch) ? 2 : 1)) out += ch;
  }
  return out;
}

const FU_STRIP_G = /[\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0]/gu;
const isBareFu = (span) => span.replace(FU_STRIP_G, '').toLowerCase() === 'fu';
// Catches fu*k, fu**ing, fu#k, fu** you, fu.ck, fu-cking. fu$k / fu_k / fu@k never reach this rule: obscenity emits no
// bare "fu" match before $ @ _ (leet maps $->s and @->a; _ is not a word boundary), so the [@$]+ and _ branches are
// currently dead. "fu.com", "Fu-Chen", "kung fu." and "kung fu-style" stay clean.
const FU_TAIL_RE = /^(?:[*#]+[a-z]*|(?:[@$]+|[.\-_])(?:c?k|q)[a-z]*)/i;

const denyCache = new Map(); // key -> { matcher, words }
function denyMatcher(words) {
  const key = words.join('\u0000');
  let e = denyCache.get(key);
  if (e) return e;
  const ds = new DataSet();
  words.forEach((w) => {
    ds.addPhrase((p) => p.setMetadata({ originalWord: w }).addPattern(parseRawPattern(`|${collapseLikeTransformer(w)}|`)));
  });
  const built = ds.build();
  e = { ds, matcher: new RegExpMatcher({ ...built, blacklistMatcherTransformers: englishRecommendedBlacklistMatcherTransformers }) };
  if (denyCache.size > 200) denyCache.clear();
  denyCache.set(key, e);
  return e;
}

function collect(m, text, termFn, source, out) {
  for (const x of m.getAllMatches(text, true)) {
    out.push({ term: termFn(x), start: x.startIndex, end: fixEnd(text, x.endIndex), source });
  }
}

/**
 * check(text, { censor = true, allow = [], deny = [] }) -> result object.
 * allow: built-in AND deny terms whose canonical word, or whose matched text (lowercased, separators removed),
 *        equals an allow entry are dropped. Allow wins.
 * deny:  extra words flagged on word boundaries, with the same leetspeak/confusable/repeat handling.
 */
export function check(text, opts = {}) {
  const allow = opts.allow || [];
  const deny = opts.deny || [];
  const censor = opts.censor !== false;
  const raw = [];
  const dm = deny.length ? denyMatcher(deny) : null;
  const denyTerm = (x) => (dm.ds.getPayloadWithPhraseMetadata(x).phraseMetadata || {}).originalWord || 'custom';

  // One matcher pass per list over the (possibly) normalized text: runs collapsed, everything else untouched.
  const { norm, map } = normalize(text);
  const scan = [];
  collect(matcher, norm, termOf, 'dataset', scan);
  if (dm) collect(dm.matcher, norm, denyTerm, 'deny', scan);
  for (const x of scan) {
    if (!map) { raw.push(x); continue; }
    // (no map: norm === text, positions are already original)
    const start = map[x.start];
    const end = origEnd(text, map[x.end - 1]);
    raw.push({ term: x.term, start, end, source: x.source, obfuscated: end - start !== x.end - x.start });
  }

  const allowSet = new Set(allow);
  const seen = new Set();
  const matches = [];
  raw.sort((a, b) => a.start - b.start || b.end - a.end || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  for (const m of raw) {
    if (m.source === 'dataset' && m.end - m.start <= 8 && isBareFu(text.slice(m.start, m.end))) {
      // Obscenity flags a bare "fu". Standalone fu / FU / kung fu / Fu Manchu is NOT flagged (documented), but a masked
      // continuation is: fu*k, fu**ing, fu#k, fu.ck, fu-cking -> the whole masked word.
      const tail = FU_TAIL_RE.exec(text.slice(m.end, m.end + 40));
      if (!tail) continue;
      m.end += tail[0].length; m.obfuscated = true;
    }
    const k = `${m.start}:${m.end}:${m.term}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const span = text.slice(m.start, m.end);
    const spanNorm = span.toLowerCase().replace(/[.\-_~+*\s]/g, '');
    if (allowSet.has(m.term) || allowSet.has(span.toLowerCase()) || allowSet.has(spanNorm)) continue;
    matches.push({ term: m.term, match: span, start: m.start, end: m.end, source: m.source, obfuscated: !!m.obfuscated });
  }

  let censored = null;
  if (censor) censored = censorText(text, matches);
  const terms = [...new Set(matches.map((m) => m.term))];
  return { has_profanity: matches.length > 0, match_count: matches.length, terms, matches, censored };
}

// Merge overlapping spans, then replace each span with one '*' per UTF-16 code unit (slice-join, O(n)), so the censored
// copy has the same length as the input and every start/end applies to both strings.
export function censorText(text, matches) {
  if (!matches.length) return text;
  const iv = matches.map((m) => [m.start, m.end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of iv) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
  }
  let out = ''; let pos = 0;
  for (const [s, e] of merged) { out += text.slice(pos, s) + '*'.repeat(e - s); pos = e; }
  return out + text.slice(pos);
}

// module-load warm-up
// Runs once per isolate at startup (global scope), not inside the first request: compiles every obscenity regex to
// native code and gets the match/map/censor/serialize paths past V8's first tiers, so a cold worst-case request costs
// about what a warm one does. Synthetic text only; nothing is stored or logged. Costs ~10-15 ms of startup CPU.
export const WARMUP = (() => {
  const t0 = Date.now();
  const w = 'Shiitake f.u.c.king sh\u00adit fu\u0301ck s h i t f*ck sh1t fuuuck fu*k asshole bitch cockpit \u200Bdick ';
  JSON.stringify(check(w, { deny: ['zzwarm'], allow: ['zzallow'] }));
  JSON.stringify(check(w, { censor: false }));
  const dense = 'fuck shit '.repeat(205); // ~2 KB, ~410 matches
  JSON.stringify(check(dense));
  return { ms: Date.now() - t0 };
})();
