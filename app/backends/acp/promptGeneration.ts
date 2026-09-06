export function clearPromptGeneration(
  markers: Map<string, number>,
  sessionId: string,
  generation: number,
) {
  if (markers.get(sessionId) === generation) markers.delete(sessionId);
}
