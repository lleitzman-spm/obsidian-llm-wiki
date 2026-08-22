export function slugify(text: string, preserveCase = false): string {
  // v1.22.2 D2: console.debug removed from slugify hot-path (called thousands
  // of times per batch — every debug log is I/O that slows ingest).
  if (!text || text.trim().length === 0) {
    console.warn('slugify: input text is empty');
    return 'untitled';
  }

  return computeSlug(text, preserveCase);
}

// Pure slug computation — no debug logs on normal path. Used for batch operations
// where thousands of silent calls are needed (e.g. matching 2141 existing pages).
// preserveCase skips the final toLowerCase() for file creation (Issue #111).
// All comparison/matching callers must NOT pass preserveCase so slugs stay
// case-insensitively comparable regardless of the user's slugCase setting.
import { MIN_ALIAS_LENGTH } from '../constants';

/**
 * Return a comparison key for a value that may become a Windows filename.
 * Windows path identity is case-insensitive and NFC-equivalent; trailing
 * dots/spaces are ignored by Win32, and slash spellings are interchangeable
 * when a caller supplies a path-like alias. Keep the original display value
 * for frontmatter, but use this key whenever aliases are deduplicated.
 */
export function windowsEquivalentIdentity(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.replace(/[ .]+$/g, ''))
    .join('/')
    .toLowerCase();
}

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i;

