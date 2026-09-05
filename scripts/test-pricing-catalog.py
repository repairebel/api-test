#!/usr/bin/env python3
"""Meaningful normalization/eligibility regressions. Run with Python + openpyxl."""
import importlib.util
import json
from pathlib import Path
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("extractor", ROOT / "scripts/extract-pricing-catalog.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class PricingCatalogTests(unittest.TestCase):
    def test_remove_supplier_metadata_preserve_hardware(self):
        actual, _ = extractor.normalize_model("Apple Watch", "iWatch Series 1 (38 mm) (Ground Shipping Only)", "Battery")
        self.assertEqual(actual, "Apple Watch Series 1 (38mm)")
        actual, _ = extractor.normalize_model("Samsung", "Samsung Galaxy S23 Ultra (S918) with Frame - Phantom Black (Aftermarket Plus) (US Version)", "Screen")
        self.assertEqual(actual, "Samsung Galaxy S23 Ultra (S918) (US Version)")

    def test_color_lists_are_not_compatibility_models(self):
        actual, _ = extractor.normalize_model("iPhone", "iPhone 6S - Gold / Rose Gold", "Charging Port")
        self.assertEqual(actual, "iPhone 6S")
        self.assertEqual(extractor.compatible_iphone_models(actual), [])

    def test_explicit_shared_screen_model_ids_match_individual_model(self):
        actual = extractor.compatible_iphone_models("iPhone 12 / 12 Pro")
        self.assertEqual([a["model"] for a in actual], ["iPhone 12", "iPhone 12 Pro"])
        self.assertEqual(actual[0]["modelId"], str(uuid.uuid5(extractor.NAMESPACE, "iPhone|iphone 12")))
        self.assertEqual([a["model"] for a in extractor.compatible_iphone_models("iPhone 11 / SE (2020)")], ["iPhone 11", "iPhone SE (2020)"])

    def test_ambiguous_compatibility_is_not_expanded(self):
        for name in ["iPhone 12 (US / International)", "Apple Watch Series 1 / 2 (38mm / 42mm)", "iPhone 6 - XS Max", "iPhone 14 / 15 Series", "iPhone 13 / iPad Mini 6"]:
            self.assertEqual(extractor.compatible_iphone_models(name), [], name)

    def test_accessories_cannot_set_battery_camera_or_speaker_floor(self):
        for repair, product in [("Battery", "Battery Buffer Foam For OnePlus 6"), ("Battery", "Battery FPC Connector For iPhone 12"), ("Rear Camera", "Conductive Cloth For Motorola Moto G84"), ("Speaker", "Loudspeaker / Mic Mesh For iPhone 12"), ("Battery", "Battery Simulating Power Supply Cable For iPhone 6 - XS Max")]:
            self.assertTrue(extractor.exclusion_reasons("iPhone 12", "iPhone 12", repair, product), product)

    def test_real_charging_boards_and_button_flex_remain_eligible(self):
        for repair, product in [("Charging Port", "Charging Port Board With Sim Card Reader For Samsung Galaxy S23 Ultra"), ("Buttons/Flex", "Power / Volume Button Flex Cable For Google Pixel 7"), ("Battery", "Replacement Battery For iPhone 12 (Ground Shipping Only)"), ("Camera Module", "Front Camera With Flex Cable For iPhone 12")]:
            self.assertEqual(extractor.exclusion_reasons("iPhone 12", "iPhone 12", repair, product), [], product)

    def test_screen_subcomponents_cannot_set_complete_display_floor(self):
        for product in ["Front Glass Only For iPhone 12", "Backlight For iPhone 12", "Touch Board For iPhone 12", "Digitizer Touch Panel For iPad 2"]:
            self.assertTrue(extractor.exclusion_reasons("iPhone 12", "iPhone 12", "Screen", product), product)
        for product in ["LCD Assembly With Digitizer For iPhone 12", "LCD Digitizer For iPhone 6", "OLED Assembly With Frame For Samsung Galaxy S23"]:
            self.assertEqual(extractor.exclusion_reasons("iPhone 12", "iPhone 12", "Screen", product), [], product)

    def test_complete_checked_in_snapshot_integrity(self):
        data = json.loads((ROOT / "src/modules/pricing/catalog-data.json").read_text())
        rows = data["rows"]
        self.assertEqual(len(rows), 8513)
        self.assertEqual({r["sourceId"] for r in rows}, set(range(1, 8514)))
        self.assertEqual(data["audit"]["formulaCellsRead"], 60)
        self.assertEqual(len(data["audit"]["sheetsRead"]), 4)
        for row in rows:
            uuid.UUID(row["modelId"])
            self.assertLessEqual(row["lowPrice"], row["partsCost"])
            self.assertGreaterEqual(row["highPrice"], row["partsCost"])
            self.assertEqual(row["catalogEligible"], not row["exclusionReasons"])
            self.assertEqual(row["sourceSuggestedPrice"], int((extractor.Decimal(str(row["partsCost"])) * extractor.Decimal(str(row["markupMultiplier"])) + extractor.Decimal(str(row["laborFee"]))).quantize(extractor.Decimal("1"), rounding=extractor.ROUND_HALF_UP)))
        shared_screen = [r for r in rows if r["catalogEligible"] and r["repairType"] == "Screen" and any(m["model"] == "iPhone 12" for m in r["compatibleModels"])]
        self.assertTrue(shared_screen, "iPhone 12 must receive shared 12/12 Pro screen pricing")
        self.assertTrue(all(r["originalRepairType"] == "Camera Module" for r in rows if r["repairType"] == "Rear Camera"))


if __name__ == "__main__":
    unittest.main()
