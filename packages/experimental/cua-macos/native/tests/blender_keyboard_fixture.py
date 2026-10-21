"""Blender-side observer for an owned Text Editor keyboard regression.

Only initialization writes Text data. Once ready, this script observes input and
publishes actual Text/selection state; every modal event passes to Blender.
"""
import argparse
from collections import deque
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback

import bpy


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--seed", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:])


ARGS = arguments()
STATE_PATH = ARGS.state.resolve()
EVENTS = deque(maxlen=256)
EVENT_SEQUENCE = 0
REVISION = 0
OBSERVER_STARTED = False
TARGET_WINDOW = None
TARGET_AREA = None
TARGET_TEXT = None


def atomic_json(value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=STATE_PATH.parent,
                                         prefix=".blender-state-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, STATE_PATH)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def selection_state(text):
    start = [text.current_line_index, text.current_character]
    end = [text.select_end_line_index, text.select_end_character]
    lines = text.as_string().split("\n")

    def offset(position):
        line, character = position
        return sum(len(value) + 1 for value in lines[:line]) + character

    # The asserted selection phases contain ASCII only, so byte/character indexing
    # differences between Blender releases cannot change the expected range.
    offsets = sorted([offset(start), offset(end)])
    return {"start": start, "end": end, "offsets": offsets,
            "selected": text.as_string()[offsets[0]:offsets[1]], "collapsed": start == end}


class WM_OT_dsh_cua_observe(bpy.types.Operator):
    bl_idname = "wm.dsh_cua_observe"
    bl_label = "Observe owned CUA keyboard fixture"

    def invoke(self, context, _event):
        global OBSERVER_STARTED
        context.window_manager.modal_handler_add(self)
        OBSERVER_STARTED = True
        return {"RUNNING_MODAL"}

    def modal(self, _context, event):
        global EVENT_SEQUENCE
        if event.value in {"PRESS", "RELEASE"} and event.type not in {"MOUSEMOVE", "INBETWEEN_MOUSEMOVE"}:
            EVENT_SEQUENCE += 1
            EVENTS.append({
                "sequence": EVENT_SEQUENCE, "type": event.type, "value": event.value,
                "unicode": event.unicode, "oskey": bool(event.oskey), "shift": bool(event.shift),
                "ctrl": bool(event.ctrl), "alt": bool(event.alt),
                "mouse_x": event.mouse_x, "mouse_y": event.mouse_y,
            })
        return {"PASS_THROUGH"}


def publish():
    global REVISION
    try:
        region = next(region for region in TARGET_AREA.regions if region.type == "WINDOW")
        active_text = TARGET_AREA.spaces.active.text
        keymap = bpy.context.window_manager.keyconfigs.active.keymaps.get("Text")
        select_all_keys = [] if keymap is None else [
            {"type": item.type, "value": item.value, "oskey": item.oskey,
             "shift": item.shift, "ctrl": item.ctrl, "alt": item.alt}
            for item in keymap.keymap_items if item.idname == "text.select_all"
        ]
        REVISION += 1
        atomic_json({
            "schema_version": 1, "token": ARGS.token, "pid": os.getpid(),
            "blender_version": bpy.app.version_string, "revision": REVISION,
            "ready": OBSERVER_STARTED and region.width > 64 and region.height > 64,
            "text_name": TARGET_TEXT.name, "text": TARGET_TEXT.as_string(),
            "is_in_memory": TARGET_TEXT.is_in_memory,
            "text_is_displayed": active_text == TARGET_TEXT,
            "selection": selection_state(TARGET_TEXT),
            "window": {"width": TARGET_WINDOW.width, "height": TARGET_WINDOW.height},
            "region": {"x": region.x, "y": region.y, "width": region.width, "height": region.height},
            "select_all_keymap": select_all_keys,
            "event_sequence": EVENT_SEQUENCE, "events": list(EVENTS),
        })
        return 0.05
    except Exception as error:
        atomic_json({"schema_version": 1, "token": ARGS.token, "pid": os.getpid(),
                     "ready": False, "error": str(error), "traceback": traceback.format_exc()})
        return None


def initialize():
    global TARGET_WINDOW, TARGET_AREA, TARGET_TEXT
    if not bpy.context.window_manager.windows:
        raise RuntimeError("A Blender GUI window is required; do not use --background")
    TARGET_WINDOW = bpy.context.window_manager.windows[0]
    TARGET_AREA = max(TARGET_WINDOW.screen.areas, key=lambda area: area.width * area.height)
    TARGET_AREA.type = "TEXT_EDITOR"
    TARGET_TEXT = bpy.data.texts.new("DSH CUA keyboard " + ARGS.token)
    TARGET_TEXT.write(ARGS.seed)
    TARGET_TEXT.cursor_set(0, character=0, select=False)
    TARGET_TEXT.use_module = False
    TARGET_AREA.spaces.active.text = TARGET_TEXT
    TARGET_AREA.spaces.active.show_line_numbers = False
    TARGET_AREA.spaces.active.show_word_wrap = False
    bpy.context.preferences.view.show_splash = False
    bpy.utils.register_class(WM_OT_dsh_cua_observe)
    region = next(region for region in TARGET_AREA.regions if region.type == "WINDOW")
    with bpy.context.temp_override(window=TARGET_WINDOW, area=TARGET_AREA, region=region):
        result = bpy.ops.wm.dsh_cua_observe("INVOKE_DEFAULT")
    if "RUNNING_MODAL" not in result:
        raise RuntimeError("Blender event observer did not start: " + repr(result))
    bpy.app.timers.register(publish, first_interval=0.05)


try:
    initialize()
except Exception as error:
    atomic_json({"schema_version": 1, "token": ARGS.token, "pid": os.getpid(),
                 "ready": False, "error": str(error), "traceback": traceback.format_exc()})
    raise
