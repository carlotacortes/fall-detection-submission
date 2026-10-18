import { MotionFeatureExtractor } from "./features.js";
import { ScoredFallDetector as FallDetector } from "./scoredFallDetector.js";

// final application configuration
export const PIPELINE_CONFIGURATIONS = Object.freeze({
  selected: Object.freeze({
    features: Object.freeze({ partialLandmarks: true }),
    // allow either posture condition and handle partial landmarks, but require a minimum aspect ratio
    detector: Object.freeze({ postureCondition: "or",
      partialLandmarks: true, candidateTrackingGraceMs: 400, minFallenAspectRatio: 1.1 }),
  }),
});

export const DEFAULT_CONFIGURATION = "selected";

// create a feature extractor and fall detector based on the selected configuration
export function createMotionPipeline(name = DEFAULT_CONFIGURATION) {
  if (!Object.hasOwn(PIPELINE_CONFIGURATIONS, name)) {
    throw new RangeError(`Unknown pipeline configuration: ${name}`);
  }
  const configuration = PIPELINE_CONFIGURATIONS[name];
  return {
    featureExtractor: new MotionFeatureExtractor(configuration.features),
    fallDetector: new FallDetector(configuration.detector),
  };
}
