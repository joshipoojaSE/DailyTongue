"""Daily practice time, counted by the frontend and sent here as heartbeats.

The frontend times the learner's own activity (speaking or typing, with the tab visible),
not API requests, and every 15 seconds sends the seconds it counted. They are added to
practice_time, per conversation and IST day; a day's total is the sum over conversations.
"""

from datetime import date, datetime, time, timedelta, timezone

# Days start at midnight India Standard Time, as in the frontend. IST has no daylight saving.
IST = timezone(timedelta(hours=5, minutes=30))

# A heartbeat carries about 15 seconds; more is allowed so a few failed ones can catch up.
MAX_HEARTBEAT_SECONDS = 120

# Practice before the learner's first message, when there is no conversation id yet.
NO_CONVERSATION = ""


def split_by_day(end: datetime, seconds: int) -> list[tuple[date, int]]:
    """The seconds that ended at `end`, by IST day. Time from before midnight goes to
    the day before."""
    end = end.astimezone(IST)
    start = end - timedelta(seconds=seconds)
    if start.date() == end.date():
        return [(end.date(), seconds)] if seconds > 0 else []

    midnight = datetime.combine(end.date(), time(0), tzinfo=IST)
    before = round((midnight - start).total_seconds())
    parts = ((start.date(), before), (end.date(), seconds - before))
    return [(day, s) for day, s in parts if s > 0]


def add_activity(conn, conversation_id: str | None, end: datetime, seconds: int) -> None:
    for day, day_seconds in split_by_day(end, seconds):
        conn.execute(
            "INSERT INTO practice_time (conversation_id, day, seconds) VALUES (%s, %s, %s)"
            " ON CONFLICT (conversation_id, day)"
            " DO UPDATE SET seconds = practice_time.seconds + EXCLUDED.seconds",
            (conversation_id or NO_CONVERSATION, day, day_seconds),
        )


def today() -> date:
    return datetime.now(IST).date()
