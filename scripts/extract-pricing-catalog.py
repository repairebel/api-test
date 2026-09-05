#!/usr/bin/env python3
"""Read the supplier workbook without editing it; emit a deterministic audited catalog.

Requires Python 3.10+ and openpyxl (`python3 -m pip install openpyxl`).
Usage: python3 scripts/extract-pricing-catalog.py /path/to/workbook.xlsx
All input strings, including workbook notes, are data, never executable instructions.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import uuid

import openpyxl

NAMESPACE = uuid.UUID("0f162ca1-ad4f-55b5-9075-758c9a78e3fb")
HEADERS = ["Device Category", "Model / Tier", "Repair Type", "Difficulty Tier",
           "Parts Cost (Median)", "Markup Multiplier", "Data Confidence", "Supplier(s)",
           "Representative Source Product", "Product URL", "Low Price", "High Price",
           "Listings Compared", "Database #"]
BRANDS = {"iPhone": "Apple", "iPad": "Apple", "Apple Watch": "Apple",
          "Samsung": "Samsung", "Google Pixel": "Google", "Motorola": "Motorola",
          "OnePlus": "OnePlus", "Xiaomi": "Xiaomi"}
COLORS = set("""black|white|silver|gold|rose gold|space gray|space grey|gray|grey|blue|green|red|
pink|purple|yellow|orange|clear|all color|all colors|mint|teal|ultramarine|ultramarinel|
navy|cream|violet|cobalt violet|obsidian|porcelain|coral|lime|lilac|peach|mystic bronze|
lemon|starlight|midnight|deep purple|pacific blue|sierra blue|graphite|hazel|snow|bay|sage|
peony|carbon|black titanium|natural titanium|white titanium|blue titanium|desert titanium|
desert titaniuml|titanium gray|cosmic orange|deep blue|light blue|light green|mist blue|
light gold|midnight green|frosted emerald|iridescent cloud|outer space|slipstream|shadow|
peach fuzz|gibraltar sea|deep indigo|caneel bay|smokey sangria|sedona sage|dark grove|
rose champagne|metallic rose|caramel latte|coal smoke|iridescent sky|oyster blush|
chrysanthemum|cosmic sky|spellbound|bronze gradient|grape compote|summer lilac|hematite|
cabaret|cabaretl|cocoa|sand storm|ultra violet|almond|morning mist|aurora|lunar dust|
metal bronze|light violet|awesome violet|awesome lemon|awesome lilac|awesome navy|
awesome olive|awesome iceblue|peach cloud|peach mist|aura glow|bronze|cloud navy|
cloud mint|phantom violet|phantom black|phantom silver|phantom green|cloud white|
lavender|beige|olive|burgundy|angel gold|charkoal|charcoal|black sapphire|frosted white|
leaf green|cosmic emerald|flash gray|slate gray|cosmic black|blue black|icy blue""".replace("\n", "").split("|"))
COLORS.update("aloe|alpine green|peach pink|cloud pink|phantom pink|pink gold|flamingo pink|light gray|aura red|aura blue|aura silver|aura white|lavender purple|midnight black|ocean blue|prism black|prism blue|prism green|prism white|crown silver|ceramic white|cloud blue|cosmic gray|cloud lavender|cloud orange|cloud red|phantom gray|phantom white|graphite gray|olive green|onyx black|amber yellow|jade green|marble gray|titanium black|titanium yellow|mint green|dark blue|silver shadow|white silver|sky blue|maple gold|lilac purple|silver white|navy blue|matte black|jet|jet black|clear glass".split("|"))
QUALITY = re.compile(r"^(?:refurb|used oem|oem pull|pull [abc]|blemish|test rating|premium|high premium|"
                     r"genuine oem|service pack|aftermarket|mq[0-9]|aq[0-9]|xo[0-9]|ampsentrix|"
                     r"no logo|ground shipping|soldering|spot welding|ic transferable|"
                     r"sleep/wake sensor|daughter board installed|warning:|real sapphire|"
                     r"assembled|on the flex|on motherboard|bottom battery|top battery|"
                     r"does not include|wrepair|mechanic|qianli|jcid|i2c|refox|aixun|"
                     r"sunshine|mega.idea|wl$|ay$|xzz$|amaoe|extended$)", re.I)
PART_ATTRIBUTES = re.compile(r"(?:\b\d+\s*(?:pack|pcs?|pieces?|pins?|mp|hz)\b|\bpack of \d+|"
                             r"\b(?:fpc|ic|connector|flex #|board #|micro usb|usb-c|type-c)\b|"
                             r"^(?:EB-|BLP|BLPA|BLPB|BM[0-9]|BN[0-9]|BP[0-9]|HQ-|SCUD-|WT-))", re.I)
TOOL = re.compile(r"\b(?:reballing|programming|programmer|calibrator|calibration|corrector|"
                  r"fixture|test cable|tester|testing cable|press pad|press mold|roller|"
                  r"laminating|battery press|battery blocker|protective cover|rework platform|"
                  r"power supply cable|simulating|test fixture)\b", re.I)
SMALL_COMPONENT = re.compile(r"\b(?:fpc connector|btb connector|foam|mesh|grille|gasket|"
                             r"cushion|cushioning|alignment sheet|graphite sheet|shield|"
                             r"battery filters|silicone sleeve|spacer|shim|tag.on|"
                             r"battery core|battery cover|battery health|mylar|conductive cloth|"
                             r"bezel ring only)\b", re.I)


def clean_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value)).replace("¬†", " ").replace("\u200b", "")
    text = text.replace("Wƒ±th", "With").replace("Premƒ±um", "Premium").replace("Refurbƒ±shed", "Refurbished")
    return re.sub(r"\s+", " ", text).strip()


def normalize_model(category: str, original: str, repair: str) -> tuple[str, list[str]]:
    value = clean_text(original)
    notes = []
    value = re.sub(r"^\[[^]]+\]\s*", "", value)
    # Find a device prefix only when preceding text is a supplier part description.
    match = re.search(r"(?:Apple\s+)?iPhone\b|iPad\b|(?:Google\s+)?Pixel(?:book)?\b|"
                      r"Samsung\b|Motorola\b|OnePlus\b|Xiaomi\b|iWatch\b|Watch\s+(?:Series|SE|Ultra)", value, re.I)
    if match and match.start() and not re.search(r"\b(?:MacBook|Oppo|Poco|Redmi|Droid|Moto)\b", value[:match.start()], re.I):
        value = value[match.start():]
        notes.append("Removed supplier product prefix")
    value = re.sub(r"\b(?:iWatch|Watch)(?=\s+(?:Series|SE|Ultra))", "Apple Watch", value, flags=re.I)
    value = re.sub(r"\bApple iPhone\b|\biphone\b", "iPhone", value, flags=re.I)
    value = re.sub(r"\bipad\b", "iPad", value, flags=re.I)
    value = re.sub(r"\bGalaxy\s+Galaxy\b", "Galaxy", value, flags=re.I)
    value = re.sub(r"\bGalaxy(?=[A-Z0-9])", "Galaxy ", value)
    value = re.sub(r"^Samsun\b", "Samsung", value)
    if category == "Samsung" and re.match(r"^Galaxy\b", value, re.I):
        value = "Samsung " + value
    value = re.sub(r"\boneplus\b", "OnePlus", value, flags=re.I)
    if category == "Google Pixel" and re.match(r"^Pixel\b", value, re.I):
        value = "Google " + value
    if category == "Motorola" and re.match(r"^(?:Moto |Droid )", value):
        value = "Motorola " + value
    if category == "Xiaomi" and re.match(r"^(?:Poco |Redmi )", value, re.I):
        value = "Xiaomi " + value
    # Remove only identified supplier/part attributes; preserve regional versions,
    # years, model codes, watch sizes, connectivity and ambiguous compatibility sets.
    def parenthetical(m: re.Match) -> str:
        content = clean_text(m.group(1))
        color_parts = re.split(r"\s*/\s*", content.lower())
        is_color = all(p in COLORS or p in {"aluminum", "stainless", "stainless steel", "ceramic", "titanium"} for p in color_parts)
        part_function = re.search(r"^(?:(?:with|without|no)\s+(?:finger\s*print|front camera|locking clamps)|does not support fingerprint)", content, re.I)
        if QUALITY.search(content) or PART_ATTRIBUTES.search(content) or is_color or part_function:
            notes.append("Removed part attribute: " + content)
            return " "
        content = re.sub(r"(?<=\d)\s*mm\b", "mm", content, flags=re.I)
        content = re.sub(r"\s*/\s*", " / ", content)
        content = re.sub(r"\b(?:wifi|wi-fi)\b", "WiFi", content, flags=re.I)
        content = re.sub(r"\bCelluar\b", "Cellular", content, flags=re.I)
        return "(" + content.strip() + ")"
    value = re.sub(r"\(([^()]*)\)", parenthetical, value)
    value = re.sub(r"\s+(?:LCD|OLED)\s+(?:Assembly|Digitizer)(?:\s+All Colors?)?", " ", value, flags=re.I)
    value = re.sub(r"\s+(?:with|without|w/)\s+(?:frame|steel plate|light sensor flex cable|fingerprint sensor|plate|locking clamps)(?:\s*-\s*(?:with|without)\s+fingerprint sensor)?", " ", value, flags=re.I)
    value = re.sub(r"\s*(?:-\s*)?\d+\s*Hz\b", " ", value, flags=re.I)
    value = re.sub(r"\s*/?\s*IC Transferable\b", " ", value, flags=re.I)
    # Color suffixes may precede a regional parenthesis that must survive cleanup.
    color_pattern = "(?:" + "|".join(re.escape(c) for c in sorted(COLORS, key=len, reverse=True)) + ")"
    value = re.sub(r"\s*-\s*" + color_pattern + r"(?:\s*/\s*" + color_pattern + r")+(?=\s*(?:\(|$))", " ", value, flags=re.I)
    for color in sorted(COLORS, key=len, reverse=True):
        value = re.sub(r"\s+(?:-\s*)?" + re.escape(color) + r"(?=\s*(?:\(|$))", " ", value, flags=re.I)
    value = re.sub(r"\s*-\s*(?=\()", " ", value)
    value = re.sub(r"\s*-\s*W\s*/\s*Out Frame\b", " ", value, flags=re.I)
    value = re.sub(r"\s*/\s*Refurbished$", " ", value, flags=re.I)
    value = re.sub(r"\s+All Colors?\s*$", " ", value, flags=re.I)
    value = re.sub(r"\s*/\s*", " / ", value)
    value = re.sub(r"\b5g\b", "5G", value, flags=re.I)
    value = re.sub(r"\b4g\b", "4G", value, flags=re.I)
    value = re.sub(r"\bIphone\b", "iPhone", value)
    value = re.sub(r"\bXSM\b", "XS Max", value)
    value = re.sub(r"\b(?:xs|xr)\b", lambda m: m[0].upper(), value, flags=re.I)
    value = re.sub(r"\b(?:mini|pro|plus|ultra|pad)\b", lambda m: m[0].title(), value, flags=re.I)
    value = re.sub(r"\s+", " ", value).strip(" -/")
    if value != original and not notes:
        notes.append("Normalized spelling, spacing or part suffix")
    return value, sorted(set(notes))


def exclusion_reasons(original: str, model: str, repair: str, product: str) -> list[str]:
    reasons = []
    if TOOL.search(product):
        reasons.append("Supplier listing describes a tool/accessory, not the named repair part")
    if repair != "Motherboard/IC" and SMALL_COMPONENT.search(product):
        reasons.append("Supplier listing describes a small component/accessory, not the named complete repair part")
    if repair in {"Camera Module", "Battery", "Taptic/Vibrator"} and re.search(r"\bIC\b|\bconnector\b", product, re.I):
        reasons.append("Supplier listing is an IC/connector rather than the named replacement assembly")
    if re.search(r"\bZIF Connector\b", product, re.I):
        reasons.append("Supplier listing describes a connector rather than a replacement flex assembly")
    if repair == "Camera Module" and re.search(r"\bCamera Flex Cable\b", product, re.I) and re.search(r"Soldering Required", product, re.I):
        reasons.append("Supplier listing describes a soldered camera flex subcomponent rather than a camera module")
    if repair == "Screen" and (re.search(r"\b(?:front glass only|glass only|lens only|backlight|polarizer|touch board)\b", product, re.I) or (re.search(r"\b(?:digitizer|touch panel)\b", product, re.I) and not re.search(r"\b(?:LCD|OLED|display)\b", product, re.I))):
        reasons.append("Supplier listing describes a screen subcomponent rather than a complete display")
    if model.count("(") != model.count(")") or len(original) >= 175:
        reasons.append("Source model appears truncated or has unmatched parentheses")
    if re.fullmatch(r"(?:Apple )?(?:iPhones?|iPads?|iPhone Back Glass)|Mobile Phone / iPad|iPhone \d+ Series", model, re.I):
        reasons.append("Source does not identify a specific compatible device model")
    if not model:
        reasons.append("No usable model identifier")
    return sorted(set(reasons))


def repair_variant(repair: str, product: str) -> str | None:
    if repair == "Screen":
        if re.search(r"\b(?:Inner|Main Screen|Built-In)\b", product, re.I): return "Inner"
        if re.search(r"\b(?:Outer|External|Cover Screen)\b", product, re.I): return "Outer"
    if repair == "Camera Module":
        if re.search(r"\bFront\b", product, re.I): return "Front"
        if re.search(r"\bMacro\b", product, re.I): return "Rear Macro"
        if re.search(r"\b(?:Ultra Wide|Ultrawide)\b", product, re.I): return "Rear Ultra Wide"
        if re.search(r"\bTelephoto\b", product, re.I): return "Rear Telephoto"
        if re.search(r"\b(?:Back|Rear)\b", product, re.I): return "Rear"
    return None


def compatible_iphone_models(model: str) -> list[dict]:
    """Expand only explicit, complete iPhone models; never split hardware/version slashes.

    Examples accepted: iPhone 12 / 12 Pro; iPhone 11 / SE (2020).
    Rejected: iPhone 14 Series; iPhone 12 (US / International); iPhone 6 - XS Max.
    """
    if not model.startswith("iPhone ") or " / " not in model:
        return []
    pattern = re.compile(r"^(?:iPhone\s+)?(?P<generation>(?:[4-9]|1\d)[SCE]?|X|XS|XR|Air|SE\s*\((?:2016|2020|2022)\))(?P<suffix>\s+(?:Pro Max|Pro|Plus|Mini))?$", re.I)
    parsed = []
    for part in model.split(" / "):
        match = pattern.fullmatch(part.strip())
        if not match: return []
        generation = match["generation"].strip()
        generation = re.sub(r"\s+", " ", generation)
        if generation.lower() in {"x", "xs", "xr"}: generation = generation.upper()
        elif generation.lower() == "air": generation = "Air"
        elif generation.lower().startswith("se"): generation = "SE" + generation[2:]
        elif generation[-1:].lower() in {"s", "c"}: generation = generation[:-1] + generation[-1].upper()
        suffix = (match["suffix"] or "").title()
        name = "iPhone " + generation + suffix
        parsed.append({"model": name, "modelId": str(uuid.uuid5(NAMESPACE, "iPhone|" + name.casefold()))})
    return list({entry["modelId"]: entry for entry in parsed}.values()) if len(parsed) > 1 else []


def device_type(category: str, model: str) -> str:
    if category == "Apple Watch" or re.search(r"\bWatch\b", model, re.I): return "Smartwatch"
    if category == "iPad" or re.search(r"\b(?:Tab|Tablet|Pad)\b", model, re.I): return "Tablet"
    if re.search(r"\b(?:Pixelbook|Book|MacBook)\b", model, re.I): return "Laptop"
    return "Smartphone"


def money(value) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def extract(path: Path) -> dict:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    # Read every cell of every sheet, including notes and calculator formulas.
    sheets = {sheet.title: list(sheet.values) for sheet in workbook}
    assert list(sheets["Parts Cost Database"][3]) == HEADERS, "Unexpected source columns"
    labor = {str(row[0]): money(row[1]) for row in sheets["Labor Fee Tiers"][4:8]}
    assert labor.keys() == {"Simple", "Medium", "Complex", "Advanced"}
    rows = []
    names = {}
    for excel_row, values in enumerate(sheets["Parts Cost Database"][4:], start=5):
        if not any(v is not None for v in values): continue
        assert len(values) == len(HEADERS) and all(v is not None for v in values), f"Incomplete row {excel_row}"
        category, original, repair, difficulty, parts, markup, confidence, suppliers, product, url, low, high, compared, source_id = values
        assert category in BRANDS and difficulty in labor, f"Unknown category/tier on {excel_row}"
        assert 0 < low <= parts <= high and markup > 0 and compared >= 1, f"Invalid pricing on {excel_row}"
        assert str(url).startswith("https://"), f"Invalid source URL on {excel_row}"
        model, notes = normalize_model(category, original, repair)
        model_key = f"{category}|{model.casefold()}"
        # Case variants share both the UUID and one deterministic display label.
        model = names.setdefault(model_key, model)
        reasons = exclusion_reasons(original, model, repair, product)
        variant = repair_variant(repair, product)
        effective_repair = f"{variant} Screen" if repair == "Screen" and variant else f"{variant} Camera" if repair == "Camera Module" and variant else repair
        if repair == "Camera Module" and re.search(r"\b(?:lens|tempered glass)\b", product, re.I):
            effective_repair, variant = "Camera Lens/Glass", None
            notes.append("Corrected camera glass/lens listing mislabeled as camera module")
        rows.append({
            "sourceId": int(source_id), "sourceSheetRow": excel_row, "category": category,
            "brand": BRANDS[category], "deviceType": device_type(category, model),
            "originalModel": original, "model": model, "modelId": str(uuid.uuid5(NAMESPACE, model_key)),
            "compatibleModels": compatible_iphone_models(model) if category == "iPhone" else [],
            "repairType": effective_repair, "originalRepairType": repair, "repairVariant": variant,
            "difficulty": difficulty, "partsCost": money(parts), "markupMultiplier": money(markup),
            "laborFee": labor[difficulty],
            "sourceSuggestedPrice": int((Decimal(str(money(parts))) * Decimal(str(markup)) + Decimal(str(labor[difficulty]))).quantize(Decimal("1"), rounding=ROUND_HALF_UP)),
            "confidence": confidence, "suppliers": [s.strip() for s in suppliers.split(",")],
            "sourceProduct": product, "sourceUrl": url, "lowPrice": money(low), "highPrice": money(high),
            "listingsCompared": int(compared), "normalizationNotes": notes,
            "catalogEligible": not reasons, "exclusionReasons": reasons,
        })
    assert len(rows) == 8513, "Unexpected row count: review workbook/version before importing"
    assert [r["sourceId"] for r in rows] == list(range(1, 8514)), "Source IDs are missing/duplicated"
    groups = defaultdict(list)
    expanded_groups = defaultdict(list)
    for row in rows:
        if row["catalogEligible"]:
            groups[(row["modelId"], row["repairType"])].append(row)
            for target in row["compatibleModels"] or [row]:
                expanded_groups[(target["modelId"], row["repairType"])].append(row)
    audit = {
        "sourceRows": len(rows), "eligibleRows": sum(r["catalogEligible"] for r in rows),
        "excludedRows": sum(not r["catalogEligible"] for r in rows),
        "originalModels": len({(r["category"], r["originalModel"]) for r in rows}),
        "normalizedModels": len({r["modelId"] for r in rows}),
        "eligibleModels": len({r["modelId"] for r in rows if r["catalogEligible"]}),
        "eligibleModelRepairGroups": len(groups),
        "eligibleRowsWithExplicitCompatibleModels": sum(bool(r["compatibleModels"]) for r in rows if r["catalogEligible"]),
        "publishedModelsAfterCompatibilityExpansion": len({key[0] for key in expanded_groups}),
        "publishedModelRepairGroupsAfterCompatibilityExpansion": len(expanded_groups),
        "groupsWithMultipleSourceRows": sum(len(v) > 1 for v in groups.values()),
        "categoryCounts": dict(sorted(Counter(r["category"] for r in rows).items())),
        "repairTypeCounts": dict(sorted(Counter(r["repairType"] for r in rows).items())),
        "confidenceCounts": dict(sorted(Counter(r["confidence"] for r in rows).items())),
        "exclusionReasonCounts": dict(sorted(Counter(reason for r in rows for reason in r["exclusionReasons"]).items())),
        "formulaCellsRead": sum(isinstance(cell, str) and cell.startswith("=") for values in sheets.values() for row in values for cell in row),
        "sheetsRead": list(sheets),
    }
    workbook.close()
    return {
        "version": 1, "sourceWorkbook": path.name,
        "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "currency": "USD", "currencyBasis": "Application currency; workbook does not explicitly label currency",
        "formula": "ROUND(partsCost * markupMultiplier + laborFee, 0)",
        "laborFees": labor,
        "notes": [str(cell) for row in sheets["Read Me"] for cell in row if cell is not None],
        "normalizationPolicy": "Strip identified supplier metadata; preserve device codes, sizes, regions and compatibility sets. Never expand ambiguous slash-delimited compatibility strings. UUIDv5 uses category plus casefolded normalized model. Excluded rows remain in this source snapshot for review.",
        "aggregationPolicy": "Median of eligible source-row medians per normalized model and repair; use the highest recorded source labor fee in a merged group and require matching markup. Keep low/high ranges and all source IDs. Listing counts are provenance, not median weights. Foldable screen/camera variants must be kept separate by the consuming pricing service.",
        "audit": audit, "rows": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "src/modules/pricing/catalog-data.json")
    args = parser.parse_args()
    catalog = extract(args.workbook)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # One source record per line keeps changes reviewable without a giant-line JSON file.
    metadata = json.dumps({k: v for k, v in catalog.items() if k != "rows"}, ensure_ascii=False, indent=2)
    serialized = metadata[:-2] + ',\n  "rows": [\n' + ',\n'.join('    ' + json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in catalog["rows"]) + '\n  ]\n}\n'
    args.output.write_text(serialized, encoding="utf-8")
    print(json.dumps(catalog["audit"], indent=2))


if __name__ == "__main__":
    main()
