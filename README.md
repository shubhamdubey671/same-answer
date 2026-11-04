# Same Answer

A Chrome extension that answers the screening questions on Naukri and LinkedIn Easy Apply for you. You answer a question once. The next time it shows up, Same Answer fills it in.

It does not apply to jobs for you, search for jobs, or open tabs. You still click Apply.

## What it does

On Naukri, the application form is a chatbot that asks one question at a time: notice period, current CTC, preferred location and so on. When Same Answer knows the answer, it types it or picks the option and presses Save. When it doesn't, it waits, watches what you answer, and remembers it.

On LinkedIn, it fills the empty fields in the Easy Apply modal: text boxes, dropdowns, radio buttons, checkboxes and the location search. Fields LinkedIn already filled are left alone. If nothing is left empty it clicks Next or Review. It stops before Submit unless you turn on auto-submit in Settings, and it is off by default because a submitted application can't be taken back.

A few details worth knowing:

- Naukri and LinkedIn keep separate answers. "Notice period?" is free text on one and a number on the other, so an answer from one site is never used on the other.
- For multiple-choice questions it remembers which options were on screen. If you picked Bangalore out of Pune and Bangalore, it won't auto-answer a later Noida, Bangalore, Pune question until you've chosen between those too.
- The popup has an Answers tab where you can search, edit and delete anything it saved, and an Activity tab that shows what happened to every question it saw.
- Backups are a JSON file: Export in Settings, Import to bring it back. Importing merges, and the more recently used answer wins.

## Sync

Signing in is optional. Without it every answer stays on your computer and everything works the same. With "Sign in" in the popup, you log in with Google and your answers are backed up and synced to every computer you sign in on. A reinstall brings them back after you sign in again.

The answers are stored in a Supabase database run by the extension's author, and each account can read only its own rows. Local storage stays the copy the extension fills from, so it works offline. When two computers change the same question, the one used most recently wins, and deleting a question deletes it everywhere. Signing out keeps the cloud copy and lets you keep or clear the answers on that computer. "Delete cloud backup" in the account menu removes your account and every answer stored for it.

What is stored and who can see it is spelled out in [PRIVACY.md](PRIVACY.md).

### Running your own backend

If you fork this and want sync to go to your own Supabase project, follow [supabase/README.md](supabase/README.md) and put your project URL and publishable key in [src/background/config.js](src/background/config.js). Leave both empty to build a version with no sync at all. The publishable key is meant to be public. Never put a `service_role` key in the extension.

## Install

From the Chrome Web Store: link to be added.

From source:

1. Clone this repo.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click Load unpacked and pick the repo folder.

After pulling changes, click the reload icon on the extension's card, then reload any open Naukri or LinkedIn tabs. Don't remove and re-add the extension, because Chrome deletes its saved answers when it is removed. Export a backup first if you're unsure.

## Permissions

`storage` for saved answers, `identity` for the Google sign-in window, and `alarms` for the periodic sync. It runs on `www.naukri.com` and `www.linkedin.com`, and talks to one other host, the Supabase project in `config.js`, and only after you sign in. See [PRIVACY.md](PRIVACY.md).

## How it works

```
manifest.json
src/
  content/naukri/      fills the application chatbot
    selectors.js         every Naukri CSS selector lives here
    content.js           question detection, filling and learning
  content/linkedin/    fills the Easy Apply modal
    selectors.js         every LinkedIn selector lives here
    content.js
  background/
    background.js        saves answers on behalf of the content scripts
    sync.js, config.js   optional cloud backup of answers (Supabase)
  popup/               the toolbar popup
  shared/storage.js    saved answers in chrome.storage.local
supabase/              SQL migrations and setup for the sync backend
test/                  plain Node tests, no dependencies
scripts/check-extension.js   checks that every file the manifest names exists and parses
```

Content scripts can't finish a write once the page navigates away, so they hand saves to the background worker, which outlives the page. Answers live in `chrome.storage.local`, and that is the copy the extension fills from, so it works offline.

When Naukri or LinkedIn change their markup, fixing it means editing the `selectors.js` file for that site. Nothing else talks to the page's DOM directly.

## Development

No build step and no dependencies.

```
npm run check    # files exist, scripts parse, the service worker boots
npm test         # option-question rule and backup import against a fake chrome.storage
npm run verify   # both
```

Content scripts of one extension share a JavaScript world, so keep top-level names unique across them. The check catches duplicates.

## Terms of the sites

LinkedIn's terms forbid automated tools. Same Answer leaves the final click to you for that reason, and you are responsible for how you use it on either site.

## License

MIT. See [LICENSE](LICENSE).
