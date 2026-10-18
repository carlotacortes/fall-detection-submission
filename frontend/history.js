// Display saved fall events and allow filtering by date and event type


// convert a selected date into a local date
function localMidnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
  // Convert the selected date to the start of that day in local time
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(value.slice(0, 4)) ||
      date.getMonth() + 1 !== Number(value.slice(5, 7)) || date.getDate() !== Number(value.slice(8, 10))) {
    throw new Error("Invalid date");
  }
  return date;
}

// prepare filters for requesting saved events
export function historyQuery({ startDate = "", endDate = "", eventType = "" }) {
  if (startDate && endDate && startDate > endDate) {
    throw new Error("Start date must be on or before end date.");
  }
  const query = new URLSearchParams();
  if (startDate) query.set("date_from", localMidnight(startDate).toISOString());
  if (endDate) {
    const nextDay = localMidnight(endDate);
    // Include the entire selected end date, even when clocks change
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0); //handle local time changes
    const lastMillisecond = new Date(nextDay.getTime() - 1).toISOString();
    query.set("date_to", lastMillisecond.replace(".999Z", ".999999Z"));
  }
  if (eventType) query.set("event_type", eventType);
  return query;
}

// convert an event's timestamp into a number for sorting
function timestampOf(event) {
  const value = typeof event?.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(value) ? value : -Infinity;
}

// managed display of saved events, with filtering and sorting
export class EventHistory {
  constructor(root, { fetchImpl = (...args) => globalThis.fetch(...args), locale } = {}) {
    this.root = root;
    this.document = root.ownerDocument;
    this.fetchImpl = fetchImpl;
    this.form = root.querySelector("#history-filters");
    this.startDate = root.querySelector("#history-start-date");
    this.endDate = root.querySelector("#history-end-date");
    this.eventType = root.querySelector("#history-event-type");
    this.body = root.querySelector("#history-body");
    this.results = root.querySelector("#history-results");
    this.message = root.querySelector("#history-message");
    this.request = null;
    this.dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
    this.scoreFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.refresh();
    });
    this.form.addEventListener("change", () => { void this.refresh(); });
    root.querySelector("#history-clear").addEventListener("click", () => {
      this.form.reset();
      void this.refresh();
    });
  }

  // show a message when events are loading, filtered out, or failed to load
  showMessage(text, state = "") {
    this.message.textContent = text;
    this.message.dataset.state = state;
    this.body.replaceChildren();
    this.results.hidden = true;
  }

  // request updated events using the selected filters
  refresh({ force = false } = {}) {
    let query;
    try {
      query = historyQuery({ startDate: this.startDate.value, endDate: this.endDate.value,
        eventType: this.eventType.value });
    } catch {
      const previous = this.request;
      this.request = null;
      previous?.controller.abort();
      this.root.setAttribute("aria-busy", "false");
      this.showMessage("Choose valid dates, with start date on or before end date.", "error");
      return Promise.resolve();
    }
    const encoded = query.toString();
    const url = `/api/events${encoded ? `?${encoded}` : ""}`;
    // Avoid repeated requests, but refresh when a new event is saved
    if (!force && this.request?.url === url) return this.request.promise;
    this.request?.controller.abort();
    const request = { url, controller: new AbortController(), promise: null };
    this.request = request;
    this.root.setAttribute("aria-busy", "true");
    this.showMessage("Loading events...");
    request.promise = this.load(request);
    return request.promise;
  }

  // get saved events from the backend
  async load(request) {
    const timeout = globalThis.setTimeout(() => request.controller.abort(), 10000);
    try {
      const response = await this.fetchImpl(request.url, {
        method: "GET", mode: "same-origin", credentials: "omit", redirect: "error",
        cache: "no-store", signal: request.controller.signal,
      });
      if (!response.ok) throw new Error("Request failed");
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error("Invalid response");
      // Ignore old responses if a newer request has started
      if (this.request !== request) return;
      this.render(events);
    } catch {
      if (this.request === request) {
        this.showMessage("Unable to load events. Please try again.", "error");
      }
    } finally {
      globalThis.clearTimeout(timeout);
      if (this.request === request) {
        this.request = null;
        this.root.setAttribute("aria-busy", "false");
      }
    }
  }

  // display saved events in a table, sorted by timestamp
  render(events) {
    this.body.replaceChildren();
    if (!events.length) {
      this.showMessage("No events found.");
      return;
    }
    this.message.textContent = "";
    this.message.dataset.state = "";
    for (const event of [...events].sort((a, b) => timestampOf(b) - timestampOf(a))) {
      const row = this.document.createElement("tr");
      const dateCell = this.document.createElement("td");
      const timestamp = timestampOf(event);
      if (Number.isFinite(timestamp)) {
        const time = this.document.createElement("time");
        time.dateTime = new Date(timestamp).toISOString();
        time.textContent = this.dateFormat.format(new Date(timestamp));
        dateCell.append(time);
      } else {
        dateCell.textContent = "—";
      }
      const typeCell = this.document.createElement("td");
      typeCell.textContent = event?.event_type === "fall_detected" ? "Fall detected" :
        (typeof event?.event_type === "string" ? event.event_type : "—");
      const scoreCell = this.document.createElement("td");
      const score = event?.rule_based_evidence_score;
      scoreCell.textContent = Number.isFinite(score) && score >= 0 && score <= 100
        ? `${this.scoreFormat.format(score)} / 100` : "—";
      // display event info as text for safety
      row.append(dateCell, typeCell, scoreCell);
      this.body.append(row);
    }
    this.results.hidden = false;
  }
}
