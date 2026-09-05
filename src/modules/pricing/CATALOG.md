# Supplier price catalog

`catalog-data.json` is read from `Repairebel_Price_Floor_Database_Fixed.xlsx`.
The corrected workbook separates brand, device family, individual model, hardware
or region variant, parts category and repair variant. Example: Apple / iPhone /
17 Pro Max / Screen. The database also fills `device_models.model_number`.

## Price policy

Suggested minimum = **2 × parts cost + $30 fixed labor**, rounded upward to cents.
Customers cannot offer less. The importer rejects any other multiplier or labor
fee. The workbook and server use scaled decimal arithmetic to agree to the cent.

Each device/repair price uses the unweighted median of eligible source-row medians.
These are captured supplier costs, including different quality grades, rather
than current retail quotations. Raw underlying supplier listings are unavailable,
so listing counts are not weights for a pooled median. USD is the application
currency. No currency conversion has been applied.

## Workbook contents

- Parts Cost Database: 5,543 prices covering 2,639 device and hardware variants,
  calculated from 7,653 eligible supplier rows.
- Source Listings: all 8,513 original rows, original labels, costs, URLs,
  representative products, price ranges and listing counts.
- Needs Review: 860 incomplete, conflicting or accessory listings with reasons.
- Labor Fee Tiers: 2x multiplier and $30 labor for every repair.
- Price Floor Calculator: editable catalog selection and customer offer check.

Source Row IDs link corrected prices to original supplier rows. These IDs and
the corrected workbook SHA-256 are preserved in imported pricing snapshots.
Previous catalog versions and historical request prices remain in the database.

## Normalization

Explicit compatibility lists are split into individual devices across brands.
Slashes inside parentheses are hardware/region metadata. Explicit size or year
alternatives can be expanded without guessing model ranges. Supplier quality,
color, shipping notes and part IDs do not become device names. Case-only spellings
are consolidated before calculating medians. Unknown compatibility and conflicting
model/product labels stay in Needs Review.

Parts categories are Screen, Battery, Charging Port, Camera, Camera Lens, Back
Glass, Speaker, Microphone, SIM Tray, Housing, Buttons & Flex, Motherboard & IC,
and Vibration Motor. Inner/outer screens and specific camera positions remain
separate repair choices. Known tools, adhesives, protectors and small subcomponents
cannot set a complete-assembly price.

## Import and verification

From the test-server directory, read the corrected workbook with Python/openpyxl:

```sh
python3 scripts/normalize-pricing-workbook.py --import-workbook /path/to/Repairebel_Price_Floor_Database_Fixed.xlsx src/modules/pricing/catalog-data.json
python3 scripts/test-pricing-catalog.py
npm run db:pricing:check
npm run db:pricing:import
```

Without `--import-workbook`, the normalizer prepares original workbook tables for
the artifact-tool Excel builder. The original extractor reads all four sheets.
Do not deploy its legacy pricing output. The corrected Excel import validates
every computed minimum against independent decimal math.

API tests verify exact-floor acceptance, below-floor rejection, stale quotes and
customer/store price consistency. `npm run test:deploy` checks repeatable compiled
Railway setup on a fresh local database without SQL dumps or source files.
See `RAILWAY.md`. Remote imports are restricted to the independently verified test
database. Main-server migration requires a separate request.
