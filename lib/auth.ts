import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE_URL } from "../constants/api";

export type AuthUser = { id: string; email: string };

type StoredSession = { token: string; user: AuthUser };

const SESSION_KEY = "dc:auth_session";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function saveSession(session: StoredSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function getStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Called once on app mount. Returns the current user or null. */
export async function loadSession(): Promise<AuthUser | null> {
  const session = await getStoredSession();
  return session?.user ?? null;
}

/** Returns the stored access token, or null if no valid session. */
export async function getAccessToken(): Promise<string | null> {
  const session = await getStoredSession();
  return session?.token ?? null;
}

/** Sign up with email + password. */
export async function signUp(
  email: string,
  password: string
): Promise<{ user: AuthUser } | { error: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/signup`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error ?? "Sign up failed." };
    await saveSession({ token: data.token, user: data.user });
    return { user: data.user };
  } catch (e: any) {
    return { error: e?.message ?? "Network error. Is the server running?" };
  }
}

/** Sign in with email + password. */
export async function signIn(
  email: string,
  password: string
): Promise<{ user: AuthUser } | { error: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/signin`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error ?? "Sign in failed." };
    await saveSession({ token: data.token, user: data.user });
    return { user: data.user };
  } catch (e: any) {
    return { error: e?.message ?? "Network error. Is the server running?" };
  }
}

/** Sign out. Clears local session regardless of network result. */
export async function signOut(accessToken?: string): Promise<void> {
  try {
    if (accessToken) {
      await fetch(`${API_BASE_URL}/api/auth/signout`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } catch {
    // best-effort — always clear locally
  } finally {
    await AsyncStorage.removeItem(SESSION_KEY);
  }
}
