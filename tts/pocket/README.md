# Deutsche Gesprächsstimme

Dieses optionale Profil nutzt Kyutais Pocket TTS mit der deutschen Stimme **Jürgen**. Das Modell mit festen Stimmen läuft auf der CPU und erzeugt synthetische Sprache. Seine Audiodaten haben 24 kHz. Die Daten des Anrufs bleiben bei der Sprachausgabe im internen Docker-Netz. Ein API-Schlüssel ist dafür entbehrlich.

Starte die Sprachausgabe im Projektstamm.

```sh
docker compose -f compose.yaml -f tts/pocket/compose.yaml up -d --build --wait
```

Für Updates die gleichen Compose-Dateien angeben. Der Build verwendet das offizielle Linux-AMD64-Binary für x86-64-v3 sowie Konfiguration, Tokenizer, deutsche Modellgewichte und die feste Sprecherstimme. Er verifiziert die SHA-256-Prüfsummen. Das Image enthält die Modelle für den Offline-Betrieb. Der bestehende Piper-Dienst kann auf Rechnern mit kleinerem Arbeitsspeicher über die Basis-Compose-Datei verwendet werden.

Pocket TTS stammt von Kyutai. Den Modellstand, die unveränderten Gewichte und ihre Attribution findest du auf der Modellkarte. Für die lokale Konfiguration wurden die Dateipfade angepasst. Das Image enthält die Softwarelizenz in `/opt/voice/LICENSE`. [Pocket TTS](https://github.com/kyutai-labs/pocket-tts/releases/tag/v4.0.1) · [Deutsches Modell, CC BY 4.0](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/tree/1e08e6a23401048648a9fdcfde2f89348215c2a7/languages/german) · [Stimmen und Quellen](https://huggingface.co/kyutai/tts-voices)
