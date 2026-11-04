/**
 * Cloud sync with Supabase. Runs in the background service worker.
 *
 * chrome.storage.local stays the source the extension reads from — filling is
 * instant and works offline. This module mirrors it to the `answers` table
 * (supabase/migrations) so answers survive a reinstall and follow the user to
 * other computers.
 *
 *   Local change  → chrome.storage.onChanged marks the question dirty
 *                 → pushed a few seconds later via rpc/sync_answers
 *   Every 30 min, on browser start, and on sign-in → pull, then push
 *
 * Conflicts: whichever copy has the newer `lastUsed` wins, on the server (see
 * sync_answers) and here (see _applyRemote). Deletions travel as tombstones.
 *
 * No SDK: plain fetch against Supabase's REST and auth endpoints, so there is
 * nothing to bundle.
 */
const CloudSync = {
  AUTH_KEY: 'sync::auth',
  STATE_KEY: 'sync::state',
  /**
   * storage key ('q::…' naukri, 'li::…' LinkedIn) -> {at, deleted}. The
   * server's `key` column holds the same storage key, so sites stay apart
   * there too. `at` is unique per change, so a push
   * only clears the exact version it uploaded; for a deletion it is also the
   * tombstone's timestamp.
   */
  DIRTY_KEY: 'sync::dirty',

  /**
   * Format of the server's `key` column. 2: storage key with its site
   * prefix ('q::…', 'li::…'). A browser that last synced an older format
   * re-uploads everything once (see _sync).
   */
  KEY_FORMAT: 2,

  ALARM: 'cloud-sync',
  ALARM_PERIOD_MIN: 30,
  PUSH_DELAY: 3000,
  PAGE_SIZE: 500,
  /** Re-read this far behind the cursor; applying a row twice is harmless. */
  PULL_OVERLAP_MS: 60 * 1000,

  /** Keys we are writing from a pull, so onChanged does not echo them back. */
  _applying: new Set(),
  _dirtyQueue: Promise.resolve(),
  _running: null,
  _again: false,
  _pushTimer: null,
  _refreshing: null,
  _lastStamp: 0,

  /** Strictly increasing epoch-ms, so two changes never share a stamp. */
  _stamp() {
    this._lastStamp = Math.max(Date.now(), this._lastStamp + 1);
    return this._lastStamp;
  },

  isConfigured() {
    return !!(SYNC_CONFIG.supabaseUrl && SYNC_CONFIG.supabaseAnonKey);
  },

  _url(path) {
    return SYNC_CONFIG.supabaseUrl.replace(/\/+$/, '') + path;
  },

  // --- Session ----------------------------------------------------------

  async _getSession() {
    const result = await chrome.storage.local.get(this.AUTH_KEY);
    return result[this.AUTH_KEY] || null;
  },

  async _saveSession(session) {
    const record = {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at
        ? session.expires_at * 1000
        : Date.now() + (session.expires_in || 3600) * 1000,
      user: session.user ? { id: session.user.id, email: session.user.email } : null,
    };
    await chrome.storage.local.set({ [this.AUTH_KEY]: record });
    return record;
  },

  async _authRequest(grantType, body) {
    const response = await fetch(this._url(`/auth/v1/token?grant_type=${grantType}`), {
      method: 'POST',
      headers: { apikey: SYNC_CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error_description || data.msg || data.message || `auth ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  },

  /** A valid access token, refreshing it first when close to expiry. */
  async _getAccessToken() {
    const session = await this._getSession();
    if (!session) return null;
    if (session.expiresAt - 60 * 1000 > Date.now()) return session.accessToken;

    // Refresh tokens are single-use: never run two refreshes at once.
    if (!this._refreshing) {
      this._refreshing = this._authRequest('refresh_token', { refresh_token: session.refreshToken })
        .then((fresh) => this._saveSession({ user: session.user, ...fresh }))
        .catch(async (err) => {
          // 4xx: the session is gone (revoked, account deleted). Keep local
          // answers, just stop syncing until the user signs in again.
          if (err.status >= 400 && err.status < 500) await this._clearSession();
          throw err;
        })
        .finally(() => {
          this._refreshing = null;
        });
    }
    const fresh = await this._refreshing;
    return fresh.accessToken;
  },

  async _clearSession() {
    await chrome.storage.local.remove([this.AUTH_KEY, this.STATE_KEY, this.DIRTY_KEY]);
  },

  async _api(path, { method = 'GET', body } = {}) {
    const token = await this._getAccessToken();
    if (!token) throw new Error('Not signed in');

    const response = await fetch(this._url(path), {
      method,
      headers: {
        apikey: SYNC_CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).message || text;
      } catch (_) {
        // not JSON
      }
      throw new Error(`${response.status} ${message}`.trim());
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  },

  // --- Sign in / out ----------------------------------------------------

  /**
   * Google sign-in through Supabase, using PKCE so no token ever appears in a
   * URL. Must run here, not in the popup: the popup closes the moment the
   * sign-in window takes focus.
   */
  async signIn() {
    if (!this.isConfigured()) {
      throw new Error('Cloud sync is not configured yet — see supabase/README.md.');
    }

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    );
    const authorize =
      this._url('/auth/v1/authorize?') +
      new URLSearchParams({
        provider: 'google',
        redirect_to: chrome.identity.getRedirectURL(),
        code_challenge: challenge,
        code_challenge_method: 's256',
      });

    const redirected = await chrome.identity.launchWebAuthFlow({ url: authorize, interactive: true });
    const url = new URL(redirected);
    const params = new URLSearchParams(url.search);
    new URLSearchParams(url.hash.slice(1)).forEach((value, key) => params.set(key, value));

    const code = params.get('code');
    if (!code) throw new Error(params.get('error_description') || 'Sign-in was cancelled.');

    const session = await this._authRequest('pkce', { auth_code: code, code_verifier: verifier });
    await this._saveSession(session);

    // First sync on this browser: upload everything it already knows, then
    // download everything else (newest copy of each question wins).
    await chrome.storage.local.remove(this.STATE_KEY);
    await this._markAllDirty();
    // The popup closed when Google's window took focus; bring it back so the
    // user lands on the result instead of an empty page. It re-renders on its
    // own as the sync below updates sync:: state.
    chrome.action.openPopup().catch(() => {});
    await this.syncNow();
    return this.status();
  },

  /**
   * Stop syncing. The cloud copy stays. Local answers stay too unless
   * `clearLocal` — for a shared computer, so the next person to sign in does
   * not get (or upload) them. Removing them is not a deletion: the session is
   * gone first, so onStorageChanged does not queue it for the cloud.
   */
  async signOut({ clearLocal = false } = {}) {
    const session = await this._getSession();
    if (session) {
      fetch(this._url('/auth/v1/logout'), {
        method: 'POST',
        headers: { apikey: SYNC_CONFIG.supabaseAnonKey, Authorization: `Bearer ${session.accessToken}` },
      }).catch(() => {});
    }
    await this._clearSession();
    if (clearLocal) await AnswerStore.clear();
    return this.status();
  },

  /** Delete the account and every answer stored in the cloud. Local answers stay. */
  async deleteAccount() {
    await this._api('/rest/v1/rpc/delete_account', { method: 'POST', body: {} });
    await this._clearSession();
    return this.status();
  },

  async status() {
    const [session, state, dirty] = await Promise.all([
      this._getSession(),
      this._getState(),
      this._getDirty(),
    ]);
    return {
      configured: this.isConfigured(),
      signedIn: !!session,
      email: session && session.user ? session.user.email : null,
      lastSyncAt: state.lastSyncAt || null,
      lastError: state.lastError || null,
      pending: Object.keys(dirty).length,
      syncing: !!this._running,
    };
  },

  // --- State + dirty set ------------------------------------------------

  async _getState() {
    const result = await chrome.storage.local.get(this.STATE_KEY);
    return result[this.STATE_KEY] || {};
  },

  async _setState(patch) {
    const state = { ...(await this._getState()), ...patch };
    await chrome.storage.local.set({ [this.STATE_KEY]: state });
  },

  async _getDirty() {
    const result = await chrome.storage.local.get(this.DIRTY_KEY);
    return result[this.DIRTY_KEY] || {};
  },

  /** Serialize every read-modify-write of the dirty set. */
  _updateDirty(mutate) {
    this._dirtyQueue = this._dirtyQueue
      .then(async () => {
        const dirty = await this._getDirty();
        mutate(dirty);
        await chrome.storage.local.set({ [this.DIRTY_KEY]: dirty });
      })
      .catch((err) => console.warn('[Same Answer] Could not update sync queue:', err));
    return this._dirtyQueue;
  },

  async _markAllDirty() {
    const records = await AnswerStore.getAll();
    await this._updateDirty((dirty) => {
      records.forEach((r) => {
        dirty[r.storageKey] = { at: this._stamp(), deleted: false };
      });
    });
  },

  /**
   * chrome.storage.onChanged listener: queue local edits for upload — only
   * while signed in. Changes made while signed out stay on this computer:
   * sign-in uploads every local answer anyway (_markAllDirty), and a deletion
   * made while signed out must never delete from the cloud later.
   */
  onStorageChanged(changes, area) {
    if (area !== 'local' || !this.isConfigured()) return;

    const changed = {};
    for (const [storageKey, change] of Object.entries(changes)) {
      if (!AnswerStore.isAnswerKey(storageKey)) continue;
      // Written by our own pull: already on the server.
      if (this._applying.delete(storageKey)) continue;
      changed[storageKey] = {
        at: this._stamp(),
        deleted: change.newValue === undefined,
      };
    }
    if (!Object.keys(changed).length) return;

    this._getSession().then((session) => {
      if (!session) return;
      this._updateDirty((dirty) => Object.assign(dirty, changed)).then(() => this.schedulePush());
    });
  },

  schedulePush() {
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.syncNow().catch(() => {}), this.PUSH_DELAY);
  },

  // --- Sync -------------------------------------------------------------

  /** Pull then push. Concurrent calls share one run, plus one follow-up. */
  syncNow() {
    if (this._running) {
      this._again = true;
      return this._running;
    }
    this._running = this._sync().finally(() => {
      this._running = null;
      if (this._again) {
        this._again = false;
        this.syncNow().catch(() => {});
      }
    });
    return this._running;
  },

  async _sync() {
    if (!this.isConfigured() || !(await this._getSession())) return;
    // A delete made a moment ago may not have reached onStorageChanged yet;
    // let it queue its tombstone before the pull looks at local state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this._dirtyQueue;
    try {
      if ((await this._getState()).keyFormat !== this.KEY_FORMAT) {
        await this._markAllDirty();
        await this._setState({ keyFormat: this.KEY_FORMAT });
      }
      await this._pull();
      await this._push();
      await this._setState({ lastSyncAt: Date.now(), lastError: null });
    } catch (err) {
      // Signed out while this run was in flight: nothing to report.
      if (!(await this._getSession())) return;
      console.warn('[Same Answer] Sync failed:', err);
      await this._setState({ lastError: String(err.message || err) });
    }
  },

  async _pull() {
    const state = await this._getState();
    const since = state.cursor
      ? new Date(Date.parse(state.cursor) - this.PULL_OVERLAP_MS).toISOString()
      : null;

    let newest = state.cursor || null;
    for (let offset = 0; ; offset += this.PAGE_SIZE) {
      const query = new URLSearchParams({
        select: 'key,record,deleted,last_used,updated_at',
        order: 'updated_at.asc,key.asc',
        limit: String(this.PAGE_SIZE),
        offset: String(offset),
      });
      if (since) query.append('updated_at', `gt.${since}`);

      const rows = await this._api(`/rest/v1/answers?${query}`);
      await this._applyRemote(rows);
      for (const row of rows) {
        if (!newest || Date.parse(row.updated_at) > Date.parse(newest)) newest = row.updated_at;
      }
      if (rows.length < this.PAGE_SIZE) break;
    }

    if (newest) await this._setState({ cursor: newest });
  },

  /** Apply server rows locally where the server's copy is newer. */
  async _applyRemote(rows) {
    // Rows are keyed by storage key, site prefix included ('li::…'); skip
    // anything this version does not know how to file.
    rows = rows.filter((r) => AnswerStore.isAnswerKey(r.key));
    if (!rows.length) return;
    const [local, dirty] = await Promise.all([
      chrome.storage.local.get(rows.map((r) => r.key)),
      this._getDirty(),
    ]);

    const toSet = {};
    const toRemove = [];
    for (const row of rows) {
      const storageKey = row.key;
      const mine = local[storageKey];
      const remoteUsed = Number(row.last_used) || 0;
      // Deleted here but not uploaded yet: the deletion time is our version.
      const pending = dirty[row.key];
      const mineUsed = mine ? mine.lastUsed || 0 : pending && pending.deleted ? pending.at : -1;

      if (remoteUsed <= mineUsed) continue;
      if (row.deleted) {
        if (mine) toRemove.push(storageKey);
      } else if (row.record) {
        toSet[storageKey] = row.record;
      }
    }

    Object.keys(toSet).concat(toRemove).forEach((k) => this._applying.add(k));
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  },

  async _push() {
    // Let any queued onChanged bookkeeping land first.
    await this._dirtyQueue;
    const dirty = await this._getDirty();
    const keys = Object.keys(dirty);
    if (!keys.length) return;

    const local = await chrome.storage.local.get(keys);

    // The last local event was a delete, yet a copy is present: a pull raced
    // the delete and brought back an older version. The delete stands.
    const resurrected = keys.filter((key) => dirty[key].deleted && local[key]);
    if (resurrected.length) {
      resurrected.forEach((key) => {
        this._applying.add(key);
        delete local[key];
      });
      await chrome.storage.local.remove(resurrected);
    }

    for (let i = 0; i < keys.length; i += this.PAGE_SIZE) {
      const batch = keys.slice(i, i + this.PAGE_SIZE);
      const changes = batch.map((key) => {
        const record = local[key];
        return record
          ? { key, record, deleted: false, last_used: record.lastUsed || 0 }
          : { key, record: null, deleted: true, last_used: dirty[key].at };
      });

      await this._api('/rest/v1/rpc/sync_answers', { method: 'POST', body: { changes } });

      // Only clear entries nobody touched while the request was in flight.
      await this._updateDirty((current) => {
        batch.forEach((key) => {
          if (current[key] && current[key].at === dirty[key].at) delete current[key];
        });
      });
    }
  },
};

/** RFC 4648 base64url without padding, for PKCE. */
function base64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
