# WhatsApp-Anrufe

Dieser Adapter beantwortet eingehende WhatsApp-Sprachanrufe von ausdrücklich freigegebenen Absendern. Er prüft Metas Webhook-Signatur, die Business-Telefonnummer und die Absenderkennung. Nach einer Sprechpause geht die Aufnahme über die interne Bridge an den ausgewählten Assistenten. Während der Antwort pausiert die Spracheingabe.

## Voraussetzungen

Meta verlangt für den Produktivbetrieb eine für die Cloud API registrierte Business-Telefonnummer mit aktivierter Calling-Funktion. Die App braucht `whatsapp_business_messaging`, muss mit dem WhatsApp-Business-Konto verknüpft sein und das Webhook-Feld `calls` abonnieren. Meta nennt für Produktivnummern derzeit eine tägliche Messaging-Grenze von mindestens 2.000 eindeutigen Empfängern. Für öffentliche Testnummern gelten andere Voraussetzungen. Die Freischaltung erfolgt im eigenen Meta-Konto. [Meta Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/)

Die Callback-URL muss für Meta per öffentlichem HTTPS erreichbar sein. Ein eigener Reverse-Proxy kann ausschließlich `/whatsapp/calls` an den lokalen Adapter-Port 8092 weiterleiten. Die GET-Challenge enthält den Verify-Token als Queryparameter. Deaktiviere das Access-Logging für diese Route oder entferne Queryparameter im Log. Der Anruf-Audiokanal nutzt ICE, DTLS und SRTP. Hinter NAT kann ein passender STUN- oder TURN-Dienst erforderlich sein. [Webhook-Einrichtung](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) · [Eingehende Anrufe](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls)

## Konfiguration

Lege im Stammverzeichnis des Projekts eine private Datei `.env.whatsapp` mit den folgenden Werten an. Das Compose-Overlay verbindet den Adapter mit dem Bridge-Netz und veröffentlicht den Webhook auf `127.0.0.1:8092`. Der Adapter braucht ausgehende HTTPS- und WebRTC-Verbindungen. Jede Variable unterstützt auch `NAME_FILE` mit dem Pfad zu einer im Container bereitgestellten Datei.

| Variable | Wert |
| --- | --- |
| `WA_PHONE_NUMBER_ID` | ID der Business-Telefonnummer aus dem Meta-Dashboard |
| `WA_ALLOWED_SENDERS` | Kommaseparierte WhatsApp-Telefonnummern der berechtigten Anrufer im internationalen Format, alternativ die jeweils belegte `bsuid:…` |
| `WA_ACCESS_TOKEN` | Graph-API-Zugriffstoken für die Business-Telefonnummer |
| `WA_APP_SECRET` | App Secret zur Prüfung von `X-Hub-Signature-256` |
| `WA_VERIFY_TOKEN` | Selbst gewählter Verifikationstoken, identisch zur Meta-Webhook-Konfiguration |
| `WA_GRAPH_VERSION` | Unterstützte Graph-API-Version deiner App im Format `vXX.X` |
| `BRIDGE_CHANNEL_SECRET` | Derselbe private Kanal-Schlüssel wie beim Bridge-Dienst |
| `BRIDGE_URL` | Standard `http://bridge:8091` |
| `WA_ICE_SERVERS_JSON` | Optionales JSON-Array mit ICE-Servern, z. B. `[{"urls":"turns:turn.example.org:5349?transport=tcp","username":"…","credential":"…"}]` |

Starte das Profil im Stammverzeichnis des Projekts.

```sh
docker compose -f compose.yaml -f channels/whatsapp/compose.yaml --profile whatsapp up -d --build whatsapp
```

Die interne Bridge stellt Spracherkennung, die Antwort des ausgewählten Assistenten und deutsche Sprachausgabe bereit. Verlangt der Assistent eine Bestätigung, verweist der Adapter auf den Chat. Er verarbeitet einen Anruf gleichzeitig. Ein Neustart beendet den laufenden Anruf.

## Lokale Prüfung

Diese Befehle im Verzeichnis `channels` bauen das Image und prüfen Challenge, signierte Webhooks, Anruferfilter, doppelte Zustellungen sowie Medien in beide Richtungen zwischen zwei lokalen WebRTC-Peers. Der Test verwendet simulierte Gegenstellen für die Graph API und den Assistenten.

```sh
docker build -f whatsapp/Dockerfile -t agent-call-whatsapp:local .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD/whatsapp/test_adapter.py,dst=/app/test_adapter.py,readonly" \
  agent-call-whatsapp:local python -m unittest -v test_adapter
```