export function computeSlug(text: string, preserveCase = false): string {
  if (!text || text.trim().length === 0) return 'untitled';

  // NFC keeps composed and decomposed spellings as one physical filename
  // (macOS commonly supplies NFD while Windows supplies NFC).
  const trimmed = text.normalize('NFC').trim();

  // Step 1: Remove ASCII control characters and filesystem-unsafe symbols
  const afterRemoveInvalid = trimmed
    // eslint-disable-next-line no-control-regex -- deliberate control-char strip for filename safety
    .replace(/[\x00-\x1f]/g, '')
    // `#` is an Obsidian heading delimiter inside wikilinks, so allowing it
    // in a filename creates a page that generated `[[path#fragment]]` links
    // cannot address as a file.
    .replace(/[/\\:*?"<>|#,()'!?、，。；：！？（）【】《》]/g, '');

  if (afterRemoveInvalid.length === 0) return 'untitled-' + Date.now();

  // Step 2: Convert spaces and dots to dashes
  const afterSpaceToDash = afterRemoveInvalid.replace(/[\s.]+/g, '-');

  // Step 3: Merge multiple dashes
  const afterMergeDash = afterSpaceToDash.replace(/-+/g, '-');

  // Step 4: Remove leading and trailing dashes
  const finalSlug = afterMergeDash.replace(/^-|-$/g, '').trim();

  if (finalSlug.length === 0) return 'untitled-' + Date.now();

  const result = preserveCase ? finalSlug : finalSlug.toLowerCase();
  // Win32 reserves these basenames even when no extension is present. Prefix
  // rather than suffix so the result remains a readable, deterministic slug
  // and cannot become reserved again after trailing punctuation is stripped.
  return WINDOWS_RESERVED_BASENAME.test(result) ? `untitled-${result}` : result;
}

// v1.25.10 PATCH Issue #366 — Turkish-aware case fold for *comparison*
// keys.
//
// `slugKeys` is used to compare "do these two names denote the same thing"
// across pages and across the link graph. For Turkish-language vaults a
// plain `.toLowerCase()` is not enough — `I` and `İ` are different
// letters in Turkish and `Ş`/`Ğ` are not in the ASCII fold at all.
//
// We do NOT change `computeSlug`'s output (the file-naming path) —
// existing users' filenames stay byte-identical. The fold only affects
// the comparison keys, so the plugin now recognises a wikilink target
// that exists under either spelling.
//
// Pure function, easily unit-tested. The six-letter fold runs in a
// single regex + map pass (one allocation per match), avoiding the
// chained `.replace` that would otherwise re-scan the text six times.
const TURKISH_FOLD: Readonly<Record<string, string>> = {
  'İ': 'i', 'Ş': 'ş', 'Ğ': 'ğ', 'Ü': 'ü', 'Ö': 'ö', 'Ç': 'ç',
};
export function turkishCaseFold(text: string): string {
  return text.replace(/[İŞĞÜÖÇ]/g, ch => TURKISH_FOLD[ch]).toLowerCase();
}

// Issue #312 — comparison keys for "do these two names denote the same thing".
// Returns the slugified forms of a name plus its aliases in the
// comparison-key form. The fold strategy is opt-in via the second
// argument so non-Turkish vaults stay on the cheap ASCII path.
//
// Pure and allocation-cheap: the merge path calls it once per page write.
export function slugKeys(
  name: string,
  aliases: readonly string[] = [],
  opts: { turkishFold?: boolean } = {},
): Set<string> {
  const keys = new Set<string>();
  const fold = opts.turkishFold === true;
  for (const raw of [name, ...aliases]) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Fold BEFORE slugifying so that `[[İsim]]` and `[[isim]]` collapse
    // to the same comparison key inside a Turkish vault. ASCII `I`
    // lowercase remains `i`, but `İ` is folded to `i` first, so both
    // inputs land on `isim` via the same `computeSlug` path.
    const folded = fold ? turkishCaseFold(trimmed) : trimmed;
    const slugged = computeSlug(folded);
    if (slugged.length === 0) continue;
    keys.add(slugged);
  }
  return keys;
}

// Filter out aliases that are redundant against a page's own filename.
// Obsidian resolves `[[X]]` to a file whose basename equals X (case-insensitive),
// so an alias that already equals the filename is a self-pointing no-op that only
// clutters frontmatter. This commonly happens on cross-type collisions where the
// colliding name is identical to the existing page's name (e.g. adding "Vigilanz"
// to vigilanz.md). Comparison is exact case-insensitive basename match — NOT slug
// based — because Obsidian does not collapse spaces/symbols when resolving links,
// so a space-variant like "Deep Learning" on deep-learning.md IS a useful alias
// and must be kept.
// Pure function (no IO) so the dedup rule can be unit-tested in isolation.
//
// v1.25.10 PATCH alias hardening:
//   - `MIN_ALIAS_LENGTH` floor (2 chars). One-character aliases carry no
//     dedup value above the page basename and collide with everything;
//     two-character aliases (ML / HD / CD / AI / UI / ...) are common in
//     real-world vaults and would be too aggressive to drop, so the
//     floor is 2, not 3. Tunable per-vault via the setting of the
//     same name; pass-through callers (existing code paths) keep
//     v1.25.9 behaviour because the default matches the threshold
//     they implicitly assumed was being applied.
//   - Optional `existingAliasesAcrossPages` argument lets callers (alias
//     completion, merge triage) reject candidates that would create a
//     wikilink ambiguity by overlapping with an alias already on
//     another page. Pass-through by default — v1.25.9 callers
//     unchanged.
//
// The constant itself lives in `src/constants.ts` so it can be
// tuned centrally without grepping the codebase.
export function filterRedundantAliases(
  pagePath: string,
  candidateAliases: string[],
  existingAliasesAcrossPages?: readonly string[],
): string[] {
  const fileName = pagePath.replace(/\\/g, '/').split('/').pop() || '';
  const fileKey = windowsEquivalentIdentity(fileName.replace(/\.md$/i, '').trim());
  const crossPageKeys = new Set<string>();
  if (existingAliasesAcrossPages) {
    for (const raw of existingAliasesAcrossPages) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed.length >= MIN_ALIAS_LENGTH) {
        crossPageKeys.add(windowsEquivalentIdentity(trimmed));
      }
    }
  }
  const seen = new Set<string>();
  return candidateAliases.filter(alias => {
    if (typeof alias !== 'string') return false;
    const trimmed = alias.trim();
    if (trimmed.length < MIN_ALIAS_LENGTH) return false;
    const key = windowsEquivalentIdentity(trimmed);
    if (key === fileKey) return false; // already resolves to this file — redundant
    if (crossPageKeys.has(key)) return false; // already used on another page — wikilink ambiguity
    if (seen.has(key)) return false; // duplicate within the batch (case-insensitive)
    seen.add(key);
    return true;
  });
}
