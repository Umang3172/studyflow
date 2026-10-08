// Synced agent state: small and written only by the server (see validateStateChange).
export type PlanStatus = "generating" | "awaiting_approval" | "active" | "rejected" | "failed" | "expired" | "completed";

export type UpcomingItem = { id: string; kind: "session" | "custom" | "checkin"; title: string; dueAt: string };

export type StudyState = {
  profile: { displayName?: string; timezone: string; checkInTime: string; onboarded: boolean; voiceEnabled: boolean };
  courses: Array<{ id: string; name: string; examDate?: string }>;
  activePlan?: { id: string; courseId: string; status: PlanStatus; progress?: number; workflowId?: string; message?: string };
  upcoming: UpcomingItem[];
  usageToday: { date: string; chatTurns: number; planStarts: number; voiceSeconds: number; inputTokens: number; outputTokens: number };
  caps: { chatTurns: number; planStarts: number; voiceSeconds: number };
  features: { voice: boolean };
};

export const initialStudyState = (): StudyState => ({
  profile: { timezone: "UTC", checkInTime: "08:00", onboarded: false, voiceEnabled: false },
  courses: [],
  upcoming: [],
  usageToday: { date: "", chatTurns: 0, planStarts: 0, voiceSeconds: 0, inputTokens: 0, outputTokens: 0 },
  caps: { chatTurns: 40, planStarts: 3, voiceSeconds: 300 },
  features: { voice: false },
});

// Pushed with broadcast() (not state) so a closed/other tab can toast it.
export type ReminderEvent = { type: "reminder"; id: string; title: string; body?: string };
