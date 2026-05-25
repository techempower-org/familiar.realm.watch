#!/usr/bin/env python3
"""wave-block — beautiful live TUI dashboard for palace-daemon jobs.

Usage:
    wave-block.py backfill [--url URL] [--key KEY] [--total N] [--interval S]
    wave-block.py custom   --title TITLE --cmd CMD [--parse JMESPATH] [--interval S]

The backfill subcommand polls /backfill-age/status and renders a live
progress dashboard.  The custom subcommand wraps any shell command that
emits JSON, rendering key metrics in the same visual frame.

Requires: Python 3.10+, no external deps (stdlib only).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any

# ── ANSI palette ────────────────────────────────────────────────────────────
# Gruvbox-ish warm palette — looks great on dark and light terminals.
C = {
    "reset":     "\033[0m",
    "bold":      "\033[1m",
    "dim":       "\033[2m",
    "fg":        "\033[38;5;223m",   # warm cream
    "accent":    "\033[38;5;214m",   # amber
    "good":      "\033[38;5;142m",   # olive green
    "warn":      "\033[38;5;208m",   # orange
    "err":       "\033[38;5;167m",   # muted red
    "muted":     "\033[38;5;245m",   # gray
    "bar_fill":  "\033[38;5;214m",   # amber
    "bar_bg":    "\033[38;5;239m",   # dark gray
    "spark":     "\033[38;5;109m",   # teal
    "border":    "\033[38;5;246m",   # visible gray
    "title_bg":  "\033[48;5;235m",   # very dark bg for title bar
    "wave1":     "\033[38;5;31m",    # deep blue
    "wave2":     "\033[38;5;37m",    # teal
    "wave3":     "\033[38;5;73m",    # light teal
    "wave4":     "\033[38;5;109m",   # pale teal
}

WAVE_CHARS = "▁▂▃▄▅▆▇█"
SPARK_CHARS = "▁▂▃▄▅▆▇█"
BAR_FILL = "█"
BAR_HALF = "▌"
BAR_EMPTY = "░"

BOX = {
    "tl": "╭", "tr": "╮", "bl": "╰", "br": "╯",
    "h": "─", "v": "│",
    "lt": "├", "rt": "┤", "tt": "┬", "bt": "┴",
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def hide_cursor():
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()

def show_cursor():
    sys.stdout.write("\033[?25h")
    sys.stdout.flush()

def clear_screen():
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()

def move_to(row: int, col: int):
    sys.stdout.write(f"\033[{row};{col}H")

def term_width() -> int:
    return shutil.get_terminal_size((80, 24)).columns

def term_height() -> int:
    return shutil.get_terminal_size((80, 24)).lines

def fmt_duration(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"

def fmt_number(n: int | float) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(int(n))

def sparkline(values: list[float], width: int = 20) -> str:
    if not values:
        return C["muted"] + "·" * width + C["reset"]
    recent = values[-width:]
    mn, mx = min(recent), max(recent)
    rng = mx - mn if mx > mn else 1.0
    chars = []
    for v in recent:
        idx = int((v - mn) / rng * (len(SPARK_CHARS) - 1))
        chars.append(SPARK_CHARS[min(idx, len(SPARK_CHARS) - 1)])
    pad = width - len(chars)
    return C["muted"] + "·" * pad + C["spark"] + "".join(chars) + C["reset"]

def progress_bar(fraction: float, width: int = 40) -> str:
    fraction = max(0.0, min(1.0, fraction))
    filled = fraction * width
    full_blocks = int(filled)
    remainder = filled - full_blocks
    bar = C["bar_fill"] + BAR_FILL * full_blocks
    if remainder >= 0.5 and full_blocks < width:
        bar += BAR_HALF
        full_blocks += 1
    bar += C["bar_bg"] + BAR_EMPTY * (width - full_blocks)
    bar += C["reset"]
    return bar

def wave_banner(tick: int, width: int) -> str:
    colors = [C["wave1"], C["wave2"], C["wave3"], C["wave4"]]
    wave_chars = "░▒▓█▓▒░ "
    line = ""
    for i in range(width):
        phase = (i * 0.3 + tick * 0.5)
        idx = int((math.sin(phase) + 1) / 2 * (len(wave_chars) - 1))
        cidx = int((math.sin(phase * 0.7) + 1) / 2 * (len(colors) - 1))
        line += colors[cidx] + wave_chars[idx]
    return line + C["reset"]


# ── Box renderer ────────────────────────────────────────────────────────────

def box_top(width: int, title: str = "") -> str:
    inner = width - 2
    if title:
        t = f" {title} "
        t_visible = re.sub(r'\033\[[^m]*m', '', t)
        pad = inner - len(t_visible)
        lpad = pad // 2
        rpad = pad - lpad
        line = BOX["h"] * lpad + C["accent"] + C["bold"] + t + C["reset"] + C["border"] + BOX["h"] * rpad
    else:
        line = BOX["h"] * inner
    return C["border"] + BOX["tl"] + line + BOX["tr"] + C["reset"]

def box_mid(width: int) -> str:
    return C["border"] + BOX["lt"] + BOX["h"] * (width - 2) + BOX["rt"] + C["reset"]

def box_bot(width: int) -> str:
    return C["border"] + BOX["bl"] + BOX["h"] * (width - 2) + BOX["br"] + C["reset"]

def box_row(content: str, width: int) -> str:
    stripped = re.sub(r'\033\[[^m]*m', '', content)
    pad = width - 2 - len(stripped)
    if pad < 0:
        pad = 0
    return C["border"] + BOX["v"] + C["reset"] + content + " " * pad + C["border"] + BOX["v"] + C["reset"]

def box_row_pair(left: str, right: str, width: int) -> str:
    half = (width - 3) // 2
    l_stripped = re.sub(r'\033\[[^m]*m', '', left)
    r_stripped = re.sub(r'\033\[[^m]*m', '', right)
    l_pad = half - len(l_stripped)
    r_pad = (width - 3 - half) - len(r_stripped)
    if l_pad < 0: l_pad = 0
    if r_pad < 0: r_pad = 0
    return (C["border"] + BOX["v"] + C["reset"] +
            left + " " * l_pad +
            C["border"] + BOX["v"] + C["reset"] +
            right + " " * r_pad +
            C["border"] + BOX["v"] + C["reset"])


# ── Data model ──────────────────────────────────────────────────────────────

@dataclass
class BackfillState:
    in_progress: bool = False
    drawers_seen: int = 0
    entities_added: int = 0
    errors: int = 0
    rate: float = 0.0
    elapsed: float = 0.0
    total_drawers: int = 339_403
    rate_history: list[float] = field(default_factory=list)
    entity_history: list[float] = field(default_factory=list)
    poll_count: int = 0
    started_at: str = ""
    last_log_time: str = ""
    workers: int = 1

    @property
    def pct(self) -> float:
        if self.total_drawers <= 0:
            return 0.0
        return self.drawers_seen / self.total_drawers

    @property
    def eta_seconds(self) -> float:
        if self.rate <= 0:
            return float('inf')
        remaining = self.total_drawers - self.drawers_seen
        return remaining / self.rate

    @property
    def entities_per_drawer(self) -> float:
        if self.drawers_seen <= 0:
            return 0.0
        return self.entities_added / self.drawers_seen


def parse_backfill_status(data: dict, state: BackfillState) -> BackfillState:
    state.in_progress = data.get("in_progress", False)
    state.elapsed = data.get("elapsed_seconds", 0.0)
    if data.get("total_drawers"):
        state.total_drawers = data["total_drawers"]

    # Prefer checkpointed_drawers from the status JSON — this reflects
    # actual progress including previously completed runs, unlike
    # drawers_seen which resets to 0 each run.
    if data.get("checkpointed_drawers"):
        state.drawers_seen = data["checkpointed_drawers"]

    lines = data.get("recent_output", [])
    if lines:
        last = lines[-1]
        # Only use log-parsed drawers_seen if no checkpoint count available
        if not data.get("checkpointed_drawers"):
            m = re.search(r'drawers_seen=(\d+)', last)
            if m:
                state.drawers_seen = int(m.group(1))
        m = re.search(r'entities_added=(\d+)', last)
        if m:
            state.entities_added = int(m.group(1))
        m = re.search(r'errors=(\d+)', last)
        if m:
            state.errors = int(m.group(1))
        m = re.search(r'rate=([\d.]+)/s', last)
        if m:
            state.rate = float(m.group(1))

        m = re.search(r'workers=(\d+)', last)
        if m:
            state.workers = int(m.group(1))
        m = re.search(r'^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})', last)
        if m:
            state.last_log_time = m.group(1)

    # Compute rate from checkpoint deltas when the source doesn't report it
    if state.rate == 0.0 and state.poll_count > 0:
        prev = state._prev_drawers if hasattr(state, '_prev_drawers') else state.drawers_seen
        prev_t = state._prev_time if hasattr(state, '_prev_time') else time.monotonic()
        dt = time.monotonic() - prev_t
        if dt > 0 and state.drawers_seen > prev:
            state.rate = (state.drawers_seen - prev) / dt
    state._prev_drawers = state.drawers_seen
    state._prev_time = time.monotonic()

    # EMA smoothing: don't let rate jump to 0 between polls
    if not hasattr(state, '_ema_rate'):
        state._ema_rate = state.rate
    if state.rate > 0:
        state._ema_rate = 0.3 * state.rate + 0.7 * state._ema_rate
    state.rate = state._ema_rate

    state.rate_history.append(state.rate)
    if len(state.rate_history) > 120:
        state.rate_history = state.rate_history[-120:]

    state.entity_history.append(state.entities_added)
    if len(state.entity_history) > 120:
        state.entity_history = state.entity_history[-120:]

    state.poll_count += 1
    return state


# ── Responsive layout tiers ─────────────────────────────────────────────────
#
#  Tier     Width     Height    Layout
#  ────     ─────     ──────    ──────
#  tiny     < 30      < 8       pct + rate only, no box, no sparklines
#  narrow   30-49     any       single-column metrics, short labels
#  medium   50-79     any       paired columns, sparklines if height allows
#  wide     80+       any       full layout with wave banners, all sparklines
#
# Height gates (applied after width tier picks candidate rows):
#  < 5   → progress bar + one stat line only
#  5-8   → progress + core stats (rate/eta/elapsed)
#  9-13  → above + entity/error stats
#  14-17 → above + sparklines (1-2)
#  18+   → above + wave banners + footer

def _size_tier(w: int) -> str:
    if w < 30: return "tiny"
    if w < 50: return "narrow"
    if w < 80: return "medium"
    return "wide"


def render_backfill(state: BackfillState, tick: int):
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    lines: list[str] = []

    status_icon = "◉" if state.in_progress else "○"
    status_color = C["good"] if state.in_progress else C["muted"]
    rate_color = C["good"] if state.rate >= 3.5 else (C["warn"] if state.rate >= 2.0 else C["err"])
    err_color = C["good"] if state.errors == 0 else C["err"]
    eta = state.eta_seconds
    eta_text = fmt_duration(eta) if eta < float('inf') else "∞"

    # ── TINY: bare minimum, no box frame ────────────────────────────────────
    if tier == "tiny":
        pct_str = f"{state.pct * 100:.0f}%"
        bar_w = max(w - len(pct_str) - 2, 5)
        lines.append(f"{progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']}")
        if h >= 3:
            lines.append(f"{rate_color}{state.rate:.1f}/s{C['reset']} {C['muted']}→{C['reset']} {C['accent']}{eta_text}{C['reset']}")
        if h >= 4:
            lines.append(f"{C['accent']}{fmt_number(state.drawers_seen)}{C['muted']}/{fmt_number(state.total_drawers)}{C['reset']}")
        if h >= 5:
            w_tag = f" {C['muted']}w:{state.workers}" if state.workers > 1 else ""
            lines.append(f"{C['muted']}E:{C['accent']}{fmt_number(state.entities_added)} {err_color}err:{state.errors}{w_tag}{C['reset']}")
        _emit(lines, h, tick)
        return

    # ── NARROW: single column in a box ──────────────────────────────────────
    if tier == "narrow":
        # Wave banner if we can afford the height
        if h >= 14:
            lines.append(wave_banner(tick, w))

        title = f"BACKFILL {status_color}{status_icon}{C['reset']}"
        lines.append(box_top(w, title))

        bar_w = max(w - 12, 8)
        pct_str = f"{state.pct * 100:5.1f}%"
        lines.append(box_row(f" {progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']}", w))

        if h >= 6:
            lines.append(box_row(f" {C['fg']}Drawers {C['accent']}{fmt_number(state.drawers_seen)}{C['muted']}/{fmt_number(state.total_drawers)}{C['reset']}", w))
        if h >= 7:
            lines.append(box_row(f" {C['fg']}Rate    {rate_color}{state.rate:.1f}/s{C['reset']}", w))
        if h >= 8:
            lines.append(box_row(f" {C['fg']}ETA     {C['accent']}{eta_text}{C['reset']}", w))
        if h >= 9:
            lines.append(box_row(f" {C['fg']}Elapsed {C['accent']}{fmt_duration(state.elapsed)}{C['reset']}", w))
        if h >= 10:
            lines.append(box_row(f" {C['fg']}Entities{C['accent']} {fmt_number(state.entities_added)}{C['reset']}", w))
        if h >= 11:
            lines.append(box_row(f" {C['fg']}Errors  {err_color}{state.errors}{C['reset']}", w))
        if h >= 12 and state.workers > 1:
            lines.append(box_row(f" {C['fg']}Workers {C['accent']}{state.workers}{C['reset']}", w))

        if h >= 14:
            lines.append(box_mid(w))
            spark_w = max(w - 12, 8)
            lines.append(box_row(f" {C['fg']}Rate {sparkline(state.rate_history, spark_w)}", w))

        lines.append(box_bot(w))

        if h >= 16:
            lines.append(wave_banner(tick + 4, w))

        _emit(lines, h, tick)
        return

    # ── MEDIUM + WIDE: paired columns ───────────────────────────────────────
    is_wide = tier == "wide"

    # Top wave
    if h >= 18:
        lines.append(wave_banner(tick, w))

    title = f"AGE GRAPH BACKFILL {status_color}{status_icon}{C['reset']}"
    lines.append(box_top(w, title))

    # Progress bar — always shown
    bar_w = max(w - 18, 10)
    pct_str = f"{state.pct * 100:5.1f}%"
    lines.append(box_row(f" {progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']} ", w))

    # Counts pair
    if h >= 6:
        seen_str = f" {C['fg']}Drawers  {C['accent']}{fmt_number(state.drawers_seen)}{C['muted']} / {fmt_number(state.total_drawers)}{C['reset']}"
        ent_str = f" {C['fg']}Entities {C['accent']}{fmt_number(state.entities_added)}{C['reset']}"
        lines.append(box_row_pair(seen_str, ent_str, w))

    if h >= 8:
        lines.append(box_mid(w))

    # Rate + ETA pair
    if h >= 9:
        rate_str = f" {C['fg']}Rate     {rate_color}{state.rate:.1f}/s{C['reset']}"
        eta_str = f" {C['fg']}ETA      {C['accent']}{eta_text}{C['reset']}"
        lines.append(box_row_pair(rate_str, eta_str, w))

    # Elapsed + Errors pair
    if h >= 10:
        elapsed_str = f" {C['fg']}Elapsed  {C['accent']}{fmt_duration(state.elapsed)}{C['reset']}"
        err_str = f" {C['fg']}Errors   {err_color}{state.errors}{C['reset']}"
        lines.append(box_row_pair(elapsed_str, err_str, w))

    # Ent/drawer + workers pair
    if h >= 11:
        epd_str = f" {C['fg']}Ent/draw {C['accent']}{state.entities_per_drawer:.1f}{C['reset']}"
        if state.workers > 1:
            workers_str = f" {C['fg']}Workers  {C['accent']}{state.workers}{C['reset']}"
        else:
            workers_str = f" {C['fg']}Last log {C['muted']}{state.last_log_time}{C['reset']}"
        lines.append(box_row_pair(epd_str, workers_str, w))

    # Sparklines — only if height allows
    if h >= 14:
        lines.append(box_mid(w))
        spark_w = max(w - 18, 10)
        lines.append(box_row(f" {C['fg']}Rate  ╌╌ {sparkline(state.rate_history, spark_w)} ", w))

    if h >= 15:
        deltas = []
        for i in range(1, len(state.entity_history)):
            deltas.append(state.entity_history[i] - state.entity_history[i - 1])
        spark_w = max(w - 18, 10)
        lines.append(box_row(f" {C['fg']}Ents  ╌╌ {sparkline(deltas, spark_w)} ", w))

    # Wide bonus: extra sparkline rows if lots of vertical space
    if is_wide and h >= 22 and len(state.rate_history) > 1:
        lines.append(box_mid(w))
        # Big ASCII bar chart of rate history
        _append_bar_chart(lines, state.rate_history, w, min(h - len(lines) - 4, 6))

    lines.append(box_bot(w))

    # Bottom wave
    if h >= 18:
        lines.append(wave_banner(tick + 4, w))

    # Footer
    if h >= 16:
        if is_wide:
            footer = f"{C['muted']}  poll #{state.poll_count}  ·  Ctrl-C to exit  ·  palace-daemon @ familiar:8085{C['reset']}"
        else:
            footer = f"{C['muted']}  poll #{state.poll_count}  ·  Ctrl-C{C['reset']}"
        lines.append(footer)

    _emit(lines, h, tick)


def _append_bar_chart(lines: list[str], values: list[float], w: int, max_rows: int):
    """Vertical bar chart using block elements — bonus for wide+tall terminals."""
    if max_rows < 2 or len(values) < 2:
        return
    chart_w = w - 4
    recent = values[-chart_w:]
    mn, mx = min(recent), max(recent)
    rng = mx - mn if mx > mn else 1.0
    for row in range(max_rows - 1, -1, -1):
        threshold = mn + (row / max_rows) * rng
        bar_line = ""
        for v in recent:
            if v >= threshold + rng / max_rows:
                bar_line += C["bar_fill"] + "█"
            elif v >= threshold:
                frac = (v - threshold) / (rng / max_rows)
                idx = min(int(frac * len(WAVE_CHARS)), len(WAVE_CHARS) - 1)
                bar_line += C["spark"] + WAVE_CHARS[idx]
            else:
                bar_line += C["bar_bg"] + " "
        bar_line += C["reset"]
        lines.append(box_row(f" {bar_line} ", w))


def _emit(lines: list[str], h: int, tick: int = 0):
    """Write lines to terminal, filling leftover rows with dim wave pattern."""
    w = term_width()
    for i, line in enumerate(lines):
        move_to(i + 1, 1)
        sys.stdout.write(line)
        sys.stdout.write("\033[K")
    for i in range(len(lines) + 1, h + 1):
        move_to(i, 1)
        fill = ""
        for col in range(w):
            phase = col * 0.15 + (i + tick) * 0.4
            v = (math.sin(phase) + 1) / 2
            if v > 0.7:
                fill += C["dim"] + "\033[38;5;237m" + "░"
            else:
                fill += " "
        sys.stdout.write(fill + C["reset"] + "\033[K")
    sys.stdout.flush()


# ── Polling ─────────────────────────────────────────────────────────────────

def fetch_backfill_status(url: str, api_key: str, cmd: str = "") -> dict:
    if cmd:
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
            return json.loads(result.stdout)
        except Exception as e:
            return {"error": str(e), "in_progress": False}
    import urllib.request
    req = urllib.request.Request(
        url,
        headers={"X-Api-Key": api_key} if api_key else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "in_progress": False}


_resize_flag = False

def _on_resize(signum, frame):
    global _resize_flag
    _resize_flag = True

def run_backfill_dashboard(url: str, api_key: str, total: int, interval: float, cmd: str = ""):
    global _resize_flag
    signal.signal(signal.SIGWINCH, _on_resize)

    state = BackfillState(total_drawers=total)
    tick = 0

    hide_cursor()
    clear_screen()

    try:
        while True:
            data = fetch_backfill_status(url, api_key, cmd=cmd)
            if "error" in data and not data.get("in_progress"):
                state.in_progress = False
            else:
                parse_backfill_status(data, state)

            clear_screen()
            render_backfill(state, tick)
            tick += 1

            if not state.in_progress and state.poll_count > 1:
                move_to(term_height() - 1, 1)
                sys.stdout.write(f"\n{C['good']}  ✓ Backfill complete!{C['reset']}\n")
                sys.stdout.flush()
                break

            poll_start = time.monotonic()
            while time.monotonic() - poll_start < interval:
                time.sleep(0.15)
                tick += 1
                if _resize_flag:
                    _resize_flag = False
                    clear_screen()
                render_backfill(state, tick)

    except KeyboardInterrupt:
        pass
    finally:
        show_cursor()
        sys.stdout.write("\n")


# ── Custom mode ─────────────────────────────────────────────────────────────

def run_custom_dashboard(title: str, cmd: str, parse_path: str | None, interval: float):
    """Run an arbitrary command, parse JSON output, render as wave block."""
    global _resize_flag
    signal.signal(signal.SIGWINCH, _on_resize)

    tick = 0
    metrics_history: dict[str, list[float]] = {}

    hide_cursor()
    clear_screen()

    try:
        while True:
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=10,
                )
                data = json.loads(result.stdout)
            except Exception as e:
                data = {"_error": str(e)}

            flat = _flatten_json(data)

            for k, v in flat.items():
                if isinstance(v, (int, float)):
                    metrics_history.setdefault(k, []).append(v)
                    if len(metrics_history[k]) > 120:
                        metrics_history[k] = metrics_history[k][-120:]

            clear_screen()
            _render_custom(title, flat, metrics_history, tick)
            tick += 1

            poll_start = time.monotonic()
            while time.monotonic() - poll_start < interval:
                time.sleep(0.15)
                tick += 1
                if _resize_flag:
                    _resize_flag = False
                    clear_screen()
                _render_custom(title, flat, metrics_history, tick)

    except KeyboardInterrupt:
        pass
    finally:
        show_cursor()
        sys.stdout.write("\n")


def _flatten_json(obj: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out.update(_flatten_json(v, key))
            elif isinstance(v, list) and len(v) <= 5:
                out[key] = v
            elif isinstance(v, (int, float, str, bool)):
                out[key] = v
    return out


def _render_custom(title: str, metrics: dict, history: dict[str, list[float]], tick: int):
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    numeric_keys = [k for k, v in metrics.items() if isinstance(v, (int, float)) and not k.startswith("_")]
    string_keys = [k for k, v in metrics.items() if isinstance(v, str) and not k.startswith("_")]

    lines: list[str] = []

    # ── TINY: no frame, just key=value lines ────────────────────────────────
    if tier == "tiny":
        lines.append(f"{C['accent']}{title[:w]}{C['reset']}")
        for k in numeric_keys[:min(h - 1, 6)]:
            v = metrics[k]
            label = k[:max(w - 8, 3)]
            lines.append(f"{C['fg']}{label} {C['accent']}{fmt_number(v)}{C['reset']}")
        _emit(lines, h, tick)
        return

    # ── NARROW: single column ───────────────────────────────────────────────
    if tier == "narrow":
        if h >= 14:
            lines.append(wave_banner(tick, w))
        lines.append(box_top(w, title.upper()))

        label_w = min(12, w - 12)
        budget = h - len(lines) - 2  # save room for box_bot
        for k in numeric_keys[:budget]:
            v = metrics[k]
            lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['accent']}{fmt_number(v)}{C['reset']}", w))

        if h >= 14 and numeric_keys:
            lines.append(box_mid(w))
            spark_w = max(w - 12, 8)
            for k in numeric_keys[:2]:
                if k in history and len(history[k]) > 1:
                    lines.append(box_row(f" {C['fg']}{k[:4]} {sparkline(history[k], spark_w)}", w))

        for k in string_keys[:max(0, h - len(lines) - 2)]:
            v = metrics[k]
            lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['muted']}{str(v)[:w-label_w-6]}{C['reset']}", w))

        lines.append(box_bot(w))
        if h >= 16:
            lines.append(wave_banner(tick + 4, w))
        _emit(lines, h, tick)
        return

    # ── MEDIUM + WIDE: paired columns ───────────────────────────────────────
    if h >= 18:
        lines.append(wave_banner(tick, w))

    lines.append(box_top(w, title.upper()))

    label_w = 12
    for i in range(0, len(numeric_keys), 2):
        if len(lines) >= h - 4:
            break
        k1 = numeric_keys[i]
        v1 = metrics[k1]
        left = f" {C['fg']}{k1[:label_w]:{label_w}s} {C['accent']}{fmt_number(v1)}{C['reset']}"
        if i + 1 < len(numeric_keys):
            k2 = numeric_keys[i + 1]
            v2 = metrics[k2]
            right = f" {C['fg']}{k2[:label_w]:{label_w}s} {C['accent']}{fmt_number(v2)}{C['reset']}"
        else:
            right = ""
        lines.append(box_row_pair(left, right, w))

    if numeric_keys and h - len(lines) >= 5:
        lines.append(box_mid(w))
        spark_w = max(w - 18, 10)
        max_sparks = 4 if tier == "wide" else 2
        for k in numeric_keys[:max_sparks]:
            if len(lines) >= h - 3:
                break
            if k in history and len(history[k]) > 1:
                label = k[:6]
                lines.append(box_row(f" {C['fg']}{label:{6}s} ╌╌ {sparkline(history[k], spark_w)} ", w))

    for k in string_keys[:max(0, min(4, h - len(lines) - 3))]:
        v = metrics[k]
        lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['muted']}{str(v)[:w-label_w-6]}{C['reset']}", w))

    if "_error" in metrics:
        lines.append(box_row(f" {C['err']}Error: {metrics['_error'][:w-14]}{C['reset']}", w))

    lines.append(box_bot(w))

    if h >= 18:
        lines.append(wave_banner(tick + 4, w))
    if h >= 16:
        lines.append(f"{C['muted']}  Ctrl-C to exit{C['reset']}")

    _emit(lines, h, tick)


# ── Terminal detection & launch ──────────────────────────────────────────────

def _detect_terminal() -> str:
    if os.environ.get("WAVETERM") == "1":
        return "waveterm"
    term_prog = os.environ.get("TERM_PROGRAM", "").lower()
    if "ghostty" in term_prog:
        return "ghostty"
    return "inline"

def _shell_quote(s: str) -> str:
    import shlex
    return shlex.quote(s)

def _find_wsh() -> str | None:
    candidates = [
        os.path.expanduser("~/.local/share/waveterm-dev/bin/wsh"),
        os.path.expanduser("~/.local/share/waveterm/bin/wsh"),
        shutil.which("wsh"),
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None

def _launch_in_waveterm(argv: list[str], env_vars: dict[str, str] | None = None):
    wsh = _find_wsh()
    if not wsh:
        print("wsh not found — falling back to inline mode", file=sys.stderr)
        return False

    cmd_parts = []
    if env_vars:
        for k, v in env_vars.items():
            cmd_parts.append(f"{k}={v}")
    cmd_parts.extend(_shell_quote(a) for a in argv)

    subprocess.Popen(
        [wsh, "run", "-c", " ".join(cmd_parts)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True

def _launch_in_ghostty(argv: list[str], env_vars: dict[str, str] | None = None):
    cmd_parts = []
    if env_vars:
        for k, v in env_vars.items():
            cmd_parts.append(f"export {k}='{v}';")
    cmd_parts.append(" ".join(_shell_quote(a) for a in argv))
    cmd_parts.append("; read -p 'Done. Press enter.'")
    shell_cmd = " ".join(cmd_parts)

    ghostty = shutil.which("ghostty") or "/snap/bin/ghostty"
    subprocess.Popen(
        [ghostty, "-e", "bash", "-c", shell_cmd],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True


def _get_palace_api_key() -> str:
    key = os.environ.get("PALACE_API_KEY", "")
    if key:
        return key
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", "service", "palace-daemon", "type", "api-key"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _get_total_drawers(api_key: str, url_base: str) -> int:
    import urllib.request
    try:
        req = urllib.request.Request(
            url_base.replace("/backfill-age/status", "/palace/drawer-count"),
            headers={"X-Api-Key": api_key} if api_key else {},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("count", 339_403)
    except Exception:
        return 339_403


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    signal.signal(signal.SIGINT, lambda *_: None)

    parser = argparse.ArgumentParser(
        description="wave-block — beautiful live TUI dashboards",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    bf = sub.add_parser("backfill", help="AGE graph backfill progress")
    bf.add_argument("--url", default="http://familiar:8085/backfill-age/status")
    bf.add_argument("--key", default="")
    bf.add_argument("--total", type=int, default=0)
    bf.add_argument("--interval", type=float, default=10.0)
    bf.add_argument("--cmd", default="",
                    help="Poll a local command instead of --url (must emit same JSON shape)")
    bf.add_argument("--detach", action="store_true",
                    help="Launch in a new terminal block (WaveTerm/Ghostty) instead of inline")

    cu = sub.add_parser("custom", help="Custom JSON command dashboard")
    cu.add_argument("--title", required=True)
    cu.add_argument("--cmd", required=True)
    cu.add_argument("--parse", default=None)
    cu.add_argument("--interval", type=float, default=5.0)
    cu.add_argument("--detach", action="store_true",
                    help="Launch in a new terminal block (WaveTerm/Ghostty) instead of inline")

    args = parser.parse_args()

    if args.mode == "backfill":
        api_key = args.key or _get_palace_api_key()

        if args.detach:
            script = os.path.abspath(__file__)
            argv = ["python3", script, "backfill",
                    "--url", args.url,
                    "--key", api_key,
                    "--interval", str(args.interval)]
            if args.total:
                argv.extend(["--total", str(args.total)])
            if args.cmd:
                argv.extend(["--cmd", args.cmd])

            terminal = _detect_terminal()
            if terminal == "waveterm":
                if _launch_in_waveterm(argv, {"PALACE_API_KEY": api_key}):
                    print(f"Launched backfill dashboard in WaveTerm block")
                    return
            elif terminal == "ghostty":
                if _launch_in_ghostty(argv, {"PALACE_API_KEY": api_key}):
                    print(f"Launched backfill dashboard in Ghostty window")
                    return
            print("No detach target found — running inline")

        total = args.total or 339_403
        run_backfill_dashboard(args.url, api_key, total, args.interval, cmd=args.cmd)

    elif args.mode == "custom":
        if args.detach:
            script = os.path.abspath(__file__)
            argv = ["python3", script, "custom",
                    "--title", args.title,
                    "--cmd", args.cmd,
                    "--interval", str(args.interval)]

            terminal = _detect_terminal()
            if terminal == "waveterm":
                if _launch_in_waveterm(argv):
                    print(f"Launched '{args.title}' dashboard in WaveTerm block")
                    return
            elif terminal == "ghostty":
                if _launch_in_ghostty(argv):
                    print(f"Launched '{args.title}' dashboard in Ghostty window")
                    return
            print("No detach target found — running inline")

        run_custom_dashboard(args.title, args.cmd, args.parse, args.interval)


if __name__ == "__main__":
    main()
