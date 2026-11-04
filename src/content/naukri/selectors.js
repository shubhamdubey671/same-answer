/**
 * Same Answer — naukri DOM contract.
 *
 * Real selectors, captured from inspecting the live naukri.com application
 * drawer on 2026-09-21. The drawer is a CHATBOT, not a form: questions arrive
 * as bot chat messages and answers are submitted one at a time.
 *
 * This is the only file in the extension that contains a CSS selector or a
 * literal class name. content.js talks to the page exclusively through `DOM.*`,
 * so when naukri ships new markup this file is the only thing that changes.
 *
 * Every id in the drawer is generated with a random prefix (`_9ub3yemll`,
 * `chatList__…`), so nothing here may key off an id — class names only.
 */

const SELECTORS = {
  // --- Drawer shell ---
  chatbotContainer: 'div._chatBotContainer',
  drawer: 'div.chatbot_Drawer.chatbot_right',
  messageContainer: 'div.chatbot_MessageContainer',
  chatList: 'ul.list',

  // --- Conversation items ---
  botItem: 'li.botItem',
  botMsgText: '.botMsg span',
  userItem: 'li.userItem',
  userMsgText: '.userMsg span',

  // --- Input: single-select radio buttons ---
  radioContainer: 'div.singleselect-radiobutton',
  radioOptionWrapper: 'div.ssrc__radio-btn-container',
  radioInput: 'input.ssrc__radio',
  radioLabel: 'label.ssrc__label',

  // --- Input: free text (a contenteditable div, NOT an <input>) ---
  textInput: 'div.textArea[contenteditable="true"]',
  textInputWrapper: '.chatbot_SendMessageContainer',

  // --- Input: chips (Yes / No / Skip this question) ---
  chipsContainer: 'div.chipsContainer',
  chip: 'div.chatbot_Chip',
  chipText: 'span',

  // --- Save ---
  saveButton: 'div.sendMsg',
  saveButtonWrapper: 'div.send',

  // --- Misc ---
  hidden: '.d-none',

  // TODO: not yet observed in the real drawer. When a dropdown or a
  // multi-select question turns up, capture its markup and fill these in —
  // then add a matching entry to FILLERS/READERS in content.js and a branch in
  // DOM.detectInputType(). Nothing else needs to change.
  dropdownContainer: null,
  checkboxContainer: null,
};

/** Literal class names the drawer uses as state flags. */
const CLASSES = {
  /** On a wrapper: that whole control is hidden right now. */
  hidden: 'd-none',
  /** On `div.send`: Save is inert until the user has entered something. */
  disabled: 'disabled',
};

/**
 * Input kinds. `chips` is new to the chatbot drawer and, unlike the others,
 * submits on click with no Save button.
 */
const INPUT_TYPES = {
  TEXT: 'text',
  RADIO: 'radio',
  CHIPS: 'chips',
  // Reserved for later — see the TODO in SELECTORS.
  DROPDOWN: 'dropdown',
  CHECKBOX: 'checkbox',
  /** A control we cannot fill yet; still learned from the reply bubble. */
  UNKNOWN: 'unknown',
};

/**
 * Bot copy that means the application flow is over. Deliberately specific: the
 * drawer's opening greeting says "thank you for showing interest", so a bare
 * 'thank' would end the session before the first question.
 */
const COMPLETION_TEXT_PATTERNS = [
  'thank you for your response',
  'thanks for your response',
  'thank you for your responses',
  'thanks for your responses',
  'successfully applied',
  'applied successfully',
  'application has been submitted',
  'application submitted',
];

/**
 * Opening bot copy that is not a question. The greeting and the first question
 * arrive in the same run of bot bubbles, and without this the greeting would
 * be read as the question label.
 */
