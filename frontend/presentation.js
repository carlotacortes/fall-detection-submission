// Functions used to display monitoring status and body landmarks

// Decide which monitoring status to show in the interface
export function monitoringState(decision, input, detector) {
  if (decision.alertActive) return "confirmed";
  if (detector.previousSample?.timestampMs !== input.timestampMs) return "tracking";
  return ["POSSIBLE_FALL", "FALL_CANDIDATE"].includes(decision.state) ? "possible" : "running";
}

// Check if a body landmark is visible and reliable enough to display
export function visiblePoint(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 &&
    Number.isFinite(point.visibility) && point.visibility >= 0.5 && point.visibility <= 1 &&
    (point.presence === undefined || Number.isFinite(point.presence) && point.presence >= 0.5 && point.presence <= 1);
}
