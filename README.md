# Agent Call Bridge

Sprich auf Deutsch mit deinem selbst gehosteten Nod-, Hermes- oder OpenClaw-Assistenten. Ein Klick öffnet das Mikrofon. Nach einer Sprechpause sendet die Bridge deinen Beitrag, spricht die Antwort und hört wieder zu. Zur Auswahl stehen lokale deutsche Stimmen von Piper und Pocket TTS. Native eingehende WhatsApp- und Telegram-Anrufe haben eigene optionale Adapter.

| Zugang | So beginnt das Gespräch | Voraussetzungen |
| --- | --- | --- |
| Browser | `/anruf/` öffnen und **Anruf starten** wählen | HTTPS und Mikrofonfreigabe. Für einen Test auf demselben Rechner funktioniert auch localhost. |
| WhatsApp mit eigener SIM | Die WhatsApp-Nummer des Assistenten vom eigenen WhatsApp-Konto aus anrufen | Eigenes WhatsApp-Konto auf dem Empfangshandy, separat per QR-Code gekoppelte Anruf-Software und Freigabe des Anrufers. Experimenteller, selbst gehosteter Zugang. [Einrichtung](channels/whatsapp-linked/README.md) |
| WhatsApp Business Platform | Eine für Calling freigeschaltete Cloud-API-Nummer anrufen | Öffentlicher HTTPS-Webhook, erreichbarer WebRTC-Medienpfad und zugelassene Anrufer. [Einrichtung](channels/whatsapp/README.md) |
| Telegram | Ein eigens verbundenes Telegram-Benutzerkonto anrufen | MTProto-Anmeldung, persistente Sitzung und zugelassene numerische Anrufer-IDs. Ein bestehender Bot kann alternativ einen Button für den Browser-Anruf anbieten. [Einrichtung](channels/telegram/README.md) |

Ein aktives Gespräch hat keine feste Gesamtdauer. Nach 60 Sekunden ohne erkannte Sprache im Hörmodus fragt die Stimme „Sind Sie noch da? Wenn ja, sprechen Sie jetzt.“ Nach der Ansage bleiben 30 Sekunden zum Antworten. Verstreicht auch diese Frist, legt der Adapter auf. Verarbeitungszeit des Assistenten und Wiedergabe zählen nicht als Stille. Die Nachfrage ist fest hinterlegt und erfordert keinen Chatmodell-Aufruf. Während der Assistent spricht, pausiert die Aufnahme.

Im Browser kann ein Gespräch bei einem Tabwechsel weiterlaufen, solange das Betriebssystem Mikrofon und Audio freigibt. Das Auflegen schließt das Mikrofon und beendet die Wiedergabe. Ein bereits übermittelter Auftrag kann im regulären Chat weiterlaufen.

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

2. Den generierten Wert in `.env` als `BRIDGE_WEB_TOKEN` speichern. Die Bridge verbindet sich mit einem bereits eingerichteten Nod-, Hermes- oder OpenClaw-Server. Für den voreingestellten Nod-Zugang den vorhandenen `NOD_AUTH_TOKEN` aus der privaten Konfiguration des Nod-Servers übernehmen und seine beiden URLs wie unten beschrieben setzen. `PUBLIC_ORIGIN` ist die **exakte** Adresse des Browserzugangs einschließlich Schema und gegebenenfalls Port.
3. Die Dienste starten.

   ```sh
   docker compose up -d --build --wait
   docker compose ps
   ```

