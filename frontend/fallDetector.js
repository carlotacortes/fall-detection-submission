// default thresholds and time settings for fall detection
export const DEFAULT_FALL_CONFIG = Object.freeze({
  // detect rapid downward movement of the hips
  minDownwardHipVelocity: 1.0,       // Hips must drop at least one torso length per second.
  minHipDisplacement: 0.6,           // Hips must drop at least 0.6 of the reference torso length.
  minRapidDescentMs: 120,            // The fast drop must last longer than a single frame.

  // check whether the person has moved into a fallen posture 
  minFallenTorsoAngle: 60,           // A torso angle from 60 to 120 is close to horizontal.
  maxFallenTorsoAngle: 120,
  minFallenAspectRatio: 1.2,         // The body must appear at least 1.2 times as wide as tall.
  postureCondition: "and",         // "and" needs both tilt and width; "or" needs either one.
  partialLandmarks: false,          // When enabled, allow some measurements despite missing body points.
  minTorsoAngleChange: 30,           // Minimum tilt change from the earlier non-fallen position.
  minAspectRatioChange: 0.4,         // A wider body shape can also show a change in position.

  // time thresholds for confirming a fall and clearing an unconfirmed suspicion
  confirmationDurationMs: 1000,
  possibleFallTimeoutMs: 3000,       // Give an unconfirmed fall up to 3 seconds, including tracking gaps.
  recoveryDurationMs: 1500,
  recoveryMaxTorsoAngle: 30,
  recoveryMaxAspectRatio: 0.9,
  recoveryMaxHipSpeed: 0.35,         // Recovery needs slow hip movement in either direction.

  // check tracking reliability and continuity of the measurements
  minReferenceDurationMs: 200,       // First observe a non-fallen position for at least this long.
  historyWindowMs: 1800,
  minReliableLandmarkCount: 6,       // Minimum usable body points; features.js checks their quality.
  maxFrameIntervalMs: 250,           // Treat longer pauses between frames as a tracking interruption.
  maxTrackingGapMs: 600,             // Limit how long an unconfirmed fall can survive lost tracking.
  candidateTrackingGraceMs: 0,       // 0 restarts confirmation timing after a tracking interruption.
  maxAbsHipVelocity: 8,              // Reject extreme hip speeds that suggest a tracking error.
  maxHipDisplacementRate: 6,         // Reject downward jumps over 6 torso lengths per second.
  maxTorsoAngularSpeed: 600,         // Reject tilt changes over 600 degrees per second.
  maxAspectRatioRate: 20,            // Reject sudden changes in the body's width-to-height ratio.
  maxRelativeScaleRate: 3,           // Reject sudden changes in the person's apparent torso size.
});

