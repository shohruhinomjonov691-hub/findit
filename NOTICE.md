# Notices and attribution

FindIt is licensed under the GNU Affero General Public License v3.0 ([LICENSE](LICENSE)).

## Why AGPL-3.0

FindIt imports and runs [Ultralytics](https://github.com/ultralytics/ultralytics)
(AGPL-3.0) and uses Ultralytics YOLOv8 weights, which Ultralytics distributes under
AGPL-3.0 as well (an Enterprise License is the alternative). A permissive license
for FindIt would not remove those obligations, so the project uses AGPL-3.0:

- the complete source of FindIt stays public;
- if FindIt is ever offered as a network service, users of that service must be
  able to get the corresponding source (AGPL §13) — e.g. a visible "Source" link
  to the public repo at the deployed commit;
- modifications to Ultralytics code, if any, are also published.

## Third-party components

| Component | Version | License | Use |
| --- | --- | --- | --- |
| ultralytics | 8.4.190 | AGPL-3.0 | detection runtime |
| ultralytics-platform | 0.1.99 | AGPL-3.0-only | pulled in by ultralytics, not used directly |
| YOLOv8n / YOLOv8s weights | assets v8.4.0 | AGPL-3.0 (Ultralytics) | pretrained COCO detection, see [models/MODELS.md](models/MODELS.md) |
| torch | 2.14.1 | BSD-style (Apache-2.0, BSD, MIT parts) | inference backend |
| torchvision | 0.29.1 | BSD-3-Clause | NMS / ops |
| Pillow | 13.0.0 | MIT-CMU (HPND) | image I/O, EXIF, drawing |
| opencv-python | 5.0.0.93 | Apache-2.0 | used inside ultralytics |
| numpy | 2.5.4 | BSD-3-Clause | |
| psutil | 7.2.2 | BSD-3-Clause | RSS measurement |
| requests | 2.34.2 | Apache-2.0 | test-set download script |
| certifi | 2026.10.23 | MPL-2.0 | CA bundle for the download script |

Full pinned list: [requirements.lock.txt](requirements.lock.txt). Model weights and
dependencies are not redistributed in this repository.

The COCO class names come with the model; the COCO dataset itself is not used or
distributed here.

## Test images

The feasibility test set is **not committed**. `scripts/fetch_testset.py` downloads
it from Wikimedia Commons; [data/testset_manifest.json](data/testset_manifest.json)
lists every file's source page, author, license and SHA-256. Licenses: CC0, CC BY
2.0/4.0, CC BY-SA 2.0/3.0/4.0.

Committed derivatives (`docs/examples/`, annotated with detection boxes) are made
only from CC0 images:

| Example | Source | Author | License |
| --- | --- | --- | --- |
| `03_gadgets_desk_n_vs_s.jpg` | https://commons.wikimedia.org/wiki/File:Gadgets_on_a_desk_(Unsplash).jpg | Niklas Veenhuis | CC0 |
| `09_iphone_desk_n_vs_s.jpg` | https://commons.wikimedia.org/wiki/File:Apple-iphone-smartphone-desk_(24243796611).jpg | www.Pixel.la Free Stock Photos | CC0 |
| `11_metal_bottles_n_vs_s.jpg` | https://commons.wikimedia.org/wiki/File:Metal_Water_Bottles.jpeg | Amraepowell | CC0 |
| `12_fridge_bottles_n_vs_s.jpg` | https://commons.wikimedia.org/wiki/File:Bottles_of_water_and_a_tray_of_ice_cubes_inside_a_fridge_freezer.jpg | Philsacor | CC0 |

If a CC BY or CC BY-SA image is ever shown publicly (README, demo), it needs:

- author, license name with link, and source link;
- a note that it was modified and how (e.g. "detection boxes and labels drawn,
  resized to 800 px height, cropped"), keeping any earlier modification notice;
- for CC BY-SA, the annotated derivative itself shared under the same CC BY-SA
  version (or a compatible later one).

See https://creativecommons.org/licenses/by-sa/4.0/ (section 3).
