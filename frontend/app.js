// import modules for pose estimation, motion pipeline, event handling, and presentation
import { PoseEstimator } from "./pose.js";
import { createMotionPipeline } from "./configuration.js";
import { EventSender } from "./events.js";
import { EventHistory } from "./history.js";
import { monitoringState, visiblePoint } from "./presentation.js";

const eventHistory = new EventHistory(document.querySelector("#event-history"));

// set up the event sender with callbacks for error handling and successful storage
const deliveryMessage = document.querySelector("#event-delivery");
const eventSender = new EventSender({
  onError: (message) => { deliveryMessage.textContent = message; },
  onStored: () => { deliveryMessage.textContent = "Event saved."; void eventHistory.refresh({ force: true }); },
});
window.addEventListener("online", () => eventSender.retryPending());
void eventHistory.refresh();

const video = document.querySelector("#webcam");
const canvas = document.querySelector("#pose-overlay");
const context = canvas.getContext("2d");
const stage = document.querySelector("#video-stage");
const startButton = document.querySelector("#start-camera");
const stopButton = document.querySelector("#stop-camera");
const status = document.querySelector("#status");
const statusLabel = document.querySelector("#status-label");
const statusMessage = document.querySelector("#status-message");
const fallWarning = document.querySelector("#fall-warning");

//stores the current camera session (null if stopped)
let activeSession = null;

const STATUS_LABELS = {
  off: "Camera inactive / ready",
  loading: "Loading",
  running: "Monitoring active",
  error: "Error",
  tracking: "Tracking unavailable",
  possible: "Possible fall",
  confirmed: "Fall confirmed",
};

// updates the camera/detection status
function setStatus(state, message = "") {
  if (status.dataset.state !== state) {
    status.dataset.state = state;
    statusLabel.textContent = STATUS_LABELS[state];
  }
  const errorMessage = state === "error" ? message : "";
  if (statusMessage.textContent !== errorMessage) statusMessage.textContent = errorMessage;
}

// stops the webcam stream
function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

// shows or hides the fall warning message
function setFallWarning(active) {
  if (fallWarning.hidden !== !active) fallWarning.hidden = !active;
  const message = active ? "FALL DETECTED!" : "";
  if (fallWarning.textContent !== message) fallWarning.textContent = message;
}

// cleans current session and resets when stopping
function releaseSession() {
  const session = activeSession;
  activeSession = null;
  if (session) {
    cancelAnimationFrame(session.frameRequestId);
    session.controller.abort();
    stopTracks(session.stream);
    session.featureExtractor.reset();
    session.latestFeatures = null;
    session.fallDetector.reset();
    session.latestFallEvent = null;
    session.pose.close();
  }
  video.pause();
  video.srcObject = null;
  context?.clearRect(0, 0, canvas.width, canvas.height);
  stage.classList.remove("is-running");
  setFallWarning(false);
  startButton.disabled = false;
  stopButton.disabled = true;
}

// stops the camera and resets the session
function stopCamera() {
  releaseSession();
  setStatus("off");
}

// handles errors 
function failSession(session, message, error) {
  if (activeSession !== session) return;
  console.error(message, error);
  releaseSession();
  setStatus("error", message);
}

// return understandable messages for camera errors
function cameraErrorMessage(error) {
  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera access was denied. Allow it in your browser's site settings, then click Start Camera.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Connect a webcam, then click Start Camera.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera could not be opened. Close other apps using it, check system camera permissions, and retry.";
    case "OverconstrainedError":
      return "The camera does not support the requested settings. Try another camera.";
    case "SecurityError":
      return "Camera access is blocked. Open this page on localhost or HTTPS and check browser permissions.";
    default:
      return `Could not start the camera: ${error.message || error.name}. Click Start Camera to retry.`;
  }
}

// starts the webcam and pose detection
async function startCamera() {
  if (activeSession) return;
  const session = {
    pose: new PoseEstimator(),
    ...createMotionPipeline(),
    latestFeatures: null,
    latestFallEvent: null,
    stream: null,
    controller: new AbortController(),
    frameRequestId: null,
    lastVideoTime: -1,
  };
  activeSession = session;
  startButton.disabled = true;
  stopButton.disabled = false;
  setStatus("loading");

  let startupPhase = "model";
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access requires a supported browser on localhost or HTTPS.");
    }
    if (!context) throw new Error("This browser does not support a 2D canvas.");

    await session.pose.initialize();
    if (activeSession !== session) return;

    startupPhase = "camera";
    setStatus("loading");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
      },
    });

    if (activeSession !== session) {
      stopTracks(stream);
      return;
    }
    session.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        failSession(session, "The camera was disconnected or access was revoked. Reconnect it and click Start Camera.");
      }, { signal: session.controller.signal });
    }

    video.srcObject = stream;
    await video.play();
    if (activeSession !== session) return;
    stage.classList.add("is-running");
    setStatus("loading");
    session.frameRequestId = requestAnimationFrame(() => processFrame(session));
  } catch (error) {
    const message = !window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !context
      ? error.message
      : startupPhase === "model"
        ? "Could not load MediaPipe or the Lite model."
        : cameraErrorMessage(error);
    failSession(session, message, error);
  }
}

// resize the overlay canvas to match the video dimensions
function resizeOverlay() {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    stage.parentElement.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
}

// draws the pose landmarks and connections on the overlay canvas
function drawPose(landmarks, connections) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = Math.max(2, canvas.width / 250);
  context.strokeStyle = "#58edc4";
  context.fillStyle = "#ffffff";

  for (const pose of landmarks) {
    context.beginPath();
    for (const { start, end } of connections) {
      const a = pose[start];
      const b = pose[end];
      if (!visiblePoint(a) || !visiblePoint(b)) continue;
      context.moveTo(a.x * canvas.width, a.y * canvas.height);
      context.lineTo(b.x * canvas.width, b.y * canvas.height);
    }
    context.stroke();

    for (const point of pose) {
      if (!visiblePoint(point)) continue;
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height,
        Math.max(3, canvas.width / 180), 0, 2 * Math.PI);
      context.fill();
    }
  }
}

//processes each video frame, detects pose, extracts features, and checks for falls
function processFrame(session) {
  if (activeSession !== session) return;
  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 && video.videoHeight > 0 &&
        video.currentTime !== session.lastVideoTime) {
      resizeOverlay();
      const result = session.pose.detectFrame(video, performance.now());
      session.latestFeatures = session.featureExtractor.update(
        result.landmarks[0] ?? null, result.timestampMs,
        { width: video.videoWidth, height: video.videoHeight },
      );
      const decision = session.fallDetector.update(session.latestFeatures);
      if (decision.event) {
        session.latestFallEvent = decision.event;
        eventSender.enqueue(decision.event);
      }
      setFallWarning(decision.state === "FALL_CONFIRMED");
      session.lastVideoTime = video.currentTime;
      drawPose(result.landmarks, session.pose.connections);
      setStatus(monitoringState(decision, session.latestFeatures, session.fallDetector));
    }
    session.frameRequestId = requestAnimationFrame(() => processFrame(session));
  } catch (error) {
    failSession(session, "Pose processing failed. Click Start Camera to reload the model and retry.", error);
  }
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);
window.addEventListener("pagehide", stopCamera);
