/**
 * Popup: browse, search, edit and delete saved answers; review the activity
 * log; settings, backups, and the cloud-sync account.
 * Vanilla JS, no framework. All storage access goes through AnswerStore;
 * account actions go to the background worker, which owns sign-in and sync.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const countEl = $('count');
  const accountEl = $('account');
  const toolbarEl = $('toolbar');
  const listEl = $('list');
  const settingsEl = $('settings');
  const searchEl = $('search');
  const autoSubmitEl = $('linkedin-auto-submit');
  const importFile = $('import-file');
  const toastEl = $('toast');
  const toastText = $('toast-text');
  const toastAction = $('toast-action');
  const dialogEl = $('dialog');

  const tabs = Array.from(document.querySelectorAll('.tab'));
  const siteChips = Array.from(document.querySelectorAll('.site-chip'));

  /** 'answers' | 'activity' | 'settings' */
  let mode = 'answers';
  /** '' (all), 'naukri' or 'linkedin'. */
  let siteFilter = '';
  /** All records, refreshed after any write. */
  let records = [];
  /** Activity log entries, newest first. */
  let logEntries = [];
  /** Storage key of the record being edited, if any. */
  let editingKey = null;
  /** Last account status from the background worker. */
  let account = null;

  // --- Icons (static markup only; never mixed with user data) ------------

  const svg = (body, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const ICONS = {
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>', 15),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 15),
    sync: svg('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>', 15),
    more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', 16),
    cloud: svg('<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/>', 18),
    inbox: svg('<path d="M4 13l2.5-7h11L20 13v5H4v-5z"/><path d="M4 13h5l1 2h4l1-2h5"/>', 20),
    clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', 20),
    google:
      '<svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
  };

  // --- Helpers ----------------------------------------------------------

  /** Build an element with text set safely (never innerHTML with user data). */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(icon, label, className = '') {
    const button = el('button', `icon-btn ${className}`.trim());
    button.type = 'button';
    button.innerHTML = ICONS[icon];
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
  }

  const formatAnswer = (answer) => (Array.isArray(answer) ? answer.join(', ') : String(answer ?? ''));

  const formatTime = (ms) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
  };

  const timeAgo = (ms) => {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    return formatTime(ms);
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const siteLabel = (site) => (AnswerStore.SITES[site] || AnswerStore.SITES.naukri).label;

  /** Log entries from before LinkedIn support carry no site: they are naukri's. */
  const entrySite = (entry) => entry.site || 'naukri';

  function siteBadge(site) {
    const known = AnswerStore.SITES[site] ? site : 'naukri';
    return el('span', `badge badge-${known}`, siteLabel(known));
  }

  const TYPE_LABELS = {
    text: 'Text',
    textarea: 'Long text',
    radio: 'Choice',
    chips: 'Choice',
    dropdown: 'Dropdown',
    checkbox: 'Checkbox',
    typeahead: 'Search',
    unknown: 'Other',
  };

  // --- Toast ------------------------------------------------------------

  let toastTimer = null;

  /** A short message at the bottom, optionally with one action (e.g. Undo). */
  function toast(text, { action, onAction, error = false, duration = 3500 } = {}) {
    clearTimeout(toastTimer);
    toastText.textContent = text;
    toastEl.classList.toggle('error', error);
    toastAction.hidden = !action;
    toastAction.textContent = action || '';
    toastAction.onclick = action
      ? () => {
          hideToast();
          onAction();
        }
      : null;
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, action ? 6000 : duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
  }

  // --- Dialog -----------------------------------------------------------

  /**
   * In-popup confirmation. Resolves with the chosen action's value, or null
   * when dismissed (Esc, or the Cancel action).
   * @param {{title: string, body: string, actions: Array<{label: string, value: string, style?: string}>}} opts
   */
  function ask({ title, body, actions }) {
    $('dialog-title').textContent = title;
    $('dialog-body').textContent = body;
    const container = $('dialog-actions');
    container.textContent = '';
    actions.concat({ label: 'Cancel', value: '' }).forEach(({ label, value, style }) => {
      const button = el('button', `btn ${style || ''}`.trim(), label);
      button.value = value;
      container.appendChild(button);
    });

    return new Promise((resolve) => {
      dialogEl.addEventListener('close', () => resolve(dialogEl.returnValue || null), { once: true });
      dialogEl.returnValue = '';
      dialogEl.showModal();
    });
  }

  // --- Background worker ------------------------------------------------

  async function background(op, ...args) {
    const response = await chrome.runtime.sendMessage({ op, args });
    if (!response || !response.ok) throw new Error(response ? response.error : 'no response');
    return response.result;
  }

  // --- Account ----------------------------------------------------------

  function renderAccount() {
    accountEl.textContent = '';
    // End users never see an unconfigured build; hide rather than explain.
    if (!account || !account.configured) {
      accountEl.hidden = true;
      return;
    }
    accountEl.hidden = false;

    if (!account.signedIn) {
      const icon = el('span', 'account-icon');
      icon.innerHTML = ICONS.cloud;

      const text = el('div', 'account-text');
      text.appendChild(
        el('div', 'account-title', records.length ? `Back up your ${plural(records.length, 'answer')}` : 'Back up your answers')
      );
      text.appendChild(el('div', 'account-sub wrap', 'Keep them safe and use them on any computer.'));

      const button = el('button', 'btn btn-google');
      button.type = 'button';
      button.innerHTML = ICONS.google;
      button.append(' Sign in');
      button.addEventListener('click', signIn);

      accountEl.append(icon, text, button);
      return;
    }

    const email = account.email || 'Signed in';
    accountEl.appendChild(el('span', 'avatar', email.charAt(0).toUpperCase()));

    const text = el('div', 'account-text');
    const title = el('div', 'account-title', email);
    title.title = email;
    text.appendChild(title);

    const sub = el('div', 'account-sub');
    const dot = el('span', 'dot');
    let line;
    if (account.syncing) {
      dot.classList.add('dot-busy');
      line = 'Syncing…';
    } else if (account.lastError) {
      dot.classList.add('dot-error');
      sub.classList.add('error');
      line = 'Sync failed — tap ↻ to retry';
      sub.title = account.lastError;
    } else if (account.pending) {
      dot.classList.add('dot-busy');
      line = `${plural(account.pending, 'change')} waiting to sync`;
    } else {
      dot.classList.add('dot-ok');
      line = account.lastSyncAt ? `Backed up ${timeAgo(account.lastSyncAt)}` : 'Backed up';
    }
    sub.append(dot, el('span', '', line));
    text.appendChild(sub);
    accountEl.appendChild(text);

    const actions = el('div', 'account-actions');
    const syncBtn = iconButton('sync', 'Sync now', account.syncing ? 'spin' : '');
    syncBtn.addEventListener('click', syncNow);
    const moreBtn = iconButton('more', 'Account options');
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu(actions);
    });
    actions.append(syncBtn, moreBtn);
    accountEl.appendChild(actions);
  }

  function toggleMenu(anchor) {
    const open = anchor.querySelector('.menu');
    if (open) {
      open.remove();
      return;
    }
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    const item = (label, onClick, danger) => {
      const button = el('button', `menu-item${danger ? ' danger' : ''}`, label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', () => {
        menu.remove();
        onClick();
      });
      menu.appendChild(button);
    };
    item('Sign out…', signOut);
    item('Delete cloud backup…', deleteAccount, true);
    anchor.appendChild(menu);
    menu.querySelector('button').focus();
  }

  document.addEventListener('click', () => {
    const menu = document.querySelector('.menu');
    if (menu) menu.remove();
  });

  async function loadAccount() {
    try {
      account = await background('sync.status');
    } catch (err) {
      account = null;
    }
    renderAccount();
  }

  async function signIn() {
    // The popup usually closes when Google's window opens; the background
    // worker finishes the sign-in and the next popup shows the result.
    toast('Opening Google sign-in…');
    try {
      account = await background('sync.signIn');
      renderAccount();
      toast('Signed in. Your answers are backed up.');
    } catch (err) {
      toast(`Sign-in failed: ${err.message}`, { error: true });
    }
  }

  async function syncNow() {
    account = { ...account, syncing: true };
    renderAccount();
    try {
      account = await background('sync.now');
      renderAccount();
      toast(account.lastError ? 'Sync failed.' : 'Everything is backed up.', { error: !!account.lastError });
    } catch (err) {
      await loadAccount();
      toast(`Sync failed: ${err.message}`, { error: true });
    }
  }

  async function signOut() {
    const choice = await ask({
      title: 'Sign out?',
      body:
        'Your cloud backup is kept either way.\n\n' +
        'On a shared computer, remove your answers so the next person does not autofill with them.',
      actions: [
        { label: 'Sign out, keep answers here', value: 'keep', style: 'btn-primary' },
        { label: 'Sign out and clear this computer', value: 'remove', style: 'btn-danger' },
      ],
    });
    if (!choice) return;
    try {
      account = await background('sync.signOut', { clearLocal: choice === 'remove' });
      renderAccount();
      toast(choice === 'remove' ? 'Signed out. Answers removed from this computer.' : 'Signed out.');
    } catch (err) {
      toast(`Sign-out failed: ${err.message}`, { error: true });
    }
  }

  async function deleteAccount() {
    const choice = await ask({
      title: 'Delete cloud backup?',
      body:
        'This permanently deletes your account and every answer stored in the cloud, on all computers you signed in on.\n\n' +
        'Answers on this computer are kept.',
      actions: [{ label: 'Delete cloud backup', value: 'delete', style: 'btn-danger-solid' }],
    });
    if (!choice) return;
    try {
      account = await background('sync.deleteAccount');
      renderAccount();
      toast('Cloud backup deleted.');
    } catch (err) {
      toast(`Could not delete: ${err.message}`, { error: true });
    }
  }

  // --- Answers ----------------------------------------------------------

  function visibleRecords() {
    const query = searchEl.value.trim().toLowerCase();
    return records.filter(
      (r) =>
        (!siteFilter || r.site === siteFilter) &&
        (!query ||
          (r.question || r.key || '').toLowerCase().includes(query) ||
          formatAnswer(r.answer).toLowerCase().includes(query))
    );
  }

  function emptyState(icon, title, text) {
    const box = el('div', 'empty');
    const circle = el('span', 'empty-icon');
    circle.innerHTML = ICONS[icon];
    box.append(circle, el('p', 'empty-title', title), el('p', '', text));
    return box;
  }

  function renderAnswers() {
    const items = visibleRecords();
    if (!items.length) {
      listEl.appendChild(
        records.length
          ? emptyState('inbox', 'No matches', 'Try another search or site.')
          : emptyState(
              'inbox',
              'No answers yet',
              'Apply to a job on Naukri or LinkedIn. Every question you answer is saved here and filled in for you next time.'
            )
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((record) => fragment.appendChild(renderCard(record)));
    listEl.appendChild(fragment);
  }

  function renderCard(record) {
    const card = el('article', 'card');
    const question = record.question || record.key || '(no question)';

    const head = el('div', 'card-head');
    head.appendChild(siteBadge(record.site));
    const uses = record.usageCount ? ` · filled ${record.usageCount}×` : '';
    head.appendChild(el('span', 'meta', `${TYPE_LABELS[record.type] || 'Other'}${uses}`));

    if (editingKey !== record.storageKey) {
      const actions = el('div', 'card-actions');
      const edit = iconButton('edit', 'Edit answer');
      edit.addEventListener('click', () => {
        editingKey = record.storageKey;
        render();
      });
      const del = iconButton('trash', 'Delete answer', 'danger');
      del.addEventListener('click', () => deleteRecord(record));
      actions.append(edit, del);
      head.appendChild(actions);
    }
    card.appendChild(head);

    const q = el('p', 'question', question);
    q.title = question;
    card.appendChild(q);

    if (editingKey === record.storageKey) {
      card.appendChild(renderEditor(record));
      return card;
    }

    card.appendChild(el('p', 'answer', formatAnswer(record.answer)));

    const choices = record.choices || [];
    if (choices.length) {
      const last = choices[choices.length - 1];
      const others = last.options.filter((o) => o !== last.answer);
      const more = choices.length > 1 ? ` · learned from ${choices.length} picks` : '';
      card.appendChild(el('p', 'learned', `Chosen over ${others.join(', ')}${more}`));
    }
    return card;
  }

  function renderEditor(record) {
    const wrap = document.createDocumentFragment();
    const isMulti = Array.isArray(record.answer);

    if (isMulti) wrap.appendChild(el('p', 'hint', 'Several choices — separate them with commas.'));
    if ((record.choices || []).length) {
      wrap.appendChild(el('p', 'hint', 'Saving replaces what was learned: this answer is used whenever it is one of the options.'));
    }

    const input = el('textarea', 'edit-input');
    input.value = formatAnswer(record.answer);
    input.rows = Math.min(6, Math.max(2, Math.ceil(input.value.length / 44)));

    const actions = el('div', 'edit-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const save = el('button', 'btn btn-primary', 'Save');
    actions.append(cancel, save);

    const close = () => {
      editingKey = null;
      render();
    };
    const commit = async () => {
      const raw = input.value.trim();
      if (!raw) {
        input.focus();
        return;
      }
      const answer = isMulti ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
      await AnswerStore.set(record.question || record.key, answer, record.type, undefined, record.site);
      editingKey = null;
      await load();
      toast('Answer updated.');
    };

    save.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    wrap.append(input, actions);
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return wrap;
  }

  async function deleteRecord(record) {
    const { storageKey, site, key, ...stored } = record;
    await AnswerStore.delete(storageKey);
    await load();
    toast('Answer deleted.', {
      action: 'Undo',
      onAction: async () => {
        await chrome.storage.local.set({ [storageKey]: stored });
        await load();
      },
    });
  }

  // --- Activity ---------------------------------------------------------

  const OUTCOMES = {
    captured: { label: 'Saved', tone: 'good' },
    autofilled: { label: 'Filled', tone: 'good' },
    submitted: { label: 'Submitted', tone: 'good' },
    asked: { label: 'Asked you', tone: 'wait' },
    skipped: { label: 'Skipped', tone: 'wait' },
    missed: { label: 'Not saved', tone: 'bad' },
    failed: { label: 'Could not fill', tone: 'bad' },
    error: { label: 'Error', tone: 'bad' },
  };
  const DOT_FOR_TONE = { good: 'dot-ok', wait: 'dot-busy', bad: 'dot-error' };

  function renderActivity() {
    const query = searchEl.value.trim().toLowerCase();
    const entries = logEntries.filter(
      (e) =>
        (!siteFilter || entrySite(e) === siteFilter) &&
        (!query ||
          [e.question, e.answer, e.detail, (e.options || []).join(' ')].join(' ').toLowerCase().includes(query))
    );

    if (!entries.length) {
      listEl.appendChild(
        logEntries.length
          ? emptyState('clock', 'No matches', 'Try another search or site.')
          : emptyState('clock', 'No activity yet', 'Every question the extension sees on Naukri or LinkedIn shows up here, with what happened to it.')
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => fragment.appendChild(renderEvent(entry)));
    listEl.appendChild(fragment);
  }

  function renderEvent(entry) {
    const outcome = OUTCOMES[entry.outcome] || { label: entry.outcome, tone: 'wait' };
    const row = el('div', 'event');
    row.appendChild(el('span', `dot ${DOT_FOR_TONE[outcome.tone]}`));

    const body = el('div', 'event-body');
    const top = el('div', 'event-top');
    top.append(el('span', `outcome outcome-${outcome.tone}`, outcome.label), siteBadge(entrySite(entry)));
    const time = el('time', '', formatTime(entry.at));
    time.dateTime = new Date(entry.at).toISOString();
    top.appendChild(time);
    body.appendChild(top);

    body.appendChild(el('p', 'event-question', entry.question || ''));

    const details = [];
    if (entry.answer) details.push(`→ ${entry.answer}`);
    if (entry.detail && entry.outcome !== 'captured') details.push(entry.detail);
    if (details.length) body.appendChild(el('p', 'event-detail', details.join(' · ')));

    row.appendChild(body);
    return row;
  }

  // --- Render -----------------------------------------------------------

  function render() {
    countEl.textContent = plural(records.length, 'answer');
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.mode === mode)));
    siteChips.forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.site === siteFilter)));

    const isSettings = mode === 'settings';
    settingsEl.hidden = !isSettings;
    toolbarEl.hidden = isSettings;
    listEl.hidden = isSettings;
    searchEl.placeholder = mode === 'activity' ? 'Search activity' : 'Search answers';

    listEl.textContent = '';
    if (mode === 'answers') renderAnswers();
    if (mode === 'activity') renderActivity();
    renderAccount();
  }

  async function load() {
    [records, logEntries] = await Promise.all([AnswerStore.getAll(), AnswerStore.getLog()]);
    render();
  }

  // --- Settings ---------------------------------------------------------

  async function exportBackup() {
    const data = await AnswerStore.exportAll();
    const count = Object.keys(data.records).length;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `same-answer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${plural(count, 'answer')}.`);
  }

  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      const { added, updated } = await AnswerStore.importAll(data);
      await load();
      toast(`Imported: ${added} new, ${updated} updated.`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, { error: true });
    }
  }

  async function clearLog() {
    if (!logEntries.length) {
      toast('The activity log is already empty.');
      return;
    }
    const choice = await ask({
      title: 'Clear activity log?',
      body: 'Saved answers are not affected.',
      actions: [{ label: 'Clear log', value: 'clear', style: 'btn-danger' }],
    });
    if (!choice) return;
    await AnswerStore.clearLog();
    await load();
    toast('Activity log cleared.');
  }

  async function clearAll() {
    if (!records.length) {
      toast('There are no answers to delete.');
      return;
    }
    const signedIn = account && account.signedIn;
    const choice = await ask({
      title: `Delete all ${plural(records.length, 'answer')}?`,
      body: signedIn
        ? 'They are also deleted from your cloud backup and every computer you are signed in on. This cannot be undone.'
        : 'This cannot be undone. Export a backup first if you might want them back.',
      actions: [{ label: 'Delete all answers', value: 'delete', style: 'btn-danger-solid' }],
    });
    if (!choice) return;
    await AnswerStore.clear();
    editingKey = null;
    await load();
    toast('All answers deleted.');
  }

  // --- Wiring -----------------------------------------------------------

  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode;
      editingKey = null;
      render();
    })
  );

  siteChips.forEach((chip) =>
    chip.addEventListener('click', () => {
      siteFilter = chip.dataset.site;
      render();
    })
  );

  searchEl.addEventListener('input', render);

  AnswerStore.getSettings().then((settings) => {
    autoSubmitEl.checked = settings.linkedinAutoSubmit;
  });
  autoSubmitEl.addEventListener('change', async () => {
    await AnswerStore.setSettings({ linkedinAutoSubmit: autoSubmitEl.checked });
    toast(autoSubmitEl.checked ? 'LinkedIn applications will be submitted automatically.' : 'You will click Submit yourself.');
  });

  $('export').addEventListener('click', exportBackup);
  $('import').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const [file] = importFile.files;
    if (file) importBackup(file);
    importFile.value = '';
  });
  $('clear-log').addEventListener('click', clearLog);
  $('clear-all').addEventListener('click', clearAll);

  // Refresh live while the popup is open (e.g. next to an application).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('sync::'))) loadAccount();
    if (editingKey === null) load();
  });

  load();
  loadAccount();
})();
