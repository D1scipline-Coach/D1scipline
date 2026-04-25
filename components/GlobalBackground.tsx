/**
 * GlobalBackground
 *
 * Full-screen ambient atmosphere layer. Renders the same blue/purple/pink glow
 * environment used on the splash screen, so every app surface shares one
 * continuous visual world.
 *
 * Usage: render once in _layout.tsx behind the navigator. Individual screens
 * must have backgroundColor: "transparent" on their root containers so this
 * layer shows through.
 *
 * pointerEvents="none" — never intercepts touches.
 */

import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { StyleSheet, View } from "react-native";

export default function GlobalBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>

      {/* ── Base ─────────────────────────────────────────────────────────────── */}
      <View style={[StyleSheet.absoluteFillObject, { backgroundColor: "#03030a" }]} />

      {/* ── Blue — upper-left corner ──────────────────────────────────────────── */}
      {/* Outer diffuse bloom */}
      <View style={{
        position: "absolute", top: -260, left: -260,
        width: 680, height: 680, borderRadius: 340,
        backgroundColor: "#00D1FF", opacity: 0.038,
      }} />
      {/* Concentrated core */}
      <View style={{
        position: "absolute", top: -160, left: -160,
        width: 440, height: 440, borderRadius: 220,
        backgroundColor: "#00D1FF", opacity: 0.060,
      }} />

      {/* ── Purple — right-middle ─────────────────────────────────────────────── */}
      <View style={{
        position: "absolute", top: 80, right: -260,
        width: 680, height: 680, borderRadius: 340,
        backgroundColor: "#7B61FF", opacity: 0.042,
      }} />
      <View style={{
        position: "absolute", top: 180, right: -160,
        width: 440, height: 440, borderRadius: 220,
        backgroundColor: "#7B61FF", opacity: 0.072,
      }} />

      {/* ── Pink — lower-left ────────────────────────────────────────────────── */}
      <View style={{
        position: "absolute", top: 500, left: -240,
        width: 620, height: 620, borderRadius: 310,
        backgroundColor: "#FF3D9A", opacity: 0.032,
      }} />
      <View style={{
        position: "absolute", top: 600, left: -140,
        width: 400, height: 400, borderRadius: 200,
        backgroundColor: "#FF3D9A", opacity: 0.050,
      }} />

      {/* ── Vignette — darkens edges, focuses eye inward ─────────────────────── */}
      <LinearGradient
        colors={["rgba(3,3,10,0.65)", "rgba(3,3,10,0.1)", "rgba(3,3,10,0)"]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 200 }}
        pointerEvents="none"
      />
      <LinearGradient
        colors={["rgba(3,3,10,0)", "rgba(3,3,10,0.1)", "rgba(3,3,10,0.55)"]}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 200 }}
        pointerEvents="none"
      />
    </View>
  );
}
