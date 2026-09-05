# Supplier price catalog

`catalog-data.json` is a reproducible source snapshot from the user-supplied
`Repairebel_Price_Floor_Database_Updated (1).xlsx`. The workbook is read without
editing or executing its contents. Its SHA-256 is recorded in the JSON.

Regenerate from the test-server directory with Python 3.10+ and `openpyxl`:

```sh
python3 -m pip install openpyxl
python3 scripts/extract-pricing-catalog.py '/path/to/Repairebel_Price_Floor_Database_Updated (1).xlsx'
python3 scripts/test-pricing-catalog.py
```

No database or network connection is used by either script. The extractor reads
all four worksheets, including the 60 calculator formulas and the workbook notes.
The JSON includes all 8,513 original rows, supplier names, representative products,
source URLs, observed price ranges, listing counts, original model/repair labels,
and every normalization/exclusion decision. Do not send raw supplier provenance
or the entire source dataset to mobile clients.

## Calculation

The workbook specifies parts cost as a **median of captured supplier listings**,
a 2.2 parts markup on every row, and labor of $15 Simple, $20 Medium, $30 Complex,
or $45 Advanced. Its calculator uses `ROUND(parts * markup + labor, 0)`;
`sourceSuggestedPrice` reproduces that positive-value half-up whole-dollar
calculation. Currency is USD to match the application; the workbook itself does
not state a currency code.

When normalized rows collide, the pricing service uses the median of their
eligible row medians. The individual supplier listings are unavailable, so an
exact pooled supplier median cannot be reconstructed; listing counts must not be
treated as weights for a supposed pooled median. Low/high prices remain observed
ranges and are not substituted for the parts median.

When a merged model/repair group contains different source labor tiers (for
example a corrected camera-glass row originally labeled a Complex camera module),
the service conservatively uses the **highest recorded labor fee** and requires
the source markup to agree. Source tiers and each row's original formula result
remain intact for audit; the merged suggested price can therefore differ from
the individual `sourceSuggestedPrice` values.

The source includes different quality grades, colors, and multipacks. The
consolidated source does not contain every individual product price or pack size;
per-unit prices cannot safely be inferred from the representative listing alone.
The prices therefore retain the supplied workbook medians. These are captured
supplier snapshots, not verified current supplier offers or market retail prices.

## Model and issue normalization

Identified SKU/product prefixes, shipping instructions, quality grades, product
colors, and assembly attributes are removed from model display names. Device
years, model codes, watch sizes, regional versions, and connectivity remain.
Original strings are always retained. Model UUIDv5 is deterministic from the
category plus the normalized, casefolded model name.

Slash-delimited compatibility strings remain intact unless the entire string
can be parsed as an explicit iPhone model list, such as `iPhone 12 / 12 Pro`.
Those rows have `compatibleModels: [{model, modelId}, ...]`. Publish their explicit
targets instead of the combined label, while retaining the source row as supplied.
Do not generically split slashes: they also occur inside hardware codes,
watch sizes, regions, years, and incomplete supplier compatibility descriptions.
Other ambiguous compatibility sets remain selectable under their original
combined label; no compatibility with a particular individual model is invented.

Source `Camera Module` is refined into front, rear, rear macro, rear telephoto,
and rear ultra-wide camera jobs where the representative product states which
camera. Foldable displays are separated into inner/outer screen jobs. Explicit
camera glass/lens products mislabeled as modules are corrected to
`Camera Lens/Glass`. `originalRepairType` retains the source classification.

## Quality audit

The original workbook has 6,937 distinct category/model labels. Normalization
produces 3,291 labels. Of 8,513 retained source records, **7,918 are eligible** and
**595 require review and cannot set prices**. After expanding 251 eligible iPhone
compatibility rows there are **3,108 published models and 5,036 model/repair
groups**. The exact generated counts are also under `audit` in the JSON.

Excluded records include tools, battery foams and connectors, speaker meshes,
camera bezel rings without glass, soldered camera flex subcomponents, and models
that are visibly truncated or identify no specific device. Exclusion is based on
the evidence available in the representative product; the original supplier
listings behind each consolidated row are unavailable for a complete manual audit.
Valid charging port boards and normal power/volume button flex assemblies remain.

All 3,147 source screen rows were inspected by full-column checks: no explicit
front-glass-only, backlight, polarizer, or touch-board products were present.
117 rows explicitly describe LCD/OLED assemblies with digitizers and 18 use the
term `LCD Digitizer`; these contain displays and remain eligible. Future imports
have a guard against standalone digitizers and other screen subcomponents being
priced as complete displays.

All rows have complete required fields, positive prices, medians within their
observed ranges, valid source IDs 1–8513, and known labor tiers. Original confidence
labels are 5,624 Low, 1,470 Medium, and 1,419 High. Confidence and provenance must
remain available for later price-policy review. This extraction improves obvious
classification errors; it does not turn low-confidence supplier evidence into a
guaranteed repair quotation.

The regression suite checks precise model cleanup, hardware/version preservation,
safe iPhone compatibility expansion, accessory exclusion, valid assembly
retention, screen subcomponent protection, all row invariants, and agreement with
the workbook rounding formula. Re-extraction is deterministic (no timestamps or
random IDs), and the source workbook is unchanged.
