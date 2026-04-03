import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { API_BASE_URL } from "../constants/api";

// ---------- Storage keys ----------
const STORE = {
  profile: "dc:profile",
  blocks:  "dc:blocks",
  tasks:   "dc:tasks",
  chat:    "dc:chat",
} as const;


/**
 * Discipline Coach — Notifications MVP
 * - Schedule blocks
 * - Timeline plan generator
 * - Local notifications for today's tasks
 * - "Test reminder (30s)" button to verify notifications immediately
 *
 * Uses Expo Router (this file is the route at /).
 */

// ---------- Types ----------
type Profile = { name: string; goal: string; wake: string; sleep: string };

type BlockType = "Work" | "School" | "Kids" | "Commute" | "Other";
type ScheduleBlock = {
  id: string;
  title: string;
  type: BlockType;
  startText: string;
  endText: string;
  startMin: number;
  endMin: number;
};

type TaskKind = "Walk" | "Meal" | "Hydration" | "Mobility" | "Sleep";
type TimedTask = {
  id: string;
  timeMin: number;
  timeText: string;
  title: string;
  kind: TaskKind;
  done: boolean;
};

type TabKey = "Today" | "Schedule" | "Chat" | "Progress" | "Settings";

// ---------- Helpers ----------
function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function parseTimeToMinutes(input: string): number | null {
  const raw = input.trim().toUpperCase();
  if (!raw) return null;

  const hasAm = raw.includes("AM");
  const hasPm = raw.includes("PM");

  let cleaned = raw.replace(/[^0-9:]/g, "");

  if (!cleaned.includes(":") && cleaned.length === 4) {
    cleaned = `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
  } else if (!cleaned.includes(":") && cleaned.length <= 2) {
    cleaned = `${cleaned}:00`;
  }

  const parts = cleaned.split(":");
  if (parts.length !== 2) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (m < 0 || m > 59) return null;

  let hour = h;

  if (hasAm || hasPm) {
    if (hour < 1 || hour > 12) return null;
    if (hasAm) {
      if (hour === 12) hour = 0;
    } else {
      if (hour !== 12) hour += 12;
    }
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return hour * 60 + m;
}

function minutesToTimeText(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const minute = m % 60;
  const ampm = hour24 >= 12 ? "PM" : "AM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${pad2(minute)} ${ampm}`;
}

function overlapsBlock(t: number, block: ScheduleBlock): boolean {
  return t >= block.startMin && t < block.endMin;
}

function isBlocked(t: number, blocks: ScheduleBlock[]): boolean {
  return blocks.some((b) => overlapsBlock(t, b));
}

function nextFreeMinute(start: number, blocks: ScheduleBlock[], sleepMin: number): number | null {
  let t = start;
  while (t < sleepMin) {
    if (!isBlocked(t, blocks)) return t;
    t += 5;
  }
  return null;
}

function buildTodaysPlan(params: { wakeMin: number; sleepMin: number; blocks: ScheduleBlock[] }): TimedTask[] {
  const { wakeMin, sleepMin, blocks } = params;

  const desired = [
    { kind: "Hydration" as TaskKind, title: "Drink 16oz water", offset: 15 },
    { kind: "Walk" as TaskKind, title: "Walk (10–20 min)", offset: 45 },
    { kind: "Meal" as TaskKind, title: "Protein meal", offset: 180 },
    { kind: "Hydration" as TaskKind, title: "Drink 16oz water", offset: 330 },
    { kind: "Walk" as TaskKind, title: "Walk (10–20 min)", offset: 450 },
    { kind: "Meal" as TaskKind, title: "Protein meal", offset: 600 },
    { kind: "Mobility" as TaskKind, title: "5–10 min mobility / stretch", offset: 690 },
    { kind: "Sleep" as TaskKind, title: "Begin wind-down (screens off soon)", offset: 0 }, // handled below
  ];

  const tasks: TimedTask[] = [];

  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];

    let target = wakeMin + d.offset;
    if (d.kind === "Sleep") target = sleepMin - 45;

    target = clamp(target, wakeMin, sleepMin - 5);
    const free = nextFreeMinute(target, blocks, sleepMin);
    if (free == null) continue;

    tasks.push({
      id: `task_${Date.now()}_${i}`,
      timeMin: free,
      timeText: minutesToTimeText(free),
      title: d.title,
      kind: d.kind,
      done: false,
    });
  }

  tasks.sort((a, b) => a.timeMin - b.timeMin);

  // de-dupe if too close
  const filtered: TimedTask[] = [];
  for (const t of tasks) {
    const last = filtered[filtered.length - 1];
    if (!last || t.timeMin - last.timeMin >= 10) filtered.push(t);
  }
  return filtered;
}

