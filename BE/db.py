"""A small Postgres connection pool on pg8000, a pure-Python driver.

psycopg's binary build ships an unsigned native DLL that Windows Smart App Control
blocks, so this uses pg8000, which has no compiled code. Rows come back as dicts.
"""

import ssl
import threading
import time
from contextlib import contextmanager
from urllib.parse import parse_qs, unquote, urlparse

import pg8000.dbapi


class Rows:
    """The result of one statement, with each row as a dict keyed by column name."""

    def __init__(self, cursor):
        self._cursor = cursor
        self._names = [column[0] for column in cursor.description or ()]

    def fetchone(self) -> dict | None:
        row = self._cursor.fetchone()
        return None if row is None else dict(zip(self._names, row))

    def fetchall(self) -> list[dict]:
        return [dict(zip(self._names, row)) for row in self._cursor.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())


class Connection:
    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql: str, params=()) -> Rows:
        cursor = self._raw.cursor()
        cursor.execute(sql, params)
        return Rows(cursor)


class _Pooled:
    def __init__(self, raw):
        self.raw = raw
        self.created = self.used = time.monotonic()


def connect_args(url: str) -> dict:
    """pg8000.connect arguments for a postgresql:// URL such as Neon's."""
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    sslmode = query.get("sslmode", ["prefer"])[0]
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 5432,
        "database": unquote(parsed.path.lstrip("/")) or None,
        "ssl_context": ssl.create_default_context() if sslmode != "disable" else None,
        "tcp_keepalive": True,
    }


class ConnectionPool:
    """Hands out connections that commit when the block succeeds and roll back when it
    raises. Neon drops idle connections, so each one is checked before reuse and
    retired after max_idle seconds unused or max_lifetime seconds in total."""

    def __init__(self, url: str, max_size: int = 10, max_idle: float = 120,
                 max_lifetime: float = 600):
        self._args = connect_args(url)
        self._max_idle = max_idle
        self._max_lifetime = max_lifetime
        self._slots = threading.BoundedSemaphore(max_size)
        self._idle: list[_Pooled] = []
        self._lock = threading.Lock()

    def _usable(self, pooled: _Pooled) -> bool:
        now = time.monotonic()
        if now - pooled.used > self._max_idle or now - pooled.created > self._max_lifetime:
            return False
        try:
            pooled.raw.cursor().execute("SELECT 1")
            pooled.raw.rollback()
            return True
        except Exception:
            return False

    def _take(self) -> _Pooled:
        while True:
            with self._lock:
                pooled = self._idle.pop() if self._idle else None
            if pooled is None:
                return _Pooled(pg8000.dbapi.connect(**self._args))
            if self._usable(pooled):
                return pooled
            _close(pooled)

    @contextmanager
    def connection(self):
        with self._slots:
            pooled = self._take()
            try:
                yield Connection(pooled.raw)
                pooled.raw.commit()
            except BaseException:
                try:
                    pooled.raw.rollback()
                except Exception:
                    _close(pooled)
                    raise
                self._give_back(pooled)
                raise
            self._give_back(pooled)

    def _give_back(self, pooled: _Pooled) -> None:
        pooled.used = time.monotonic()
        with self._lock:
            self._idle.append(pooled)

    def close(self) -> None:
        with self._lock:
            idle, self._idle = self._idle, []
        for pooled in idle:
            _close(pooled)


def _close(pooled: _Pooled) -> None:
    try:
        pooled.raw.close()
    except Exception:
        pass
