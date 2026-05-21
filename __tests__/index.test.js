'use strict';
const { injectSyncError, clearSyncError } = require('../index-helpers');

describe('sync-error comment injection', () => {
  const LOCAL_MARKER = '<!-- local: notes below this line are not synced to Notion -->';

  it('injectSyncError appends error comment below local marker', () => {
    const content = [
      '---',
      'status: Backlog',
      '---',
      '',
      '# Title',
      '',
      LOCAL_MARKER,
      '',
    ].join('\n');

    const result = injectSyncError(content, 'Invalid category "xyz"');
    const parts = result.split(LOCAL_MARKER);
    expect(parts[0]).not.toContain('sync-error');
    expect(parts[1]).toContain('<!-- sync-error: Invalid category "xyz"');
  });

  it('injectSyncError replaces existing sync-error comment (no duplicates)', () => {
    const content = [
      '---',
      'status: Backlog',
      '---',
      '',
      '# Title',
      '',
      LOCAL_MARKER,
      '<!-- sync-error: old error -->',
    ].join('\n');

    const result = injectSyncError(content, 'new error');
    const count = (result.match(/sync-error/g) || []).length;
    expect(count).toBe(1);
    expect(result).toContain('new error');
    expect(result).not.toContain('old error');
  });

  it('clearSyncError removes sync-error comment', () => {
    const content = [
      '---',
      'status: Backlog',
      '---',
      '',
      '# Title',
      '',
      LOCAL_MARKER,
      '<!-- sync-error: something broke -->',
    ].join('\n');

    const result = clearSyncError(content);
    expect(result).not.toContain('sync-error');
  });

  it('clearSyncError is a no-op when no sync-error present', () => {
    const content = '---\nstatus: Backlog\n---\n\n# Title\n\n' + LOCAL_MARKER + '\n';
    expect(clearSyncError(content)).toBe(content);
  });

  it('does not touch the body section (above the marker)', () => {
    const content = [
      '---',
      'status: Backlog',
      '---',
      '',
      '# Title',
      '',
      'Body paragraph.',
      '',
      LOCAL_MARKER,
      '',
    ].join('\n');

    const injected = injectSyncError(content, 'error msg');
    expect(injected.split(LOCAL_MARKER)[0]).toContain('Body paragraph.');
    expect(injected.split(LOCAL_MARKER)[0]).not.toContain('sync-error');
  });
});
