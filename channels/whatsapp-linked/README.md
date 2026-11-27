# Den Assistenten über seine eigene WhatsApp-Nummer anrufen

Registriere die zweite SIM in WhatsApp als eigenes Konto für den Assistenten. Dieses Konto verknüpft den Docker-Dienst über einen QR-Code als zusätzliches Gerät. Anschließend rufst du die Assistentennummer aus dem WhatsApp-Konto deiner persönlichen Nummer an. Der Ton läuft über WhatsApp und die Bridge auf deinem Server. Eine SIM im Server, ein öffentlicher Webhook und eine Meta-Business-Registrierung sind für diesen Weg entbehrlich. [WhatsApp zu zwei Konten](https://blog.whatsapp.com/multiple-accounts-coming-to-whatsapp) · [WhatsApp zu verknüpften Geräten](https://faq.whatsapp.com/378279804439436/)

Dieser experimentelle Zugang verwendet die unabhängigen Implementierungen Hypermeow und meowcaller. WhatsApp unterstützt den Betrieb inoffizieller Clients nicht und kann Konten einschränken. Der gepinnte Medienstack unterstützt MLow. Bei einer Gegenstelle, die Opus benötigt, kann das Gespräch ohne Ton bleiben. [WhatsApp zu inoffiziellen Apps](https://faq.whatsapp.com/1848531392146538/) · [Medienfunktionen und Codec-Grenze](https://github.com/purpshell/meowcaller/tree/c48c3e2a243c672c942cbf0c941d14161720d540)

## Einrichten

1. Richte die Bridge für den gewünschten Assistenten ein. Trage einen privaten `BRIDGE_CHANNEL_SECRET` mit mindestens 32 Zeichen in ihrer `.env` ein. Einen neuen Schlüssel erzeugt `openssl rand -hex 32`.
2. Lege im Projektstamm die Konfiguration für das verknüpfte Gerät an.

   ```sh
   umask 077
   cp channels/whatsapp-linked/linked.env.example .env.whatsapp-linked
   ```

   Setze `LINKED_ACCOUNT_NUMBER` auf die zweite Nummer, auf der der Assistent angerufen wird. Setze `LINKED_ALLOWED_CALLERS` auf die persönliche Nummer, von der du anrufst. Verwende jeweils die internationale Vorwahl und Ziffern. Mehrere durch Kommas getrennte persönliche Nummern erhalten vollen Sprachzugriff auf denselben Assistenten und seine Werkzeuge. Trage bei `BRIDGE_CHANNEL_SECRET` denselben Wert wie in der Bridge ein.

3. Baue das Image und starte die Kopplung in einem privaten interaktiven Terminal.

   ```sh
   docker compose -f compose.yaml -f channels/whatsapp-linked/compose.yaml --profile whatsapp-linked build whatsapp-linked
   docker compose -f compose.yaml -f channels/whatsapp-linked/compose.yaml --profile whatsapp-linked run --rm --no-deps whatsapp-linked pair
   ```

   Öffne auf dem Empfangshandy **im Konto der zweiten Nummer** das Menü **Verknüpfte Geräte → Gerät hinzufügen** und scanne den QR-Code. Der Code erscheint während der Kopplung im Terminal. Das verknüpfte Gerät führt eine eigene verschlüsselte WhatsApp-Sitzung. Seine privaten Geräteschlüssel liegen in der SQLite-Datenbank des Docker-Volumes `whatsapp-linked-session`. Zugriff auf dieses Volume bedeutet Zugriff auf das gekoppelte Konto.

4. Starte den Dienst.

   ```sh
   docker compose -f compose.yaml -f channels/whatsapp-linked/compose.yaml --profile whatsapp-linked up -d whatsapp-linked
   ```

   Rufe die zweite Nummer mit der WhatsApp-Sprachanruffunktion an. Nach der Begrüßung kannst du Deutsch sprechen. Bei einer Pause schickt der Adapter den Beitrag an den konfigurierten Assistenten und spielt anschließend dessen Antwort ab. Während der Wiedergabe pausiert die Spracheingabe. Freigaben bearbeitest du im regulären Chat.

Ein aktives Gespräch hat im Adapter keine feste Höchstdauer. Wenn beim Zuhören eine Minute lang keine Sprache zu erkennen ist, fragt die Sprachausgabe „Sind Sie noch da? Wenn ja, sprechen Sie jetzt.“ Sobald die Ansage zu Ende ist, bleiben 30 Sekunden für eine Antwort. Erkennt der Adapter Sprache, läuft das Gespräch weiter. Bei weiterer Stille legt er auf. Während der Verarbeitung und Wiedergabe pausiert die Frist. Die Nachfrage verwendet einen festen Text und löst keinen Auftrag an den Assistenten aus.

Mit der Pocket-Stimme beginnt die Wiedergabe, sobald der erste 60-ms-Audioabschnitt vorliegt. Die Bridge liefert 24-kHz-Audio, das der Adapter fortlaufend auf die 16 kHz des WhatsApp-Codecs umrechnet. Bei Piper und älteren Bridge-Versionen lädt der Adapter die Antwort satzweise als WAV. Auflegen beendet die laufende Audioübertragung.

Die Erkennung vergleicht das Mikrofonsignal mit dem laufenden Hintergrundgeräusch. So kann die Stillefrist auch bei einem hörbaren Lüfter ablaufen. Bei leisen Antworten puffert der Adapter den Wortanfang und gibt das ursprüngliche Audiosignal an die Transkription weiter.

## Betrieb und Daten

Der Container nutzt ausgehende Verbindungen zur WhatsApp-Infrastruktur und das private Docker-Netz der Bridge. Vor der Annahme prüft er den Absender des Signal-verschlüsselten Angebots und den zugehörigen Anrufer gegen die Freigabeliste. Er behandelt einen privaten eingehenden Sprachanruf gleichzeitig. Der Adapter hält die erkannten Sprachabschnitte im Arbeitsspeicher. Transkripte und Antworten unterliegen dem Speicherverhalten des gewählten Assistenten. [Nod, Hermes und OpenClaw](../../README.md)

Zum Abschalten dient `docker compose -f compose.yaml -f channels/whatsapp-linked/compose.yaml --profile whatsapp-linked stop whatsapp-linked`. Zum dauerhaften Trennen entferne das Gerät auf dem Empfangshandy unter **Verknüpfte Geräte**.

Der Docker-Build prüft die Aufruferidentität, die Bridge-HTTP-Anfragen, die Freigabebehandlung und die Audio-Konvertierung mit lokalen Tests. Ein Anruf zwischen zwei Geräten ist erforderlich, um die Konto- und Medienverbindung zu WhatsApp für deine Nummer zu bestätigen.

## Lizenzen

Die unveränderten Go-Abhängigkeiten sind in `go.mod` und `go.sum` festgelegt. Das gebaute Image enthält Modulversionen und Lizenztexte unter `/usr/share/doc/whatsapp-linked/licenses/`. Meowcaller steht unter MIT, Hypermeow unter MPL-2.0. Die verknüpften Repository-Stände enthalten den verwendeten Quelltext. [Meowcaller-Quelltext](https://github.com/purpshell/meowcaller/tree/c48c3e2a243c672c942cbf0c941d14161720d540) · [Hypermeow-Quelltext](https://github.com/polymorfa/hypermeow/tree/90f9e4ec2c88ddc8dda3de40bf1344cf027cbf9a)
