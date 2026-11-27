# Telegram

### Open the web call from an existing bot chat

A normal Telegram bot can send a button that opens your HTTPS call page. The user starts the bot in a private chat. The operator then sets `TELEGRAM_BOT_TOKEN` privately and runs the following command with that user's numeric chat ID and the actual URL:

```sh
python channels/telegram/send_link.py --chat-id <private-chat-id> --call-url https://your-host.example/anruf/
```

The command sends one message. The user may pin it for easy access. The bot keeps its existing webhook, commands and updates. A private deployment still needs its usual network connection and web login on the caller's device. If Telegram opens the URL in an embedded browser and microphone access is unavailable, choose **Open in browser** or open the same URL in Safari or Chrome. [Telegram URL buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton)

### Receive a native one-to-one voice call

This optional adapter answers Telegram voice calls using a **dedicated Telegram user account** operated with its owner's consent. The official one-to-one calling methods require a user session. A Bot API token works only for the web button above. Both the receiver account and the calling user's account must permit calls from each other in their Telegram privacy settings. [Telegram calling API](https://core.telegram.org/api/calls) · [User-only call method](https://core.telegram.org/method/phone.acceptCall)

1. Obtain your own application ID and API hash at [my.telegram.org](https://my.telegram.org/apps). In the project root copy `channels/telegram/telegram.env.example` to `.env.telegram`. Set those two credentials, `TELEGRAM_ALLOWED_CALLERS` and `BRIDGE_CHANNEL_SECRET`. Use the same strong channel secret in the bridge's root `.env`. Each allowlisted caller can interact with the configured assistant and its connected apps. Prefer just the owner's numeric user ID.
2. From the project root, build the adapter and sign in to the **receiving** account interactively. Enter the phone number, Telegram login code and two-step verification password (if enabled) in this local terminal. The service keeps the Telethon session in its private named volume. Access to that volume grants access to the Telegram account.

```sh
docker compose -f compose.yaml -f channels/telegram/compose.yaml --profile telegram build telegram
docker compose -f compose.yaml -f channels/telegram/compose.yaml --profile telegram run --rm --no-deps telegram login
docker compose -f compose.yaml -f channels/telegram/compose.yaml --profile telegram up -d --build
```

3. From an allowlisted account, call the dedicated receiving account with Telegram's **voice call** button. After the greeting, speak and pause. The adapter sends only each completed utterance to the bridge and plays the answer in the same call. It accepts one call at a time, drops microphone input during playback, and ends the call after asking you to open the main chat for an approval. No microphone audio is used to approve actions.
4. To stop answering, run `docker compose -f compose.yaml -f channels/telegram/compose.yaml --profile telegram stop telegram`. Revoke the receiver session through Telegram's **Settings → Devices** if retiring it.

The container uses outbound Telegram MTProto signalling and WebRTC media, with no published host port. Networks that block UDP or Telegram relay traffic can prevent media negotiation. The bridge shared secret authorizes the adapter; callers must pass the separate server-side Telegram user-ID allowlist. The adapter never initiates a call, consumes bot updates or sends chat messages.

The implementation uses the incoming P2P call handler, external PCM record stream and timed audio-frame sender from the pinned PyTgCalls and NTgCalls SDKs. Local checks exercise the media conversion, conversation turn and caller checks. A real inter-account call requires both account holders and an authorized receiver session. [SDK incoming call example](https://github.com/pytgcalls/pytgcalls/blob/master/example/p2p_example/example_p2p.py) · [External media example](https://github.com/pytgcalls/pytgcalls/blob/master/example/bridged_calls/example_bridged.py)

Run the offline checks from the `channels` directory.

```sh
docker build -f telegram/Dockerfile -t agent-call-telegram:local .
docker run --rm --read-only --cap-drop ALL --entrypoint python \
  --mount "type=bind,src=$PWD/telegram/test_adapter.py,dst=/app/test_adapter.py,readonly" \
  agent-call-telegram:local -m unittest -v test_adapter
```
