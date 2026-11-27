"""Send the HTTPS call entry to one private chat of an existing Telegram bot."""

import argparse
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def call_url(value):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path.rstrip("/") != "/anruf"):
        raise ValueError("Use the HTTPS /anruf/ URL without credentials or query parameters.")
    return value.rstrip("/") + "/"


def bot_api(token, method, body):
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        if not result.get("ok"):
            raise RuntimeError("Telegram did not accept the request.")
        return result["result"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram returned HTTP {error.code}.") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("The Telegram Bot API could not be reached.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chat-id", type=int, required=True)
    parser.add_argument("--call-url", required=True)
    args = parser.parse_args()
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token or args.chat_id <= 0:
        parser.error("Set TELEGRAM_BOT_TOKEN and provide a positive private chat ID.")
    try:
        url = call_url(args.call_url)
        target = bot_api(token, "getChat", {"chat_id": args.chat_id})
        if target.get("type") != "private" or target.get("id") != args.chat_id:
            raise ValueError("Choose a private chat that has already started your bot.")
        bot_api(token, "sendMessage", {
            "chat_id": args.chat_id,
            "text": "Öffne den Anruf im Browser und tippe auf Start. Falls Telegram den "
                    "Mikrofonzugriff nicht erlaubt, öffne den Link in Safari oder Chrome.",
            "reply_markup": {"inline_keyboard": [[{"text": "Anruf öffnen", "url": url}]]},
            "link_preview_options": {"is_disabled": True},
        })
    except (ValueError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")
    print("Call button sent.")


if __name__ == "__main__":
    main()
