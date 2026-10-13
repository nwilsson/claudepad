# The README demo

`docs/demo.svg` is an animated illustration of the pane, not a screen
recording. Each pane frame is the mod's own render tree, captured with the test
kit while a short scripted session plays; `build.py` lays those trees out as
terminal text and animates them with SVG `<animate>`, which plays inside a
GitHub `<img>`. The window, the prompt box and the typing are drawn around
them.

To rebuild it after the pane changes:

```bash
cp scripts/demo/capture.tsx tests/zz-capture.test.tsx
claude plugin test . 2>&1 | grep '^FRAME' > frames.jsonl
rm tests/zz-capture.test.tsx
python -I scripts/demo/build.py frames.jsonl docs/demo.svg
rm frames.jsonl
```

The scenes (captions, what is typed, timings) are the `SCENES` list in
`build.py`; the pane states they show are the steps in `capture.tsx` (named so the test
runner skips it until it is copied into `tests/`).
