# Agent Call Bridge

Sprich auf Deutsch mit deinem selbst gehosteten Nod-, Hermes- oder OpenClaw-Assistenten. Ein Klick öffnet das Mikrofon. Nach einer Sprechpause sendet die Bridge deinen Beitrag, liest die Antwort mit einer lokalen deutschen Piper-Stimme vor und hört wieder zu. Native eingehende WhatsApp- und Telegram-Anrufe haben eigene optionale Adapter.

| Zugang | So beginnt das Gespräch | Voraussetzungen |
| --- | --- | --- |
| Browser | `/anruf/` öffnen und **Anruf starten** wählen | HTTPS und Mikrofonfreigabe. Für einen Test auf demselben Rechner funktioniert auch localhost. |
| WhatsApp mit eigener SIM | Die WhatsApp-Nummer des Assistenten vom eigenen WhatsApp-Konto aus anrufen | Eigenes WhatsApp-Konto auf dem Empfangshandy, separat per QR-Code gekoppelte Anruf-Software und Freigabe des Anrufers. Experimenteller, selbst gehosteter Zugang. [Einrichtung](channels/whatsapp-linked/README.md) |
| WhatsApp Business Platform | Eine für Calling freigeschaltete Cloud-API-Nummer anrufen | Öffentlicher HTTPS-Webhook, erreichbarer WebRTC-Medienpfad und zugelassene Anrufer. [Einrichtung](channels/whatsapp/README.md) |
| Telegram | Ein eigens verbundenes Telegram-Benutzerkonto anrufen | MTProto-Anmeldung, persistente Sitzung und zugelassene numerische Anrufer-IDs. Ein bestehender Bot kann alternativ einen Button für den Browser-Anruf anbieten. [Einrichtung](channels/telegram/README.md) |

Während der Assistent antwortet, pausiert die Aufnahme. Die Browserseite muss im Vordergrund bleiben. Das Auflegen schließt das Mikrofon und beendet die Wiedergabe. Ein bereits an den Assistenten übermittelter Auftrag kann im regulären Chat weiterlaufen.

## Installation

Die mitgelieferten Images wurden auf **Linux/AMD64** mit Docker Compose v2 getestet. Der Piper-Build lädt das deutsche Modell einmalig und prüft dessen Prüfsumme. Für die Sprachausgabe entstehen keine API-Kosten. Für Assistent und Transkription gelten die Bedingungen der jeweiligen Verbindung.

1. Repository klonen und eine private Konfigurationsdatei anlegen.

   ```sh
   git clone https://github.com/pveiberger/agent-call-bridge.git
   cd agent-call-bridge
   umask 077
   cp .env.example .env
   openssl rand -hex 32
   ```

2. Den generierten Wert in `.env` als `BRIDGE_WEB_TOKEN` speichern. Den Assistenten wie unten beschrieben konfigurieren. `PUBLIC_ORIGIN` ist die **exakte** Adresse des Browserzugangs einschließlich Schema und gegebenenfalls Port.
3. Die Dienste starten.

   ```sh
   docker compose up -d --build --wait
   docker compose ps
   ```

