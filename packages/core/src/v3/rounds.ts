import { join } from "node:path";

export const ROUND_ARTIFACTS = [
  "select",
  "worker",
  "gate",
  "checkpoint",
  "review",
  "discoveries",
] as const;
export type RoundArtifact = (typeof ROUND_ARTIFACTS)[number];

export function roundName(round: number): string {
  if (!Number.isInteger(round) || round < 1)
    throw new Error("round must be a positive integer");
  return String(round).padStart(3, "0");
}

export function getRoundDir(runDir: string, round: number): string {
  return join(runDir, "rounds", roundName(round));
}

export function getRoundArtifactPath(
  runDir: string,
  round: number,
  artifact: RoundArtifact
): string {
  if (!ROUND_ARTIFACTS.includes(artifact))
    throw new Error(`unknown round artifact: ${artifact}`);
  return join(getRoundDir(runDir, round), `${artifact}.json`);
}
