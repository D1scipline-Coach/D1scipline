import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { signIn, signUp, type AuthUser } from "../lib/auth";

interface Props {
  onSuccess: (user: AuthUser) => void;
}

export default function AuthScreen({ onSuccess }: Props) {
  const [mode, setMode]             = useState<"signin" | "signup">("signin");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [showPassword, setShowPass] = useState(false);
  const [error, setError]           = useState("");
  const [loading, setLoading]       = useState(false);

  const handleSubmit = async () => {
    setError("");
    const trimEmail = email.trim().toLowerCase();
    const trimPass  = password.trim();

    if (!trimEmail || !trimPass) {
      setError("Email and password are required.");
      return;
    }
    if (trimPass.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      if (mode === "signup") {
        const result = await signUp(trimEmail, trimPass);
        if ("error" in result) { setError(result.error); return; }
        onSuccess(result.user);
      } else {
        const result = await signIn(trimEmail, trimPass);
        if ("error" in result) { setError(result.error); return; }
        onSuccess(result.user);
      }
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={s.inner}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={s.header}>
          <Text style={s.title}>Aira</Text>
          <Text style={s.sub}>Your discipline coach.</Text>
        </View>

        <View style={s.form}>
          <TextInput
            style={s.input}
            placeholder="Email"
            placeholderTextColor="#555"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={(v) => { setEmail(v); setError(""); }}
          />
          <View style={s.passwordRow}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              placeholder="Password"
              placeholderTextColor="#555"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={(v) => { setPassword(v); setError(""); }}
            />
            <Pressable
              style={s.eyeBtn}
              onPress={() => setShowPass((p) => !p)}
              hitSlop={8}
            >
              <Ionicons
                name={showPassword ? "eye-off-outline" : "eye-outline"}
                size={20}
                color="#555"
              />
            </Pressable>
          </View>

          {!!error && <Text style={s.errorText}>{error}</Text>}

          <Pressable
            style={[s.primaryBtn, loading && s.primaryBtnDisabled]}
            onPress={handleSubmit}
            disabled={loading}
          >
            <Text style={s.primaryBtnText}>
              {loading
                ? "Please wait…"
                : mode === "signin" ? "Sign in" : "Create account"}
            </Text>
          </Pressable>

          <Pressable
            style={s.toggleBtn}
            onPress={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}
          >
            <Text style={s.toggleText}>
              {mode === "signin"
                ? "Don't have an account? Sign up"
                : "Already have an account? Sign in"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ACCENT = "#6C63FF";

const s = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: "#000000" },
  inner:   { flex: 1, justifyContent: "center", padding: 24, gap: 32 },
  header:  { gap: 8 },
  title:   { color: "#ffffff", fontSize: 40, fontWeight: "800" },
  sub:     { color: "#bdbdbd", fontSize: 15 },

  form:    { gap: 12 },
  passwordRow: { flexDirection: "row", alignItems: "center", gap: 0 },
  eyeBtn: {
    position: "absolute",
    right: 14,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  input: {
    backgroundColor: "#0f0f0f",
    borderWidth: 1,
    borderColor: "#262626",
    borderRadius: 14,
    padding: 14,
    color: "#ffffff",
    fontSize: 15,
  },

  errorText: { color: "#e07070", fontSize: 13, marginTop: 2 },

  primaryBtn: {
    backgroundColor: ACCENT,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 15 },

  toggleBtn:  { alignItems: "center", paddingVertical: 10 },
  toggleText: { color: "#777", fontSize: 13 },
});
