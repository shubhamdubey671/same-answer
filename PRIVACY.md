# Privacy policy

Same Answer fills application questions on Naukri and LinkedIn Easy Apply using answers you gave before. It has no analytics, no ads, and it never sells or shares your data.

## Without signing in

Saved questions and answers, an activity log of the last 200 questions seen, and your settings stay in `chrome.storage.local` on your computer. The extension makes no network requests.

## If you sign in with Google (optional)

Your answers are backed up to a Supabase database run by the extension's author, so they can sync across your computers.

- What is stored: your Google account's email address and an internal user ID, and for each saved question its text, your answer, the answer type, how often and when you last used it, and, for multiple-choice questions, the options you were offered.
- Why: only to restore and sync your answers. It is not used for anything else.
- Who can read it: the database enforces that each account can read only its own rows. The author, as the database owner, has technical access to the stored data and does not look at it, use it, or share it.
- Because answers can include personal details such as your notice period, salary expectations or phone number, only sign in if you are comfortable with that.
- Sign-in uses Google OAuth through Supabase. The extension never sees your Google password.

## What the extension reads

It runs on `www.naukri.com` and `www.linkedin.com` and reads the application form you are filling in, to detect the question and fill the answer. It reads nothing on other sites.

## Your control

- Edit or delete any answer in the popup, or use "Delete all answers" in Settings. While signed in, deletes also remove the cloud copy.
- Account menu, "Delete cloud backup": permanently deletes your account and every answer stored for it.
- Signing out stops syncing and keeps the cloud copy, unless you delete it as above.
- Removing the extension deletes the data on that computer.

## Changes

Any change to this policy will be published in this file in the repository.
