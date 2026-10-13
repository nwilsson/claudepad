"""Builds docs/demo.svg: an animated illustration of the claudepad pane.

Every pane frame is the mod's own render tree, captured with the test kit
(frames.jsonl); this script only lays those trees out as terminal text and
animates them. Usage: python -I build_demo.py frames.jsonl out.svg
"""
import json
import sys
import unicodedata
from xml.sax.saxutils import escape

FRAMES = {}
for line in open(sys.argv[1], encoding='utf-8'):
    frame = json.loads(line[len('FRAME '):])
    FRAMES[frame['label']] = frame

# ---- layout: the render tree as lines of styled spans ----------------------

COLS = 66  # the pane body's width in cells


def cells(text):
    return sum(2 if unicodedata.east_asian_width(ch) in 'WF' else 0 if ch == '️' else 1 for ch in text)


def merge(style, props):
    out = dict(style)
    for key in ('bold', 'dimColor', 'strikethrough', 'color'):
        if props.get(key) not in (None, False):
            out[key] = props[key]
        elif props.get(key) is False and key in out:
            del out[key]
    return out


def inline(el, style):
    """An element as one run of spans (Text, Button, Input, or a row Box's children)."""
    if isinstance(el, str):
        return [(el, style)]
    kind, props = el['type'], el.get('props', {})
    if kind == 'Text':
        own = merge(style, props)
        return [span for child in el.get('children', []) for span in inline(child, own)]
    if kind == 'Button':
        label = props.get('label') or ''.join(c for c in el.get('children', []) if isinstance(c, str))
        hotkey = f"{props['hotkey']}: " if props.get('hotkey') else ''
        own = merge(style, {'dimColor': props.get('dimColor', False)})
        text = f'{hotkey}{label}' if props.get('plain') else f'[ {label} ]'
        return [(text, own)]
    if kind == 'Input':
        value = props.get('value') or ''
        return [(props.get('label', ''), style), (value or props.get('placeholder', ''), {**style, 'dimColor': not value, 'input': True})]
    return [span for child in el.get('children', []) for span in inline(child, style)]


def wrap(items, gap, width):
    """Lays inline items left to right, `gap` cells apart, onto lines of `width` cells."""
    lines, line, used = [], [], 0
    for item in items:
        size = sum(cells(text) for text, _ in item)
        if line and used + gap + size > width:
            lines.append(line)
            line, used = [], 0
        if line:
            line.append((' ' * gap, {}))
            used += gap
        if size > width:
            # A long run (a note's text): break it at spaces.
            for text, style in item:
                for word in text.split(' '):
                    piece = word + ' '
                    if used + cells(piece) > width and line:
                        lines.append(line)
                        line, used = [], 0
                    line.append((piece, style))
                    used += cells(piece)
        else:
            line.extend(item)
            used += size
    if line:
        lines.append(line)
    return lines


def block(el, style=None, width=COLS):
    style = style or {}
    if isinstance(el, str) or el['type'] != 'Box':
        return wrap([inline(el, style)], 0, width)
    props = el.get('props', {})
    out = []
    if props.get('flexDirection') == 'column':
        for child in el.get('children', []):
            margin = child.get('props', {}).get('marginTop', 0) if isinstance(child, dict) else 0
            out.extend([[]] * margin)
            out.extend(block(child, style, width))
        return out
    items = [inline(child, style) for child in el.get('children', [])]
    return wrap([item for item in items if item], props.get('gap', 0), width)


# ---- the story ---------------------------------------------------------------

def noted(where, text):
    return f'📝 Noted ({where}): {text}'


