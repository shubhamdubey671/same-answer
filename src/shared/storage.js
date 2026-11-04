/**
 * chrome.storage.local wrapper for saved question/answer pairs.
 *
 * Every answer belongs to one site. Naukri and LinkedIn ask differently shaped
 * questions ("Notice period?" is free text on naukri but a number on
 * LinkedIn), so an answer learned on one site is never used on the other.
 * The site is part of the storage key: `q::<question>` for naukri (the
 * original prefix, so older data and backups still load) and
 * `li::<question>` for LinkedIn. Every method takes the site; it defaults to
 * naukri for the original naukri content script.
 *
 * Shape of a stored record (keyed by site prefix + normalized question):
 *   {
 *     question: "Original question text as shown to the user",
 *     answer: "value" | ["value1", "value2"],   // most recent answer
 *     type: "text" | "radio" | "chips" | "dropdown" | "checkbox" | "textarea"
           | "typeahead" | "unknown",
 *     choices: [                                 // option questions only
 *       { options: ["Pune", "Bangalore"], answer: "Bangalore", at: 1710000000000 }
 *     ],
 *     lastUsed: 1710000000000,
 *     usageCount: 3
 *   }
 *
 * `choices` is what makes option questions safe to auto-fill: every time the
 * user picks X out of a set of options we learn "X beats each other option".
 * A later question is only auto-filled when one of the options on screen is
 * known to beat every other option on screen — so "Bangalore out of Pune,
 * Bangalore" never auto-answers "Noida, Bangalore, Pune". See pickAnswer().
 *
 * Loaded both by the content script and the popup, so it must not assume a DOM.
 * Named `AnswerStore` rather than `Storage` to avoid clashing with the built-in
 * window.Storage global.
 */
