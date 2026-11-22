"""Optional Groq routing. The application runs tools and formats their results."""
import os

import httpx


TOOLS = {
    "expiry_records": "Look up expiring and expired stock for the current store or named SKU.",
    "daily_actions": "List the current store's reorder and inventory review actions.",
    "stock_by_sku": "Look up sellable stock for a product whose name or SKU appears in the original question.",
    "forecast_evidence": "Look up the forecast for an exact SKU in the original question.",
}


def enabled():
    return os.getenv("DEFENSE_GROQ_ROUTE") == "true" and bool(os.getenv("GROQ_API_KEY", "").strip())


def select_tool(question):
    if not enabled():
        return None
    key = os.getenv("GROQ_API_KEY", "").strip()
    try:
        with httpx.Client(timeout=5, trust_env=False) as client:
            response = client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": "Bearer " + key},
                json={
                    "model": os.getenv("GROQ_MODEL") or "openai/gpt-oss-20b",
                    "tool_choice": "auto",
                    "messages": [
                        {"role": "system", "content": "Select one relevant read-only tool for this Filipino, English or Taglish question. Use no tool for unsupported questions. You cannot answer with inventory numbers."},
                        {"role": "user", "content": question},
                    ],
                    "tools": [
                        {"type": "function", "function": {
                            "name": name, "description": description,
                            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
                        }}
                        for name, description in TOOLS.items()
                    ],
                },
            ).raise_for_status()
        calls = response.json()["choices"][0]["message"].get("tool_calls") or []
        name = calls[0]["function"]["name"] if len(calls) == 1 else None
        return name if name in TOOLS else None
    except (httpx.HTTPError, AttributeError, KeyError, IndexError, TypeError, ValueError):
        return None
