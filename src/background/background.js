/**
 * Same Answer — background service worker.
 *
 * Content-script writes are routed through here because the page does not
 * live long enough to finish them: after "Thank you for your responses" the
 * drawer closes and naukri navigates away, often while the last answer's
 * get-then-set round trip is still in flight. This worker survives the
 * navigation, so the write completes.
 *
 * It also runs cloud sync (sync.js), since sign-in and periodic syncing both
 * need something that outlives the popup.
 */

importScripts('../shared/storage.js', 'config.js', 'sync.js');

/** Store operations the content script may call, and nothing else. */
const OPS = {
  set: (question, answer, type, options, site) => AnswerStore.set(question, answer, type, options, site),
  touch: (question, site) => AnswerStore.touch(question, site),
  log: (entry) => AnswerStore.log(entry),
};

/** Account operations, for the popup only — never for a web page's script. */
const POPUP_OPS = {
  'sync.status': () => CloudSync.status(),
  'sync.signIn': () => CloudSync.signIn(),
  'sync.signOut': (options) => CloudSync.signOut(options),
  'sync.now': () => CloudSync.syncNow().then(() => CloudSync.status()),
  'sync.deleteAccount': () => CloudSync.deleteAccount(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const name = message && message.op;
  // Content scripts have sender.tab; extension pages such as the popup do not.
  const op = OPS[name] || (!sender.tab && POPUP_OPS[name]);
  if (!op) return false;

  Promise.resolve(op(...(message.args || [])))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));

  return true; // keep the channel open for the async response
});

// --- Cloud sync ----------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => CloudSync.onStorageChanged(changes, area));

function scheduleSync() {
  chrome.alarms.create(CloudSync.ALARM, { periodInMinutes: CloudSync.ALARM_PERIOD_MIN });
}

function startUp() {
  scheduleSync();
  CloudSync.syncNow().catch(() => {});
}

chrome.runtime.onInstalled.addListener(startUp);
chrome.runtime.onStartup.addListener(startUp);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CloudSync.ALARM) CloudSync.syncNow().catch(() => {});
});
