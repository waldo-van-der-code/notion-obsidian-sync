'use strict';
const { validateFields, parseFile, renderFile, LOCAL_MARKER } = require('../convert');

// Fixture category set used by all validateFields tests that touch categories.
// Mirrors a typical personal todos config with mixed-case entries.
const TEST_CATEGORIES = new Set(['KA', 'ABnB', 'laptop', 'claude', 'Biztrix']);
const TEST_CATEGORY_ALIASES = new Map([...TEST_CATEGORIES].map(v => [v.toLowerCase(), v]));
const catOpts = { validCategories: TEST_CATEGORIES, categoryAliases: TEST_CATEGORY_ALIASES };

describe('validateFields', () => {
  describe('returns { errors, corrected }', () => {
    it('returns no errors and corrected object for valid input', () => {
      const { errors, corrected } = validateFields({
        status: 'Backlog', horizon: 'Now', outcome: '', categories: ['KA'],
      }, catOpts);
      expect(errors).toEqual([]);
      expect(corrected.status).toBe('Backlog');
      expect(corrected.categories).toEqual(['KA']);
    });

    it('errors on genuinely unknown status', () => {
      const { errors } = validateFields({ status: 'Wontfix', horizon: '', outcome: '', categories: [] });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/Invalid status/);
    });

    it('errors on genuinely unknown category', () => {
      const { errors } = validateFields({ status: 'Backlog', horizon: '', outcome: '', categories: ['nonexistent-xyz'] }, catOpts);
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/Invalid category/);
    });
  });

  describe('case-insensitive normalisation', () => {
    it('corrects lowercase outcome "completed" → "Completed"', () => {
      const { errors, corrected } = validateFields({
        status: 'Backlog', horizon: '', outcome: 'completed', categories: [],
      });
      expect(errors).toEqual([]);
      expect(corrected.outcome).toBe('Completed');
    });

    it('corrects lowercase status "backlog" → "Backlog"', () => {
      const { errors, corrected } = validateFields({
        status: 'backlog', horizon: '', outcome: '', categories: [],
      });
      expect(errors).toEqual([]);
      expect(corrected.status).toBe('Backlog');
    });

    it('corrects "in progress" → "In progress" (multi-word)', () => {
      const { errors, corrected } = validateFields({
        status: 'in progress', horizon: '', outcome: '', categories: [],
      });
      expect(errors).toEqual([]);
      expect(corrected.status).toBe('In progress');
    });

    it('corrects lowercase category "ka" → "KA"', () => {
      const { errors, corrected } = validateFields({
        status: 'Backlog', horizon: '', outcome: '', categories: ['ka'],
      }, catOpts);
      expect(errors).toEqual([]);
      expect(corrected.categories).toEqual(['KA']);
    });

    it('preserves ABnB correctly — does not mangle mixed-case categories', () => {
      const { errors, corrected } = validateFields({
        status: 'Backlog', horizon: '', outcome: '', categories: ['abnb'],
      }, catOpts);
      expect(errors).toEqual([]);
      expect(corrected.categories).toEqual(['ABnB']);
    });

    it('corrects "laptop" category (was removed, now restored)', () => {
      const { errors, corrected } = validateFields({
        status: 'Backlog', horizon: '', outcome: '', categories: ['laptop'],
      }, catOpts);
      expect(errors).toEqual([]);
      expect(corrected.categories).toContain('laptop');
    });
  });
});

describe('parseFile', () => {
  it('parses a well-formed file', () => {
    const content = [
      '---',
      'notion_id: abc-123',
      'status: Backlog',
      'horizon: Now',
      'outcome:',
      'category: KA, claude',
      'last_synced_at: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# My task',
      '',
      'Some body text.',
      '',
      LOCAL_MARKER,
      'local note',
    ].join('\n');

    const parsed = parseFile(content);
    expect(parsed.title).toBe('My task');
    expect(parsed.status).toBe('Backlog');
    expect(parsed.categories).toEqual(['KA', 'claude']);
    expect(parsed.body).toBe('Some body text.');
    expect(parsed.localNotes).toBe('local note');
  });

  it('returns null for content with no frontmatter', () => {
    expect(parseFile('# Just a heading\n\nNo frontmatter.')).toBeNull();
  });
});

describe('renderFile', () => {
  it('places sync-error comment in local notes section, not in body', () => {
    const rendered = renderFile({
      notion_id: 'abc',
      title: 'Test',
      status: 'Backlog',
      horizon: 'Now',
      outcome: '',
      categories: [],
      body: 'Some content',
      localNotes: '<!-- sync-error: something went wrong -->',
    });
    const bodyPart = rendered.split(LOCAL_MARKER)[0];
    const notesPart = rendered.split(LOCAL_MARKER)[1];
    expect(bodyPart).not.toContain('sync-error');
    expect(notesPart).toContain('sync-error');
  });
});