function calcScore(tasks: TimedTask[]) {
  if (!tasks.length) return 0;
  const done = tasks.filter((t) => t.done).length;
  return Math.round((done / tasks.length) * 100);
}

function dateForDayAtMinutes(minSinceMidnight: number, dayOffset: 0 | 1) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  d.setMinutes(minSinceMidnight);
  return d;
}

// ---------- Styles ----------
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0b", padding: 16, gap: 12 },

  h1: { color: "#fff", fontSize: 34, fontWeight: "800" },
  h2: { color: "#fff", fontSize: 26, fontWeight: "800" },
  sub: { color: "#bdbdbd", fontSize: 14, marginBottom: 6 },
  sub2: { color: "#bdbdbd", fontSize: 13, marginBottom: 6 },

  card: { backgroundColor: "#121212", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#1f1f1f", gap: 8 },

  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  smallLabel: { color: "#bdbdbd", fontSize: 12, fontWeight: "700", marginTop: 4 },
  bodyMuted: { color: "#bdbdbd", fontSize: 13, lineHeight: 18 },
  miniNote: { color: "#777", fontSize: 12, lineHeight: 16 },

  input: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 12, padding: 12, color: "#fff" },

  primaryBtn: { backgroundColor: "#ffffff", padding: 14, borderRadius: 14, alignItems: "center", flex: 1 },
  primaryBtnText: { color: "#0b0b0b", fontWeight: "800", fontSize: 14 },

  smallBtn: {
    backgroundColor: "#0f0f0f",
    borderWidth: 1,
    borderColor: "#262626",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flex: 1,
    alignItems: "center",
  },
  smallBtnText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  chip: { backgroundColor: "#1b1b1b", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#2a2a2a" },
  chipText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  linkBtn: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  linkText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  timelineRow: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, padding: 12, flexDirection: "row", justifyContent: "space-between", gap: 10 },
  timelineRowDone: { borderColor: "#3a3a3a", opacity: 0.92 },
  timelineLeft: { flex: 1, gap: 4 },
  timelineRight: { alignItems: "flex-end", gap: 6, justifyContent: "center" },

  timeText: { color: "#fff", fontWeight: "900", fontSize: 12 },
  taskText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  taskTextDone: { color: "#bdbdbd", textDecorationLine: "line-through" },
  taskTap: { color: "#777", fontSize: 12, fontWeight: "800" },

  kindPill: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    backgroundColor: "#151515",
    overflow: "hidden",
  },

  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  typeBtn: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 },
  typeBtnActive: { backgroundColor: "#ffffff", borderColor: "#ffffff" },
  typeText: { color: "#bdbdbd", fontWeight: "900", fontSize: 12 },
  typeTextActive: { color: "#0b0b0b" },

  blockRow: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, padding: 12, flexDirection: "row", gap: 10, alignItems: "center" },
  blockTitle: { color: "#fff", fontWeight: "900", fontSize: 13 },

  removeBtn: { backgroundColor: "#141414", borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  removeText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  tabBar: { flexDirection: "row", gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#1e1e1e" },
  tabBtn: { flex: 1, backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, paddingVertical: 10, alignItems: "center" },
  tabBtnActive: { backgroundColor: "#ffffff", borderColor: "#ffffff" },
  tabText: { color: "#bdbdbd", fontWeight: "900", fontSize: 11 },
  tabTextActive: { color: "#0b0b0b" },
});

// ---------- UI ----------
function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.primaryBtn, disabled && { opacity: 0.5 }]}>
      <Text style={styles.primaryBtnText}>{title}</Text>
    </Pressable>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

function SmallButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.smallBtn}>
      <Text style={styles.smallBtnText}>{title}</Text>
    </Pressable>
  );
}

// ---------- Notifications setup ----------
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,

    // ✅ add these (required by some Expo versions/types)
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function ensureNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === "granted";
}

// ---------- App ----------
export default function Index() {
  // persistence — false until the initial AsyncStorage load completes
  const [loaded, setLoaded] = useState(false);

  // profile/auth
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<TabKey>("Today");
  const [profile, setProfile] = useState<Profile | null>(null);

  // routine
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [tasks, setTasks] = useState<TimedTask[]>([]);

  // chat — lifted here so they survive tab switches and can be persisted
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // notifications
  const [notifReady, setNotifReady] = useState(false);
  const [scheduledNotifIds, setScheduledNotifIds] = useState<string[]>([]);
const [dayMode, setDayMode] = useState<"today" | "tomorrow">("today");
  const score = useMemo(() => calcScore(tasks), [tasks]);

  // Onboarding fields
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("Model Build (Lean + Athletic)");
  const [wake, setWake] = useState("7:00 AM");
  const [sleep, setSleep] = useState("11:00 PM");

  // Load persisted data once on mount
  useEffect(() => {
    (async () => {
      try {
        const [profileRaw, blocksRaw, tasksRaw, chatRaw] = await Promise.all([
          AsyncStorage.getItem(STORE.profile),
          AsyncStorage.getItem(STORE.blocks),
          AsyncStorage.getItem(STORE.tasks),
          AsyncStorage.getItem(STORE.chat),
        ]);
        if (profileRaw) {
          setProfile(JSON.parse(profileRaw) as Profile);
          setAuthed(true);
        }
        if (blocksRaw) setBlocks(JSON.parse(blocksRaw) as ScheduleBlock[]);
        if (tasksRaw)  setTasks(JSON.parse(tasksRaw) as TimedTask[]);
        if (chatRaw) {
          const { messages: msgs, sessionId: sid } = JSON.parse(chatRaw);
          if (msgs)  setMessages(msgs);
          if (sid)   setSessionId(sid);
        }
      } catch (e) {
        console.warn("[storage] Load failed:", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Save profile whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded || !profile) return;
    AsyncStorage.setItem(STORE.profile, JSON.stringify(profile)).catch(console.warn);
  }, [profile, loaded]);

  // Save blocks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.blocks, JSON.stringify(blocks)).catch(console.warn);
  }, [blocks, loaded]);

  // Save tasks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.tasks, JSON.stringify(tasks)).catch(console.warn);
  }, [tasks, loaded]);

  // Save chat messages and sessionId whenever either changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.chat, JSON.stringify({ messages, sessionId })).catch(console.warn);
  }, [messages, sessionId, loaded]);

  useEffect(() => {
    (async () => {
      if (!authed) return;

      // Android needs a channel (safe to call on iOS too)
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("discipline", {
          name: "Discipline Reminders",
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      const ok = await ensureNotificationPermissions();
      setNotifReady(ok);
      if (!ok) {
        Alert.alert(
          "Notifications are OFF",
          "Enable notifications for Expo Go in your phone settings to receive discipline reminders."
        );
      }
    })();
  }, [authed]);

  async function cancelAllScheduled() {
    try {
      for (const id of scheduledNotifIds) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    } catch {}
    setScheduledNotifIds([]);
  }

  async function scheduleFromTasks(newTasks: TimedTask[]) {
    await cancelAllScheduled();

    if (!notifReady) return;

    const now = new Date();
    const ids: string[] = [];

    for (const t of newTasks) {
      const fireDate = dateForDayAtMinutes(t.timeMin, dayMode === "today" ? 0 : 1);

      // only schedule if in the future (give 30s buffer)
      if (fireDate.getTime() <= now.getTime() + 30_000) continue;

      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Discipline Coach",
          body: `${t.timeText} — ${t.title}`,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
      });

      ids.push(id);
    }

    setScheduledNotifIds(ids);
  }

  function generatePlanFromProfileAndSchedule(p: Profile, schedule: ScheduleBlock[]) {
    const wakeMin = parseTimeToMinutes(p.wake);
    const sleepMin = parseTimeToMinutes(p.sleep);

    if (wakeMin == null || sleepMin == null) {
      Alert.alert("Time format issue", "Enter wake/sleep like '7:00 AM' or '23:00'.");
      return;
    }
    if (sleepMin <= wakeMin + 60) {
      Alert.alert("Sleep time issue", "Sleep must be at least 1 hour after wake.");
      return;
    }

    const plan = buildTodaysPlan({ wakeMin, sleepMin, blocks: schedule });
    setTasks(plan);
    scheduleFromTasks(plan);
  }

  async function testReminderIn30s() {
    if (!notifReady) {
      Alert.alert("Notifications are OFF", "Enable notifications permission first.");
      return;
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Discipline Coach (Test)",
        body: "If you see this, reminders are working ✅",
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 30  },
    });
    Alert.alert("Test scheduled", "You should get a notification in ~30 seconds.");
  }

  // Block render until the initial storage load is done.
  // Prevents a flash of the onboarding screen for returning users.
  if (!loaded) return null;

  // ---------- Onboarding ----------
  if (!authed) {
    const canContinue = name.trim().length >= 2;

    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.h1}>Discipline Coach</Text>
        <Text style={styles.sub}>Routine → Consistency → Physique.</Text>

        <Card>
          <Text style={styles.label}>Name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="e.g., Nate" placeholderTextColor="#777" style={styles.input} />

          <View style={{ height: 12 }} />

          <Text style={styles.label}>Goal</Text>
          <TextInput value={goal} onChangeText={setGoal} style={styles.input} />

          <View style={{ height: 12 }} />

          <Text style={styles.label}>Wake time</Text>
          <TextInput value={wake} onChangeText={setWake} style={styles.input} />

          <View style={{ height: 12 }} />

          <Text style={styles.label}>Sleep time</Text>
          <TextInput value={sleep} onChangeText={setSleep} style={styles.input} />
        </Card>

        <PrimaryButton
          title="Create my plan"
          disabled={!canContinue}
          onPress={() => {
            const p = { name: name.trim(), goal, wake, sleep };
            setProfile(p);
            setAuthed(true);
            setTab("Today");
            generatePlanFromProfileAndSchedule(p, []);
          }}
        />

        <Text style={styles.miniNote}>
          After login you’ll be asked for notification permission. Approve it to activate discipline reminders.
        </Text>
      </SafeAreaView>
    );
  }

  // ---------- Screens ----------
  const Today = () => {
    const toggleTask = (id: string) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    };

    return (
      <View style={{ flex: 1, gap: 12 }}>
        <Text style={styles.h2}>Today</Text>
        <Text style={styles.sub2}>Lock in, {profile?.name || "Coach"}.</Text>

        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>Discipline Score</Text>
            <Chip label={`${score}/100`} />
          </View>
          <Text style={styles.bodyMuted}>
            Reminders: {notifReady ? "ON" : "OFF"} • Scheduled: {scheduledNotifIds.length}
          </Text>

       <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
  <SmallButton title="Test reminder (30s)" onPress={testReminderIn30s} />
  <SmallButton
    title={dayMode === "today" ? "Scheduling: Today" : "Scheduling: Tomorrow"}
    onPress={() => setDayMode(dayMode === "today" ? "tomorrow" : "today")}
  />
</View>

<View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
  <SmallButton
    title={dayMode === "today" ? "Reschedule Today" : "Schedule Tomorrow"}
    onPress={() => profile && generatePlanFromProfileAndSchedule(profile, blocks)}
  />
  <SmallButton title="Cancel reminders" onPress={cancelAllScheduled} />
</View>
        </Card>

        <Card style={{ flex: 1 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>Timeline</Text>
            <Pressable onPress={() => profile && generatePlanFromProfileAndSchedule(profile, blocks)} style={styles.linkBtn}>
              <Text style={styles.linkText}>Regenerate</Text>
            </Pressable>
          </View>

          <FlatList
            data={tasks}
            keyExtractor={(item) => item.id}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            renderItem={({ item }) => (
              <Pressable onPress={() => toggleTask(item.id)} style={[styles.timelineRow, item.done && styles.timelineRowDone]}>
                <View style={styles.timelineLeft}>
                  <Text style={styles.timeText}>{item.timeText}</Text>
                  <Text style={[styles.taskText, item.done && styles.taskTextDone]}>{item.title}</Text>
                </View>

                <View style={styles.timelineRight}>
                  <Text style={styles.kindPill}>{item.kind}</Text>
                  <Text style={styles.taskTap}>{item.done ? "done" : "tap"}</Text>
                </View>
              </Pressable>
            )}
          />
        </Card>

        <Card>
          <Text style={styles.label}>Discipline controls</Text>
          <Text style={styles.bodyMuted}>
            Add schedule blocks so tasks avoid work/school/kids time.
          </Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PrimaryButton title="Go to Schedule" onPress={() => setTab("Schedule")} />
          </View>
        </Card>
      </View>
    );
  };

  const Schedule = () => {
    // Kept local so typing doesn't re-render Index and dismiss the keyboard
    const [blockTitle, setBlockTitle] = useState("");
    const [blockType, setBlockType] = useState<BlockType>("Work");
    const [blockStart, setBlockStart] = useState("9:00 AM");
    const [blockEnd, setBlockEnd] = useState("5:00 PM");

    const typeButtons: BlockType[] = ["Work", "School", "Kids", "Commute", "Other"];

    const addBlock = () => {
      const title = blockTitle.trim() || blockType;
      const s = parseTimeToMinutes(blockStart);
      const e = parseTimeToMinutes(blockEnd);

      if (s == null || e == null) {
        Alert.alert("Time format", "Use times like '9:00 AM' or '13:30'.");
        return;
      }
      if (e <= s) {
        Alert.alert("Time range", "End time must be after start time.");
        return;
      }

      const newBlock: ScheduleBlock = {
        id: `blk_${Date.now()}`,
        title,
        type: blockType,
        startText: minutesToTimeText(s),
        endText: minutesToTimeText(e),
        startMin: s,
        endMin: e,
      };

      setBlocks((prev) => [...prev, newBlock].sort((a, b) => a.startMin - b.startMin));
      setBlockTitle("");
    };

    const removeBlock = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

    return (
      <View style={{ flex: 1, gap: 12 }}>
        <Text style={styles.h2}>Schedule</Text>
        <Text style={styles.sub2}>Add blocks so the coach builds around your real life.</Text>

        <Card>
          <Text style={styles.label}>Add a block</Text>

          <Text style={styles.smallLabel}>Type</Text>
          <View style={styles.typeRow}>
            {typeButtons.map((t) => {
              const active = blockType === t;
              return (
                <Pressable key={t} onPress={() => setBlockType(t)} style={[styles.typeBtn, active && styles.typeBtnActive]}>
                  <Text style={[styles.typeText, active && styles.typeTextActive]}>{t}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.smallLabel}>Label (optional)</Text>
          <TextInput value={blockTitle} onChangeText={setBlockTitle} placeholder="e.g., Work shift" placeholderTextColor="#777" style={styles.input} />

          <View style={{ height: 10 }} />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>Start</Text>
              <TextInput value={blockStart} onChangeText={setBlockStart} style={styles.input} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>End</Text>
              <TextInput value={blockEnd} onChangeText={setBlockEnd} style={styles.input} />
            </View>
          </View>

          <View style={{ height: 10 }} />
          <PrimaryButton title="Add block" onPress={addBlock} />
        </Card>

        <Card style={{ flex: 1 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>Your blocks</Text>
            <Pressable
              onPress={() => {
                if (!profile) return;
                generatePlanFromProfileAndSchedule(profile, blocks);
                setTab("Today");
              }}
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>Generate Plan</Text>
            </Pressable>
          </View>

          {blocks.length === 0 ? (
            <Text style={styles.bodyMuted}>No blocks yet. Add Work/School/Kids time so the plan fits your day.</Text>
          ) : (
            <FlatList
              data={blocks}
              keyExtractor={(b) => b.id}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item }) => (
                <View style={styles.blockRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockTitle}>{item.title}</Text>
                    <Text style={styles.bodyMuted}>
                      {item.type} • {item.startText}–{item.endText}
                    </Text>
                  </View>

                  <Pressable onPress={() => removeBlock(item.id)} style={styles.removeBtn}>
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
              )}
            />
          )}

          <View style={{ height: 10 }} />
          <PrimaryButton title="Cancel all reminders (today)" onPress={cancelAllScheduled} />
        </Card>
      </View>
    );
  };

const Chat = () => {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  // messages and sessionId are lifted to Index state for persistence and tab-switch survival

const handleAskCoach = async () => {
  console.log("SEND pressed. message=", message);

  const trimmed = message.trim();
  if (!trimmed) return;

  // Optimistically show the user's message and clear the input
  setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
  setMessage("");

  try {
    setLoading(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    console.log("About to fetch:", `${API_BASE_URL}/api/coach`);

    const res = await fetch(`${API_BASE_URL}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        sessionId: sessionId ?? undefined,
        name: profile?.name ?? "User",
        goal: profile?.goal ?? "Build discipline",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log("Fetch finished. status=", res.status);

    const text = await res.text();
    console.log("Raw response text:", text);

    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("Response was not valid JSON. Raw text: " + text);
    }

    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    console.log("Parsed reply:", data?.reply);

    // Persist session so subsequent messages continue the same conversation
    if (data.sessionId) setSessionId(data.sessionId);

    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: data?.reply ?? "No reply field returned." },
    ]);
  } catch (err: any) {
    console.error("handleAskCoach ERROR:", err);
    Alert.alert("Error", err?.message ? String(err.message) : String(err));
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "❌ Error: " + (err?.message ? String(err.message) : String(err)) },
    ]);
  } finally {
    setLoading(false);
  }
};

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, padding: 20 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={80}
    >
      <ScrollView style={{ flex: 1 }}>
        {messages.map((msg, index) => (
          <View
            key={index}
            style={{
              alignSelf:
                msg.role === "user" ? "flex-end" : "flex-start",
              backgroundColor:
                msg.role === "user" ? "#2E86DE" : "#1E1E1E",
              padding: 12,
              borderRadius: 12,
              marginBottom: 10,
              maxWidth: "80%",
            }}
          >
            <Text style={{ color: "white" }}>
              {msg.content}
            </Text>
          </View>
        ))}

        {loading && (
          <Text style={{ color: "gray", marginTop: 10 }}>
            Coach is thinking...
          </Text>
        )}
      </ScrollView>

      <View style={{ flexDirection: "row", marginTop: 10 }}>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Ask your coach..."
          placeholderTextColor="gray"
          style={{
            flex: 1,
            backgroundColor: "#1E1E1E",
            color: "white",
            padding: 12,
            borderRadius: 10,
            marginRight: 10,
          }}
        />

        <TouchableOpacity
          onPress={handleAskCoach}
          style={{
            backgroundColor: "#2E86DE",
            padding: 12,
            borderRadius: 10,
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "white" }}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
};

  // ---------- Progress ----------
  const Progress = () => {
    const done = tasks.filter((t) => t.done).length;
    const total = tasks.length;

    const kinds: TaskKind[] = ["Walk", "Meal", "Hydration", "Mobility", "Sleep"];
    const breakdown = kinds
      .map((k) => ({
        kind: k,
        done: tasks.filter((t) => t.kind === k && t.done).length,
        total: tasks.filter((t) => t.kind === k).length,
      }))
      .filter((b) => b.total > 0);

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={{ gap: 12 }}>
          <Text style={styles.h2}>Progress</Text>
          <Text style={styles.sub2}>{profile?.goal ?? "Your goal"}</Text>

          <Card>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>Today's score</Text>
              <Chip label={`${score}/100`} />
            </View>
            <Text style={styles.bodyMuted}>
              {total === 0
                ? "No plan yet — go to Today and generate one."
                : `${done} of ${total} tasks completed`}
            </Text>
          </Card>

          {breakdown.length > 0 && (
            <Card>
              <Text style={styles.label}>By category</Text>
              <View style={{ gap: 8, marginTop: 4 }}>
                {breakdown.map((b) => (
                  <View key={b.kind} style={styles.rowBetween}>
                    <Text style={styles.bodyMuted}>{b.kind}</Text>
                    <Text style={styles.bodyMuted}>
                      {b.done}/{b.total} {b.done === b.total ? "✓" : ""}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          )}

          {tasks.length > 0 && (
            <Card>
              <Text style={styles.label}>Task list</Text>
              <View style={{ gap: 8, marginTop: 4 }}>
                {tasks.map((t) => (
                  <View key={t.id} style={styles.rowBetween}>
                    <Text
                      style={[
                        styles.bodyMuted,
                        t.done && { textDecorationLine: "line-through", color: "#555" },
                      ]}
                    >
                      {t.timeText}{"  "}{t.title}
                    </Text>
                    <Text style={styles.miniNote}>{t.done ? "✓" : "·"}</Text>
                  </View>
                ))}
              </View>
            </Card>
          )}
        </View>
      </ScrollView>
    );
  };

  // ---------- Settings ----------
  const Settings = () => {
    const [editName, setEditName] = useState(profile?.name ?? "");
    const [editGoal, setEditGoal] = useState(profile?.goal ?? "");
    const [editWake, setEditWake] = useState(profile?.wake ?? "7:00 AM");
    const [editSleep, setEditSleep] = useState(profile?.sleep ?? "11:00 PM");

    const saveProfile = () => {
      const updated = {
        name: editName.trim(),
        goal: editGoal.trim(),
        wake: editWake.trim(),
        sleep: editSleep.trim(),
      };
      if (!updated.name) {
        Alert.alert("Name required", "Please enter your name.");
        return;
      }
      setProfile(updated);
      Alert.alert("Saved", "Your profile has been updated.");
    };

    const resetApp = () => {
      Alert.alert(
        "Reset app",
        "This will delete your profile, schedule, tasks, and chat history. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Reset",
            style: "destructive",
            onPress: async () => {
              await AsyncStorage.multiRemove(Object.values(STORE));
              setProfile(null);
              setBlocks([]);
              setTasks([]);
              setMessages([]);
              setSessionId(null);
              setAuthed(false);
            },
          },
        ]
      );
    };

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={{ gap: 12 }}>
          <Text style={styles.h2}>Settings</Text>
          <Text style={styles.sub2}>Adjust your profile and preferences.</Text>

          <Card>
            <Text style={styles.label}>Profile</Text>
            <Text style={styles.smallLabel}>Name</Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Goal</Text>
            <TextInput
              value={editGoal}
              onChangeText={setEditGoal}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Wake time</Text>
            <TextInput
              value={editWake}
              onChangeText={setEditWake}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Sleep time</Text>
            <TextInput
              value={editSleep}
              onChangeText={setEditSleep}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <View style={{ height: 10 }} />
            <PrimaryButton title="Save profile" onPress={saveProfile} />
          </Card>

          <Card>
            <Text style={styles.label}>Notifications</Text>
            <Text style={styles.bodyMuted}>
              Status: {notifReady ? "Enabled" : "Disabled"}
            </Text>
            {!notifReady && (
              <Text style={styles.miniNote}>
                To enable, open your phone's Settings → Notifications → Expo Go and turn them on.
              </Text>
            )}
          </Card>

          <Card>
            <Text style={styles.label}>Data</Text>
            <Text style={styles.bodyMuted}>
              Erase everything and return to onboarding.
            </Text>
            <View style={{ height: 8 }} />
            <SmallButton title="Reset app" onPress={resetApp} />
          </Card>
        </View>
      </ScrollView>
    );
  };

  // ---------- Authenticated shell ----------
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={{ flex: 1 }}>
        {tab === "Today" && <Today />}
        {tab === "Schedule" && <Schedule />}
        {tab === "Chat" && <Chat />}
        {tab === "Progress" && <Progress />}
        {tab === "Settings" && <Settings />}
      </View>
      <View style={styles.tabBar}>
        {(["Today", "Schedule", "Chat", "Progress", "Settings"] as TabKey[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}