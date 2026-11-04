/**
 * LinkedIn Easy Apply — DOM contract.
 *
 * Captured from the live Easy Apply modal on 2026-09-24. Unlike naukri's
 * chatbot, Easy Apply is a plain multi-step form: every step shows a batch of
 * form elements plus a footer button (Next → Review → Submit application).
 *
 * This is the only LinkedIn file with CSS selectors. linkedin-content.js talks
 * to the page exclusively through `LiDOM.*`. LinkedIn's class names are partly
 * obfuscated (`aTwXMVRtzuSMhWShQOgfjKapaLliCA`), so everything here keys off
 * `data-test-*` attributes, ARIA, or long-lived `artdeco-*` / `fb-dash-*` names.
 */

const LI_SELECTORS = {
  // --- Modal shell ---
  applyModal: '.jobs-easy-apply-modal',
  modalHeader: '#jobs-apply-header',
  dialog: '[role="dialog"], .artdeco-modal',
  dismissButton: 'button[data-test-modal-close-btn], button[aria-label="Dismiss"]',
  progress: 'progress',
  stepHeading: 'form h3',

  // --- Form elements (one question each) ---
  formElement: '[data-test-form-element], .fb-dash-form-element',
  requiredMarker: '[class*="--is-required"], [required], [aria-required="true"]',
  errorMessage: '.artdeco-inline-feedback--error',

  // --- Controls inside a form element ---
  fieldset: 'fieldset',
  legend: 'legend',
  radio: 'input[type="radio"]',
  checkbox: 'input[type="checkbox"]',
  select: 'select',
  textarea: 'textarea',
  typeahead:
    'input[role="combobox"], input[aria-autocomplete], [data-test-single-typeahead-entity-form-component] input',
  textInput: 'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"]',
  fileInput: 'input[type="file"]',
  typeaheadOption: '[role="option"]',
  /** Shown once a file has been uploaded into an upload field. */
  uploadedFile: '[class*="file-name"], .ui-attachment',

  // --- Resume step ---
  resumeCard: '.jobs-document-upload-redesign-card__container',
  resumeCardSelected: '.jobs-document-upload-redesign-card__container--selected',
  resumeRequired: '.jobs-document-upload__title--is-required',

  // --- Contact card (profile location lives here) ---
  profileLocation: '.artdeco-entity-lockup__metadata',

  // --- Footer actions, most final first ---
  submitButton:
    'button[data-live-test-easy-apply-submit-button], button[aria-label="Submit application"]',
  reviewButton:
    'button[data-live-test-easy-apply-review-button], button[aria-label="Review your application"]',
  nextButton: 'button[data-easy-apply-next-button], button[aria-label="Continue to next step"]',
  footerPrimary: 'footer button.artdeco-button--primary',
};

/** Field kinds. Text/radio match naukri's names so memory is shared. */
const LI_TYPES = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  RADIO: 'radio',
  CHECKBOX: 'checkbox',
  SELECT: 'dropdown',
  TYPEAHEAD: 'typeahead',
  /** Resume / cover letter upload — never filled. */
  FILE: 'file',
};

/** Copy of the post-submit confirmation modal. */
const LI_SUCCESS_PATTERN = /your application was sent|application (was )?submitted/i;

/** Buttons on that modal, in order of preference. */
const LI_SUCCESS_BUTTON_PATTERNS = [/^not now$/i, /^done$/i];

/** First option of every LinkedIn <select>; not an answer. */
const LI_SELECT_PLACEHOLDER = /^select( an)? option$/i;

const liText = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

