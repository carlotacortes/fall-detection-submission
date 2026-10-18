# store and retrieve fall events using a local JSON database. The API never stores frames or landmark sequences, only metadata.

from datetime import datetime
from pathlib import Path
from threading import RLock

from tinydb import Query, TinyDB

from .models import FallEvent


class EventDatabase:
    #set up local database
    def __init__(self, path: Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._database = TinyDB(path, encoding="utf-8", ensure_ascii=False, indent=2)
        self._events = self._database.table("events")
        # prevent multiple requests from accessing the database at the same time
        self._lock = RLock()

    def insert(self, event: FallEvent) -> tuple[FallEvent, bool]:
        #save and event unless its ID already exists
        with self._lock:
            existing = self._events.get(Query().event_id == str(event.event_id))
            if existing is not None:
                return FallEvent.model_validate(existing), False
            # convert event info into JSON-format
            self._events.insert(event.model_dump(mode="json"))
            return event, True

    #find saved events that match the given filters, sorted by timestamp
    def list_events(self, event_type: str | None = None, date_from: datetime | None = None,
                    date_to: datetime | None = None) -> list[FallEvent]:
        with self._lock:
            events = [FallEvent.model_validate(row) for row in self._events.all()]
        matching = [event for event in events
                    if (event_type is None or event.event_type == event_type)
                    and (date_from is None or event.timestamp >= date_from)
                    and (date_to is None or event.timestamp <= date_to)]
        # return matching events sorted by timestamp, newest first
        return sorted(matching, key=lambda event: event.timestamp, reverse=True)

    #close when app stops
    def close(self):
        with self._lock:
            self._database.close()
