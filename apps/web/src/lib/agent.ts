import type { useAgent } from "agents/react";
import type { StudyState } from "@studyflow/shared";

export type AgentClient = ReturnType<typeof useAgent<StudyState>>;

/** Typed wrapper over agent.call(): callables take one validated object argument. */
export const rpc = <T = unknown>(agent: AgentClient, method: string, arg?: unknown): Promise<T> =>
  agent.call(method, arg === undefined ? [] : [arg]) as Promise<T>;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
