from pathlib import Path
from datetime import date
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.inventory_backtest import compare, generate, TEST_DAYS
from app.services.defense_trial import answer_question, daily_actions
from app.services.defense_groq import select_tool


class DefenseTrialTests(unittest.TestCase):
    def test_backtest_replay_promo_and_costs(self):
        standard = compare(30)
        self.assertEqual(standard, compare(30))
        self.assertEqual(standard["test_days"], TEST_DAYS)
        self.assertGreater(standard["training_censored_days"], 0)
        self.assertGreater(standard["training_zero_sales_days"], 0)
        self.assertEqual(generate(8, 0, 0)[0], generate(8, 0, 100)[0])
        self.assertNotEqual(compare(0)["totals"], compare(90)["totals"])
        result = compare(0)["totals"]
        self.assertEqual(result["Adaptive reorder"], result["Adaptive without promo context"])
        for policy in standard["totals"].values():
            self.assertAlmostEqual(policy["total_cost"], policy["waste_cost"] + policy["holding_cost"] + policy["missed_margin"])

    def test_structured_answer_and_no_record(self):
        row = dict(product_id=1, product_name="Coffee", product_barcode="SHOW-001", product_quantity=0,
                   sellable=0, batch_count=0, batch_units=0, expired=0, expiring=0, due=None,
                   season_start_month=None, season_end_month=None, reorder_level=8)
        today = date(2026, 11, 22)
        answer = answer_question("Ilan ang stock ng SHOW-001?", [row], today)
        self.assertEqual(answer["tool"], "stock_by_sku")
        self.assertIn("0 sellable units", answer["answer"])
        self.assertIn("[1]", answer["answer"])
        self.assertIn("stock_batch", answer["sources"][0]["label"])
        self.assertEqual(answer_question("Kailan mag-expire ang SHOW-404?", [row], today)["sources"], [])
        self.assertEqual(daily_actions([row], today)[0]["action"], "Review stockout")
        near_expiry = {**row, "expiring": 2}
        expiry_answer = answer_question("Aling produkto ang malapit mag-expire?", [near_expiry], today)
        self.assertEqual(expiry_answer["tool"], "expiry_records")
        self.assertIn("2 due within 7 days", expiry_answer["answer"])
        self.assertEqual(len(expiry_answer["sources"]), 1)

    def test_groq_routes_only_allowlisted_tools(self):
        with patch.dict("os.environ", {"DEFENSE_GROQ_ROUTE": "false", "GROQ_API_KEY": "mock"}):
            with patch("app.services.defense_groq.httpx.Client") as client:
                self.assertIsNone(select_tool("Ano ang low stock?"))
                client.assert_not_called()
        with patch.dict("os.environ", {"DEFENSE_GROQ_ROUTE": "true", "GROQ_API_KEY": "mock"}):
            with patch("app.services.defense_groq.httpx.Client") as client:
                response = client.return_value.__enter__.return_value.post.return_value.raise_for_status.return_value
                response.json.return_value = {"choices": [{"message": {"tool_calls": [{"function": {"name": "expiry_records"}}]}}]}
                self.assertEqual(select_tool("Aling produkto ang mapapanis?"), "expiry_records")
                response.json.return_value = {"choices": [{"message": {"tool_calls": [{"function": {"name": "execute_sql"}}]}}]}
                self.assertIsNone(select_tool("Any question"))


if __name__ == "__main__":
    unittest.main()
