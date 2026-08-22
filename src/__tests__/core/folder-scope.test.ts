import { describe, it, expect } from 'vitest';
import {
  folderScopePrefix,
  isInFolderScope,
  isAtOrInFolderScope,
  isExcludedFromSourcePicker,
} from '../../core/folder-scope';

describe('folderScopePrefix', () => {
  it('anchors a folder path on a trailing slash', () => {
    expect(folderScopePrefix('Notizen', false)).toBe('Notizen/');
    expect(folderScopePrefix('a/b', false)).toBe('a/b/');
  });

  it('returns an empty prefix for the vault root', () => {
    expect(folderScopePrefix('/', true)).toBe('');
    expect(folderScopePrefix('', true)).toBe('');
  });

  it('does not double the separator on an already-trailing slash', () => {
    expect(folderScopePrefix('Notizen/', false)).toBe('Notizen/');
    expect(folderScopePrefix('Notizen//', false)).toBe('Notizen/');
  });

  it('treats an empty non-root path as unscoped rather than emitting a bare slash', () => {
    expect(folderScopePrefix('', false)).toBe('');
  });
});

describe('isInFolderScope', () => {
  it('matches true descendants at any depth', () => {
    expect(isInFolderScope('Notizen/a.md', 'Notizen', false)).toBe(true);
    expect(isInFolderScope('Notizen/sub/deep/a.md', 'Notizen', false)).toBe(true);
  });

  // Issue #364, the reported case.
  it('does not match a sibling folder sharing a name prefix', () => {
    expect(isInFolderScope('Notizen-temp/a.md', 'Notizen', false)).toBe(false);
    expect(isInFolderScope('Notizen2/a.md', 'Notizen', false)).toBe(false);
  });

  // Same root cause, second symptom: an unanchored prefix also swallows a
  // file that merely starts with the folder's name.
  it('does not match a file sitting beside the folder', () => {
    expect(isInFolderScope('Notizen.md', 'Notizen', false)).toBe(false);
  });

  it('does not match the folder itself', () => {
    expect(isInFolderScope('Notizen', 'Notizen', false)).toBe(false);
  });

  it('scopes nested folders without leaking into name-prefixed neighbours', () => {
    expect(isInFolderScope('a/b/x.md', 'a/b', false)).toBe(true);
    expect(isInFolderScope('a/bc/x.md', 'a/b', false)).toBe(false);
  });

  it('accepts every path at the vault root', () => {
    expect(isInFolderScope('a.md', '/', true)).toBe(true);
    expect(isInFolderScope('deep/nested/a.md', '/', true)).toBe(true);
  });

  it('is unaffected by the folder name appearing later in the path', () => {
    expect(isInFolderScope('Archiv/Notizen/a.md', 'Notizen', false)).toBe(false);
  });

  it('treats Windows separators, case, NFC, and trailing dot/space spelling as the same path', () => {
    expect(isInFolderScope('WIKI.\\Notes\\Cafe\u0301.md ', 'wiki', false)).toBe(true);
    expect(isInFolderScope('wiki\\Notes\\café.md', 'WIKI. ', false)).toBe(true);
  });

  it('does not let rooted, device, ADS, traversal, or reserved-name paths enter a relative scope', () => {
    expect(isInFolderScope('C:\\vault\\wiki\\a.md', 'wiki', false)).toBe(false);
    expect(isInFolderScope('\\\\?\\C:\\vault\\wiki\\a.md', 'wiki', false)).toBe(false);
    expect(isInFolderScope('wiki\\a.md:secret', 'wiki', false)).toBe(false);
    expect(isInFolderScope('wiki\\..\\wiki\\a.md', 'wiki', false)).toBe(false);
    expect(isInFolderScope('wiki\\CON\\a.md', 'wiki', false)).toBe(false);
  });
});

describe('isAtOrInFolderScope', () => {
  it('matches the folder itself — the case isInFolderScope refuses', () => {
    expect(isAtOrInFolderScope('Notizen', 'Notizen', false)).toBe(true);
  });

  it('still matches descendants at any depth', () => {
    expect(isAtOrInFolderScope('Notizen/a.md', 'Notizen', false)).toBe(true);
    expect(isAtOrInFolderScope('Notizen/sub/deep/a.md', 'Notizen', false)).toBe(true);
  });

  it('still refuses sibling folders and adjacent files', () => {
    expect(isAtOrInFolderScope('Notizen-temp/a.md', 'Notizen', false)).toBe(false);
    expect(isAtOrInFolderScope('Notizen.md', 'Notizen', false)).toBe(false);
  });

  it('normalises a trailing slash on the folder path', () => {
    expect(isAtOrInFolderScope('Notizen', 'Notizen/', false)).toBe(true);
    expect(isAtOrInFolderScope('Notizen/a.md', 'Notizen/', false)).toBe(true);
  });

  it('uses Windows path identity for folder equality, including Unicode and trailing spelling', () => {
    expect(isAtOrInFolderScope('Cafe\u0301', 'café. ', false)).toBe(true);
    expect(isAtOrInFolderScope('WIKI\\Notes', 'wiki', false)).toBe(true);
    expect(isAtOrInFolderScope('C:\\vault\\wiki', 'wiki', false)).toBe(false);
  });
});

describe('isExcludedFromSourcePicker', () => {
  it('excludes the wiki folder itself', () => {
    expect(isExcludedFromSourcePicker('wiki', 'wiki', '.obsidian')).toBe(true);
  });

  it('excludes wiki descendants at any depth', () => {
    expect(isExcludedFromSourcePicker('wiki/entities', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('wiki/sources/deep', 'wiki', '.obsidian')).toBe(true);
  });

  it('keeps a sibling folder sharing the wiki name prefix', () => {
    expect(isExcludedFromSourcePicker('wiki-archive', 'wiki', '.obsidian')).toBe(false);
  });

  it('keeps an unrelated user folder', () => {
    expect(isExcludedFromSourcePicker('Notes', 'wiki', '.obsidian')).toBe(false);
  });

  it('excludes the config directory and its descendants', () => {
    expect(isExcludedFromSourcePicker('.obsidian/plugins', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('.obsidian/plugins/foo/bar', 'wiki', '.obsidian')).toBe(true);
  });

  it('excludes hidden folders without excluding ordinary dotted names', () => {
    expect(isExcludedFromSourcePicker('.obsidian-backup/x.md', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('notes/.trash/x.md', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('notes/.draft/x.md', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('notes/archive.hidden/x.md', 'wiki', '.obsidian')).toBe(false);
  });

  it('keeps the vault root selectable', () => {
    expect(isExcludedFromSourcePicker('/', 'wiki', '.obsidian')).toBe(false);
  });

  it('excludes invalid Windows identities and device paths from source pickers', () => {
    expect(isExcludedFromSourcePicker('C:\\vault\\Notes', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('Notes\\draft.md:secret', 'wiki', '.obsidian')).toBe(true);
    expect(isExcludedFromSourcePicker('Notes\\CON\\draft.md', 'wiki', '.obsidian')).toBe(true);
  });
});
