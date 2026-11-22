from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter

import httpx

from app.core import GROQ_API_KEY, GROQ_INVENTORY_CONTEXT, GROQ_MODEL, LLM_PROVIDER

COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"
last_check: dict | None = None

MESSAGES = {
    "missing_key": "Add GROQ_API_KEY to the server's .env and restart Smart Stock.",
    "configured": "Run the connection test to verify that Groq can answer.",
    "online": "Groq returned a completion.",
    "invalid_key": "Groq rejected the API key or its permissions.",
    "model_unavailable": "Groq rejected the model or completion settings. Check GROQ_MODEL.",
    "rate_limited": "Groq limited the request. Check the account limits and retry later.",
    "unreachable": "The server could not reach Groq in time.",
    "provider_error": "Groq did not return a usable answer.",
}


def groq_readiness() -> dict:
    initial = "configured" if GROQ_API_KEY else "missing_key"
    check = last_check or {"status": initial, "checked_at": None}
    status = check["status"]
    return {
        **check,
        "message": MESSAGES[status],
        "model": GROQ_MODEL,
        "can_test": bool(GROQ_API_KEY),
        "assistant_enabled": LLM_PROVIDER == "groq" and GROQ_INVENTORY_CONTEXT and bool(GROQ_API_KEY),
    }


async def complete_with_groq(messages: list[dict[str, str]]) -> str | None:
    global last_check
    if not GROQ_API_KEY:
        return None
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_completion_tokens": 550,
    }
    if GROQ_MODEL in {"openai/gpt-oss-20b", "openai/gpt-oss-120b"}:
        payload["reasoning_effort"] = "low"
    status = "online"
    answer = None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                COMPLETIONS_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                json=payload,
            )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        if isinstance(content, str) and content.strip():
            answer = content.strip()
        else:
            status = "provider_error"
    except httpx.HTTPStatusError as error:
        status = {
            400: "model_unavailable", 401: "invalid_key", 403: "invalid_key",
            404: "model_unavailable", 429: "rate_limited",
        }.get(error.response.status_code, "provider_error")
    except httpx.RequestError:
        status = "unreachable"
    except (ValueError, KeyError, IndexError, TypeError):
        status = "provider_error"
    last_check = {"status": status, "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return answer


async def probe_groq() -> dict:
    started = perf_counter()
    answer = await complete_with_groq([
        {"role": "user", "content": "This is a connectivity test. Reply with the word Ready."},
    ])
    return {
        **groq_readiness(),
        "latency_ms": round((perf_counter() - started) * 1000),
        "probe_reply": "Ready" if answer and answer.strip().strip(".!").casefold() == "ready" else None,
    }
