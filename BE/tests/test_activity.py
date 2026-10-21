from datetime import date, datetime, timedelta, timezone

from activity import IST, NO_CONVERSATION, add_activity, split_by_day


class FakeConnection:
    """Applies practice_time upserts to a dict, as Postgres would."""

    def __init__(self):
        self.rows: dict[tuple[str, date], int] = {}

    def execute(self, sql, params=()):
        assert "INSERT INTO practice_time" in sql
        assert "ON CONFLICT (conversation_id, day)" in sql
        conversation_id, day, seconds = params
        key = (conversation_id, day)
        self.rows[key] = self.rows.get(key, 0) + seconds

    def day_totals(self) -> dict[date, int]:
        totals: dict[date, int] = {}
        for (_, day), seconds in self.rows.items():
            totals[day] = totals.get(day, 0) + seconds
        return totals


def ist(*args) -> datetime:
    return datetime(*args, tzinfo=IST)


def test_seconds_go_to_the_ist_day_they_ended_on():
    assert split_by_day(ist(2026, 10, 19, 14, 0, 0), 15) == [(date(2026, 10, 19), 15)]


def test_utc_times_are_counted_in_ist():
    # 20:00 UTC on the 18th is 01:30 IST on the 19th.
    end = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)
    assert split_by_day(end, 15) == [(date(2026, 10, 19), 15)]


def test_a_heartbeat_across_midnight_is_split_between_the_days():
    assert split_by_day(ist(2026, 10, 19, 0, 0, 5), 15) == [
        (date(2026, 10, 18), 10),
        (date(2026, 10, 19), 5),
    ]


def test_a_heartbeat_ending_exactly_at_midnight_belongs_to_the_day_before():
    assert split_by_day(ist(2026, 10, 19, 0, 0, 0), 15) == [(date(2026, 10, 18), 15)]


def test_no_seconds_records_nothing():
    assert split_by_day(ist(2026, 10, 19, 12, 0), 0) == []


def test_heartbeats_add_up_per_day():
    conn = FakeConnection()
    end = ist(2026, 10, 19, 9, 0, 0)
    for i in range(4):
        add_activity(conn, "c1", end + timedelta(seconds=15 * i), 15)
    add_activity(conn, "c1", ist(2026, 10, 20, 9, 0), 30)
    assert conn.rows == {("c1", date(2026, 10, 19)): 60, ("c1", date(2026, 10, 20)): 30}


def test_free_talk_and_scene_time_share_one_total():
    # The mode isn't part of the total, so both count towards the same day.
    conn = FakeConnection()
    add_activity(conn, "c1", ist(2026, 10, 19, 9, 0, 0), 15)  # Free Talk
    add_activity(conn, "c1", ist(2026, 10, 19, 9, 0, 15), 15)  # scene practice
    assert conn.rows == {("c1", date(2026, 10, 19)): 30}


def test_practice_before_the_first_message_is_kept_and_counted_in_the_day():
    conn = FakeConnection()
    add_activity(conn, None, ist(2026, 10, 19, 9, 0, 0), 15)
    add_activity(conn, "c1", ist(2026, 10, 19, 9, 0, 15), 15)
    assert conn.rows[(NO_CONVERSATION, date(2026, 10, 19))] == 15
    assert conn.day_totals() == {date(2026, 10, 19): 30}