export const FALL_STATES = Object.freeze({
  NORMAL: "NORMAL",
  POSSIBLE_FALL: "POSSIBLE_FALL",
  FALL_CANDIDATE: "FALL_CANDIDATE",
  FALL_CONFIRMED: "FALL_CONFIRMED",
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteInRange(value, minimum, maximum = Infinity) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

// use motion and posture features to detect falls, with a state machine and temporal rules
export class FallDetector {
  // check settings and set up the detector
  constructor(config = {}, { clock = Date.now } = {}) {
    this.config = Object.freeze({ ...DEFAULT_FALL_CONFIG, ...config });
    for (const [key, value] of Object.entries(this.config)) {
      if (key === "partialLandmarks") {
        if (typeof value !== "boolean") throw new RangeError("partialLandmarks must be boolean.");
        continue;
      }
      if (key === "postureCondition") {
        if (!["and", "or"].includes(value)) throw new RangeError('postureCondition must be "and" or "or".');
        continue;
      }
      const allowsZero = key === "candidateTrackingGraceMs";
      if (!Object.hasOwn(DEFAULT_FALL_CONFIG, key) || !Number.isFinite(value) ||
          (allowsZero ? value < 0 : value <= 0)) {
        throw new RangeError(`Invalid fall-detector setting: ${key}`);
      }
    }
    const c = this.config;
    if (c.minFallenTorsoAngle >= c.maxFallenTorsoAngle || c.maxFallenTorsoAngle > 180 ||
        c.recoveryMaxTorsoAngle >= c.minFallenTorsoAngle ||
        c.recoveryMaxAspectRatio >= c.minFallenAspectRatio ||
        c.historyWindowMs < c.minReferenceDurationMs || c.maxTrackingGapMs < c.maxFrameIntervalMs ||
        c.possibleFallTimeoutMs <= c.confirmationDurationMs ||
        c.candidateTrackingGraceMs >= c.possibleFallTimeoutMs ||
        c.minDownwardHipVelocity >= c.maxAbsHipVelocity ||
        !Number.isInteger(c.minReliableLandmarkCount) || c.minReliableLandmarkCount > 33) {
      throw new RangeError("Inconsistent fall-detector thresholds or durations.");
    }
    if (typeof clock !== "function") throw new TypeError("clock must return epoch milliseconds.");
    this.clock = clock;
    this.reset();
  }
  // reset the detector to its initial state
  reset() {
    this.state = FALL_STATES.NORMAL;
    this.lastTimestampMs = null;
    this.lastTrustedTimestampMs = null;
    this.previousSample = null;
    this.history = [];
    this.incident = null;
    this.clearDwellTimers();
  }

  //reset timers for rapid descent, fallen posture, and recovery
  clearDwellTimers() {
    this.rapidSinceMs = null;
    this.postureSinceMs = null;
    this.recoverySinceMs = null;
    this.candidateEvidenceMs = 0;
    this.candidateLastReliableMs = null;
  }

  postureEvidenceMs(timestampMs) {
    // count how long person stays in fallen posture
    if (this.config.candidateTrackingGraceMs > 0) return this.candidateEvidenceMs;
    return this.postureSinceMs === null ? 0 : timestampMs - this.postureSinceMs;
  }

  // transition to a new state and clear evidence if returning to normal
  transitionTo(nextState, reason, timestampMs) {
    const transition = { from: this.state, to: nextState, reason, timestampMs };
    this.state = nextState;
    if (nextState === FALL_STATES.NORMAL) {
      this.incident = null;
      this.history = [];
      this.clearDwellTimers();
    }
    return transition;
  }

  result(event = null, transition = null) {
    return { state: this.state, alertActive: this.state === FALL_STATES.FALL_CONFIRMED, transition, event };
  }

  snapshot(input) {
    // keep only measurements needed for fall detection
    const f = input.features ?? {};
    return {
      timestampMs: input.timestampMs,
      velocity: Number.isFinite(f.hipVerticalVelocity) ? f.hipVerticalVelocity : null,
      displacement: input.baselineReady === true && Number.isFinite(f.hipVerticalDisplacement)
        ? f.hipVerticalDisplacement : null,
      angle: f.torsoInclinationAngle,
      aspect: f.bodyAspectRatio,
      scale: input.personScalePx,
    };
  }

  // check if body measurements are reliable enough 
  reliable(input, sample) {
    if (this.config.partialLandmarks && input.partialLandmarks === true && this.config.postureCondition === "or") {
      // allow either posture measurement when partial landmarks are enabled
      return finiteInRange(input.reliableLandmarkCount, this.config.minReliableLandmarkCount, 33) &&
        ((input.poseReliable === true && finiteInRange(sample.angle, 0, 180) &&
          finiteInRange(sample.scale, Number.EPSILON)) || finiteInRange(sample.aspect, Number.EPSILON));
    }
    return input.poseReliable === true && input.resetReason !== "unreliable-torso" &&
      finiteInRange(input.reliableLandmarkCount, this.config.minReliableLandmarkCount, 33) &&
      finiteInRange(sample.scale, Number.EPSILON) &&
      finiteInRange(sample.angle, 0, 180) && finiteInRange(sample.aspect, Number.EPSILON);
  }

  plausible(sample) {
    const c = this.config;
    if (sample.velocity !== null && Math.abs(sample.velocity) > c.maxAbsHipVelocity) return false;
    const previous = this.previousSample;
    if (!previous) return true;
    const seconds = (sample.timestampMs - previous.timestampMs) / 1000;
    // Compare changes only when both measurements are available.
    if ((Number.isFinite(sample.angle) && Number.isFinite(previous.angle) &&
          Math.abs(sample.angle - previous.angle) / seconds > c.maxTorsoAngularSpeed) ||
        (Number.isFinite(sample.aspect) && Number.isFinite(previous.aspect) &&
          Math.abs(sample.aspect - previous.aspect) / seconds > c.maxAspectRatioRate) ||
        (Number.isFinite(sample.scale) && Number.isFinite(previous.scale) && previous.scale > 0 &&
          Math.abs(sample.scale - previous.scale) / previous.scale / seconds > c.maxRelativeScaleRate)) return false;
    // reject sudden jumps in hip displacement
    return sample.displacement === null || previous.displacement === null ||
      (sample.displacement - previous.displacement) / seconds <= c.maxHipDisplacementRate;
  }

  nonFallenPosture(sample) {
    return finiteInRange(sample.angle, 0, this.config.recoveryMaxTorsoAngle) &&
      finiteInRange(sample.aspect, Number.EPSILON, this.config.recoveryMaxAspectRatio);
  }

  fallenPosture(sample) {
    const tilted = finiteInRange(sample.angle, this.config.minFallenTorsoAngle, this.config.maxFallenTorsoAngle);
    const wide = finiteInRange(sample.aspect, this.config.minFallenAspectRatio);
    return this.config.postureCondition === "or" ? tilted || wide : tilted && wide;
  }

  recentReference() {
    // find a recent non-fallen posture as reference 
    let run = [];
    let referenceRun = null;
    for (const sample of this.history) {
      if (!this.nonFallenPosture(sample)) {
        run = [];
        continue;
      }
      run.push(sample);
      if (sample.timestampMs - run[0].timestampMs >= this.config.minReferenceDurationMs) {
        referenceRun = run;
      }
    }
    return referenceRun ? {
      angle: median(referenceRun.map((s) => s.angle)),
      aspect: median(referenceRun.map((s) => s.aspect)),
    } : null;
  }

  interrupt(timestampMs, reason, discardEvidence = false) {
    const graceCandidate = this.state === FALL_STATES.FALL_CANDIDATE &&
      this.config.candidateTrackingGraceMs > 0;
    const graceExpired = graceCandidate && this.lastTrustedTimestampMs !== null &&
      timestampMs - this.lastTrustedTimestampMs > this.config.candidateTrackingGraceMs;
    if (graceCandidate && !discardEvidence && !graceExpired) {
      this.rapidSinceMs = null;
      this.recoverySinceMs = null;
      this.candidateLastReliableMs = null;
    } else {
      this.clearDwellTimers();
    }
    this.previousSample = null;
    this.history = [];
    const tooLong = this.lastTrustedTimestampMs !== null &&
      timestampMs - this.lastTrustedTimestampMs > this.config.maxTrackingGapMs;
    if (this.state !== FALL_STATES.NORMAL && this.state !== FALL_STATES.FALL_CONFIRMED &&
        (discardEvidence || graceExpired || (!graceCandidate && tooLong))) {
      return this.transitionTo(FALL_STATES.NORMAL,
        graceExpired ? "candidate-tracking-timeout" : reason, timestampMs);
    }
    return null;
  }

  update(input) {
    const timestampMs = input?.timestampMs;
    if (!finiteInRange(timestampMs, 0) ||
        (this.lastTimestampMs !== null && timestampMs <= this.lastTimestampMs)) {
      throw new RangeError("Detector timestamps must be nonnegative, strictly increasing milliseconds.");
    }
    const elapsedMs = this.lastTimestampMs === null ? 0 : timestampMs - this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    let transition = null;

    if (this.incident && this.state !== FALL_STATES.FALL_CONFIRMED &&
        timestampMs - this.incident.startedAtMs >= this.config.possibleFallTimeoutMs) {
      return this.result(null, this.transitionTo(FALL_STATES.NORMAL, "evidence-expired", timestampMs));
    }

    // check if the person has been missing for longer than the allowed time
    if (this.state === FALL_STATES.FALL_CANDIDATE && this.config.candidateTrackingGraceMs > 0 &&
        this.lastTrustedTimestampMs !== null &&
        timestampMs - this.lastTrustedTimestampMs > this.config.candidateTrackingGraceMs) {
      transition = this.interrupt(timestampMs, "candidate-tracking-timeout");
    }

    if (elapsedMs > this.config.maxFrameIntervalMs || input.resetReason === "frame-gap" ||
        input.resetReason === "frame-size-changed") {
      transition = this.interrupt(timestampMs, "tracking-discontinuity", input.resetReason === "frame-size-changed") ?? transition;
    }
    const sample = this.snapshot(input);
    if (!this.reliable(input, sample)) {
      transition = this.interrupt(timestampMs, "tracking-lost") ?? transition;
      return this.result(null, transition);
    }
    // reset tracking if gap > max allowed
    if (this.lastTrustedTimestampMs !== null &&
        timestampMs - this.lastTrustedTimestampMs > this.config.maxTrackingGapMs) {
      transition = this.interrupt(timestampMs, "tracking-lost") ?? transition;
    }
    if (!this.plausible(sample)) {
      transition = this.interrupt(timestampMs, "tracking-jump", true) ?? transition;
      return this.result(null, transition);
    }
    this.lastTrustedTimestampMs = timestampMs;
    this.previousSample = sample;
    this.history = this.history.filter((s) => timestampMs - s.timestampMs <= this.config.historyWindowMs);

    // check whether the person has recovered after a confirmed fall
    if (this.state === FALL_STATES.FALL_CONFIRMED) {
      const recovered = this.nonFallenPosture(sample) && sample.velocity !== null &&
        Math.abs(sample.velocity) <= this.config.recoveryMaxHipSpeed;
      this.recoverySinceMs = recovered ? (this.recoverySinceMs ?? timestampMs) : null;
      if (this.recoverySinceMs !== null && timestampMs - this.recoverySinceMs >= this.config.recoveryDurationMs) {
        transition = this.transitionTo(FALL_STATES.NORMAL, "stable-recovery", timestampMs);
      }
      return this.result(null, transition);
    }
    // start a possible fall when the hips move downward quickly
    if (this.state === FALL_STATES.NORMAL) {
      const reference = this.recentReference();
      if (reference && sample.velocity !== null && sample.velocity >= this.config.minDownwardHipVelocity) {
        this.incident = {
          startedAtMs: timestampMs, reference, rapidDescent: false,
          peakVelocity: 0, peakDisplacement: 0, postureChanged: false,
        };
        this.rapidSinceMs = timestampMs;
        transition = this.transitionTo(FALL_STATES.POSSIBLE_FALL, "rapid-descent-started", timestampMs);
      }
      this.history.push(sample);
      if (!this.incident) return this.result(null, transition);
    } else {
      this.history.push(sample);
    }

    // Track the strongest movement and posture changes during a possible fall
    const incident = this.incident;
    incident.peakVelocity = Math.max(incident.peakVelocity, sample.velocity ?? 0);
    incident.peakDisplacement = Math.max(incident.peakDisplacement, sample.displacement ?? 0);
    incident.postureChanged ||= sample.angle - incident.reference.angle >= this.config.minTorsoAngleChange ||
      sample.aspect - incident.reference.aspect >= this.config.minAspectRatioChange;

    if (sample.velocity !== null && sample.velocity >= this.config.minDownwardHipVelocity) {
      this.rapidSinceMs ??= timestampMs;
      if (timestampMs - this.rapidSinceMs >= this.config.minRapidDescentMs) incident.rapidDescent = true;
    } else {
      this.rapidSinceMs = null;
    }

    // check whether the person has reached a fallen posture
    const fallen = this.fallenPosture(sample);
    if (this.state === FALL_STATES.POSSIBLE_FALL && incident.rapidDescent &&
        incident.peakDisplacement >= this.config.minHipDisplacement && incident.postureChanged && fallen) {
      this.postureSinceMs = timestampMs;
      this.candidateEvidenceMs = 0;
      this.candidateLastReliableMs = timestampMs;
      transition = this.transitionTo(FALL_STATES.FALL_CANDIDATE, "descent-and-fallen-posture", timestampMs);
    } else if (this.state === FALL_STATES.FALL_CANDIDATE) {
      if (!fallen) {
        this.postureSinceMs = null;
        this.candidateEvidenceMs = 0;
        this.candidateLastReliableMs = null;
        transition = this.transitionTo(FALL_STATES.POSSIBLE_FALL, "fallen-posture-lost", timestampMs);
      } else {
        this.postureSinceMs ??= timestampMs;
        if (this.config.candidateTrackingGraceMs > 0) {
          if (this.candidateLastReliableMs !== null) {
            this.candidateEvidenceMs += timestampMs - this.candidateLastReliableMs;
          }
          this.candidateLastReliableMs = timestampMs;
        }
        // confirm the fall only after the fallen posture lasts long enough
        const requiredMs = this.config.confirmationDurationMs;
        if (this.postureEvidenceMs(timestampMs) >= requiredMs) {
          transition = this.transitionTo(FALL_STATES.FALL_CONFIRMED, "sustained-fallen-posture", timestampMs);
          return this.result({
            event_type: "fall_detected",
            timestamp: new Date(this.clock()).toISOString(),
            sequence_timestamp_ms: timestampMs,
            detection_method: "temporal_rules_v1",
            evidence: {
              peak_downward_velocity: incident.peakVelocity,
              peak_hip_displacement: incident.peakDisplacement,
              posture_persistence_ms: this.postureEvidenceMs(timestampMs),
              required_persistence_ms: requiredMs,
            },
          }, transition);
        }
      }
    }

    // cancel a possible fall if person returns to stable posture
    const recovered = this.nonFallenPosture(sample) && sample.velocity !== null &&
      Math.abs(sample.velocity) <= this.config.recoveryMaxHipSpeed;
    this.recoverySinceMs = recovered ? (this.recoverySinceMs ?? timestampMs) : null;
    if (this.recoverySinceMs !== null && timestampMs - this.recoverySinceMs >= this.config.recoveryDurationMs) {
      transition = this.transitionTo(FALL_STATES.NORMAL, "suspicion-recovered", timestampMs);
    }
    return this.result(null, transition);
  }
}