const AnswerStore = {
  /** Storage-key prefix per site. Nothing else in local storage uses these. */
  SITES: {
    naukri: { prefix: 'q::', label: 'Naukri' },
    linkedin: { prefix: 'li::', label: 'LinkedIn' },
  },
  DEFAULT_SITE: 'naukri',

  /** Key of the activity log (see log()). */
  LOG_KEY: 'activityLog',
  LOG_LIMIT: 200,

  /** Per-question cap on remembered choices. */
  CHOICE_LIMIT: 30,

  /** Bumped when the export format changes. 2: per-site keys. */
  EXPORT_VERSION: 2,

  /** `app` field of a backup file; older files say 'quickapply' or 'naukri-autofill'. */
  EXPORT_APP: 'same-answer',
  IMPORTABLE_APPS: ['same-answer', 'quickapply', 'naukri-autofill'],

  /**
   * Normalize a question into a stable storage key:
   * lowercase, trim, collapse all whitespace runs into single spaces.
   */
  normalizeKey(question) {
    if (!question) return '';
    return String(question).replace(/\s+/g, ' ').trim().toLowerCase();
  },

  /** Prefix for a site; throws on a typo rather than writing to nowhere. */
  _prefix(site = this.DEFAULT_SITE) {
    const entry = this.SITES[site];
    if (!entry) throw new Error(`Unknown site "${site}"`);
    return entry.prefix;
  },

  /** Storage key of a question on a site. */
  storageKey(question, site) {
    return this._prefix(site) + this.normalizeKey(question);
  },

  /** Which site a storage key belongs to, or null when it is not an answer. */
  siteOf(storageKey) {
    return (
      Object.keys(this.SITES).find((site) => String(storageKey).startsWith(this.SITES[site].prefix)) ||
      null
    );
  },

  isAnswerKey(storageKey) {
    return this.siteOf(storageKey) !== null;
  },

  /**
   * Look up a saved answer on one site.
   * @returns {Promise<Object|null>} the record, or null when nothing is saved.
   */
  async get(question, site) {
    if (!this.normalizeKey(question)) return null;
    const key = this.storageKey(question, site);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  },

  /**
   * Save (or overwrite) an answer. Preserves usageCount across overwrites.
   *
   * With `options` (the choices that were on screen), the pick is appended to
   * the record's choice history. Without it — a text answer, or an edit from
   * the popup — the history is cleared and `answer` becomes the rule: "answer
   * this whenever it is one of the options".
   *
   * @param {string} question raw question text
   * @param {string|string[]} answer
   * @param {string} type see INPUT_TYPES (naukri) and LI_TYPES (LinkedIn)
   * @param {string[]} [options] labels of every option that was offered
   * @param {string} [site] key of SITES; defaults to naukri
   */
  async set(question, answer, type, options, site) {
    if (!this.normalizeKey(question)) {
      console.warn('[Same Answer] Refusing to store an answer for an empty question.');
      return null;
    }

    const key = this.storageKey(question, site);
    const existing = await this.get(question, site);

    let choices = [];
    if (Array.isArray(options) && options.length > 1) {
      choices = (existing && existing.choices) || [];
      choices = choices
        .concat({ options: options.slice(), answer, at: Date.now() })
        .slice(-this.CHOICE_LIMIT);
    }

    const record = {
      question: String(question).replace(/\s+/g, ' ').trim(),
      answer,
      type,
      choices,
      lastUsed: Date.now(),
      usageCount: existing ? existing.usageCount || 0 : 0,
    };

    await chrome.storage.local.set({ [key]: record });
    return record;
  },

  /**
   * Decide what to answer given the options currently on screen.
   *
   * @param {Object} record a stored record
   * @param {string[]} [options] labels on screen; omit for text questions
   * @returns {{answer: string|null, reason: string}} answer is one of
   *   `options` (as given), or null when the user should decide.
   */
  pickAnswer(record, options) {
    const stored = Array.isArray(record.answer) ? record.answer[0] : record.answer;

    // Text: nothing to choose between.
    if (!options || !options.length) {
      return { answer: stored || null, reason: 'saved answer' };
    }

    const norm = (s) => this.normalizeKey(s);
    const onScreen = options.map(norm);
    const choices = record.choices || [];

    // No history (older record, or edited in the popup): the answer is a rule.
    if (!choices.length) {
      const i = onScreen.indexOf(norm(stored));
      return i >= 0
        ? { answer: options[i], reason: 'saved answer' }
        : { answer: null, reason: `saved answer "${stored}" is not among the options` };
    }

    // Pairwise preferences, oldest pick first so newer picks override: picking
    // A over B deletes any earlier "B beats A".
    const beats = new Map(); // winner -> Set(loser)
    for (const choice of choices) {
      const winner = norm(choice.answer);
      for (const opt of choice.options.map(norm)) {
        if (opt === winner) continue;
        if (!beats.has(winner)) beats.set(winner, new Set());
        beats.get(winner).add(opt);
        if (beats.has(opt)) beats.get(opt).delete(winner);
      }
    }

    // Transitive: A beats B and B beats C means A beats C.
    const reaches = (from, to) => {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        const node = queue.shift();
        for (const next of beats.get(node) || []) {
          if (next === to) return true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };

    const winners = onScreen.filter((candidate) =>
      onScreen.every(
        (other) => other === candidate || (reaches(candidate, other) && !reaches(other, candidate))
      )
    );

    if (winners.length === 1) {
      return { answer: options[onScreen.indexOf(winners[0])], reason: 'learned preference' };
    }
    return { answer: null, reason: 'new set of options — not sure which you prefer' };
  },

  /**
   * Bump usage stats after an answer was successfully auto-filled.
   */
  async touch(question, site) {
    const record = await this.get(question, site);
    if (!record) return null;

    record.usageCount = (record.usageCount || 0) + 1;
    record.lastUsed = Date.now();

    await chrome.storage.local.set({ [this.storageKey(question, site)]: record });
    return record;
  },

  /**
   * Every saved record, from every site.
   * @returns {Promise<Array<Object>>} records with `storageKey`, `site` and
   *   `key` (the normalized question) fields.
   */
  async getAll() {
    const all = await chrome.storage.local.get(null);

    return Object.keys(all)
      .filter((k) => this.isAnswerKey(k))
      .map((k) => {
        const site = this.siteOf(k);
        return { storageKey: k, site, key: k.slice(this.SITES[site].prefix.length), ...all[k] };
      })
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  },

  /** Delete one record by its storage key (as returned by getAll). */
  async delete(storageKey) {
    if (!this.isAnswerKey(storageKey)) return;
    await chrome.storage.local.remove(storageKey);
  },

  /** Delete every saved answer on every site, leaving other keys (the log) untouched. */
  async clear() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => this.isAnswerKey(k));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  },

  // --- Activity log -----------------------------------------------------

  /** Serializes log writes so concurrent entries don't overwrite each other. */
  _logQueue: Promise.resolve(),

  /**
   * Append one entry to the activity log, newest first.
   * @param {{question: string, type?: string, outcome: string, answer?: string,
   *   options?: string[], detail?: string}} entry
   */
  log(entry) {
    this._logQueue = this._logQueue
      .then(async () => {
        const result = await chrome.storage.local.get(this.LOG_KEY);
        const entries = result[this.LOG_KEY] || [];
        entries.unshift({ at: Date.now(), ...entry });
        await chrome.storage.local.set({ [this.LOG_KEY]: entries.slice(0, this.LOG_LIMIT) });
      })
      .catch((err) => console.warn('[Same Answer] Could not write activity log:', err));
    return this._logQueue;
  },

  async getLog() {
    const result = await chrome.storage.local.get(this.LOG_KEY);
    return result[this.LOG_KEY] || [];
  },

  async clearLog() {
    await chrome.storage.local.remove(this.LOG_KEY);
  },

  // --- Settings ---------------------------------------------------------

  SETTINGS_KEY: 'settings',

  /** Defaults for anything the user has not changed. */
  SETTINGS_DEFAULTS: {
    /**
     * Click "Submit application" on LinkedIn once every field is filled. Off
     * by default: LinkedIn's terms forbid automated tools, and a submit is
     * the one click that cannot be taken back.
     */
    linkedinAutoSubmit: false,
  },

  async getSettings() {
    const result = await chrome.storage.local.get(this.SETTINGS_KEY);
    return { ...this.SETTINGS_DEFAULTS, ...(result[this.SETTINGS_KEY] || {}) };
  },

  async setSettings(patch) {
    const settings = { ...(await this.getSettings()), ...patch };
    await chrome.storage.local.set({ [this.SETTINGS_KEY]: settings });
    return settings;
  },

  // --- Backup -----------------------------------------------------------

  /** Everything worth keeping, as a plain object ready for JSON.stringify. */
  async exportAll() {
    const all = await chrome.storage.local.get(null);
    const records = {};
    Object.keys(all)
      .filter((k) => this.isAnswerKey(k))
      .forEach((k) => {
        records[k] = all[k];
      });
    return { app: this.EXPORT_APP, version: this.EXPORT_VERSION, exportedAt: Date.now(), records };
  },

  /**
   * Merge a backup into storage. For a question present on both sides, the
   * copy used most recently wins. Version 1 backups predate LinkedIn support,
   * so their `q::` keys are naukri answers, which is what that prefix means.
   * @returns {Promise<{added: number, updated: number, skipped: number}>}
   */
  async importAll(data) {
    if (!data || !this.IMPORTABLE_APPS.includes(data.app) || typeof data.records !== 'object') {
      throw new Error('This file is not a Same Answer backup.');
    }

    const all = await chrome.storage.local.get(null);
    const toWrite = {};
    const stats = { added: 0, updated: 0, skipped: 0 };

    for (const [key, record] of Object.entries(data.records)) {
      if (!this.isAnswerKey(key) || !record || !record.question) {
        stats.skipped += 1;
        continue;
      }
      const current = all[key];
      if (!current) {
        toWrite[key] = record;
        stats.added += 1;
      } else if ((record.lastUsed || 0) > (current.lastUsed || 0)) {
        toWrite[key] = record;
        stats.updated += 1;
      } else {
        stats.skipped += 1;
      }
    }

    if (Object.keys(toWrite).length) await chrome.storage.local.set(toWrite);
    return stats;
  },
};