4. Auf dem Rechner [den lokalen Anrufzugang](http://localhost:8091/anruf/login) öffnen und den privaten Zugangsschlüssel eingeben. Auf dem Handy die HTTPS-Adresse des eigenen Reverse-Proxys verwenden. Der Proxy leitet `/anruf/*` unverändert an Port 8091 weiter. Compose bindet diesen Port an Loopback. Die interne `/channel/*`-Schnittstelle und den Sprachdienst privat halten.

### Nod

Standardmäßig laufen Sprachnachrichten über Nods eigenen Spracheingang. Für die Anrufkanäle kannst du einen eigenen Transkriptionsdienst über `STT_BASE_URL` und `STT_MODEL` wählen. Dann erscheint das Transkript als Text im bestehenden Nod-Chat. Die Bridge prüft ausstehende Freigaben und private Eingaben vor der Übergabe. Ein privater `STT_PROMPT` hilft dem Modell bei der Schreibweise von Namen oder häufig verwendeten Begriffen. Die optionale Installation mit Whisper Large v3 Turbo verarbeitet Sprache lokal. [Lokale Spracherkennung](stt/README.md)

Für kurze Äußerungen bis sechs Sekunden lassen sich Parakeet und Whisper kombinieren. Parakeet erkennt sie zunächst auf der CPU. Bei unsicheren Wörtern prüft Whisper dieselbe Aufnahme. Längere Beiträge gehen direkt an Whisper. Widersprechen sich beide Transkripte bei einer Verneinung, fragt die Stimme nach, bevor der Assistent einen Auftrag erhält. Häufige Eigennamen kannst du privat hinterlegen. [Parakeet und Whisper kombinieren](stt/parakeet/README.md)

Die deutsche Stimme **Jürgen** aus Pocket TTS läuft ebenfalls lokal. Mit diesem Profil beginnen der Browser und die Messenger-Adapter die Wiedergabe, während die Stimme den Rest der Antwort noch erzeugt. [Pocket TTS einrichten](tts/pocket/README.md)

In `.env` muss `AGENT_BACKEND=nod` stehen. `NOD_BASE_URL` ist die aus dem Bridge-Container erreichbare Adresse des Nod-Servers. `NOD_PUBLIC_URL` entspricht dem in Nod konfigurierten Origin. Für den eigenständigen Login oder für Messenger-Anrufe braucht die Bridge `NOD_AUTH_TOKEN`. Chatverlauf, Tools und Aktionsfreigaben bleiben in Nod. Wenn du Nods eingebauten Spracheingang nutzt, sende vor dem ersten Anruf eine Sprachaufnahme im normalen Nod-Chat und lasse bei Bedarf das dortige Modell vorbereiten. [Nod-Audionachrichten](https://nod.n8n.io/docs/use/chat/#send-an-audio-message)

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

Für eine Anruftaste im eigenen Chat kann dessen Oberfläche das ES-Modul `/anruf/call-client.js` vom selben Origin vorladen. `createCallClient({ onState, onAnswer })` liefert einen Client. Die Anruftaste ruft `client.start()` direkt beim Klick auf. `onState` liefert Status, Detailtext und den aktiven Gesprächszustand, `onAnswer` den Antworttext. Beim Auflegen ruft die Oberfläche `client.stop()` auf, beim Verlassen des Chats `client.dispose()`. Das Vorladen allein öffnet das Mikrofon nicht.

Bei lokaler Spracherkennung mit Parakeet und Whisper kann `CALL_PREPARE_SHORT_SPEECH=true` kurze Beiträge schon während einer möglichen Satzpause transkribieren. Erst das erkannte Satzende löst einen Auftrag an Nod aus. Sprichst du weiter, prüft die Bridge die vollständige Aufnahme. Nur für exakt dieselben Audiodaten und dieselbe Anmeldung übernimmt sie ein vorbereitetes Ergebnis.

### Hermes und OpenClaw

Beide Adapter verwenden den Agenten-Server mit seinem normalen Chat-Completions-Endpunkt. Der Assistent behält seine eigenen Tools und Berechtigungen. Zusätzlich benötigt die Bridge einen Transkriptionsdienst mit OpenAI-kompatiblem `POST /audio/transcriptions`. `STT_BASE_URL` zeigt auf den API-Prefix, beispielsweise `https://api.openai.com/v1`, `STT_MODEL` auf ein dort unterstütztes Modell, beispielsweise `whisper-1`. Für einen authentifizierten Dienst `STT_API_KEY` setzen. An diesen Dienst geht die Audioaufnahme. Die lokale Sprachausgabe verarbeitet den Antworttext.

| Variable | Hermes Agent | OpenClaw |
| --- | --- | --- |
| `AGENT_BACKEND` | `hermes` | `openclaw` |
| `AGENT_BASE_URL` | Erreichbarer Hermes-API-Server einschließlich `/v1` | Erreichbares Gateway einschließlich `/v1` |
| `AGENT_API_KEY` | Hermes-API-Server-Schlüssel | Gateway-Bearer-Token |
| `AGENT_MODEL` | Modellalias aus der Hermes-Konfiguration, standardmäßig `hermes-agent` | `openclaw` oder z. B. `openclaw/default` |

Bei Hermes den API-Server mit `API_SERVER_ENABLED=true` und einem privaten `API_SERVER_KEY` aktivieren. Diesen Schlüssel in der Bridge als `AGENT_API_KEY` hinterlegen. In einem gemeinsamen privaten Docker-Netz braucht der Hermes-Server eine für die Bridge erreichbare Bind-Adresse, etwa `API_SERVER_HOST=0.0.0.0` bei internem Container-Port 8642. Bei OpenClaw den Gateway-Schalter `gateway.http.endpoints.chatCompletions.enabled` auf `true` setzen. Ein Gateway-Schlüssel gewährt weitreichenden Zugriff und gehört nur auf Server, die du kontrollierst. [Hermes-API-Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) · [OpenClaw-Gateway](https://docs.openclaw.ai/gateway/openai-http-api)

Hermes erhält Gesprächskontext aus den letzten acht Frage-Antwort-Paaren desselben Anrufs. OpenClaw erhält einen eigenen Sitzungsschlüssel pro Anruf. Nod verwendet seinen bestehenden persönlichen Chat. Mit `CHAT_URL` lässt sich ein Link zur normalen Agentenoberfläche angeben.

### Messenger

Für die nativen Adapter einen eigenen zufälligen `BRIDGE_CHANNEL_SECRET` auf Bridge und jeweiligem Adapter setzen. Die Adapter nehmen nur eingehende Anrufe zugelassener Konten an. Diese Personen sprechen mit dem **konfigurierten persönlichen Assistenten** und dessen verbundenen Tools. Die Zugangsdaten für Meta bzw. Telegram gehören jeweils nur in den betreffenden Adapter.

**WhatsApp mit eigener SIM.** Registriere die Nummer für den Assistenten auf seinem Handy. Du kannst Nod für Nachrichten koppeln und den Anrufadapter als weiteres Gerät hinzufügen. Der Anrufadapter hat eine eigene Gerätesitzung und verarbeitet die Sprache auf deinem Server. Du rufst anschließend vom persönlichen WhatsApp-Konto aus die Nummer des Assistenten an. Für diesen Weg brauchst du weder eine freigeschaltete Business-Nummer noch einen öffentlichen Webhook. Die zugrunde liegende Anrufbibliothek ist ein unabhängiges Projekt. Änderungen am WhatsApp-Protokoll können die Kompatibilität beeinträchtigen. [WhatsApp-Gerätekopplung](https://faq.whatsapp.com/378279804439436/) · [Anrufbibliothek meowcaller](https://github.com/purpshell/meowcaller)

**WhatsApp Business und Telegram.** Für Betreiber einer freigeschalteten Business-Nummer gibt es einen separaten Adapter für Metas Calling API. Für native Telegram-Einzelanrufe setzt Telegram ein angemeldetes Benutzerkonto voraus. Ein bereits verbundener Bot kann einen Button zum Browser-Anruf anbieten. [Meta Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/) · [Telegram phone.acceptCall](https://core.telegram.org/method/phone.acceptCall)

### Mehrere Compose-Dateien gemeinsam verwenden

Die einzelnen Adapteranleitungen zeigen jeweils den Start eines Profils. Sobald du Dateien kombinierst, speichere die vollständige Auswahl in der privaten `.env` im Projektstamm. Compose berücksichtigt alle dort aufgeführten Dateien beim Start und bei Updates. Dieses Beispiel verbindet die Bridge über die oben gezeigte `compose.override.yaml` mit Nod und aktiviert beide privaten Messenger-Adapter.

```dotenv
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=compose.yaml:compose.override.yaml:channels/whatsapp-linked/compose.yaml:channels/telegram/compose.yaml
COMPOSE_PROFILES=whatsapp-linked,telegram
```

Führe in `COMPOSE_FILE` nur vorhandene Dateien auf. Für die Pocket-Stimme ergänze `tts/pocket/compose.yaml`. Für lokales Whisper ergänze `stt/compose.yaml`, bei NVIDIA danach `stt/nvidia.yaml`, sowie `local-stt` in `COMPOSE_PROFILES`. Jeder Messenger braucht weiterhin seine eigene private Konfigurationsdatei und die Anmeldung aus seiner Anleitung.

Mit dieser Auswahl gelten die folgenden Befehle im Projektstamm. Die beiden Anmeldebefehle brauchst du bei der ersten Kopplung.

```sh
docker compose config --services
docker compose build
docker compose run --rm --no-deps whatsapp-linked pair
docker compose run --rm --no-deps telegram login
docker compose up -d --wait
```

## Überprüfung

```sh
node --test test/*.test.mjs
```

Für einen echten Browser-Dauertest ohne Modellkosten öffnet das Testskript ein temporäres Chromium-Profil auf dem eigenen Rechner. Es spielt deutsche Sprachproben über das Mikrofon des Testbrowsers ein, prüft die Antworten und wartet zum Schluss auf das automatische Auflegen. Mit `--minutes 0` durchläuft es einen Wortwechsel und beide Stillefristen. Voraussetzungen und Aufruf stehen im Skript. [Browser-Dauertest](test/browser-soak.py)

Ein Chrome-Dauerlauf mit lokaler Gegenstelle dauerte 63 Minuten und 53 Sekunden. Alle 92 Beiträge und Antworten gehörten zur selben Sitzung. Nach dem letzten Beitrag fragte die Stimme nach 60,001 Sekunden Stille nach. Weitere 30,016 Sekunden nach der Ansage gab Chrome das Mikrofon frei. Die separaten Tests der Messenger-Adapter simulieren rund 2 Stunden 8 Minuten Gespräch über WhatsApp per QR und 2 Stunden 20 Minuten über Telegram. Beide prüfen auch den Fall, dass das Gerät in der Stille keine Audiopakete mehr sendet.

Der WhatsApp-Business-Adapter lief 61 Minuten und 43 Sekunden mit zwei lokalen WebRTC-Gegenstellen. Die Spracherkennung verstand alle 81 eingespielten Fragen, und die Gegenstelle empfing alle 81 gesprochenen Antworten im selben Anruf. Nach 60 Sekunden Stille kam genau eine Nachfrage. 30 Sekunden nach der Ansage löste der Adapter das Auflegen aus. Nur die Signalisierung von Meta und die Antworten des Chatmodells waren in diesem Test nachgebildet.

Der Browsertest mit einer laufenden Nod-Instanz deckte deutsche Spracheingabe und automatische Wiedergabe ab. Für Hermes Agent v0.23.4 und OpenClaw 2026.11.10 lief je ein veröffentlichtes Gateway im lokalen Docker-Test. Die Bridge verarbeitete deutsche WAV-Dateien über Parakeet und Piper. Ein lokaler Modell-Dummy beantwortete eine Folgefrage anhand der zuvor genannten Farbe. In einem neuen Anruf erhielt er die gleiche Frage ohne die frühere Farbangabe. Die Messenger-Adapter wurden mit lokalen Gegenstellen geprüft. Ihre Anleitungen beschreiben die Voraussetzungen für einen echten Anruf im eigenen Konto.

## Lizenz

Der eigene Bridge-Code steht unter der [MIT-Lizenz](LICENSE). Für die mitgelieferte Schrift, die separat heruntergeladenen Sprachgewichte und die installierten Bibliotheken gelten deren eigene Lizenzen. [Schriftlizenz](web/Geist-OFL.txt) · [Stimme und Piper](tts/VOICE.md)