const LiDOM = {
  // --- Visibility -------------------------------------------------------

  isVisible(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0;
  },

  /**
   * Text of a label/legend. LinkedIn renders the copy twice — once in an
   * aria-hidden span and once in a visually-hidden one — so textContent would
   * double it. Prefer the first non-empty aria-hidden span.
   */
  readLabel(el) {
    if (!el) return '';
    const shown = Array.from(el.querySelectorAll('[aria-hidden="true"]')).find((node) =>
      liText(node.textContent)
    );
    return liText(shown ? shown.textContent : el.textContent)
      .replace(/\s*\*\s*$/, '')
      .replace(/\s+Required$/i, '')
      .trim();
  },

  // --- Modals -----------------------------------------------------------

  /** The open Easy Apply modal, or null. */
  getApplyModal() {
    const modal = document.querySelector(LI_SELECTORS.applyModal);
    return this.isVisible(modal) ? modal : null;
  },

  /** "Apply to <Company>", for the activity log. */
  getModalTitle(modal) {
    const header = modal && modal.querySelector(LI_SELECTORS.modalHeader);
    return liText(header ? header.textContent : '') || 'LinkedIn application';
  },

  /**
   * The "Your application was sent" modal, or null. LinkedIn may render it in
   * the Easy Apply modal's own container, so that one is not excluded — its
   * form steps never contain this copy.
   */
  getSuccessModal() {
    return (
      Array.from(document.querySelectorAll(LI_SELECTORS.dialog)).find(
        (el) => this.isVisible(el) && LI_SUCCESS_PATTERN.test(liText(el.textContent))
      ) || null
    );
  },

  /** "Not now" (or "Done", or the ✕) on the success modal. */
  getSuccessCloseButton(modal) {
    const buttons = Array.from(modal.querySelectorAll('button')).filter((b) => this.isVisible(b));
    for (const pattern of LI_SUCCESS_BUTTON_PATTERNS) {
      const match = buttons.find((b) => pattern.test(liText(b.textContent)));
      if (match) return match;
    }
    const dismiss =
      modal.querySelector(LI_SELECTORS.dismissButton) ||
      (modal.closest(LI_SELECTORS.dialog) || modal).querySelector(LI_SELECTORS.dismissButton);
    return this.isVisible(dismiss) ? dismiss : null;
  },

  // --- Step -------------------------------------------------------------

  /**
   * Identity of the step on screen: progress + headings + field ids. Values
   * are deliberately left out, so filling a field does not look like a new
   * step. Returns '' while the step is still rendering.
   */
  getStepSignature(modal) {
    const form = modal.querySelector('form');
    if (!form) return '';
    const progress = modal.querySelector(LI_SELECTORS.progress);
    const headings = Array.from(modal.querySelectorAll(LI_SELECTORS.stepHeading)).map((h) =>
      liText(h.textContent)
    );
    const ids = this.getFields(modal).map((f) => f.id);
    if (!headings.length && !ids.length) return '';
    return [progress ? progress.value : '-', headings.join('|'), ids.join('|')].join('#');
  },

  /** Visible inline validation errors in the modal. */
  getErrors(modal) {
    return Array.from(modal.querySelectorAll(LI_SELECTORS.errorMessage))
      .filter((el) => this.isVisible(el))
      .map((el) => liText(el.textContent))
      .filter(Boolean);
  },

  /** A required resume section with no resume selected. */
  isResumeMissing(modal) {
    if (!modal.querySelector(LI_SELECTORS.resumeRequired)) return false;
    return !modal.querySelector(LI_SELECTORS.resumeCardSelected);
  },

  /** City from the contact card ("Gurugram, Haryana, India"), or ''. */
  getProfileLocation(modal) {
    const el = modal.querySelector(LI_SELECTORS.profileLocation);
    return liText(el ? el.textContent : '');
  },

  /**
   * The footer's forward action.
   * @returns {{kind: 'submit'|'review'|'next', element: HTMLButtonElement}|null}
   */
  getPrimaryAction(modal) {
    const find = (selector) =>
      Array.from(modal.querySelectorAll(selector)).find((b) => this.isVisible(b)) || null;

    const submit = find(LI_SELECTORS.submitButton);
    if (submit) return { kind: 'submit', element: submit };
    const review = find(LI_SELECTORS.reviewButton);
    if (review) return { kind: 'review', element: review };
    const next = find(LI_SELECTORS.nextButton);
    if (next) return { kind: 'next', element: next };

    // Fallback on the button's words, should the data attributes change.
    const primary = find(LI_SELECTORS.footerPrimary);
    if (!primary) return null;
    const label = liText(primary.textContent).toLowerCase();
    if (/submit/.test(label)) return { kind: 'submit', element: primary };
    if (/review/.test(label)) return { kind: 'review', element: primary };
    if (/next|continue/.test(label)) return { kind: 'next', element: primary };
    return null;
  },

  // --- Fields -----------------------------------------------------------

  /**
   * Every visible question on the current step.
   * @returns {Array<{id: string, type: string, question: string, required: boolean,
   *   root: Element, control: Element|null, inputs: HTMLInputElement[]}>}
   */
  getFields(modal) {
    const roots = Array.from(modal.querySelectorAll(LI_SELECTORS.formElement)).filter(
      (el) => this.isVisible(el) && !el.parentElement.closest(LI_SELECTORS.formElement)
    );
    return roots.map((root) => this.describeField(root)).filter(Boolean);
  },

  describeField(root) {
    const fieldset = root.querySelector(LI_SELECTORS.fieldset);
    const required = !!root.querySelector(LI_SELECTORS.requiredMarker);

    if (fieldset) {
      const radios = Array.from(fieldset.querySelectorAll(LI_SELECTORS.radio));
      const boxes = Array.from(fieldset.querySelectorAll(LI_SELECTORS.checkbox));
      const inputs = radios.length ? radios : boxes;
      if (inputs.length) {
        return {
          id: fieldset.id || inputs[0].name || inputs[0].id,
          type: radios.length ? LI_TYPES.RADIO : LI_TYPES.CHECKBOX,
          question: this.readLabel(fieldset.querySelector(LI_SELECTORS.legend)),
          required,
          root,
          control: fieldset,
          inputs,
        };
      }
    }

    const pick = (selector, type) => {
      const control = root.querySelector(selector);
      return control ? { control, type } : null;
    };
    const found =
      pick(LI_SELECTORS.fileInput, LI_TYPES.FILE) ||
      pick(LI_SELECTORS.select, LI_TYPES.SELECT) ||
      pick(LI_SELECTORS.textarea, LI_TYPES.TEXTAREA) ||
      pick(LI_SELECTORS.typeahead, LI_TYPES.TYPEAHEAD) ||
      pick(LI_SELECTORS.textInput, LI_TYPES.TEXT) ||
      // A lone checkbox outside a fieldset ("I agree to …").
      pick(LI_SELECTORS.checkbox, LI_TYPES.CHECKBOX);
    if (!found) return null;

    const { control, type } = found;
    const label =
      (control.labels && control.labels[0]) ||
      (control.id && root.querySelector(`label[for="${CSS.escape(control.id)}"]`)) ||
      root.querySelector('label');

    return {
      id: control.id || control.name || this.readLabel(label),
      type,
      question: this.readLabel(label) || liText(control.getAttribute('aria-label')),
      // Forms from other hiring systems (Workable, SmartRecruiters) often mark
      // required fields only with a "*" in the label.
      required: required || control.required || /\*\s*$/.test(liText(label ? label.textContent : '')),
      root,
      control,
      inputs: type === LI_TYPES.CHECKBOX ? [control] : [],
    };
  },

  /** Has a file been uploaded into this upload field? */
  hasUpload(field) {
    return (
      (field.control.files && field.control.files.length > 0) ||
      !!field.root.querySelector(LI_SELECTORS.uploadedFile)
    );
  },

  /** Visible label of one radio/checkbox option. */
  getOptionLabel(input) {
    const label =
      (input.labels && input.labels[0]) ||
      (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
    return this.readLabel(label) || liText(input.value);
  },

  /** Answerable <option>s of a select, placeholder excluded. */
  getSelectOptions(select) {
    return Array.from(select.options)
      .map((option) => ({ label: liText(option.textContent), value: option.value, element: option }))
      .filter((o) => o.label && !LI_SELECT_PLACEHOLDER.test(o.label) && !LI_SELECT_PLACEHOLDER.test(o.value));
  },

  /** Suggestions currently listed under a typeahead input. */
  getTypeaheadOptions(input) {
    const ids = [input.getAttribute('aria-controls'), input.getAttribute('aria-owns')].filter(Boolean);
    const roots = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const field = input.closest(LI_SELECTORS.formElement);
    if (field) roots.push(field);

    const seen = new Set();
    return roots
      .flatMap((root) => Array.from(root.querySelectorAll(LI_SELECTORS.typeaheadOption)))
      .filter((el) => !seen.has(el) && seen.add(el) && this.isVisible(el))
      .map((element) => ({ text: liText(element.textContent), element }))
      .filter((o) => o.text);
  },
};
