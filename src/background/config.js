/**
 * Cloud sync settings. Leave both empty to run without sync — everything else
 * works exactly the same. Setup steps: supabase/README.md.
 *
 * The anon key is meant to be public: it only identifies the project, and
 * row-level security keeps each user to their own answers.
 */
const SYNC_CONFIG = {
  supabaseUrl: 'https://zmymqvnkobdqbdlnwxjs.supabase.co',
  /** Project Settings → API → anon / publishable key. */
  supabaseAnonKey: 'sb_publishable_YBrCAKx1vIfJ82-yr7plfw_juE-6-W8',
};
