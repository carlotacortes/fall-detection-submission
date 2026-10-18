// Send confirmed fall events to the backend without sending video or landmarks
import { DEFAULT_CONFIGURATION } from "./configuration.js";

// handles saving confirmed class events to the backend, with retries for temporary failures
export class EventSender {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args),
    uuid = () => globalThis.crypto.randomUUID(),
    // Use browser timers to manage requests and retries
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (id) => globalThis.clearTimeout(id),
    requestTimeoutMs = 5000, retryDelayMs = 1000, maxRetryDelayMs = 30000,
    onError = (message) => console.warn(message), onStored = () => {} } = {}) {
    // Allow custom settings for requests, timers, and testing
    this.fetchImpl = fetchImpl;
    this.uuid = uuid;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.onError = onError;
    this.onStored = onStored;
    this.pending = new Map();
    this.knownEvents = new WeakMap();
  }

  // create a new event and add it to the sending queue
  enqueue(confirmedEvent) {
    if (confirmedEvent?.event_type !== "fall_detected") return null;
    try {
      if (this.knownEvents.has(confirmedEvent)) return this.knownEvents.get(confirmedEvent);
      // Prepare the event information to send to the backend
      const payload = Object.freeze({
        event_id: this.uuid(),
        timestamp: new Date(confirmedEvent.timestamp).toISOString(),
        event_type: "fall_detected",
        rule_based_evidence_score: Number.isFinite(confirmedEvent.rule_based_evidence_score) &&
          confirmedEvent.rule_based_evidence_score >= 0 && confirmedEvent.rule_based_evidence_score <= 100
          ? confirmedEvent.rule_based_evidence_score : null,
        detection_method: "temporal_rules_v1",
        configuration: DEFAULT_CONFIGURATION,
      });
      this.knownEvents.set(confirmedEvent, payload.event_id);
      const entry = { payload, failures: 0, inFlight: false, retryTimer: null };
      this.pending.set(payload.event_id, entry);
      void this.attempt(entry); // Send the event without stopping camera processing
      return payload.event_id;
    } catch {
      this.onError("Could not prepare fall-event metadata; camera processing continues.");
      return null;
    }
  }

  // send the event to the backend and retry if necessary
  async attempt(entry) {
    if (entry.inFlight || !this.pending.has(entry.payload.event_id)) return;
    entry.inFlight = true;
    const controller = new AbortController();
    const timeout = this.setTimer(() => controller.abort(), this.requestTimeoutMs);
    let retry = false;
    let storedEvent = null;
    try {
      const response = await this.fetchImpl("/api/events", {
        method: "POST", mode: "same-origin", credentials: "omit", redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.payload), signal: controller.signal,
      });
      if (!response.ok) {
        // Retry temporary server errors, but not invalid requests
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retry) throw new Error(`HTTP ${response.status}`);
        this.pending.delete(entry.payload.event_id);
        this.onError(`Fall-event metadata rejected (HTTP ${response.status}); camera processing continues.`);
        return;
      }
      const stored = await response.json();
      if (stored.event_id !== entry.payload.event_id) throw new Error("Unexpected event acknowledgement");
      this.pending.delete(entry.payload.event_id);
      storedEvent = stored;
    } catch {
      retry = true;
      entry.failures++;
      if (entry.failures === 1) this.onError("Fall event not acknowledged; retrying metadata in the background.");
    } finally {
      this.clearTimer(timeout);
      entry.inFlight = false;
      if (retry && this.pending.has(entry.payload.event_id)) {
        const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** Math.min(entry.failures - 1, 10));
        entry.retryTimer = this.setTimer(() => {
          entry.retryTimer = null;
          void this.attempt(entry);
        }, delay);
      }
    }
    // A successful save should not be repeated if updating the interface fails
    if (storedEvent) {
      try { this.onStored(storedEvent); }
      catch { this.onError("Fall event stored; history refresh could not be started."); }
    }
  }

  retryPending() {
    // Retry events that have not been saved yet
    for (const entry of this.pending.values()) {
      if (entry.retryTimer !== null) this.clearTimer(entry.retryTimer);
      entry.retryTimer = null;
      void this.attempt(entry);
    }
  }
}
