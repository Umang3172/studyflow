// One place for every cap so the UI, the zod schemas and the agent agree.
export const LIMITS = {
  userMessageChars: 8000,
  memoryChars: 280,
  memoryRows: 50,
  reminderTitleChars: 140,
  reminderMaxDays: 180,
  reminderMaxScheduled: 100,
  materialChars: 12000,
  courses: 10,
  topicsMin: 3,
  topicsMax: 30,
  sessionsMax: 120,
  planMaxAheadDays: 120,
  displayNameChars: 40,
  courseNameChars: 80,
} as const;

export const DEFAULT_CAPS = { chatTurns: 40, planStarts: 3, voiceSeconds: 300 } as const;
