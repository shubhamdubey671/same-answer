# Cloud sync setup (Supabase)

One-time setup that lets users sign in with Google and have their answers
backed up and synced. Without it the extension works as before, local only.

Project: your own Supabase project (the published build uses the one set in `src/background/config.js`).

## 1. Create the table and functions

Supabase dashboard → **SQL Editor** → New query → paste the whole of
[migrations/20260924000000_answers_sync.sql](migrations/20260924000000_answers_sync.sql)
→ **Run**. You should see "Success. No rows returned".

Check: **Table Editor** shows an `answers` table with RLS enabled.

## 2. Put the API key in the extension

Dashboard → **Project Settings → API Keys**. Copy the **publishable** key
(`sb_publishable_…`) or, under *Legacy API keys*, the **anon public** key. Paste
it into `supabaseAnonKey` in [../src/background/config.js](../src/background/config.js).

This key is public by design. **Never** put the `service_role` / secret key in
the extension — it bypasses row-level security.

## 3. Google sign-in

**a. Google Cloud Console** (console.cloud.google.com), any project:

1. *APIs & Services → OAuth consent screen*: External, app name, your email.
   While in "Testing", add your Google account under *Test users*.
2. *APIs & Services → Credentials → Create credentials → OAuth client ID*:
   - Application type: **Web application** (not "Chrome extension")
   - Authorized redirect URI:
     `https://<your-project-ref>.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret**.

**b. Supabase** → **Authentication → Sign In / Providers → Google**: enable,
paste the client ID and secret, save.

## 4. Allow the extension's redirect URL

Supabase → **Authentication → URL Configuration → Redirect URLs** → add

    https://pajmiggekolehifbgcfcmioamfjbmcnh.chromiumapp.org/**

`pajmiggekolehifbgcfcmioamfjbmcnh` is the extension's ID. It is fixed by the
`key` in [../manifest.json](../manifest.json), so it is the same on every
computer and whatever the folder is called. A Chrome Web Store listing gets an
ID of its own — add that one too when publishing.

## 5. Try it

Reload the extension (↻), open the popup → **Sign in with Google**. After
signing in, the popup shows your email and "synced just now", and the
`answers` table in the dashboard fills with your saved questions.

## How sync behaves

- Answers are uploaded ~3 s after they change and pulled every 30 minutes,
  on browser start, and on **Sync now**.
- If two computers change the same question, the most recently used answer
  wins.
- Deleting a question (or **Clear All**) deletes it everywhere.
- **Sign out** stops syncing; answers stay on the computer and in the cloud.
  Typing `DELETE` in the sign-out prompt deletes the account and its cloud
  data; answers on the computer are kept.
