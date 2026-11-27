# Lokale deutsche Spracherkennung

Dieses optionale Profil transkribiert die Sprachbeiträge mit dem multilingualen Whisper Large v3 Turbo in der Quantisierung Q5_0. Der Dienst bleibt zwischen den Gesprächsbeiträgen geladen. Das Modell erhält die gewählte Sprache Deutsch und auf Wunsch eine kurze Liste häufiger Eigennamen und Fachbegriffe. [Whisper-Modell](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1) · [whisper.cpp-Server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server)

## Auf der CPU starten

Richte im Projektstamm zunächst die Anmeldung und den gewünschten Assistenten in `.env` ein. Für individuelle Begriffe eignet sich eine kurze Zeile mit den tatsächlichen Schreibweisen, zum Beispiel `STT_PROMPT=Im Gespräch geht es um Notion, OpenClaw und Kalenderaufgaben.` Lass das Feld für einen ersten Vergleich leer. Häufig verwendete Wörter helfen dem Modell, ähnliche Laute einzuordnen. Lange Listen können Wörter ins Transkript bringen, die niemand gesagt hat.

```sh
docker compose -f compose.yaml -f stt/compose.yaml --profile local-stt up -d --build --wait
docker compose -f compose.yaml -f stt/compose.yaml --profile local-stt ps call-stt
```

Das Overlay verbindet die Bridge mit `http://call-stt:8093/v1` und setzt `STT_MODEL=whisper-large-v3-turbo`. Der Server empfängt WAV-Audio unter `POST /v1/audio/transcriptions`. Die Bereitschaftsprüfung nutzt `GET /health`. Für dieses Profil gelten Linux/AMD64, vier Rechenthreads und ein Containerlimit von 4 GiB RAM. Der erste Build lädt das rund 574 MB große Modell und prüft dessen SHA-256. Sowohl Modellrevision als auch Upstream-Images sind festgelegt.

Der Dienst verwendet das interne Docker-Netz `speech` ohne veröffentlichten Port. Seine Docker-Protokollierung ist abgeschaltet, damit die Ausgaben des Erkenners keine Transkripte im Containerlog hinterlassen. Beim gewählten Agenten gelten dessen Einstellungen für den Chatverlauf.

## NVIDIA-GPU verwenden

Auf einem Linux-Host mit unterstützter NVIDIA-GPU, Vulkan-Treiber und eingerichtetem NVIDIA Container Toolkit ergänze beim Start das GPU-Overlay. [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)

```sh
docker compose -f compose.yaml -f stt/compose.yaml -f stt/nvidia.yaml --profile local-stt up -d --build --wait
```

Das Overlay verwendet das Vulkan-Image von whisper.cpp und fordert eine GPU an. Es bindet zwei Manifeste des installierten NVIDIA-Treibers schreibgeschützt ein. Falls die Dateien auf deiner Distribution anders liegen, setze in der privaten `.env` die tatsächlichen Pfade als `NVIDIA_VULKAN_ICD` und `NVIDIA_EGL_VENDOR`. Die Standardpfade sind `/usr/share/vulkan/icd.d/nvidia_icd.json` und `/usr/share/glvnd/egl_vendor.d/10_nvidia.json`. Auf dem Host zeigt `nvidia-smi` während der Transkription die Nutzung der GPU.

## Kurze Sprachbeiträge beschleunigen

Mit `STT_WHISPER_SHORT_CONTEXT=true` in der privaten `.env` schickt die Bridge bei fertigen Mono-WAV-Aufnahmen bis einschließlich sechs Sekunden (PCM16, 16 kHz) den Parameter `audio_ctx=768` an whisper.cpp. Für längere Beiträge und andere Formate wählt sie den vollen Kontext. Ohne diese Option verwendet die Bridge die Voreinstellung des Transkriptionsdienstes. Verwende die Option nur mit einem kompatiblen whisper.cpp-Endpunkt.

Im lokalen GPU-Vergleich mit vier synthetischen deutschen Aufnahmen von 3,9 bis 5,6 Sekunden sank die mediane Transkriptionszeit bei geladenem Modell von 4,53 auf 2,00 Sekunden. Bei diesen Aufnahmen blieben die Eigennamen, die Verneinung und die Zeitangaben erhalten. Für die eigene Stimme lohnt sich ein Vergleich mit identischen Aufnahmen, besonders bei Dialekt und Hintergrundgeräuschen.

Erkennt die Bridge bei einem solchen kurzen Beitrag drei unmittelbar aufeinanderfolgende Kopien derselben längeren Wortfolge, transkribiert sie die Aufnahme einmal mit vollem Kontext. Bleiben die Wiederholungen bestehen, bittet die Bridge um eine neue Aufnahme. Der Assistent erhält nur das geprüfte Ergebnis.
