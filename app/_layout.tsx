import GlobalBackground from "../components/GlobalBackground";
import { Stack } from "expo-router";
import { View } from "react-native";

export default function RootLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: "#03030a" }}>
      {/* Shared cinematic atmosphere — sits behind all screens */}
      <GlobalBackground />
      <Stack
        screenOptions={{
          headerShown:  false,
          // Make every screen container transparent so GlobalBackground shows through
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
    </View>
  );
}
