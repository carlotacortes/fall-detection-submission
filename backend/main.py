# run the FastAPI server for the frontend and fall event database

from contextlib import asynccontextmanager
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .database import EventDatabase
from .models import FallEvent, UtcTimestamp


DEFAULT_DATABASE = Path(__file__).resolve().parent / "data/events.json"
FRONTEND = Path(__file__).resolve().parents[1] / "frontend"

# create the app and connect to database
def create_app(database_path: str | Path | None = None) -> FastAPI:
    #allow a diff dabase location for testing
    path = Path(database_path if database_path is not None else
                os.environ.get("FALL_DETECTION_DB_PATH", DEFAULT_DATABASE))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.database = EventDatabase(path)
        try:
            yield
        finally:
            app.state.database.close()

    app = FastAPI(title="Real-Time Fall Detection API", version="1.0.0", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # return a clear error when data invalid
        return JSONResponse(status_code=422, content={"detail": [
            {key: item[key] for key in ("type", "loc", "msg")}
            for item in error.errors()
        ]})

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/events", response_model=FallEvent, status_code=status.HTTP_201_CREATED,
              responses={200: {"description": "Identical event already stored"},
                         409: {"description": "UUID already used for different metadata"}})
    def create_event(event: FallEvent, response: Response):
        stored, created = app.state.database.insert(event)
        if not created:
            if stored != event:
                raise HTTPException(409, "event_id already belongs to different event metadata")
            response.status_code = status.HTTP_200_OK
        return stored

    @app.get("/api/events", response_model=list[FallEvent])
    def list_events(event_type: str | None = Query(default=None, max_length=64),
                    date_from: UtcTimestamp | None = None, date_to: UtcTimestamp | None = None):
        if date_from is not None and date_to is not None and date_from > date_to:
            raise HTTPException(422, "date_from must be earlier than or equal to date_to")
        return app.state.database.list_events(event_type, date_from, date_to)

    # serve the frontend from the static build directory
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
    return app


# create the app for uvicorn to run
app = create_app()
