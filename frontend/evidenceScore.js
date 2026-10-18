// calculate a rule-based evidence score from 0 to 100
// higher scores indicate stronger fall evidence, not a probability

// Convert a measurement to a value between 0 and 1
function normalize(value, lower, upper) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, (value - lower) / (upper - lower))) : 0;
}

export function ruleBasedEvidenceScore(evidence = {}) {
  const e = evidence ?? {};
  const velocity = normalize(e.peakVelocity, 0, 4);
  const displacement = normalize(e.peakDisplacement, 0, 2);
  const change = Math.max(normalize(e.peakAngleIncrease, 0, 90),
    normalize(e.peakAspectIncrease, 0, 1.5));
  const angle = Number.isFinite(e.angle) && e.angle >= 0 && e.angle <= 180
    ? normalize(90 - Math.abs(e.angle - 90), 30, 90) : 0;
  const aspect = normalize(e.aspect, 0.9, 1.9);
  const fallen = (angle + aspect) / 2;
  const persistence = normalize(e.persistenceMs, 0, 2000);
  return Math.round(25 * velocity + 25 * displacement + 20 * change + 20 * fallen + 10 * persistence);
}
