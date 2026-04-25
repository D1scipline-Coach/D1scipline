if (!process.env.EXPO_PUBLIC_API_BASE_URL) {
  console.warn(
    "[discipline-coach] EXPO_PUBLIC_API_BASE_URL is not set in .env. " +
    "Auth and chat requests will fail. Set it to your backend's address and restart Expo."
  );
}

// Value is injected at bundle time by Expo from the .env file (EXPO_PUBLIC_ prefix required).
// Physical device / Expo Go: use your machine's LAN IP (e.g. http://192.168.1.x:3001)
// iOS simulator / web: http://localhost:3001
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
