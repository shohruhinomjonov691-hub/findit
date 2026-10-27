# Detector feasibility — 2026-10-27

Small feasibility check of COCO-pretrained YOLOv8 for FindIt ("find & highlight an
everyday object in a photo"). **Not an accuracy benchmark**: 20 images, one
reviewer, visual judgment, no annotated boxes, no IoU.

## Setup

| Item | Value |
| --- | --- |
| Device | MacBook (Apple M2, 16 GB RAM), macOS 27.0.1 |
| Python / torch / ultralytics | 3.13.3 / 2.14.1 / 8.4.190 (full list: `requirements.lock.txt`) |
| Models | `yolov8n.pt`, `yolov8s.pt` (official release v8.4.0; SHA-256 in `models/MODELS.md`) |
| Input | images scaled by Wikimedia to 1920 px wide (one is 1024×768); model input `imgsz=640` letterbox |
| Threshold | `conf=0.25`, default class-wise NMS |
| Device for main numbers | CPU; MPS run once for comparison |
| Network | `YOLO_OFFLINE=1` (set by `findit/detector.py`): turns off Ultralytics' own online checks and analytics; not network isolation |

Command:

```bash
python scripts/fetch_testset.py
python scripts/make_exif_variant.py data/testset/09_iphone_desk.jpg data/derived/09_iphone_desk_exif6.jpg
python -m findit.detect data/testset data/derived --out results/yolov8n_cpu
python -m findit.detect data/testset data/derived --model models/yolov8s.pt --out results/yolov8s_cpu
```

## Test set

20 images from Wikimedia Commons (licenses in `data/testset_manifest.json`) plus
one EXIF-rotated derivative. Scenarios: desks with several objects (01–05, 09),
single cup (06, 07), similar items side by side (08 cups, 10 two phones, 11 two
bottles, 12 five bottles lying in a freezer), books (13 small in a shop window,
14 stack), low light (15, 16), no target objects (17 landscape, 18 empty café),
single object on white (19 mouse), book + glass mug (20).

Missing from the set (not collected): real phone photos with natural EXIF
rotation, motion blur, heavy clutter like a full bag/drawer, a target object
held in a hand, very small target (< 2 % of the frame) on a desk, our own photos.

## Per-image result (target classes: cell phone, cup, laptop, book, mouse, bottle)

✓ = found, ✗ = missed, FP = box on a different object.

| Image | Visible targets | YOLOv8n | YOLOv8s |
| --- | --- | --- | --- |
| 01 desk | laptop, phone, mouse | 3/3 ✓; phone box also labelled **book 0.51** (same box, two classes) | 3/3 ✓ |
| 02 desk setup | laptop, mouse, glass (cup) | 3/3 ✓ | 3/3 ✓ |
| 03 gadgets top view | phone, laptop, mouse | 0/3; FP cell phone on a mixer controller | 3/3 ✓ (phone 0.78, laptop 0.67, mouse 0.51) |
| 04 half-closed laptop | laptop, mouse | 2/2 (laptop only 0.29) | 2/2 ✓ |
| 05 desk after work | laptop, mouse | 1/2 (laptop → keyboard); FP cup on chair | 2/2 ✓ |
| 06 mug | cup | ✓ 0.93 | ✓ 0.98 |
| 07 mug top view | cup | ✓ 0.81 | ✓ 0.93 |
| 08 silver coffee set | creamer (cup) | ✗ | ✓ 0.60 |
| 09 iPhone desk | phone, laptop, notebook (book) | 2/3: phone → **book 0.46**; pen → knife | 3/3 ✓ (phone 0.89); pen → knife 0.27 |
| 10 two phones | 2 phones | 2/2 ✓ (separate boxes); lantern → bottle | 2/2 ✓; lantern → bottle |
| 11 two metal bottles | 2 bottles | 1/2; steel bottle → vase, extra vase box on blue bottle | 2/2 ✓; extra vase box on steel bottle |
| 12 bottles in freezer | 5 bottles (lying, frosted) | 0/5 → "teddy bear" ×2 | 0/5 → "teddy bear" ×4 |
| 13 bookshop | many small books in window | nothing | nothing; FP person at frame edge |
| 14 book stack | ~5 books | 0 | 3 boxes, not one per book |
| 15 laptop at night | laptop | ✓ 0.80 | ✓ 0.94 |
| 16 dark room | laptop in front of person; second Mac only as glowing logo | 0/2; logo → kite | 1/2 (laptop 0.38); logo → bird; FP cell phone ×2 on hand/earring |
| 17 mountain lake | none | no boxes ✓ | no boxes ✓ |
| 18 empty café | none (chairs/table only) | no target-class box ✓ | no target-class box ✓ |
| 19 wireless mouse on white | mouse | ✗ → frisbee 0.27 | ✓ 0.37 |
| 20 book + glass mug | book, cup | 1/2 (cup ✓, book ✗) | 1/2 (cup ✓, book ✗) |

Rough tally over the countable target instances (39; image 13 not counted, the
dark bottle on the left of 10 excluded as ambiguous):

| Class | Instances | YOLOv8n found | YOLOv8s found |
| --- | --- | --- | --- |
| laptop | 9 | 5 | 8 |
| cell phone | 5 | 3 | 5 |
| mouse | 6 | 4 | 6 |
| cup | 5 | 4 | 5 |
| bottle | 7 | 1 | 2 |
| book | 7 | 1 | ~3 |
| **total** | **39** | **18** | **~29** |

Target-class false positives: YOLOv8n ~6 (book on phone ×2, cell phone on
controller, cup on chair, cup on dark bottle, bottle on lantern); YOLOv8s ~3
(bottle on lantern, cell phone ×2 in the dark image). Both: no target-class box on
the two negative images.

These numbers describe this set only and can shift a lot with other photos.

## Several items of the same class

- Two phones (10): both models give two separate boxes.
- Two bottles (11): YOLOv8s separates them; YOLOv8n finds one.
- Five lying bottles (12): both fail — wrong class, merged boxes.
- Book stack (14): YOLOv8s gives 3 overlapping boxes, not per book.
- Class-wise NMS lets one object get two labels (01 n: phone = book + cell phone;
  11: bottle + vase). A "find X" feature would show the right box, but a
  "what is here" list would double-count.

## Speed and memory (CPU unless noted)

| Metric | YOLOv8n | YOLOv8s |
| --- | --- | --- |
| `import ultralytics` | 0.60 s | 0.60 s |
| Weight load | 0.012 s | 0.017 s |
| First inference (warm disk) | 497–499 ms (3 runs) | 530–531 ms (2 runs) |
| First inference, very first run after install | 2690 ms (1 run, disk/cache cold) | — |
| Warm inference median (min–max), 20 images | 32.7–33.3 ms (29–37) | 62.0–62.8 ms (55–68) |
| `main()` elapsed¹, 21 images incl. drawing + JPEG save | 2.16–2.18 s | 2.83 s |
| RSS after import + model load | ~247 MiB | ~282 MiB |
| Peak RSS | ~553 MiB | ~698 MiB |
| MPS warm median / peak RSS | 16.9 ms / 818 MiB | 24.9 ms / 896 MiB |

Warm inference time is per call (`model.predict`) on a 1920 px image, including
Ultralytics pre/post-processing; it excludes file decode, EXIF transpose,
drawing and saving.

¹ Measured inside `main()` from argument parsing until just before `run.json`
is written; Python start-up, module imports before `main()` and process exit
are not included, so this is not whole-process time. The saved runs used the
earlier field names `process_wall_s` and `rss_mb` (values are MiB: bytes / 2²⁰);
the code now writes `main_elapsed_s` and `rss_mib`. Benchmarks were not re-run
for this rename.

MPS gave the same classes as CPU for YOLOv8n but used more
RAM. Server numbers are not measured.

## EXIF orientation

- Unit tests (`python -m unittest discover -s tests`): 3/3 pass — orientation 6
  gives an upright 100×200 image, pixel content moves to the expected corner.
- End-to-end: `09_iphone_desk_exif6.jpg` stores the pixels rotated with
  Orientation=6. Output size is 1920×1281 like the original, and all 4 boxes match
  the original's within 0.2 px (JPEG re-encode noise).
- Boxes are in the upright image's pixel frame; the annotated JPEG is drawn on
  that same image (`result.orig_shape` is asserted equal to the image size).

## Examples (CC0 sources, n left / s right)

- `docs/examples/03_gadgets_desk_n_vs_s.jpg` — n misses phone/laptop/mouse, s finds all three.
- `docs/examples/09_iphone_desk_n_vs_s.jpg` — n calls the phone "book", s gets it.
- `docs/examples/11_metal_bottles_n_vs_s.jpg` — two bottles, n vs s.
- `docs/examples/12_fridge_bottles_n_vs_s.jpg` — both fail on lying bottles.

## Conclusion

- YOLOv8n is fast enough (≈33 ms CPU) but on this set misses about half of the
  target objects, including easy ones (single mouse on white, phone on a desk).
- YOLOv8s found ~29/39 with fewer false positives at ≈62 ms CPU and ~700 MiB peak
  RSS — still fine for an upload-and-highlight flow.
- In this configuration (YOLOv8n and YOLOv8s, `conf=0.25`, these 20 images, one
  reviewer) both missed the lying bottles and most books (stacked / small). Whether
  that comes from the COCO-pretrained models in general, from this threshold, or
  from this image set was not tested: no threshold sweep or other image set was run.
- Recommendation for the Find & Highlight MVP: **YOLOv8s on CPU**, filter to the
  requested COCO class, `agnostic_nms` or per-box best-class to avoid double
  labels, and say "not found" honestly below a threshold. Keep the supported
  object list to COCO classes and show what the model can find.