const GREETING_TEXT_PATTERNS = [
  /^(hi|hello|hey|dear)\b/i,
  /thank(s| you) for (showing|your) interest/i,
  /kindly answer/i,
  /answer (a few|the following|all the|these) (recruiter'?s? )?questions/i,
];

/** Bot copy that means the submission failed and offers a retry. */
const ERROR_TEXT_PATTERNS = ['something went wrong'];

/** Label of the retry affordance that accompanies an error message. */
const RETRY_TEXT_PATTERN = /try again/i;

/** Chip we must never store as an answer — it answers nothing. */
const SKIP_CHIP_TEXT = 'skip this question';

/** Collapse whitespace and trim. Shared by every text read below. */
const normalizeText = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

const DOM = {
  // --- Scope ------------------------------------------------------------

  /**
   * Root to query controls from. The radio/chip/text/Save controls all live
   * inside the chatbot container but outside the chat list, so queries are
   * scoped here rather than to the drawer or to `document`.
   */
  getScope() {
    return document.querySelector(SELECTORS.chatbotContainer) || document;
  },

  /** The open drawer panel, or null when no drawer is mounted. */
  getDrawer() {
    return document.querySelector(SELECTORS.drawer);
  },

  /** True when the drawer is mounted and actually on screen. */
  isDrawerOpen() {
    return this.isVisible(this.getDrawer());
  },

  /** Number of messages (bot + user) in the conversation so far. */
  countMessages() {
    return document.querySelectorAll(`${SELECTORS.botItem}, ${SELECTORS.userItem}`).length;
  },

  /** The `ul.list` holding the conversation, or null. */
  getChatList() {
    const drawer = this.getDrawer();
    const container = drawer
      ? drawer.querySelector(SELECTORS.messageContainer)
      : document.querySelector(SELECTORS.messageContainer);
    return container ? container.querySelector(SELECTORS.chatList) : null;
  },

  // --- Visibility -------------------------------------------------------

  /**
   * Is this element really on screen? The drawer keeps controls mounted and
   * hides them with `d-none`, so presence in the DOM proves nothing: both a
   * radio group and the text box routinely exist at once with only one shown.
   */
  isVisible(el) {
    if (!el || !el.isConnected) return false;
    // `d-none` on the element or any ancestor.
    if (el.closest(SELECTORS.hidden)) return false;
    // Catches display:none / detached layout anywhere up the tree.
    return el.getClientRects().length > 0;
  },

  // --- Conversation -----------------------------------------------------

  /** Question-label text of a bot item: the first span inside `.botMsg`. */
  readBotText(item) {
    if (!item) return '';
    const span = item.querySelector(SELECTORS.botMsgText);
    return normalizeText(span ? span.textContent : item.textContent);
  },

  /** Answer text of a user item. */
  readUserText(item) {
    if (!item) return '';
    const span = item.querySelector(SELECTORS.userMsgText);
    return normalizeText(span ? span.textContent : item.textContent);
  },

  /**
   * The conversation's open turn: every bot item after the last user answer.
   *
   * One question can arrive as several bot items ("Data Privacy Policy", then
   * "Please read and consent <link>"), so the caller gets the whole run. The
   * first item is the question label; the rest are description.
   *
   * @returns {{question: string, texts: string[], items: Element[]}}
   */
  getLatestBotGroup() {
    const empty = { question: '', texts: [], items: [] };
    const list = this.getChatList();
    if (!list) return empty;

    const items = Array.from(list.children).filter(
      (li) => li.matches(SELECTORS.botItem) || li.matches(SELECTORS.userItem)
    );
    if (!items.length) return empty;

    // Everything after the user's most recent answer is the current turn.
    let start = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].matches(SELECTORS.userItem)) {
        start = i + 1;
        break;
      }
    }

    let group = items.slice(start).filter((li) => li.matches(SELECTORS.botItem));

    // Drop a leading greeting, but only when something follows it — a lone
    // greeting stays so completion/error checks still see its text.
    while (
      group.length > 1 &&
      this.isGreeting(this.readBotText(group[0]))
    ) {
      group = group.slice(1);
    }
    if (!group.length) return empty;

    return {
      question: this.readBotText(group[0]),
      // Full item text, not just the label span, so callers can pattern-match
      // completion and error copy wherever in the bubble it sits.
      texts: group.map((li) => normalizeText(li.textContent)).filter(Boolean),
      items: group,
    };
  },

  /**
   * The first user reply posted after `botItem` — i.e. the user's answer to
   * that question, whatever control they used to give it.
   */
  getUserReplyAfter(botItem) {
    const list = this.getChatList();
    if (!list || !botItem || !botItem.isConnected) return null;

    return (
      Array.from(list.querySelectorAll(SELECTORS.userItem)).find(
        (li) => botItem.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING
      ) || null
    );
  },

  /** Is this bot text the drawer's opening greeting rather than a question? */
  isGreeting(text) {
    return GREETING_TEXT_PATTERNS.some((re) => re.test(text || ''));
  },

  /**
   * The retry affordance shown alongside "Something went wrong". Looks only at
   * chips and user items — never at bot items, whose own error copy ends in
   * "Please Try again later" and would otherwise match itself.
   */
  getRetryElement() {
    const chip = this.getAllChipElements().find((el) =>
      RETRY_TEXT_PATTERN.test(normalizeText(el.textContent))
    );
    if (chip) return chip;

    const list = this.getChatList();
    const userItems = list ? Array.from(list.querySelectorAll(SELECTORS.userItem)) : [];
    const item = userItems
      .reverse()
      .find((el) => RETRY_TEXT_PATTERN.test(normalizeText(el.textContent)));
    if (item) return item.querySelector(SELECTORS.userMsgText) || item;

    return null;
  },

  // --- Input type detection --------------------------------------------

  /**
   * Which control is the drawer currently asking with?
   *
   * Order matters. Radio and chips are checked before text because the
   * contenteditable box stays mounted underneath them; a question is only a
   * text question when nothing else is on screen. Each branch also requires at
   * least one real option, so a mounted-but-empty container is not mistaken
   * for a live control.
   *
   * @returns {'radio'|'chips'|'text'|null}
   */
  detectInputType() {
    const scope = this.getScope();

    const radioContainer = scope.querySelector(SELECTORS.radioContainer);
    if (this.isVisible(radioContainer) && radioContainer.querySelector(SELECTORS.radioInput)) {
      return INPUT_TYPES.RADIO;
    }

    const chipsContainer = scope.querySelector(SELECTORS.chipsContainer);
    if (this.isVisible(chipsContainer) && chipsContainer.querySelector(SELECTORS.chip)) {
      return INPUT_TYPES.CHIPS;
    }

    if (this.isTextInputVisible()) {
      return INPUT_TYPES.TEXT;
    }

    // TODO: dropdown and checkbox branches go here once their markup is known.
    return null;
  },

  // --- Radio ------------------------------------------------------------

  /**
   * Visible radio options.
   * @returns {Array<{value: string, label: string, element: HTMLInputElement}>}
   */
  getRadioOptions() {
    const container = this.getScope().querySelector(SELECTORS.radioContainer);
    if (!this.isVisible(container)) return [];

    return Array.from(container.querySelectorAll(SELECTORS.radioInput)).map((input) => {
      const wrapper = input.closest(SELECTORS.radioOptionWrapper);
      const labelEl = wrapper ? wrapper.querySelector(SELECTORS.radioLabel) : null;
      const label = normalizeText(labelEl ? labelEl.textContent : '');
      return {
        // The drawer puts the answer text in `value`; label is the visible copy.
        value: normalizeText(input.value) || label,
        label: label || normalizeText(input.value),
        element: input,
      };
    });
  },

  /** The user's current radio choice, or '' when nothing is selected. */
  getCheckedRadioValue() {
    const container = this.getScope().querySelector(SELECTORS.radioContainer);
    if (!container) return '';

    const checked = Array.from(container.querySelectorAll(SELECTORS.radioInput)).find(
      (input) => input.checked
    );
    if (!checked) return '';

    const option = this.getRadioOptions().find((o) => o.element === checked);
    return option ? option.value : normalizeText(checked.value);
  },

  // --- Chips ------------------------------------------------------------

  /** Every chip element on screen, "Skip this question" included. */
  getAllChipElements() {
    const container = this.getScope().querySelector(SELECTORS.chipsContainer);
    if (!this.isVisible(container)) return [];
    return Array.from(container.querySelectorAll(SELECTORS.chip));
  },

  /** Text of one chip. */
  readChipText(el) {
    if (!el) return '';
    const span = el.querySelector(SELECTORS.chipText);
    return normalizeText(span ? span.textContent : el.textContent);
  },

  /**
   * Answerable chips — "Skip this question" is excluded, since storing it
   * would teach the extension to skip that question forever.
   * @returns {Array<{text: string, element: Element}>}
   */
  getChipOptions() {
    return this.getAllChipElements()
      .map((element) => ({ text: this.readChipText(element), element }))
      .filter((chip) => chip.text && chip.text.toLowerCase() !== SKIP_CHIP_TEXT);
  },

  // --- Text -------------------------------------------------------------

  /** The contenteditable message box, whether or not it is visible. */
  getTextInput() {
    return this.getScope().querySelector(SELECTORS.textInput);
  },

  /** Is the message box currently accepting input? */
  isTextInputVisible() {
    const input = this.getTextInput();
    if (!input) return false;

    // The drawer toggles the whole send row with `d-none`.
    const wrapper = input.closest(SELECTORS.textInputWrapper);
    if (wrapper && wrapper.classList.contains(CLASSES.hidden)) return false;

    return this.isVisible(input);
  },

  /** Whatever the user has typed, trimmed. */
  getTextInputValue() {
    const input = this.getTextInput();
    return input ? normalizeText(input.textContent) : '';
  },

  // --- Save -------------------------------------------------------------

  /** The Save button, or null. */
  getSaveButton() {
    return this.getScope().querySelector(SELECTORS.saveButton);
  },

  /** Its wrapper, which carries the `disabled` flag. */
  getSaveButtonWrapper() {
    return this.getScope().querySelector(SELECTORS.saveButtonWrapper);
  },

  /** Can Save be clicked yet? False while the drawer marks it `disabled`. */
  isSaveEnabled() {
    const wrapper = this.getSaveButtonWrapper();
    if (!wrapper) return false;
    if (wrapper.classList.contains(CLASSES.disabled)) return false;
    return this.isVisible(wrapper);
  },
};
