---
name: office-pptx
description: Create, read, edit, and validate PowerPoint presentations (.pptx).
---

# PowerPoint presentations

Use `python-pptx` unless an explicit user or applicable AGENTS.md requirement names another library. Run Python as described in the Python environment section below. Do not install npm packages for the default workflow.

Keep scripts and output files in the task workspace. The runtime and skill directory contain shared read-only resources. Match the requested slide language and the supplied presentation's design when editing it.

Name Python scripts for their task, such as `edit_pptx.py`; avoid module names such as `inspect.py`, `pptx.py`, or `zipfile.py` that shadow imported libraries.

## Create and edit

Use `python-pptx` to inspect or modify an existing presentation. Inspect slide layouts, text runs, images, tables, and charts before editing. Change only the requested content, preserve mixed text formatting, and save to a new file unless the user requests an in-place edit. Rebuilding slides can discard unsupported animation, SmartArt, or other extension content.

For a new deck, use `python-pptx` with editable text, tables, and charts. Use local image assets rather than network-dependent image URLs. Set slide dimensions, text sizes, and chart data explicitly.

A minimal editable deck, run with the selected Python executable:

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

presentation = Presentation()
presentation.slide_width = Inches(13.333)
presentation.slide_height = Inches(7.5)
slide = presentation.slides.add_slide(presentation.slide_layouts[6])
title = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12), Inches(0.8))
run = title.text_frame.paragraphs[0].add_run()
run.text = "Quarterly report"
run.font.size = Pt(30)
data = CategoryChartData()
data.categories = ["Q1", "Q2"]
data.add_series("Revenue", [12, 18])
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,
                       Inches(0.8), Inches(1.6), Inches(11.5), Inches(4.8), data)
presentation.save("report.pptx")
```

Use `Inches` or `Cm` for positions and sizes and `Pt` for font sizes. To edit a generated title while retaining its other slides and charts:

```python
from pptx import Presentation

presentation = Presentation("report.pptx")
for shape in presentation.slides[0].shapes:
    if shape.has_text_frame and shape.text == "Quarterly report":
        shape.text_frame.paragraphs[0].runs[0].text = "Quarterly results"
presentation.save("report-edited.pptx")
```

Check that text and images fit the slide dimensions, titles form a useful sequence, and chart labels agree with source values. Paragraph alignment does not move a text box: when a title must be centered on the slide, center both its paragraph and the text box against `presentation.slide_width`, then reopen to verify both. A native chart's embedded workbook is part of the deliverable and must contain the intended data.

## Check and deliver

Reopen the saved presentation with python-pptx to verify the requested slide count, content, formatting, chart data, and notes, including unchanged content that must be preserved. These checks do not establish text fit, readable contrast, or rendering fidelity.

Deliver after the requested edits are verified. Creating a file or changing content with incidental basic formatting does not require additional operations. Call the `office` tool with `operation: "render"` for requested images or visual inspection and for appearance-focused styling, spacing, sizing, or alignment changes unless the user explicitly skips rendering. For PDF output, call `office` with `operation: "convert"` and `format: "pdf"`, then copy the returned temporary file to the destination.

A fully transparent or uniformly blank image of populated content is a renderer failure: stop visual checks for the task at once, without rendering again with other slides, DPI, or settings and without editing the source for it. If content and structure checks pass, state the visual status only as "Content and structure checks passed; visual inspection was not completed." or "内容与结构检查通过；视觉检查未完成。"; never claim visual verification.

Call `present({"files":[{"path":"report-edited.pptx"}]})` with the actual final PPTX path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and leave intermediate images and reports out of delivery unless requested. If `present` is unavailable, use the session's supported file delivery method.