# (pane frame, caption, prompt typed, reply or toast under the pane, keys, seconds)
SCENES = [
    ('empty', 'A notes pane, inside Claude Code', None, None, None, 2.0),
    ('empty', 'Jot a note without leaving the prompt', '/note fix the login redirect #bug', None, None, 2.4),
    ('note', 'Jot a note without leaving the prompt', None, noted('acme-app', 'fix the login redirect #bug'), None, 2.0),
    ('note', 'Global notes, with due dates', '/note -g renew the domain #due:2026-11-01', None, None, 2.6),
    ('global', 'Global notes, with due dates', None, noted('global', 'renew the domain #due:2026-11-01'), None, 2.0),
    ('global', 'Claude parks follow-ups for you', 'park that 429 retry issue as a note, we will fix it later', None, None, 2.8),
    ('claude', 'Claude parks follow-ups for you', None, FRAMES['claude']['toast'], None, 2.8),
    ('claude', 'Notes for the branch you are on', '/note -b ask in review whether the retry belongs here', None, None, 2.8),
    ('branch', 'Notes for the branch you are on', None, noted('acme-app 🌿 main', 'ask in review whether the retry belongs here'), None, 2.2),
    ('pin', 'Pinned notes ride along with every prompt', None, None, 'click pin', 2.4),
    ('select', 'Keys: j / k to select', None, None, 'j  j', 2.0),
    ('done', 'd marks it done', None, None, 'd', 3.0),
]
TOTAL = sum(scene[-1] for scene in SCENES)

# ---- drawing -------------------------------------------------------------------

FONT = 14
LINE = 20
CHAR = 8.4
PAD = 18
BG, PANEL, FG, DIM, ACCENT, RULE = '#15161c', '#1b1c24', '#d6d6dc', '#8b8b96', '#d97757', '#2e303b'
FONTS = "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

pane_lines = {label: block(frame['tree']) for label, frame in FRAMES.items()}
PANE_ROWS = max(len(lines) for lines in pane_lines.values())

WIDTH = int(PAD * 2 + 24 + COLS * CHAR + 24)
TITLE_H = 44
PANE_TOP = TITLE_H + 14
PANE_H = (PANE_ROWS + 2) * LINE + 10
REPLY_TOP = PANE_TOP + PANE_H + 12
PROMPT_TOP = REPLY_TOP + LINE + 16
PROMPT_H = 40
STATUS_TOP = PROMPT_TOP + PROMPT_H + 22
HEIGHT = STATUS_TOP + 22


def text_line(spans, x, y):
    parts = []
    for text, style in spans:
        if not text:
            continue
        attrs = []
        fill = style.get('color') or (DIM if style.get('dimColor') else None)
        if fill:
            attrs.append(f'fill="{fill}"')
        if style.get('bold'):
            attrs.append('font-weight="700"')
        if style.get('strikethrough'):
            attrs.append('text-decoration="line-through"')
        if style.get('dimColor') and not style.get('color'):
            attrs.append('fill-opacity="0.9"')
        if style.get('input'):
            attrs.append('font-style="italic"')
        parts.append(f'<tspan {" ".join(attrs)}>{escape(text)}</tspan>' if attrs else escape(text))
    return f'<text x="{x:.1f}" y="{y}" xml:space="preserve">{"".join(parts)}</text>' if parts else ''


def window(start, end):
    """SMIL: shown from `start` to `end` seconds of the loop, hidden otherwise."""
    s, e = start / TOTAL, end / TOTAL
    if s <= 0:
        keys, values = f'0;{e:.4f};1', '1;0;0'
    elif e >= 1:
        keys, values = f'0;{s:.4f};1', '0;1;1'
    else:
        keys, values = f'0;{s:.4f};{e:.4f};1', '0;1;0;0'
    return (f'<animate attributeName="opacity" calcMode="discrete" dur="{TOTAL:.2f}s" '
            f'repeatCount="indefinite" keyTimes="{keys}" values="{values}"/>')


def typing(attr, start, seconds, frm, to):
    s, t = start / TOTAL, (start + seconds) / TOTAL
    return (f'<animate attributeName="{attr}" dur="{TOTAL:.2f}s" repeatCount="indefinite" '
            f'keyTimes="0;{s:.4f};{t:.4f};1" values="{frm:.1f};{frm:.1f};{to:.1f};{to:.1f}"/>')


out = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" '
    f'font-family="{FONTS}" font-size="{FONT}" fill="{FG}" role="img" '
    f'aria-label="An animated illustration of the claudepad pane: adding notes, Claude adding one, a branch note, pinning and marking done">',
    '<title>claudepad: a notepad pane for Claude Code (illustration drawn from the mod\'s own render output)</title>',
    f'<rect width="{WIDTH}" height="{HEIGHT}" rx="12" fill="{BG}"/>',
    # window chrome
    f'<circle cx="{PAD + 6}" cy="22" r="6" fill="#ff5f57"/><circle cx="{PAD + 26}" cy="22" r="6" fill="#febc2e"/>'
    f'<circle cx="{PAD + 46}" cy="22" r="6" fill="#28c840"/>',
    f'<text x="{PAD + 66}" y="27" fill="{DIM}">claude · ~/work/acme-app</text>',
    f'<line x1="0" y1="{TITLE_H}" x2="{WIDTH}" y2="{TITLE_H}" stroke="{RULE}"/>',
    # the pane's frame
    f'<rect x="{PAD}" y="{PANE_TOP}" width="{WIDTH - PAD * 2}" height="{PANE_H}" rx="8" fill="{PANEL}" stroke="{ACCENT}" stroke-opacity="0.7"/>',
    f'<rect x="{PAD + 14}" y="{PANE_TOP - 9}" width="{cells(" claudepad ") * CHAR:.0f}" height="18" fill="{BG}"/>',
    f'<text x="{PAD + 14}" y="{PANE_TOP + 5}" fill="{ACCENT}" font-weight="700" xml:space="preserve"> claudepad </text>',
    # the prompt box
    f'<rect x="{PAD}" y="{PROMPT_TOP}" width="{WIDTH - PAD * 2}" height="{PROMPT_H}" rx="8" fill="none" stroke="{RULE}" stroke-width="1.5"/>',
    f'<text x="{PAD + 14}" y="{PROMPT_TOP + 25}" fill="{DIM}">&gt;</text>',
]

PANE_X = PAD + 16
TEXT_X = PAD + 34
clock = 0.0
for index, (label, caption, typed, reply, keys, seconds) in enumerate(SCENES):
    frame = FRAMES[label]
    group = [f'<g opacity="0">{window(clock, clock + seconds)}']
    # caption, top right
    group.append(f'<text x="{WIDTH - PAD}" y="27" text-anchor="end" fill="{FG}" font-weight="600">{escape(caption)}</text>')
    # the pane
    for row, spans in enumerate(pane_lines[label]):
        group.append(text_line(spans, PANE_X, PANE_TOP + 28 + row * LINE))
    # the reply or toast under the pane
    if reply:
        group.append(f'<text x="{PAD + 4}" y="{REPLY_TOP + 14}" fill="{ACCENT}">{escape(reply)}</text>')
    # keys pressed
    if keys:
        size = cells(keys) * CHAR + 20
        group.append(f'<rect x="{WIDTH - PAD - size}" y="{REPLY_TOP}" width="{size:.0f}" height="24" rx="6" fill="{RULE}"/>')
        group.append(f'<text x="{WIDTH - PAD - size / 2:.1f}" y="{REPLY_TOP + 17}" text-anchor="middle" fill="{FG}">{escape(keys)}</text>')
    # the prompt: typed in, with a cursor
    if typed:
        span = cells(typed) * CHAR
        clip = f'type{index}'
        group.append(f'<clipPath id="{clip}"><rect x="{TEXT_X}" y="{PROMPT_TOP + 6}" height="{PROMPT_H - 12}" width="0">'
                     f'{typing("width", clock + 0.2, seconds * 0.6, 0, span)}</rect></clipPath>')
        group.append(f'<text x="{TEXT_X}" y="{PROMPT_TOP + 25}" clip-path="url(#{clip})" textLength="{span:.1f}" '
                     f'lengthAdjust="spacingAndGlyphs" xml:space="preserve">{escape(typed)}</text>')
        group.append(f'<rect x="{TEXT_X}" y="{PROMPT_TOP + 11}" width="8" height="18" fill="{FG}" fill-opacity="0.8">'
                     f'{typing("x", clock + 0.2, seconds * 0.6, TEXT_X, TEXT_X + span + 2)}</rect>')
    else:
        group.append(f'<rect x="{TEXT_X}" y="{PROMPT_TOP + 11}" width="8" height="18" fill="{FG}" fill-opacity="0.8"/>')
    # the status line, as the mod sets it
    if frame.get('status'):
        group.append(f'<text x="{PAD + 4}" y="{STATUS_TOP}" fill="{DIM}">{escape(frame["status"])}</text>')
    group.append('</g>')
    out.append(''.join(part for part in group if part))
    clock += seconds

out.append('</svg>')
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(out) + '\n')
print(f'{WIDTH}x{HEIGHT}, {TOTAL:.1f}s loop, {PANE_ROWS} pane rows, {sum(len(x) for x in out) // 1024} KB')
