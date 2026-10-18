import { FallDetector, FALL_STATES } from "./fallDetector.js";
import { ruleBasedEvidenceScore } from "./evidenceScore.js";

// add an evidence score to confirmed falls without changing detection decisions

// Reset the saved evidence when starting a new detection session
export class ScoredFallDetector extends FallDetector {
  reset() {
    super.reset();
    this.scoreIncident = null;
    this.scoreEvidence = null;
  }

  // Update fall detection and collect measurements for the evidence score
  update(input) {
    const decision = super.update(input);
    if (this.incident !== this.scoreIncident) {
      this.scoreIncident = this.incident;
      this.scoreEvidence = this.incident ? { peakAngleIncrease: null, peakAspectIncrease: null } : null;
    }
    if (!this.incident || (decision.state === FALL_STATES.FALL_CONFIRMED && !decision.event)) return decision;

    // Only use measurements that passed the detector's reliability checks
    const sample = this.previousSample;
    if (sample?.timestampMs === input.timestampMs) {
      const reference = this.incident.reference;
      if (input.poseReliable === true && Number.isFinite(sample.scale) && sample.scale > 0 &&
          Number.isFinite(sample.angle) && sample.angle >= 0 && sample.angle <= 180 &&
          Number.isFinite(reference.angle)) {
        this.scoreEvidence.peakAngleIncrease = Math.max(this.scoreEvidence.peakAngleIncrease ?? 0,
          sample.angle - reference.angle);
      }
      if (Number.isFinite(sample.aspect) && sample.aspect > 0 && Number.isFinite(reference.aspect)) {
        this.scoreEvidence.peakAspectIncrease = Math.max(this.scoreEvidence.peakAspectIncrease ?? 0,
          sample.aspect - reference.aspect);
      }
    }

    // Calculate and attach the score when a fall is confirmed
    if (decision.transition?.to === FALL_STATES.FALL_CONFIRMED && decision.event) {
      decision.event.rule_based_evidence_score = ruleBasedEvidenceScore({
        ...this.scoreEvidence,
        peakVelocity: decision.event.evidence.peak_downward_velocity,
        peakDisplacement: decision.event.evidence.peak_hip_displacement,
        angle: input.poseReliable === true && Number.isFinite(sample.scale) && sample.scale > 0 ? sample.angle : null,
        aspect: sample.aspect,
        persistenceMs: decision.event.evidence.posture_persistence_ms,
      });
    }
    return decision;
  }
}
