//loads mediapipe -> detect one person -> process video frames -> return body landmarks -> closes model 

// mediapipe person and model URL
export const MEDIAPIPE_VERSION = "1.1.0";
const PACKAGE_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

//handles camera start, stop, and frame processing
//body landmarks are drawn on overlay canvas, features extracted, and fall detection performed
export class PoseEstimator {
  constructor() {
    this.landmarker = null;
    this.connections = [];
    this.initialization = null;
    this.closed = false;
    this.lastTimestampMs = -Infinity;
  }

  // loads the model if not loaded yet
  async initialize() {
    if (this.closed) throw new Error("This pose estimator has been closed.");
    if (this.landmarker) return;

    // only load once
    if (!this.initialization) {
      this.initialization = this.load().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  // loads the model and creates a PoseLandmarker instance
  async load() {
    const { FilesetResolver, PoseLandmarker } = await import(`${PACKAGE_ROOT}/vision_bundle.mjs`);
    if (this.closed) throw new DOMException("Pose loading was cancelled.", "AbortError");

    const fileset = await FilesetResolver.forVisionTasks(`${PACKAGE_ROOT}/wasm`);
    if (this.closed) throw new DOMException("Pose loading was cancelled.", "AbortError");

    const landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });

    // close model if loading was cancelled
    if (this.closed) {
      landmarker.close();
      throw new DOMException("Pose loading was cancelled.", "AbortError");
    }
    this.landmarker = landmarker;
    this.connections = PoseLandmarker.POSE_CONNECTIONS;
  }

  // detects body landmarks for a video frame and returns them with the timestamp
  detectFrame(frame, timestampMs) {
    if (!this.landmarker || this.closed) {
      throw new Error("Initialize the pose estimator before processing frames.");
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs <= this.lastTimestampMs) {
      throw new RangeError("Frame timestamps must be nonnegative and strictly increasing (milliseconds).");
    }

    const result = this.landmarker.detectForVideo(frame, timestampMs);
    this.lastTimestampMs = timestampMs;
    return {
      timestampMs,
      landmarks: result.landmarks,
      worldLandmarks: result.worldLandmarks,
    };
  }

  // release model 
  close() {
    this.closed = true;
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