4. Auf dem Rechner [den lokalen Anrufzugang](http://localhost:8091/anruf/login) öffnen und den privaten Zugangsschlüssel eingeben. Auf dem Handy die HTTPS-Adresse des eigenen Reverse-Proxys verwenden. Der Proxy leitet `/anruf/*` unverändert an Port 8091 weiter. Compose bindet diesen Port an Loopback. Die interne `/channel/*`-Schnittstelle und den Sprachdienst privat halten.

### Nod

In `.env` muss `AGENT_BACKEND=nod` stehen. `NOD_BASE_URL` ist die aus dem Bridge-Container erreichbare Adresse des Nod-Servers. `NOD_PUBLIC_URL` entspricht dem in Nod konfigurierten Origin. Für den eigenständigen Login oder für Messenger-Anrufe braucht die Bridge `NOD_AUTH_TOKEN`. Nod übernimmt Transkription, Chatverlauf, Toolzugriff und seine bestehenden Aktionsfreigaben. **Vor dem ersten Anruf** einmal im normalen Nod-Chat eine Sprachaufnahme senden und gegebenenfalls die lokale Transkription vorbereiten lassen. [Nod-Audionachrichten](https://nod.n8n.io/docs/use/chat/#send-an-audio-message)

Die beiden Compose-Projekte können sich über ein gemeinsames Docker-Netz erreichen. Bei einem vorhandenen Nod-Self-Host-Stack lässt sich die Bridge zusätzlich an sein Outbound-Netz anschließen. Den tatsächlichen Netznamen in dieser optionalen `compose.override.yaml` einsetzen und `NOD_BASE_URL=http://server:4310` entsprechend anpassen.

```yaml
services:
  bridge:
    networks: [agents, speech, nod-outbound]
networks:
  nod-outbound:
    external: true
    name: example-nod_outbound
```

Wer die Seite **unter demselben Origin wie Nod** betreibt, kann den bestehenden Browser-Login mit `WEB_AUTH=nod` verwenden. Dafür müssen `PUBLIC_ORIGIN` und `NOD_PUBLIC_URL` in Schema, Host und Port übereinstimmen. Nod muss den eigenen Zugriffsschlüssel erzwingen. Die Bridge prüft bei jeder Browseranfrage, dass Nod eine anonyme Anfrage abweist und die angemeldete Person erkennt. Bei reinem Browserbetrieb benötigt die Bridge dann keinen gespeicherten Nod-Token. Eine normale Nod-Anmeldung öffnet den Call-Zugang, danach erneut `/anruf/` aufrufen.

### Hermes und OpenClaw

Beide Adapter verwenden den Agenten-Server mit seinem normalen Chat-Completions-Endpunkt. Der Assistent behält seine eigenen Tools und Berechtigungen. Zusätzlich benötigt die Bridge einen Transkriptionsdienst mit OpenAI-kompatiblem `POST /audio/transcriptions`. `STT_BASE_URL` zeigt auf den API-Prefix, beispielsweise `https://api.openai.com/v1`, `STT_MODEL` auf ein dort unterstütztes Modell, beispielsweise `whisper-1`. Für einen authentifizierten Dienst `STT_API_KEY` setzen. An diesen Dienst geht die Audioaufnahme. Die lokale Piper-Ausgabe verarbeitet nur den Antworttext.

| Variable | Hermes Agent | OpenClaw |
| --- | --- | --- |
| `AGENT_BACKEND` | `hermes` | `openclaw` |
| `AGENT_BASE_URL` | Erreichbarer Hermes-API-Server einschließlich `/v1` | Erreichbares Gateway einschließlich `/v1` |
| `AGENT_API_KEY` | Hermes-API-Server-Schlüssel | Gateway-Bearer-Token |
| `AGENT_MODEL` | Modellalias aus der Hermes-Konfiguration, standardmäßig `hermes-agent` | `openclaw` oder z. B. `openclaw/default` |

Für OpenClaw den Chat-Completions-Endpunkt im Gateway aktivieren. Ein Gateway-Schlüssel gewährt weitreichenden Zugriff und gehört nur auf Server, die du kontrollierst. Hermes erhält Gesprächskontext aus den letzten acht Frage-Antwort-Paaren desselben Anrufs. OpenClaw erhält einen eigenen Sitzungsschlüssel pro Anruf. Nod verwendet seinen bestehenden persönlichen Chat. Mit `CHAT_URL` lässt sich ein Link zur normalen Agentenoberfläche angeben. [Hermes-API-Server](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md) · [OpenClaw-Gateway](https://docs.openclaw.ai/gateway/openai-http-api)

### Messenger

Für die nativen Adapter einen eigenen zufälligen `BRIDGE_CHANNEL_SECRET` auf Bridge und jeweiligem Adapter setzen. Die Adapter nehmen nur eingehende Anrufe zugelassener Konten an. Diese Personen sprechen mit dem **konfigurierten persönlichen Assistenten** und dessen verbundenen Tools. Die Zugangsdaten für Meta bzw. Telegram gehören jeweils nur in den betreffenden Adapter.

**WhatsApp mit eigener SIM.** Registriere die Nummer für den Assistenten auf seinem Handy. Du kannst Nod für Nachrichten koppeln und den Anrufadapter als weiteres Gerät hinzufügen. Der Anrufadapter hat eine eigene Gerätesitzung und verarbeitet die Sprache auf deinem Server. Du rufst anschließend vom persönlichen WhatsApp-Konto aus die Nummer des Assistenten an. Für diesen Weg brauchst du weder eine freigeschaltete Business-Nummer noch einen öffentlichen Webhook. Die zugrunde liegende Anrufbibliothek ist ein unabhängiges Projekt. Änderungen am WhatsApp-Protokoll können die Kompatibilität beeinträchtigen. [WhatsApp-Gerätekopplung](https://faq.whatsapp.com/378279804439436/) · [Anrufbibliothek meowcaller](https://github.com/purpshell/meowcaller)

**WhatsApp Business und Telegram.** Für Betreiber einer freigeschalteten Business-Nummer gibt es einen separaten Adapter für Metas Calling API. Für native Telegram-Einzelanrufe setzt Telegram ein angemeldetes Benutzerkonto voraus. Ein bereits verbundener Bot kann einen Button zum Browser-Anruf anbieten. [Meta Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/) · [Telegram phone.acceptCall](https://core.telegram.org/method/phone.acceptCall)

## Überprüfung

```sh
node --test test/*.test.mjs
```

Getestet wurden der Browserablauf gegen eine laufende Nod-Instanz einschließlich deutscher Spracheingabe und automatischer deutscher Wiedergabe sowie die Protokolladapter mit lokalen Gegenstellen. Die Anleitungen der Messenger-Adapter beschreiben die Voraussetzungen für einen echten Anruf im eigenen Konto. Hermes und OpenClaw wurden gegen simulierte API-Gegenstellen geprüft.

## Lizenz

Der eigene Bridge-Code steht unter der [MIT-Lizenz](LICENSE). Für die mitgelieferte Schrift, die separat heruntergeladenen Sprachgewichte und die installierten Bibliotheken gelten deren eigene Lizenzen. [Schriftlizenz](web/Geist-OFL.txt) · [Stimme und Piper](tts/VOICE.md)
