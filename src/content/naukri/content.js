/**
 * Same Answer — naukri content script.
 *
 * The naukri.com application drawer is a chatbot. Questions arrive as bot chat
 * messages; the user answers with radio buttons, chips, or a contenteditable
 * message box, and each answer is submitted on its own before the next question
 * loads. So this script does not fill a form — it takes turns in a conversation.
 *
 *   Phase 1  Watch document.body for the drawer to mount.
 *   Phase 2  Watch the chat list. Each new bot turn is one question:
 *            classify it, answer it from storage, or learn what the user does.
 *   Phase 3  The drawer closes (or a thanks message flashes past) — tear down
 *            the per-application state and go back to Phase 1.
 *
 * Every selector lives in selectors.js and is reached through `DOM.*`; storage
 * goes through `AnswerStore`. Neither a CSS selector nor a raw class name
 * belongs in this file.
 */

(() => {
  'use strict';

  // Re-injection guard. A second copy would install a second set of observers
  // and double-click every Save button.
  if (window.__sameAnswerNaukri) {
    console.log('[Same Answer · Naukri] Already running in this page; skipping.');
    return;
  }
  window.__sameAnswerNaukri = true;

  const LOG = '[Same Answer · Naukri]';
  const log = (...args) => console.log(LOG, ...args);
  const warn = (...args) => console.warn(LOG, ...args);

  // --- Tunables ---------------------------------------------------------

  /** One question can arrive as several bot bubbles; let the run settle. */
  const BOT_TURN_DEBOUNCE = 500;

  /** Body mutations are cheap to check but not free. */
  const DRAWER_DEBOUNCE = 100;

  /** The control often renders a beat after the question text. */
  const INPUT_RETRY_DELAY = 300;
  const MAX_INPUT_RETRIES = 6;

  /** Save stays `disabled` until the drawer registers the answer. */
  const SAVE_POLL_INTERVAL = 100;
  const SAVE_POLL_TIMEOUT = 3000;

  /** Human-like pause before clicking Save. */
  const FILL_DELAY_MIN = 300;
  const FILL_DELAY_MAX = 500;

  /** A question is attempted at most this many times per drawer session. */
  const MAX_ATTEMPTS_PER_QUESTION = 2;

  /** Guard against an error/retry loop. */
  const MAX_ERROR_RETRIES = 2;

  /** How many times to look for a "Try again" before giving up on one error. */
  const MAX_ERROR_LOOKUPS = 6;

  // --- Session state ----------------------------------------------------

  const state = {
    /** Observer on the chat list; null between drawer sessions. */
    chatObserver: null,
    /** The chat list we are currently observing. */
    chatList: null,
    /** The bot `<li>` whose question we are handling — identity, not text. */
    currentItem: null,
    /** True while a fill/save cycle is in flight; blocks re-entry. */
    busy: false,
    /** True once the flow completed; reset when the drawer closes. */
    finished: false,
    /** Detach function for the capture listeners currently attached. */
    detachCapture: null,
    /**
     * The question waiting for the user's answer:
     * {question, type, options, item, done}. See the Capture section.
     */
    pending: null,
    /** normalized question -> attempts, so a stuck question cannot loop. */
    attempts: new Map(),
    /** How many times we clicked "Try again" this session. */
    errorRetries: 0,
    /** Consecutive "error shown but no Try again yet" lookups. */
    errorLookups: 0,
    /** Consecutive "question text but no control yet" retries. */
    inputRetries: 0,
    turnTimer: null,
    drawerTimer: null,
    retryTimer: null,
  };

  // --- Utilities --------------------------------------------------------

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const humanDelay = () =>
    delay(FILL_DELAY_MIN + Math.random() * (FILL_DELAY_MAX - FILL_DELAY_MIN));

  const cleanText = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  /** Answer comparison, reusing the same normalization storage keys use. */
  const looseEquals = (a, b) => AnswerStore.normalizeKey(a) === AnswerStore.normalizeKey(b);

  const matchesAny = (text, patterns) => {
    const haystack = cleanText(text).toLowerCase();
    return !!haystack && patterns.some((pattern) => haystack.includes(pattern));
  };

  /**
   * After the extension is reloaded, a script already running in a tab is
   * orphaned: `chrome.storage` and `chrome.runtime.id` vanish and nothing can
   * be saved until the tab is refreshed. Detect that and stand down loudly.
   */
  let orphanWarned = false;
  function isOrphaned() {
    let alive = false;
    try {
      alive = !!(chrome.runtime && chrome.runtime.id && chrome.storage);
    } catch (_) {
      alive = false;
    }
    if (!alive && !orphanWarned) {
      orphanWarned = true;
      // A log, not a warning: a stale tab after a reload is expected.
      log('The extension was reloaded or updated. REFRESH THIS TAB so answers can be saved again.');
    }
    return !alive;
  }

  /**
   * Writes go to the background worker, which outlives this page — naukri
   * navigates away right after the last answer. Reads stay local.
   */
  async function persist(op, ...args) {
    if (isOrphaned()) throw new Error('extension context invalidated');
    try {
      const response = await chrome.runtime.sendMessage({ op, args });
      if (!response || !response.ok) throw new Error(response ? response.error : 'no response');
      return response.result;
    } catch (err) {
      // "Extension context invalidated": the extension was reloaded but this
      // tab still runs the old script. Only a page refresh fixes that.
      warn(`Could not ${op} (refresh this tab if the extension was just reloaded):`, err);
      throw err;
    }
  }

  /** Activity log entry; never allowed to break the flow. */
  const activity = (entry) => persist('log', entry).catch(() => {});

  const isCompletionText = (text) => matchesAny(text, COMPLETION_TEXT_PATTERNS);
  const isErrorText = (text) => matchesAny(text, ERROR_TEXT_PATTERNS);

  // --- Per-type fill and read handlers ---------------------------------
  //
  // Adding an input type means adding one entry to each registry below plus a
  // branch in DOM.detectInputType(). Nothing else in this file needs to know
  // the new type exists.

  /**
   * Select the radio option matching `answer`.
   * @returns {boolean} false when no option matches, so the caller can hand
   *   the question back to the user.
   */
  function fillRadio(answer) {
    const options = DOM.getRadioOptions();
    if (!options.length) {
      log('Radio question has no options on screen.');
      return false;
    }

    const match =
      options.find((option) => looseEquals(option.value, answer)) ||
      options.find((option) => looseEquals(option.label, answer));

    if (!match) {
      log(
        `No radio option matches "${answer}". Options:`,
        options.map((o) => o.value)
      );
      return false;
    }

    // Clicking the input directly is what the real drawer responds to.
    match.element.click();
    return true;
  }

  /** Click the chip matching `answer`. Chips submit themselves. */
  function fillChips(answer) {
    const options = DOM.getChipOptions();
    if (!options.length) {
      log('Chip question has no answerable chips on screen.');
      return false;
    }

    const match = options.find((option) => looseEquals(option.text, answer));
    if (!match) {
      log(
        `No chip matches "${answer}". Chips:`,
        options.map((o) => o.text)
      );
      return false;
    }

    match.element.click();
    return true;
  }

  /**
   * Type into the contenteditable message box. This is not an <input>, so there
   * is no value setter to go through — set textContent and tell the drawer.
   */
  function fillText(answer) {
    const input = DOM.getTextInput();
    if (!input) {
      log('Text question but no message box on screen.');
      return false;
    }

    input.focus();
    input.textContent = String(answer);
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // Some validation only runs on blur; Save polling below tolerates either.
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  const FILLERS = {
    [INPUT_TYPES.RADIO]: fillRadio,
    [INPUT_TYPES.CHIPS]: fillChips,
    [INPUT_TYPES.TEXT]: fillText,
    // TODO: [INPUT_TYPES.DROPDOWN]: fillDropdown,
    // TODO: [INPUT_TYPES.CHECKBOX]: fillCheckbox,
  };

  const READERS = {
    [INPUT_TYPES.RADIO]: () => DOM.getCheckedRadioValue(),
    [INPUT_TYPES.TEXT]: () => DOM.getTextInputValue(),
    // Chips are read from the click itself — see attachChipCapture.
    // TODO: [INPUT_TYPES.DROPDOWN]: () => DOM.getDropdownValue(),
    // TODO: [INPUT_TYPES.CHECKBOX]: () => DOM.getCheckedBoxes(),
  };

  /** Types that submit on click and never touch the Save button. */
  const AUTO_SUBMIT_TYPES = new Set([INPUT_TYPES.CHIPS]);

  // --- Save -------------------------------------------------------------

  /** Poll until the drawer enables Save, or give up. */
  async function waitForSaveEnabled(timeout = SAVE_POLL_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (DOM.isSaveEnabled()) return true;
      await delay(SAVE_POLL_INTERVAL);
    }
    return DOM.isSaveEnabled();
  }

  /** Wait for Save to go live, pause, then click it. */
  async function clickSave() {
    if (!(await waitForSaveEnabled())) {
      log('Save stayed disabled for 3s; leaving this question to the user.');
      return false;
    }

    await humanDelay();

    // The drawer can close while we wait.
    if (!DOM.isDrawerOpen()) {
      log('Drawer closed before Save; aborting.');
      return false;
    }

    const button = DOM.getSaveButton();
    if (!button) {
      log('Save button vanished before it could be clicked.');
      return false;
    }

    button.click();
    return true;
  }

  // --- Auto-fill --------------------------------------------------------

  /** Labels of the options on screen, or [] for questions without options. */
  function currentOptions(inputType) {
    if (inputType === INPUT_TYPES.RADIO) return DOM.getRadioOptions().map((o) => o.label);
    if (inputType === INPUT_TYPES.CHIPS) return DOM.getChipOptions().map((o) => o.text);
    return [];
  }

  /**
   * Answer a known question.
   * @param {string} answer already chosen by AnswerStore.pickAnswer
   * @returns {Promise<boolean>} false when the answer could not be applied, in
   *   which case the caller falls back to capture mode.
   */
  async function autoFill(question, answer, inputType) {
    log(`Auto-filling (${inputType}): "${question}" → "${answer}"`);

    const fill = FILLERS[inputType];
    if (!fill) {
      log(`No fill handler for input type "${inputType}" yet — see the TODOs.`);
      return false;
    }

    if (!fill(answer)) return false;

    // Chips submit on click; anything else needs Save.
    if (!AUTO_SUBMIT_TYPES.has(inputType)) {
      if (!(await clickSave())) return false;
    }

    // touch() — not set() — is what increments usageCount for the popup.
    await persist('touch', question).catch(() => {});
    activity({ question, type: inputType, outcome: 'autofilled', answer });
    log(`Answered: "${question}"`);
    return true;
  }

  // --- Capture ----------------------------------------------------------
  //
  // Every unanswered question becomes `state.pending`. Two things can resolve
  // it, and whichever fires first wins:
  //
  //   1. A listener on the control itself (Save click / chip click), which
  //      reads the exact option value.
  //   2. The user's reply bubble appearing in the chat after the question.
  //      This works for every control — Enter instead of Save, a re-rendered
  //      Save button, a checkbox or dropdown we cannot fill yet — so nothing
  //      the user answers goes unrecorded.

  /**
   * Drop the pending question and its listeners. With a `reason`, a question
   * that was never answered is written to the activity log as missed.
   */
  function clearCapture(reason) {
    if (state.detachCapture) {
      state.detachCapture();
      state.detachCapture = null;
    }

    const pending = state.pending;
    state.pending = null;
    if (reason && pending && !pending.done) {
      activity({
        question: pending.question,
        type: pending.type,
        options: pending.options,
        outcome: 'missed',
        detail: reason,
      });
    }
  }

  /** Map a free-form answer onto the option label it names, if any. */
  function toOptionLabel(answer, inputType) {
    if (inputType === INPUT_TYPES.RADIO) {
      const option = DOM.getRadioOptions().find(
        (o) => looseEquals(o.value, answer) || looseEquals(o.label, answer)
      );
      if (option) return option.label;
    }
    const pending = state.pending;
    const label = pending && pending.options.find((o) => looseEquals(o, answer));
    return label || answer;
  }

  /** Resolve the pending question with the user's answer. Runs at most once. */
  async function commitPending(rawAnswer, source) {
    const pending = state.pending;
    if (!pending || pending.done) return;

    const value = cleanText(rawAnswer);
    if (!value || RETRY_TEXT_PATTERN.test(value)) return;

    pending.done = true;
    const { question, type, options } = pending;

    if (value.toLowerCase() === SKIP_CHIP_TEXT) {
      log('Question skipped; not storing.');
      activity({ question, type, options, outcome: 'skipped' });
      return;
    }

    const answer = options.length ? toOptionLabel(value, type) : value;

    try {
      await persist('set', question, answer, type, options);
      activity({ question, type, options, outcome: 'captured', answer, detail: source });
      log(`Captured (${type}, via ${source}): "${question}" → "${answer}"`);
    } catch (err) {
      warn('Failed to store captured answer:', err);
      activity({ question, type, outcome: 'error', detail: String(err) });
    }
  }

  /** Called on every chat mutation: did the user just reply to `pending`? */
  function checkUserReply() {
    const pending = state.pending;
    if (!pending || pending.done) return;

    const reply = DOM.getUserReplyAfter(pending.item);
    if (!reply) return;

    const text = DOM.readUserText(reply);
    if (text) commitPending(text, 'reply');
  }

  /**
   * Radio and text: read the control when the user clicks Save. Capture phase,
   * so we run before the drawer swaps the DOM for the next question.
   */
  function attachSaveCapture(inputType) {
    const button = DOM.getSaveButton();
    const read = READERS[inputType];
    if (!button || !read) return () => {};

    const onSave = () => commitPending(read(), 'save');
    button.addEventListener('click', onSave, { capture: true, once: true });
    return () => button.removeEventListener('click', onSave, { capture: true });
  }

  /** Chips submit on click, so listen on the chips themselves. */
  function attachChipCapture() {
    // All chips, "Skip this question" included — commitPending logs a skip.
    const chips = DOM.getAllChipElements();
    const handlers = chips.map((element) => {
      const onClick = () => commitPending(DOM.readChipText(element), 'chip');
      element.addEventListener('click', onClick, { capture: true });
      return { element, onClick };
    });

    return () =>
      handlers.forEach(({ element, onClick }) =>
        element.removeEventListener('click', onClick, { capture: true })
      );
  }

  /** Hand the question back to the user and learn from whatever they do. */
  function attachCapture(question, inputType, item, why) {
    clearCapture();
    log(`${why} for "${question}" (${inputType}). Waiting for you.`);

    state.pending = {
      question,
      type: inputType,
      options: currentOptions(inputType),
      item,
      done: false,
    };

    if (inputType === INPUT_TYPES.CHIPS) {
      state.detachCapture = attachChipCapture();
    } else if (inputType !== INPUT_TYPES.UNKNOWN) {
      state.detachCapture = attachSaveCapture(inputType);
    }

    // The reply may already be on screen (answered while we were deciding).
    checkUserReply();
  }

  // --- Error recovery ---------------------------------------------------

  /** "Something went wrong. Please Try again later" — click the retry. */
  function handleError() {
    if (state.errorRetries >= MAX_ERROR_RETRIES) {
      warn('Repeated errors from the drawer; standing down.');
      finish('too many errors');
      return;
    }

    const retry = DOM.getRetryElement();
    if (!retry) {
      // The retry affordance lands a beat after the error copy. Look again
      // shortly rather than spending one of our few retries on nothing.
      if (state.errorLookups < MAX_ERROR_LOOKUPS) {
        state.errorLookups += 1;
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(handleError, INPUT_RETRY_DELAY);
      } else {
        log('Drawer reported an error but offered no "Try again" to click.');
      }
      return;
    }

    state.errorLookups = 0;
    state.errorRetries += 1;
    log(`Drawer error; clicking "Try again" (${state.errorRetries}/${MAX_ERROR_RETRIES}).`);
    // A retry re-asks the question, so let it be processed afresh.
    state.currentItem = null;
    clearCapture('drawer error');
    retry.click();
  }

  // --- The per-question handler ----------------------------------------

  async function processTurn() {
    if (state.finished || state.busy) return;
    if (isOrphaned()) return;
    if (!DOM.isDrawerOpen()) return;

    const turn = DOM.getLatestBotGroup();
    if (!turn.items.length) return;

    // Completion and errors can appear anywhere in the bot's bubbles. A live
    // control on screen means the conversation is still asking something.
    if (turn.texts.some(isCompletionText) && !DOM.detectInputType()) {
      finish('thanks message');
      return;
    }
    if (turn.texts.some(isErrorText)) {
      handleError();
      return;
    }

    const item = turn.items[0];
    const question = turn.question;
    if (!question) return;

    // Dedupe on the element, not the text: if the bot re-asks something, that
    // is a new `<li>` and a genuinely new turn.
    if (item === state.currentItem) return;

    const key = AnswerStore.normalizeKey(question);
    const attempts = state.attempts.get(key) || 0;
    if (attempts >= MAX_ATTEMPTS_PER_QUESTION) {
      log(`Giving up on "${question}" after ${attempts} attempts.`);
      state.currentItem = item;
      return;
    }

    const inputType = DOM.detectInputType();
    if (!inputType) {
      // The control renders a beat after the text. Retry without claiming the
      // turn, so nothing is marked handled prematurely.
      if (state.inputRetries < MAX_INPUT_RETRIES) {
        state.inputRetries += 1;
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(processTurn, INPUT_RETRY_DELAY);
      } else {
        // A control we do not know how to fill (checkbox, dropdown, …). We
        // still learn the answer from the user's reply bubble. A log, not a
        // warning: this is expected, and chrome://extensions lists every
        // warning as an error.
        log(`No known input control for "${question}"; learning from your reply only.`);
        state.inputRetries = 0;
        state.currentItem = item;
        if (!DOM.isGreeting(question)) {
          attachCapture(question, INPUT_TYPES.UNKNOWN, item, 'Unsupported control');
        }
      }
      return;
    }
    state.inputRetries = 0;

    state.busy = true;
    state.currentItem = item;
    state.attempts.set(key, attempts + 1);
    clearCapture('moved on to the next question');

    try {
      log(`Question (${inputType}): "${question}"`);
      const record = await AnswerStore.get(question);

      if (!record) {
        attachCapture(question, inputType, item, 'No saved answer');
        return;
      }

      const options = currentOptions(inputType);
      const pick = AnswerStore.pickAnswer(record, options);
      if (!pick.answer) {
        // Known question, but these options were never compared before.
        activity({ question, type: inputType, options, outcome: 'asked', detail: pick.reason });
        attachCapture(question, inputType, item, `Not auto-filling (${pick.reason})`);
        return;
      }

      if (!(await autoFill(question, pick.answer, inputType))) {
        // Fix for audit 5.1: release the turn so this question can be retried
        // or answered by hand, instead of being parked for the whole session.
        log('Auto-fill did not apply; handing back to you.');
        activity({ question, type: inputType, options, outcome: 'failed', answer: pick.answer });
        state.currentItem = null;
        attachCapture(question, inputType, item, 'Auto-fill failed');
      }
    } catch (err) {
      warn('Error while handling the question:', err);
      state.currentItem = null;
    } finally {
      state.busy = false;
    }
  }

  function scheduleTurn() {
    clearTimeout(state.turnTimer);
    state.turnTimer = setTimeout(processTurn, BOT_TURN_DEBOUNCE);
  }

  // --- Phase 2: the chat list ------------------------------------------

  /**
   * The user's reply is checked first and synchronously: it can land in the
   * same batch as the thanks message, just before the drawer closes.
   * Completion flashes past in well under the turn debounce too, so added
   * nodes are scanned for it here. Everything else can wait for the run of
   * bot bubbles to settle.
   */
  function onChatMutations(mutations) {
    checkUserReply();
    if (state.finished) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const text = node.textContent;
        if (isCompletionText(text)) {
          finish('thanks message');
          return;
        }
        if (isErrorText(text)) {
          handleError();
          return;
        }
      }
    }

    scheduleTurn();
  }

  function startChatSession() {
    const list = DOM.getChatList();
    if (!list || list === state.chatList) return;

    // A fresh conversation, even if the drawer itself was never unmounted —
    // the SPA can swap the list in for a second application.
    stopChatSession();
    clearSessionState();

    state.chatList = list;
    state.chatObserver = new MutationObserver(onChatMutations);
    state.chatObserver.observe(list, { childList: true, subtree: true });

    log('Drawer open; watching the conversation.');

    // The first question is usually already rendered by the time we get here.
    processTurn();
  }

  function stopChatSession() {
    if (state.chatObserver) {
      state.chatObserver.disconnect();
      state.chatObserver = null;
    }
    state.chatList = null;
  }

  /** Stop answering this application, but stay loaded for the next one. */
  function finish(reason) {
    if (state.finished) return;
    state.finished = true;
    log(`Done with this application (${reason}).`);
    clearCapture(reason);
    clearTimeout(state.turnTimer);
    clearTimeout(state.retryTimer);
  }

  // --- Phase 3: teardown -----------------------------------------------

  /** Everything scoped to one conversation, back to zero. */
  function clearSessionState() {
    clearCapture('drawer closed before you answered');

    // Fix for audit 5.11: pending timers die with the session.
    clearTimeout(state.turnTimer);
    clearTimeout(state.retryTimer);
    state.turnTimer = null;
    state.retryTimer = null;

    state.currentItem = null;
    state.busy = false;
    state.finished = false;
    state.attempts.clear();
    state.errorRetries = 0;
    state.errorLookups = 0;
    state.inputRetries = 0;
  }

  /** The drawer went away: drop the observer too and start over. */
  function resetSession(reason) {
    if (state.chatList || state.currentItem || state.finished) {
      log(`Session reset: ${reason}.`);
    }

    stopChatSession();
    clearSessionState();
  }

  // --- Phase 1: watch for the drawer -----------------------------------

  function checkDrawer() {
    if (DOM.isDrawerOpen()) {
      startChatSession();
    } else if (state.chatList || state.finished) {
      // Removed or hidden — either the flow completed or the user bailed out.
      resetSession('drawer closed');
    }
  }

  function onBodyMutations() {
    clearTimeout(state.drawerTimer);
    state.drawerTimer = setTimeout(checkDrawer, DRAWER_DEBOUNCE);
  }

  const bodyObserver = new MutationObserver(onBodyMutations);

  function start() {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    log('Watching for the application drawer.');
    checkDrawer();
  }

  window.addEventListener('pagehide', () => {
    bodyObserver.disconnect();
    clearTimeout(state.drawerTimer);
    resetSession('page hidden');
  });

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
