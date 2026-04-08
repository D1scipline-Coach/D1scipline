/**
 * Supabase PostgREST wrapper for per-user app data.
 * Uses only `fetch` — no SDK, no Node modules, Expo-safe.
 *
 * Schema (run once in Supabase SQL Editor):
 *
 *   create table user_data (
 *     user_id    uuid primary key references auth.users(id) on delete cascade,
 *     profile    jsonb,
 *     blocks     jsonb,
 *     streak     jsonb,
 *     tasks      jsonb,
 *     updated_at timestamptz default now()
 *   );
 *   alter table user_data enable row level security;
 *   create policy "users own their data" on user_data
 *     for all using (auth.uid() = user_id)
 *     with check  (auth.uid() = user_id);
 */

const SUPABASE_URL  = process.env.EXPO_PUBLIC_SUPABASE_URL  ?? "";
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export type UserData = {
  profile?: any;
  blocks?:  any;
  streak?:  any;
  tasks?:   any;
};

function dbHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_ANON,
    "Authorization": `Bearer ${accessToken}`,
    "Prefer":        "return=representation",
  };
}

/**
 * Load this user's persisted data from Supabase.
 * Returns null if no row exists yet (new account).
 */
export async function loadUserData(
  userId: string,
  accessToken: string
): Promise<UserData | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${encodeURIComponent(userId)}&select=profile,blocks,streak,tasks`,
      { headers: dbHeaders(accessToken) }
    );
    if (!res.ok) {
      console.warn("[db] loadUserData failed:", res.status);
      return null;
    }
    const rows: UserData[] = await res.json();
    return rows[0] ?? null;
  } catch (e) {
    console.warn("[db] loadUserData error:", e);
    return null;
  }
}

/**
 * Upsert (create or merge) this user's data in Supabase.
 * Only the keys present in `patch` are written — others are left untouched
 * by using PostgREST's merge upsert.
 */
export async function saveUserData(
  userId: string,
  accessToken: string,
  patch: Partial<UserData>
): Promise<void> {
  try {
    const body = { user_id: userId, ...patch, updated_at: new Date().toISOString() };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method:  "POST",
      headers: {
        ...dbHeaders(accessToken),
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("[db] saveUserData failed:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("[db] saveUserData error:", e);
  }
}
