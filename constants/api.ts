if (__DEV__ && !process.env.EXPO_PUBLIC_API_BASE_URL) {
  console.warn(
    "[discipline-coach] EXPO_PUBLIC_API_BASE_URL is not set in .env. " +
    "Chat requests will fail. Set it to your backend's address and restart Expo."
  );
}

// Value is injected at bundle time by Expo from .env (EXPO_PUBLIC_ prefix required).
// Do not fall back to localhost — the correct value depends on your target
// (physical device vs simulator vs emulator). See .env for instructions.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";