// body landmarks and features are based on MediaPipe Pose 33-landmark model
const BODY_INDICES = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const FEATURE_NAMES = [
  "hipVerticalVelocity", "hipVerticalDisplacement", "torsoInclinationAngle",
  "bodyAspectRatio",
];

export const DEFAULT_FEATURE_OPTIONS = Object.freeze({
  minVisibility: 0.5,
  minPresence: 0.5,
  smoothingTauMs: 100,
  scaleSmoothingTauMs: 250,
  baselineWindowMs: 1500,
  baselineLagMs: 200,
  maxGapMs: 500,
  partialLandmarks: false,
});

function midpoint(a, b) {
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// smooth measuremnts to reduce noise
function smooth(previous, value, elapsedMs, tauMs) {
  if (previous === null || tauMs === 0) return value;
  const alpha = -Math.expm1(-elapsedMs / tauMs);
  return previous + alpha * (value - previous);
}

// calcutates movement features from media-pipe pose landmarks. The features are normalized to the person's scale, so they are invariant to distance from the camera.
export class MotionFeatureExtractor {
  constructor(options = {}) {
    this.options = Object.freeze({ ...DEFAULT_FEATURE_OPTIONS, ...options });
    for (const [key, value] of Object.entries(this.options)) {
      if (key === "partialLandmarks") {
        if (typeof value !== "boolean") throw new RangeError("partialLandmarks must be boolean.");
        continue;
      }
      if (!(key in DEFAULT_FEATURE_OPTIONS) || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`Invalid feature option: ${key}`);
      }
    }
    const settings = this.options;
    if (settings.minVisibility > 1 || settings.minPresence > 1 || settings.maxGapMs === 0 ||
        settings.baselineWindowMs <= settings.baselineLagMs) {
      throw new RangeError("Confidence scores must be in [0, 1]; maxGapMs > 0; baselineWindowMs > baselineLagMs.");
    }
    this.reset();
  }

  reset() {
    this.lastTimestampMs = null;
    this.frameSize = null;
    this.clearTemporalState();
  }

  clearTemporalState() {
    this.previousHip = null;
    this.personScalePx = null;
    this.hipHistory = [];
    this.filters = new Map();
    this.lastObservedScaleMs = null;
  }

  //check if landmark is valid and return pixel coordinates and confidence score, or null if not valid
  reliablePoint(landmark, width, height) {
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) ||
        landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1 ||
        !Number.isFinite(landmark.visibility) || landmark.visibility > 1 ||
        landmark.visibility < this.options.minVisibility) return null;

    if (landmark.presence !== undefined && (!Number.isFinite(landmark.presence) ||
        landmark.presence > 1 || landmark.presence < this.options.minPresence)) return null;

    return {
      x: landmark.x * width,
      y: landmark.y * height,
      confidence: Math.min(landmark.visibility, landmark.presence ?? 1),
    };
  }

  // smooth the calculated features to reduce noise and return the filtered values
  filterFeatures(values, timestampMs) {
    return Object.fromEntries(FEATURE_NAMES.map((name) => {
      const value = values[name];
      if (value === null) {
        this.filters.delete(name);
        return [name, null];
      }
      const previous = this.filters.get(name);
      const filtered = smooth(previous?.value ?? null, value,
        previous ? timestampMs - previous.timestampMs : 0, this.options.smoothingTauMs);
      this.filters.set(name, { value: filtered, timestampMs });
      return [name, filtered];
    }));
  }

  // calculate features from the current frame
  update(landmarks, timestampMs, { width, height }) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0 ||
        (this.lastTimestampMs !== null && timestampMs <= this.lastTimestampMs)) {
      throw new RangeError("Feature timestamps must be nonnegative and strictly increasing milliseconds.");
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError("Source frame width and height must be positive finite numbers.");
    }

    let resetReason = null;
    if (this.lastTimestampMs !== null && timestampMs - this.lastTimestampMs > this.options.maxGapMs) {
      resetReason = "frame-gap";
    }
    if (this.frameSize && (this.frameSize.width !== width || this.frameSize.height !== height)) {
      resetReason = "frame-size-changed";
    }
    if (resetReason) this.clearTemporalState();
    const elapsedMs = this.lastTimestampMs === null ? 0 : timestampMs - this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    this.frameSize = { width, height };

    // Missing, low-confidence, and out-of-frame landmarks cannot enter geometry.
    const points = Array.from({ length: 33 }, (_, index) =>
      this.reliablePoint(landmarks?.[index], width, height));
    const hips = midpoint(points[23], points[24]);
    const shoulders = midpoint(points[11], points[12]);
    const minimumLength = Math.hypot(width, height) * 1e-4;
    let torsoHip = hips;
    let torsoShoulder = shoulders;
    let torsoSource = hips && shoulders ? "midpoints" : null;
    if (this.options.partialLandmarks && (!hips || !shoulders)) {
      // use one side of the body if both shoulders or hips are not visible. This is a fallback for partial occlusion, but it is less reliable than using both sides.
      const sides = [["left", 11, 23], ["right", 12, 24]].map(([side, s, h]) => {
        const shoulder = points[s];
        const hip = points[h];
        return shoulder && hip && distance(shoulder, hip) > minimumLength
          ? { side, shoulder, hip, confidence: Math.min(shoulder.confidence, hip.confidence) } : null;
      }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);
      const side = sides[0];
      torsoHip = side?.hip ?? null;
      torsoShoulder = side?.shoulder ?? null;
      torsoSource = side?.side ?? null;
    }
    const torsoLength = torsoHip && torsoShoulder ? distance(torsoHip, torsoShoulder) : null;
    const poseReliable = torsoLength !== null && torsoLength > minimumLength;
    const values = Object.fromEntries(FEATURE_NAMES.map((name) => [name, null]));
    let baselineReady = false;

    if (!poseReliable && !this.options.partialLandmarks) {
      // reset previous measurements if the torso is not reliably detected, since the features are normalized to the person's scale. This prevents unreliable measurements from affecting future calculations.
      this.clearTemporalState();
      resetReason = resetReason ?? "unreliable-torso";
    }
    if (poseReliable) {
      this.personScalePx = smooth(this.personScalePx, torsoLength, elapsedMs,
        this.options.scaleSmoothingTauMs);
      this.lastObservedScaleMs = timestampMs;
      values.torsoInclinationAngle = Math.atan2(Math.abs(torsoHip.x - torsoShoulder.x),
        torsoHip.y - torsoShoulder.y) * 180 / Math.PI;
    } else if (this.options.partialLandmarks) {
      // keep the last observed scale for a short time, so that a brief occlusion does not reset the person's scale. 
      // This allows features to be calculated even when the torso is not visible, but it is less reliable than using the current observation.
      if (this.lastObservedScaleMs === null || timestampMs - this.lastObservedScaleMs > this.options.maxGapMs) {
        this.personScalePx = null;
      }
    }
    // HIP VERTICAL VELOCITY AND DISPLACEMENT:
    if (hips && this.personScalePx !== null) {
      const scale = this.personScalePx;
      if (this.previousHip) {
        const seconds = (timestampMs - this.previousHip.timestampMs) / 1000;
        const meanScale = (scale + this.previousHip.scale) / 2;
        // calculate vertical velocity and displacement of the hips, normalized to the person's scale
        values.hipVerticalVelocity = (hips.y - this.previousHip.y) / (seconds * meanScale);
      }

      this.hipHistory = this.hipHistory.filter((sample) =>
        timestampMs - sample.timestampMs <= this.options.baselineWindowMs);
      const baseline = this.hipHistory.filter((sample) =>
        timestampMs - sample.timestampMs >= this.options.baselineLagMs);
      if (baseline.length > 0) {
        baselineReady = true;
        values.hipVerticalDisplacement = (hips.y - median(baseline.map((sample) => sample.y))) /
          median(baseline.map((sample) => sample.scale));
      }
      this.hipHistory.push({ timestampMs, y: hips.y, scale });
      this.previousHip = { timestampMs, y: hips.y, scale };
    } else if (this.options.partialLandmarks) {
      // reset previous measurements if the hips are not reliably detected
      this.previousHip = null;
      this.hipHistory = [];
    }

    // BODY ASPECT RATIO:
    const bodyPoints = BODY_INDICES.map((index) => points[index]).filter(Boolean);
    // calculate asprect ratio of the body bounding box, which is a rough measure of whether the person is upright or lying down
    if (bodyPoints.length >= 6 && (points[11] || points[12]) &&
        (points[23] || points[24]) && (points[27] || points[28])) {
      const bodyWidth = Math.max(...bodyPoints.map((point) => point.x)) -
        Math.min(...bodyPoints.map((point) => point.x));
      const bodyHeight = Math.max(...bodyPoints.map((point) => point.y)) -
        Math.min(...bodyPoints.map((point) => point.y));
      if (bodyWidth > minimumLength && bodyHeight > minimumLength) {
        values.bodyAspectRatio = bodyWidth / bodyHeight;
      }
    }

    return {
      timestampMs,
      poseReliable,
      reliableLandmarkCount: points.filter(Boolean).length,
      personScalePx: this.personScalePx,
      baselineReady,
      resetReason,
      ...(this.options.partialLandmarks ? {
        partialLandmarks: true, torsoSource: poseReliable ? torsoSource : null,
        scaleSource: this.personScalePx === null ? null : poseReliable ? "current-observation" : "recent-observation",
      } : {}),
      features: this.filterFeatures(values, timestampMs),
    };
  }
}
