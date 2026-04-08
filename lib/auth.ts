/**
 * Supabase Auth via direct REST API calls.
 * Uses only `fetch` (built into React Native) and AsyncStorage.
 * Zero npm dependencies — no ws, no Node core modules, no Metro shims needed.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export type AuthUser = { id: string; email: string };

type AuthSession = {
  access_token:  string;
  refresh_token: string;
  expires_at:    number; // Unix timestamp (seconds)
  user:          AuthUser;
};

const SESSION_KEY = "dc:auth_session";

const SUPABASE_URL  = process.env.EXPO_PUBLIC_SUPABASE_URL  ?? "";
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

function authHeaders(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON,
  };
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  return h;
}

function parseSession(data: any): AuthSession | null {
  if (!data?.access_token || !data?.user?.id) return null;
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token ?? "",
    expires_at:    Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    user:          { id: data.user.id, email: data.user.email ?? "" },
  };
}

async function saveSession(session: AuthSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function refreshSession(refreshToken: string): Promise<AuthSession | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({ refresh_token: refreshToken }),
      }
    );
    if (!res.ok) return null;
    return parseSession(await res.json());
  } catch {
    return null;
  }
}

function normalizeAuthError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("already registered") || s.includes("already exists")) {
    return "Account already exists. Try signing in instead.";
  }
  if (s.includes("invalid login") || s.includes("invalid_grant") || s.includes("invalid credentials")) {
    return "Invalid email or password.";
  }
  if (s.includes("email not confirmed")) {
    return "This account needs email confirmation. Disable it in Supabase for Expo Go testing.";
  }
  if (s.includes("password") && s.includes("6")) {
    return "Password must be at least 6 characters.";
  }
  if (s.includes("invalid format") || s.includes("unable to validate email")) {
    return "Please enter a valid email address.";
  }
  return raw;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Called once on app mount. Returns the current user or null. */
export async function loadSession(): Promise<AuthUser | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const session: AuthSession = JSON.parse(raw);
    const nowSecs = Math.floor(Date.now() / 1000);

    // Token still valid for at least 60 more seconds — use it as-is
    if (session.expires_at > nowSecs + 60) return session.user;

    // Token expiring — attempt silent refresh
    const refreshed = await refreshSession(session.refresh_token);
    if (!refreshed) {
      await AsyncStorage.removeItem(SESSION_KEY);
      return null;
    }
    await saveSession(refreshed);
    return refreshed.user;
  } catch {
    return null;
  }
}

/** Sign in with email + password. Returns user on success or error string. */
export async function signIn(
  email: string,
  password: string
): Promise<{ user: AuthUser } | { error: string }> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({ email, password }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return { error: normalizeAuthError(data?.error_description ?? data?.message ?? "Sign in failed.") };
    }
    const session = parseSession(data);
    if (!session) return { error: "Invalid response from server." };
    await saveSession(session);
    return { user: session.user };
  } catch (e: any) {
    return { error: e?.message ?? "Network error." };
  }
}

/** Sign up with email + password. Returns user on success or error string. */
export async function signUp(
  email: string,
  password: string
): Promise<{ user: AuthUser } | { error: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: normalizeAuthError(data?.error_description ?? data?.message ?? "Sign up failed.") };
    }
    if (!data?.access_token) {
      // No token means email confirmation is still enabled in Supabase.
      return {
        error:
          "Email confirmation is still enabled in Supabase. " +
          "Go to Authentication → Settings and disable it for Expo Go testing.",
      };
    }
    const session = parseSession(data);
    if (!session) return { error: "Invalid response from server." };
    await saveSession(session);
    return { user: session.user };
  } catch (e: any) {
    return { error: e?.message ?? "Network error." };
  }
}

/** Returns the stored access token, or null if no valid session. */
export async function getAccessToken(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: AuthSession = JSON.parse(raw);
    return session.access_token ?? null;
  } catch {
    return null;
  }
}

/** Sign out. Clears local session regardless of network result. */
export async function signOut(accessToken?: string): Promise<void> {
  try {
    if (accessToken) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method:  "POST",
        headers: authHeaders(accessToken),
      });
    }
  } catch {
    // best-effort — always clear locally
  } finally {
    await AsyncStorage.removeItem(SESSION_KEY);
  }
}
