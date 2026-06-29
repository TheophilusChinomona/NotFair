"""Tests for _should_auto_open in notfair-content-calendar."""

from __future__ import annotations

import importlib.util
import sys
import types


def _import_bin_module() -> types.ModuleType:
    """Load notfair-content-calendar as a module via importlib."""
    spec = importlib.util.spec_from_file_location(
        "notfair_content_calendar",
        "bin/notfair-content-calendar",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestShouldAutoOpen:
    """_should_auto_open honors --no-open on every platform."""

    def setup_method(self) -> None:
        self.mod = _import_bin_module()

    def test_no_open_suppresses_on_darwin(self) -> None:
        assert self.mod._should_auto_open(True, "darwin", "/tmp/.X11-unix") is False

    def test_no_open_suppresses_on_win32(self) -> None:
        assert self.mod._should_auto_open(True, "win32", "") is False

    def test_no_open_suppresses_on_linux(self) -> None:
        assert self.mod._should_auto_open(True, "linux", ":0") is False

    def test_default_opens_on_darwin(self) -> None:
        assert self.mod._should_auto_open(False, "darwin", "") is True

    def test_default_opens_on_win32(self) -> None:
        assert self.mod._should_auto_open(False, "win32", "") is True

    def test_linux_opens_with_display(self) -> None:
        assert self.mod._should_auto_open(False, "linux", ":0") is True

    def test_linux_stays_closed_without_display(self) -> None:
        assert self.mod._should_auto_open(False, "linux", "") is False
