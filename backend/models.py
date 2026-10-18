# define and validate the information stored for each fall event

from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, BaseModel, BeforeValidator, ConfigDict, Field


def require_iso_string(value):
    # require a full date and time with timezone
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("Use an ISO 8601 datetime with timezone, for example 2026-10-16T12:00:00Z")
    return value

#convert any timezone to UTC for storage and comparison
def to_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc)

UtcTimestamp = Annotated[AwareDatetime, BeforeValidator(require_iso_string), AfterValidator(to_utc)]

#define the fields required for each fall event, and validate them
class FallEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: UUID
    timestamp: UtcTimestamp
    event_type: Literal["fall_detected"]
    rule_based_evidence_score: float | None = Field(default=None, ge=0, le=100, strict=True,
        allow_inf_nan=False, description="Rule-based evidence score (0–100), not a calibrated probability. Missing in older records; not validated as real-world fall likelihood.")
    detection_method: Literal["temporal_rules_v1"]
    configuration: Literal["selected"]
