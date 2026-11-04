/**
 * LinkedIn Easy Apply — content script.
 *
 * Easy Apply is a multi-step form in a modal. For every step:
 *
 *   1. Fields that already have a value (LinkedIn pre-fills contact info and
 *      answers it saved from earlier applications) are left alone.
 *   2. Empty fields are answered from answers learned on LinkedIn — never
 *      from naukri's, which are shaped differently (see storage.js).
 *   3. If nothing is left empty, the footer button is clicked: Next, Review,
 *      and — when enabled in the popup — Submit application.
 *   4. If something is left for you, the script waits. When you click the
 *      footer button yourself, whatever you typed is remembered, and saved
 *      once LinkedIn accepts the step.
 *
 * After submitting, the "Your application was sent" modal is closed with
 * "Not now".
 *
 * Every selector lives in linkedin-selectors.js (`LiDOM.*`); storage goes
 * through `AnswerStore`.
 */

(() => {
  'use strict';

  if (window.__sameAnswerLinkedIn) return;
  window.__sameAnswerLinkedIn = true;

  const LOG = '[Same Answer · LinkedIn]';

  /** Answers are per site: only LinkedIn answers are read or written here. */
  const SITE = 'linkedin';
  const log = (...args) => console.log(LOG, ...args);
  const warn = (...args) => console.warn(LOG, ...args);

  // --- Tunables ---------------------------------------------------------

  /** LinkedIn's feed mutates constantly; look at most this often. */
  const CHECK_INTERVAL = 150;

  /** A step renders in pieces; wait for it to hold still before filling. */
  const STEP_SETTLE = 200;

  /** Short pause between fields, so each one lands before the next. */
  const FILL_DELAY_MIN = 100;
  const FILL_DELAY_MAX = 200;

  /** After filling, let LinkedIn's bindings catch up before clicking Next. */
  const PRE_CLICK_DELAY = 150;

  /** How long to wait for location suggestions to load. */
  const TYPEAHEAD_TIMEOUT = 5000;

  /**
   * After clicking Next, how long before we decide LinkedIn rejected it.
   * Checked in the background: the next step is handled as soon as it shows.
   */
  const ADVANCE_CHECK_DELAY = 1500;

  /** How long the success modal's "Not now" may take to appear. */
  const SUCCESS_BUTTON_TIMEOUT = 2000;

  /** Selects with more options than this are stored as a plain rule. */
  const MAX_LEARNED_OPTIONS = 20;

  /**
   * Questions asking where you live: "Location (city)", "City", "Current
   * location". Any of them can reuse your last LinkedIn answer to another.
   * Short labels only, so "Are you open to relocation to <city>?" and the
   * like are left alone.
   */
  const LOCATION_QUESTION = /\b(location|city)\b/i;
  const LOCATION_LABEL_MAX = 40;
  const isLocationField = (field) =>
    (field.type === LI_TYPES.TYPEAHEAD || field.type === LI_TYPES.TEXT) &&
    field.question.length <= LOCATION_LABEL_MAX &&
    LOCATION_QUESTION.test(field.question);

  /**
   * Questions that mean the same thing however a company words them:
   * "Mention your Expected CTC." and "Please enter your expected ctc in INR".
   * A question with no saved answer reuses your newest answer to another of
   * the same kind. Kept narrow on purpose — a wrong guess is worse than
   * asking. `unit` tells apart questions that want the same thing in a
   * different unit (LPA vs rupees, days vs months); two questions whose units
   * are both known must agree.
   */
  const SIMILAR_QUESTIONS = [
    {
      kind: 'expected pay',
      test: /\b(expected|desired)\b.*\b(ctc|salary|compensation|package)\b/,
      // "Expected hike %" wants a percentage, not an amount.
      unless: /hike|increment|percent|%/,
      unit: (q) => (/\b(lpa|lakhs?|lacs?)\b/.test(q) ? 'lpa' : 'inr'),
    },
    {
      kind: 'current pay',
      test: /\b(current|present|last drawn)\b.*\b(ctc|salary|compensation|package)\b/,
      unless: /\b(variable|bonus|incentives?|esops?|stocks?)\b|hike|increment|percent|%/,
      unit: (q) => (/\b(lpa|lakhs?|lacs?)\b/.test(q) ? 'lpa' : 'inr'),
    },
    {
      kind: 'notice period',
      test: /\bnotice period\b/,
      // "Last working day (if serving notice period)", "Is it negotiable?":
      // about the notice period, but not asking for its length.
      unless: /\b(last working|serving|buy ?out|negotiable)\b/,
      unit: (q) => (q.match(/\b(days|weeks|months)\b/) || [])[1] || null,
    },
    {
      kind: 'linkedin url',
      test: /\blinkedin\b.*\b(url|profile|link)\b|^linkedin$/,
    },
    {
      kind: 'total experience',
      test: /\b(total|overall)\b.*\bexperience\b|^how many years (of )?(professional |work )?experience do you have\??$/,
      // "... experience as a Frontend Developer", "... in Angular": a
      // specific skill, not your career total.
      unless: /\bmonths?\b|\brelevant\b|experience (as|with|on)\b|experience in (?!years?\b)/,
    },
  ];

  const similarKind = (question) => {
    const q = AnswerStore.normalizeKey(question);
    const match = SIMILAR_QUESTIONS.find((s) => s.test.test(q) && !(s.unless && s.unless.test(q)));
    return match ? { kind: match.kind, unit: match.unit ? match.unit(q) : null } : null;
  };

  /** How long a status message stays up, unless it is waiting on you. */
  const STATUS_TIMEOUT = 8000;

  // --- State ------------------------------------------------------------

  const state = {
    /**
     * The step being handled: {signature, fields: Map(id -> {initialEmpty,
     * filled})}. `filled` is what we typed, so it is not "learned" back.
     */
    step: null,
    /** Answers you gave, read when you clicked the footer button. */
    snapshot: null,
    /** Signatures we already clicked forward on — never click twice. */
    advanced: new Set(),
    /**
     * Steps (progress + heading) we handed to you. A follow-up question
     * appearing there changes the signature, but must not make us click Next
     * while you are still typing.
     */
    handedOver: new Set(),
    busy: false,
    /** A check was requested while one was running. */
    dirty: false,
    checkTimer: null,
    /** The success message we last closed, so one message is closed once. */
    lastSuccess: { text: '', at: 0 },
  };

  // --- Utilities --------------------------------------------------------

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const humanDelay = () => delay(FILL_DELAY_MIN + Math.random() * (FILL_DELAY_MAX - FILL_DELAY_MIN));
  const cleanText = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const looseEquals = (a, b) => AnswerStore.normalizeKey(a) === AnswerStore.normalizeKey(b);
  const isEmpty = (value) => (Array.isArray(value) ? !value.length : !cleanText(value));
  const sameValue = (a, b) =>
    Array.isArray(a) || Array.isArray(b)
      ? [].concat(a).map(AnswerStore.normalizeKey).sort().join('|') ===
        [].concat(b).map(AnswerStore.normalizeKey).sort().join('|')
      : looseEquals(a, b);

  // --- On-page status ---------------------------------------------------

  let statusEl = null;
  let statusTimer = null;
  const STATUS_COLORS = { info: '#1d4ed8', wait: '#92400e', done: '#166534', error: '#b91c1c' };

  /**
   * One line in the bottom-left corner saying what the extension is doing.
   * 'wait' and 'error' stay up, since they need you; the rest fade out.
   */
  function showStatus(text, tone = 'info') {
    if (!document.body) return;
    if (!statusEl || !statusEl.isConnected) {
      statusEl = document.createElement('div');
      statusEl.setAttribute('role', 'status');
      Object.assign(statusEl.style, {
        position: 'fixed',
        left: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '380px',
        padding: '8px 12px',
        borderRadius: '8px',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#fff',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        pointerEvents: 'none',
      });
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = `Same Answer · ${text}`;
    statusEl.style.background = STATUS_COLORS[tone] || STATUS_COLORS.info;
    statusEl.style.display = 'block';
    clearTimeout(statusTimer);
    if (tone !== 'wait' && tone !== 'error') {
      statusTimer = setTimeout(hideStatus, STATUS_TIMEOUT);
    }
  }

  function hideStatus() {
    clearTimeout(statusTimer);
    if (statusEl) statusEl.style.display = 'none';
  }

  const shorten = (text, max = 50) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  async function waitFor(fn, timeout, interval = 150) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = fn();
      if (result) return result;
      await delay(interval);
    }
    return fn() || null;
  }

  let orphanWarned = false;
  function isOrphaned() {
    let alive = false;
    try {
      alive = !!(chrome.runtime && chrome.runtime.id && chrome.storage);
    } catch (_) {
      alive = false;
    }
    if (!alive && LiDOM.getApplyModal()) {
      showStatus('The extension was updated — refresh this tab (⌘R) to use it.', 'error');
    }
    if (!alive && !orphanWarned) {
      orphanWarned = true;
      // A log, not a warning: a stale tab after a reload is expected, and
      // chrome://extensions lists every warning as an error.
      log('The extension was reloaded or updated. REFRESH THIS TAB so answers can be saved again.');
    }
    return !alive;
  }

  /** Writes go through the background worker, as on naukri. */
  async function persist(op, ...args) {
    if (isOrphaned()) throw new Error('extension context invalidated');
    const response = await chrome.runtime.sendMessage({ op, args });
    if (!response || !response.ok) throw new Error(response ? response.error : 'no response');
    return response.result;
  }

  const activity = (entry) => persist('log', { site: SITE, ...entry }).catch(() => {});

  // --- Reading fields ---------------------------------------------------

  /** Labels of the choices a field offers; [] for free text. */
  function fieldOptions(field) {
    if (field.type === LI_TYPES.RADIO || field.type === LI_TYPES.CHECKBOX) {
      return field.inputs.map((input) => LiDOM.getOptionLabel(input));
    }
    if (field.type === LI_TYPES.SELECT) {
      return LiDOM.getSelectOptions(field.control).map((o) => o.label);
    }
    return [];
  }

  /** Current value: string, string[] for checkbox groups, '' when empty. */
  function readValue(field) {
    switch (field.type) {
      case LI_TYPES.RADIO: {
        const checked = field.inputs.find((input) => input.checked);
        return checked ? LiDOM.getOptionLabel(checked) : '';
      }
      case LI_TYPES.CHECKBOX: {
        const labels = field.inputs.filter((i) => i.checked).map((i) => LiDOM.getOptionLabel(i));
        return field.inputs.length === 1 ? labels[0] || '' : labels;
      }
      case LI_TYPES.SELECT: {
        const option = field.control.selectedOptions[0];
        const valid = LiDOM.getSelectOptions(field.control).find((o) => o.element === option);
        return valid ? valid.label : '';
      }
      case LI_TYPES.FILE:
        return '';
      default:
        return cleanText(field.control.value);
    }
  }

  // --- Filling fields ---------------------------------------------------

  /** Set a value the way a keystroke would, so Ember's bindings notice. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }

  function fillTextLike(field, answer) {
    const el = field.control;
    el.focus();
    setNativeValue(el, String(answer));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return looseEquals(el.value, answer);
  }

  function fillRadio(field, answer) {
    const input = field.inputs.find((i) => looseEquals(LiDOM.getOptionLabel(i), answer));
    if (!input) return false;
    input.click();
    if (!input.checked && input.labels && input.labels[0]) input.labels[0].click();
    return input.checked;
  }

  function fillCheckbox(field, answer) {
    const wanted = [].concat(answer);
    const targets = wanted.map((label) =>
      field.inputs.find((i) => looseEquals(LiDOM.getOptionLabel(i), label))
    );
    // A single "I agree" box may have been stored under any label.
    if (field.inputs.length === 1 && wanted.length === 1 && !targets[0]) targets[0] = field.inputs[0];
    if (targets.some((t) => !t)) return false;
    targets.forEach((input) => {
      if (!input.checked) input.click();
    });
    return targets.every((input) => input.checked);
  }

  function fillSelect(field, answer) {
    const option = LiDOM.getSelectOptions(field.control).find(
      (o) => looseEquals(o.label, answer) || looseEquals(o.value, answer)
    );
    if (!option) return false;
    const select = field.control;
    select.focus();
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.blur();
    return select.value === option.value;
  }

  /** Click the way a mouse does; typeaheads commit on mousedown, before blur. */
  function pressLikeUser(el) {
    const init = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.click();
  }

  /**
   * Location search: type the first part ("Gurugram"), wait for LinkedIn's
   * suggestions, and pick the one matching the saved answer exactly
   * ("Gurugram, Haryana, India", not "Gurugram Tehsil, …").
   */
  async function fillTypeahead(field, answer) {
    const input = field.control;
    const full = cleanText(answer);
    const query = full.split(',')[0].trim();

    input.focus();
    setNativeValue(input, '');
    setNativeValue(input, query);
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: query.slice(-1) }));

    const options = await waitFor(() => {
      const found = LiDOM.getTypeaheadOptions(input);
      return found.length ? found : null;
    }, TYPEAHEAD_TIMEOUT);
    if (!options) {
      warn(`No suggestions appeared for "${query}".`);
      return false;
    }

    const norm = AnswerStore.normalizeKey;
    const match =
      options.find((o) => looseEquals(o.text, full)) ||
      options.find((o) => norm(o.text.split(',')[0]) === norm(query)) ||
      options.find((o) => norm(o.text).startsWith(norm(query)));
    if (!match) {
      warn(`None of the suggestions match "${full}":`, options.map((o) => o.text));
      return false;
    }

    const picked = () => looseEquals(input.value, match.text);
    pressLikeUser(match.element);
    await waitFor(picked, 300, 50);

    // Keyboard fallback, for a list that ignores synthetic mouse events.
    if (!picked() && LiDOM.getTypeaheadOptions(input).length) {
      const index = LiDOM.getTypeaheadOptions(input).findIndex((o) => o.text === match.text);
      for (let i = 0; i <= index; i += 1) {
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', keyCode: 40 }));
      }
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
      await waitFor(picked, 300, 50);
    }

    return !isEmpty(input.value);
  }

  const FILLERS = {
    [LI_TYPES.TEXT]: fillTextLike,
    [LI_TYPES.TEXTAREA]: fillTextLike,
    [LI_TYPES.RADIO]: fillRadio,
    [LI_TYPES.CHECKBOX]: fillCheckbox,
    [LI_TYPES.SELECT]: fillSelect,
    [LI_TYPES.TYPEAHEAD]: fillTypeahead,
  };

  // --- Deciding ---------------------------------------------------------

  /** Your most recent LinkedIn answer to any location question, or ''. */
  async function lastLocationAnswer() {
    const records = await AnswerStore.getAll(); // newest first
    const match = records.find(
      (r) =>
        r.site === SITE &&
        typeof r.answer === 'string' &&
        r.answer.trim() &&
        (r.question || '').length <= LOCATION_LABEL_MAX &&
        LOCATION_QUESTION.test(r.question || '')
    );
    return match ? match.answer : '';
  }

  /**
   * Your newest LinkedIn answer to a differently worded question of the same
   * kind (see SIMILAR_QUESTIONS) that fits this field, or null. Text fields
   * only take text answers; option fields only an answer that is one of
   * their options.
   */
  async function similarAnswer(field) {
    const wanted = similarKind(field.question);
    if (!wanted) return null;
    const textField = field.type === LI_TYPES.TEXT || field.type === LI_TYPES.TEXTAREA;
    const options = fieldOptions(field);
    if (!textField && !options.length) return null;

    const records = await AnswerStore.getAll(); // newest first
    for (const record of records) {
      if (record.site !== SITE || typeof record.answer !== 'string' || !record.answer.trim()) continue;
      const kind = similarKind(record.question);
      if (!kind || kind.kind !== wanted.kind) continue;
      if (kind.unit && wanted.unit && kind.unit !== wanted.unit) continue;

      const reason = `similar question: "${shorten(record.question, 60)}"`;
      if (textField) {
        if (record.type === LI_TYPES.TEXT || record.type === LI_TYPES.TEXTAREA) {
          return { answer: record.answer, reason, borrowed: true };
        }
        continue;
      }
      const option = options.find((o) => looseEquals(o, record.answer));
      if (option) return { answer: option, reason, borrowed: true };
    }
    return null;
  }

  /**
   * What to put in an empty field. `borrowed`: the answer came from another
   * question, so it is saved under this one once filled.
   * @returns {Promise<{answer: string|string[]|null, reason: string, borrowed?: boolean}>}
   */
  async function decide(field, modal) {
    const record = await AnswerStore.get(field.question, SITE);

    if (!record) {
      if (isLocationField(field)) {
        const city = (await lastLocationAnswer()) || LiDOM.getProfileLocation(modal);
        if (city) return { answer: city, reason: 'your location', borrowed: true };
      }
      return (await similarAnswer(field)) || { answer: null, reason: 'no saved answer' };
    }

    if (field.type === LI_TYPES.CHECKBOX) {
      return { answer: record.answer, reason: 'saved answer' };
    }

    const options = fieldOptions(field);
    const pick = AnswerStore.pickAnswer(record, options.length ? options : undefined);
    if (pick.answer && !options.length && Array.isArray(record.answer)) {
      pick.answer = record.answer.join(', ');
    }
    return pick;
  }

  // --- Learning ---------------------------------------------------------

  /**
   * You clicked Next/Review/Submit: note every answer you gave yourself on
   * this step. Saved only once LinkedIn accepts the step (see commitSnapshot),
   * so a value LinkedIn rejects is never learned.
   */
  function takeSnapshot(kind) {
    const modal = LiDOM.getApplyModal();
    if (!modal) return;
    const signature = LiDOM.getStepSignature(modal);

    // A click on a later step means LinkedIn accepted the step the pending
    // answers came from, even if processStep never saw the change (you
    // clicked through faster than it checks). Save them before replacing them.
    if (state.snapshot && stepOf(state.snapshot.signature) !== stepOf(signature)) commitSnapshot();

    // Field ids are unique per question, so entries from a step processStep
    // has not caught up with just miss, and the field counts as yours.
    const known = state.step ? state.step.fields : new Map();
    const answers = [];
    for (const field of LiDOM.getFields(modal)) {
      if (field.type === LI_TYPES.FILE || !field.question) continue;
      const entry = known.get(field.id);
      // Pre-filled by LinkedIn: not an answer you gave.
      if (entry && !entry.initialEmpty) continue;
      const value = readValue(field);
      if (isEmpty(value)) continue;
      // Ours and untouched: already counted by touch().
      if (entry && entry.filled != null && sameValue(value, entry.filled)) continue;
      answers.push({ question: field.question, type: field.type, value, options: fieldOptions(field) });
    }

    state.snapshot = { signature, kind, answers };
  }

  function commitSnapshot() {
    const snapshot = state.snapshot;
    state.snapshot = null;
    if (!snapshot) return;

    for (const { question, type, value, options } of snapshot.answers) {
      const learnable = options.length > 1 && options.length <= MAX_LEARNED_OPTIONS && !Array.isArray(value);
      persist('set', question, value, type, learnable ? options : undefined, SITE)
        .then(() => {
          log(`Learned (${type}): "${question}" → "${[].concat(value).join(', ')}"`);
          activity({ question, type, options, outcome: 'captured', answer: [].concat(value).join(', ') });
        })
        .catch((err) => {
          warn('Failed to store answer:', err);
          activity({ question, type, outcome: 'error', detail: String(err) });
        });
    }
  }

  /** Capture-phase listener for your own clicks on the footer button. */
  function onDocumentClick(event) {
    const modal = LiDOM.getApplyModal();
    if (!modal) return;
    const action = LiDOM.getPrimaryAction(modal);
    if (action && action.element.contains(event.target)) takeSnapshot(action.kind);
  }

  // --- Steps ------------------------------------------------------------

  /** The step part of a signature (progress + headings), without field ids. */
  const stepOf = (signature) => signature.split('#').slice(0, 2).join('#');

  async function processStep(modal) {
    const signature = LiDOM.getStepSignature(modal);
    if (!signature || (state.step && state.step.signature === signature)) return;

    await delay(STEP_SETTLE);
    if (!modal.isConnected || LiDOM.getStepSignature(modal) !== signature) return;

    // LinkedIn moved on, so whatever you answered on the last step was
    // accepted. A follow-up question on the same step is not moving on: the
    // answers may still be rejected.
    const base = stepOf(signature);
    if (state.snapshot && stepOf(state.snapshot.signature) !== base) commitSnapshot();

    const fields = LiDOM.getFields(modal);
    // Field ids are unique per question, so carrying entries over keeps what
    // you already typed marked as yours when a follow-up question appears.
    const previous = state.step ? state.step.fields : new Map();
    state.step = { signature, fields: new Map() };
    log(`Step: ${base.replace('#', ' · ')} (${fields.length} field(s))`);

    const leftForYou = [];
    let filledCount = 0;
    showStatus(`Checking ${fields.length} field(s)…`);
    for (const field of fields) {
      const entry = previous.get(field.id) || { initialEmpty: isEmpty(readValue(field)), filled: null };
      state.step.fields.set(field.id, entry);

      if (field.type === LI_TYPES.FILE) {
        // Photos, cover letters: never filled, but a required one needs you.
        if (field.required && !LiDOM.hasUpload(field)) leftForYou.push(field.question || 'File upload');
        continue;
      }
      if (!entry.initialEmpty) continue;
      if (LiDOM.getStepSignature(modal) !== signature) return; // you moved on

      const fill = FILLERS[field.type];
      const { answer, reason, borrowed } = field.question
        ? await decide(field, modal)
        : { answer: null, reason: 'no label' };

      if (answer == null || !fill) {
        if (field.required) leftForYou.push(field.question || field.id);
        if (answer == null && reason !== 'no saved answer') {
          activity({ question: field.question, type: field.type, options: fieldOptions(field), outcome: 'asked', detail: reason });
        }
        continue;
      }

      await humanDelay();
      if (await fill(field, answer)) {
        entry.filled = readValue(field);
        filledCount += 1;
        log(`Filled (${field.type}): "${field.question}" → "${[].concat(answer).join(', ')}"`);
        if (borrowed) {
          // Borrowed from another question or the contact card: save it under
          // this question too, so it is an exact match next time. If you
          // change it before clicking Next, your value replaces it.
          persist('set', field.question, entry.filled, field.type, undefined, SITE).catch(() => {});
        } else {
          persist('touch', field.question, SITE).catch(() => {});
        }
        activity({ question: field.question, type: field.type, outcome: 'autofilled', answer: [].concat(answer).join(', '), detail: reason });
      } else {
        warn(`Could not fill "${field.question}" with "${answer}".`);
        activity({ question: field.question, type: field.type, options: fieldOptions(field), outcome: 'failed', answer: [].concat(answer).join(', ') });
        if (field.required) leftForYou.push(field.question);
      }
    }

    const filledNote = filledCount ? `Filled ${filledCount}. ` : '';
    if (leftForYou.length) {
      state.handedOver.add(base);
      log('Waiting for you on:', leftForYou);
      showStatus(
        `${filledNote}Your turn: ${leftForYou.map((q) => shorten(q, 40)).join(' · ')}`,
        'wait'
      );
      return;
    }
    if (LiDOM.isResumeMissing(modal)) {
      state.handedOver.add(base);
      log('No resume selected; waiting for you.');
      showStatus(`${filledNote}Select a resume, then click Next.`, 'wait');
      return;
    }
    if (state.handedOver.has(base)) {
      log('You are answering this step; the Next click is yours.');
      showStatus(`${filledNote}Click Next when you're ready.`, 'wait');
      return;
    }
    if (filledNote) showStatus(filledNote.trim());
    await advance(modal, signature, filledCount > 0);
  }

  /** Click Next / Review / Submit, once per step. */
  async function advance(modal, signature, filledSomething) {
    if (state.advanced.has(signature)) return;

    const errors = LiDOM.getErrors(modal);
    if (errors.length) {
      log('LinkedIn shows errors on this step; leaving it to you:', errors);
      showStatus(`LinkedIn says: ${shorten(errors[0], 60)} — over to you.`, 'error');
      return;
    }

    const action = LiDOM.getPrimaryAction(modal);
    if (!action || action.element.disabled) return;

    if (action.kind === 'submit') {
      const settings = await AnswerStore.getSettings();
      if (!settings.linkedinAutoSubmit) {
        log('Ready to submit. Auto-submit is off in the popup, so the last click is yours.');
        showStatus('All filled. Review and click Submit application.', 'wait');
        return;
      }
    }

    if (filledSomething) await delay(PRE_CLICK_DELAY);
    if (!modal.isConnected || LiDOM.getStepSignature(modal) !== signature) return;

    state.advanced.add(signature);
    const title = LiDOM.getModalTitle(modal);
    log(`Clicking ${action.kind}.`);
    showStatus(action.kind === 'submit' ? 'Submitting…' : `Clicking ${action.kind === 'review' ? 'Review' : 'Next'}…`);
    action.element.click();

    if (action.kind === 'submit') {
      activity({ question: title, type: 'linkedin', outcome: 'submitted' });
    }

    // Not awaited: holding the loop here would delay the next step by this long.
    setTimeout(() => {
      if (!modal.isConnected || LiDOM.getStepSignature(modal) !== signature) return;
      const rejected = LiDOM.getErrors(modal);
      if (rejected.length) {
        warn('LinkedIn rejected this step; over to you:', rejected);
        showStatus(`LinkedIn says: ${shorten(rejected[0], 60)} — over to you.`, 'error');
        activity({ question: title, type: 'linkedin', outcome: 'failed', detail: rejected.join(' · ') });
      }
    }, ADVANCE_CHECK_DELAY);
  }

  // --- Success modal ----------------------------------------------------

  async function closeSuccess(modal) {
    // LinkedIn can reuse one container for every application, so remember the
    // message rather than the element; each names its company.
    const text = cleanText(modal.textContent).slice(0, 200);
    if (text === state.lastSuccess.text && Date.now() - state.lastSuccess.at < 10000) return;
    state.lastSuccess = { text, at: Date.now() };

    commitSnapshot();
    state.step = null;
    state.advanced.clear();
    state.handedOver.clear();

    // Click as soon as the button is up; it can lag the modal by a frame or two.
    const button = await waitFor(() => LiDOM.getSuccessCloseButton(modal), SUCCESS_BUTTON_TIMEOUT, 50);
    if (button) {
      log(`Application sent; clicking "${cleanText(button.textContent) || 'Dismiss'}".`);
      button.click();
    }
    showStatus('Application sent ✓', 'done');
  }

  // --- Main loop --------------------------------------------------------

  async function check() {
    state.checkTimer = null;
    if (isOrphaned()) return;
    if (state.busy) {
      state.dirty = true;
      return;
    }
    state.busy = true;
    try {
      const success = LiDOM.getSuccessModal();
      if (success) {
        await closeSuccess(success);
        return;
      }

      const modal = LiDOM.getApplyModal();
      if (!modal) {
        if (state.step || state.snapshot) {
          // A submit you clicked yourself may close the modal without the
          // success screen we recognise; anything else was abandoned.
          if (state.snapshot && state.snapshot.kind === 'submit') commitSnapshot();
          state.step = null;
          state.snapshot = null;
          state.advanced.clear();
          state.handedOver.clear();
          hideStatus();
          log('Easy Apply closed.');
        }
        return;
      }

      await processStep(modal);
    } catch (err) {
      warn('Error while handling the step:', err);
    } finally {
      state.busy = false;
      if (state.dirty) {
        state.dirty = false;
        scheduleCheck();
      }
    }
  }

  /** Throttle, not debounce: the feed never stops mutating long enough. */
  function scheduleCheck() {
    if (!state.checkTimer) state.checkTimer = setTimeout(check, CHECK_INTERVAL);
  }

  function start() {
    new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onDocumentClick, true);
    log('Watching for Easy Apply.');
    scheduleCheck();
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
