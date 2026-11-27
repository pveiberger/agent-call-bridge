# Lokale Transkription mit Parakeet

Dieses CPU-Profil erkennt Deutsch und 24 weitere Sprachen mit NVIDIA Parakeet TDT 0.6B v3. Die drei int8-Modelle bleiben während des Betriebs im Speicher. Das Profil nutzt auf Linux/AMD64 vier CPU-Threads, verarbeitet jeweils einen Sprachbeitrag und reserviert keinen GPU-Speicher.

Richte den gewünschten Assistenten im Projektstamm ein. Für häufige Namen kannst du in der privaten `.env` bis zu 1.024 Zeichen als Wortliste angeben, etwa `STT_HOTWORDS=OpenClaw|Notion|Berlin Mitte`. Der originale Modell-Tokenizer wandelt jeden Begriff in Teilwörter um. Der Decoder berücksichtigt diese Begriffe während der Erkennung. Ohne Liste verwendet der Dienst den schnelleren Greedy-Decoder.

```sh
docker compose -f compose.yaml -f stt/parakeet/compose.yaml --profile parakeet up -d --build --wait
```

Die Bridge verwendet danach den internen Dienst unter `http://call-stt:8093/v1`. Der Container prüft `GET /health` und akzeptiert unter `POST /v1/audio/transcriptions` jeweils eine Monoaufnahme mit 16 kHz, 16 Bit PCM und höchstens 120 Sekunden Länge. Während eines Telefonats verarbeitet er beliebig viele aufeinanderfolgende Beiträge. Ein bereits ausgelasteter Dienst antwortet mit HTTP 503. Das Profil veröffentlicht keinen Port. Die Audioverarbeitung erfolgt auf dem eigenen Rechner. Docker speichert keine Transkriptionslogs.

## Mit Whisper kombinieren

Im kombinierten Profil übernimmt Parakeet kurze Äußerungen bis sechs Sekunden. Meldet der Decoder mehrere unsichere Teilwörter oder einen besonders schwachen Treffer in einer kurzen Äußerung, transkribiert Whisper denselben Beitrag. Bei widersprüchlicher Verneinung oder leerer Erkennung bittet die Stimme um Wiederholung. Längere Aufnahmen gehen direkt an Whisper. Der Assistent bekommt einen einzigen endgültigen Gesprächsbeitrag. Ist der schnelle Dienst nicht erreichbar, übernimmt Whisper.

```sh
docker compose -f compose.yaml -f stt/compose.yaml -f stt/parakeet/review.yaml --profile local-stt up -d --build --wait
```

Für Whisper auf einer unterstützten NVIDIA-GPU zusätzlich `-f stt/nvidia.yaml` vor `--profile` angeben. Beide Modelle bleiben zwischen den Beiträgen geladen. Häufige Eigennamen lassen sich für Parakeet mit `STT_HOTWORDS` und für Whisper mit `STT_PROMPT` in der privaten `.env` hinterlegen. Die Bewertung der Teilwörter nutzt interne Modellsignale. Auch ein zuversichtlich erkannter Name kann falsch sein.

## Quellen und Lizenz

NVIDIA trainierte das Originalmodell Parakeet TDT 0.6B v3. Das sherpa-onnx-Projekt exportierte die Gewichte ins ONNX-Format und quantisierte sie auf int8. Für Modell und Tokenizer gilt CC BY 4.0. Die Versionen und SHA-256-Prüfsummen der herunter­geladenen Dateien stehen im Dockerfile. Der Python-Dienst nutzt sherpa-onnx unter Apache 2.0. [Originalmodell und Tokenizer](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/541d1f99c6b0c3cd0b11a95167540bb8edefd82b) · [ONNX-Export](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tree/ed5d745623472f97cfc2e6c2916ee248798fc5a8) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
