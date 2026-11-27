import { VoiceDetector } from "./vad.js";

const $ = (id) => document.getElementById(id);
const toggle = $("toggle");
let active = null;
let agent = "Nod";
let chatUrl = "/";

function sessionInfo(info) {
  if (["Nod", "Hermes", "OpenClaw"].includes(info.agent)) agent = info.agent;
  if ("chatUrl" in info) {
    chatUrl = null;
    if (typeof info.chatUrl === "string" && info.chatUrl.length) {
      try {
        const url = new URL(info.chatUrl, location.origin);
        if (
          url.protocol === "https:" ||
          (url.protocol === "http:" && url.origin === location.origin)
        )
          chatUrl = url.href;
      } catch {
        /* No browser chat configured. */
      }
    }
  }
  $("agent").textContent = agent;
  $("title").textContent = document.title = "Anruf mit " + agent;
  const headerChat = $("header-chat");
  headerChat.hidden = !chatUrl;
  if (chatUrl) headerChat.href = chatUrl;
}

function present(phase, status, detail = "", showChat = false) {
  document.body.dataset.phase = phase;
  $("status").textContent = status;
  $("detail").textContent = detail;
  $("label").textContent = active ? "Anruf beenden" : "Anruf starten";
  toggle.setAttribute("aria-pressed", String(Boolean(active)));
  const action = $("chat-action");
  action.hidden = !showChat || (showChat !== "login" && !chatUrl);
  action.href = showChat === "login" ? "/anruf/login" : chatUrl || "/anruf/";
  action.textContent =
    showChat === "login" ? "Zur Anmeldung ↗" : "Im Chat öffnen ↗";
}

function end(phase, status, detail, showChat = false) {
  const call = active;
  active = null;
  if (call) {
    call.controller.abort();
    call.listen?.(false);
    call.stream?.getTracks().forEach((track) => track.stop());
    try {
      call.playing?.stop();
    } catch {
      /* The buffer may have just ended. */
    }
    for (const node of call.nodes) {
      try {
        node.disconnect();
      } catch {
        /* Already disconnected. */
      }
    }
    if (call.worklet) call.worklet.port.close();
    if (call.context && call.context.state !== "closed")
      call.context.close().catch(() => {});
    call.lock?.release().catch(() => {});
  }
  present(phase, status, detail, showChat);
}

function check(call) {
  if (active !== call) throw new DOMException("Anruf beendet", "AbortError");
}

class CallError extends Error {
  constructor(message, chat = false) {
    super(message);
    this.chat = chat;
  }
}

async function request(call, path, options = {}) {
  check(call);
  const response = await fetch("/anruf/api/" + path, {
    ...options,
    headers: { ...options.headers, "X-Call-Id": call.id },
    credentials: "same-origin",
    cache: "no-store",
    signal: call.controller.signal,
  });
  check(call);
  if (response.ok) return response;
  const error = (await response.json().catch(() => ({}))).error;
  if (response.status === 401)
    throw new CallError(
      "Melde dich an und öffne danach die Anrufseite erneut.",
      "login",
    );
  if (response.status === 409)
    throw new CallError(
      error || "Schließe zuerst den offenen Vorgang bei deinem Assistenten ab.",
      true,
    );
  throw new CallError(
    error ||
      agent + " ist gerade nicht erreichbar. Du kannst den Anruf neu starten.",
    true,
  );
}

function pause(call, milliseconds) {
  return new Promise((resolve, reject) => {
    check(call);
    const signal = call.controller.signal;
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Anruf beendet", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function arm(call) {
  check(call);
  call.stream.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });
  call.listen(true);
  present(
    "listening",
    "Ich höre zu",
    "Sprich jetzt. Nach einer kurzen Sprechpause übernimmt " + agent + ".",
  );
}

function finishError(call, error) {
  if (active !== call) return;
  const deviceErrors = {
    NotAllowedError:
      "Erlaube den Mikrofonzugriff in den Website-Einstellungen und starte den Anruf erneut.",
    NotFoundError:
      "Verbinde ein Mikrofon mit deinem Gerät und starte den Anruf erneut.",
    NotReadableError:
      "Dein Mikrofon ist gerade nicht verfügbar. Prüfe die Geräteauswahl deines Browsers.",
  };
  const detail =
    error instanceof CallError
      ? error.message
      : deviceErrors[error?.name] ||
        "Die Verbindung wurde unterbrochen. Starte den Anruf erneut.";
  end(
    "error",
    "Anruf unterbrochen",
    detail,
    error.chat ?? !deviceErrors[error?.name],
  );
}

async function capture(call) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  if (active !== call) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  call.stream = stream;
  stream.getAudioTracks()[0].addEventListener("ended", () => {
    if (active === call)
      end(
        "error",
        "Mikrofon getrennt",
        "Verbinde dein Mikrofon und starte den Anruf erneut.",
      );
  });
  const ctx = call.context;
  const source = ctx.createMediaStreamSource(stream);
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 90;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  call.nodes.push(source, filter, mute);
  const event = (data) => {
    if (active !== call) return;
    const phase = document.body.dataset.phase;
    if (phase !== "listening" && phase !== "capturing") return;
    if (data.type === "voice")
      present(
        "capturing",
        "Du sprichst",
        "Mach eine kurze Pause, wenn du fertig bist.",
      );
    if (data.type === "quiet")
      present(
        "listening",
        "Ich höre zu",
        "Sprich jetzt. Nach einer kurzen Sprechpause übernimmt " + agent + ".",
      );
    if (data.type === "utterance")
      talk(call, data.wav).catch((error) => finishError(call, error));
  };
  let processor;
  if (ctx.audioWorklet && window.AudioWorkletNode) {
    await ctx.audioWorklet.addModule("/anruf/capture.js");
    check(call);
    processor = new AudioWorkletNode(ctx, "nod-call-capture", {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    call.worklet = processor;
    processor.port.onmessage = ({ data }) => event(data);
    processor.onprocessorerror = () =>
      finishError(
        call,
        new CallError(
          "Die Aufnahme wurde unterbrochen. Starte den Anruf erneut.",
        ),
      );
    call.listen = (enabled) =>
      processor.port.postMessage(enabled ? "listen" : "mute");
  } else {
    const detector = new VoiceDetector(ctx.sampleRate, event);
    processor = ctx.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (e) =>
      detector.feed(e.inputBuffer.getChannelData(0));
    call.listen = (enabled) => detector.arm(enabled);
  }
  call.nodes.push(processor);
  source
    .connect(filter)
    .connect(processor)
    .connect(mute)
    .connect(ctx.destination);
  if (ctx.state !== "running") await ctx.resume();
  if (document.hidden) {
    end(
      "idle",
      "Anruf pausiert",
      "Halte die Anrufseite im Vordergrund. Zum Fortsetzen erneut starten.",
    );
    return;
  }
  arm(call);
}

async function begin() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (
    !Audio ||
    !navigator.mediaDevices?.getUserMedia ||
    !window.isSecureContext
  ) {
    end(
      "error",
      "Mikrofon nicht verfügbar",
      "Öffne die HTTPS-Anrufseite in einem aktuellen Browser.",
      true,
    );
    return;
  }
  const call = {
    id: crypto.randomUUID(),
    controller: new AbortController(),
    nodes: [],
  };
  active = call;
  present(
    "starting",
    "Anruf wird gestartet",
    "Erlaube den Zugriff auf dein Mikrofon.",
  );
  try {
    // Unlock both capture and future automatic playback in the button's gesture.
    const ctx = new Audio({ latencyHint: "interactive" });
    call.context = ctx;
    const resume = ctx.resume();
    const unlock = ctx.createBufferSource();
    unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    unlock.connect(ctx.destination);
    unlock.onended = () => unlock.disconnect();
    unlock.start();
    await resume;
    const auth = await (await request(call, "session")).json();
    if (!auth.ok) throw new CallError("Melde dich zuerst an.", "login");
    sessionInfo(auth);
    ctx.onstatechange = () => {
      if (
        active === call &&
        document.body.dataset.phase !== "starting" &&
        (ctx.state === "suspended" || ctx.state === "interrupted")
      ) {
        end(
          "idle",
          "Anruf pausiert",
          "Dein Gerät hat den Ton unterbrochen. Starte den Anruf erneut.",
        );
      }
    };
    await capture(call);
    check(call);
    if (navigator.wakeLock && !document.hidden) {
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (active === call) call.lock = lock;
          else lock.release().catch(() => {});
        })
        .catch(() => {});
    }
  } catch (error) {
    finishError(call, error);
  }
}

// Keep sentences together, with a firm limit on each TTS request.
function speechParts(text) {
  let remaining = text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .trim();
  const result = [];
  while (remaining.length > 460) {
    const window = remaining.slice(0, 460);
    let at = 0;
    for (const match of window.matchAll(/[.!?](?:[”»“"])?\s+|\n+/g))
      at = match.index + match[0].length;
    if (at < 150) at = window.lastIndexOf(" ");
    if (at < 1) at = /[\uD800-\uDBFF]/.test(window.slice(-1)) ? 459 : 460;
    result.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) result.push(remaining);
  return result.filter(Boolean);
}

async function playback(call, bytes) {
  check(call);
  const ctx = call.context;
  const buffer = await ctx.decodeAudioData(bytes);
  check(call);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  call.playing = source;
  await new Promise((resolve, reject) => {
    const signal = call.controller.signal;
    const abort = () => reject(new DOMException("Anruf beendet", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    source.onended = () => {
      signal.removeEventListener("abort", abort);
      source.disconnect();
      if (call.playing === source) call.playing = null;
      resolve();
    };
    source.start();
  });
}

async function talk(call, wav) {
  check(call);
  call.listen(false);
  call.stream.getAudioTracks().forEach((track) => {
    track.enabled = false;
  });
  present(
    "working",
    agent + " antwortet gleich",
    "Dein Mikrofon pausiert während der Antwort.",
  );
  const submitted = await (
    await request(call, "utterance", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Request-Id": crypto.randomUUID(),
      },
      body: wav,
    })
  ).json();
  if (!submitted.id || typeof submitted.id !== "string")
    throw new CallError(
      "Die Aufnahme konnte nicht zugeordnet werden. Prüfe den Verlauf bei deinem Assistenten.",
      true,
    );
  let turn;
  while (true) {
    turn = await (
      await request(call, "turn/" + encodeURIComponent(submitted.id))
    ).json();
    if (turn.state !== "working") break;
    await pause(call, 950);
  }
  check(call);
  if (turn.state === "approval") {
    end(
      "approval",
      agent + " braucht deine Bestätigung",
      chatUrl
        ? "Öffne den Chat, prüfe die Anfrage und bestätige sie dort."
        : "Prüfe die offene Anfrage direkt bei deinem Assistenten.",
      true,
    );
    return;
  }
  if (
    turn.state !== "reply" ||
    typeof turn.text !== "string" ||
    !turn.text.trim()
  ) {
    throw new CallError(
      turn.text || turn.error || "Es kam keine vorlesbare Antwort zurück.",
      true,
    );
  }
  $("answer").textContent = turn.text;
  $("last").hidden = false;
  for (const part of speechParts(turn.text)) {
    const speech = await request(call, "speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: part }),
    });
    const bytes = await speech.arrayBuffer();
    check(call);
    present(
      "speaking",
      agent + " spricht",
      "Sobald die Antwort endet, bist du wieder dran.",
    );
    await playback(call, bytes);
  }
  await pause(call, 450);
  arm(call);
}

toggle.addEventListener("click", () => {
  if (active)
    end("idle", "Anruf beendet", "Du kannst jederzeit wieder anrufen.");
  else void begin();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && active?.stream)
    end(
      "idle",
      "Anruf pausiert",
      "Halte die Anrufseite im Vordergrund. Zum Fortsetzen erneut starten.",
    );
});
window.addEventListener("pagehide", () => {
  if (active)
    end("idle", "Anruf beendet", "Du kannst jederzeit wieder anrufen.");
});
present(
  "idle",
  "Bereit zum Anrufen",
  "Sprich nach dem Start einfach los. Nod antwortet dir nach einer kurzen Sprechpause.",
);
// Fetch only account metadata; microphone permission always needs a button click.
fetch("/anruf/api/session", { credentials: "same-origin", cache: "no-store" })
  .then(async (response) => {
    if (active) return;
    if (response.status === 401) {
      $("header-chat").hidden = true;
      present(
        "idle",
        "Anmeldung erforderlich",
        "Melde dich an, um deinen Assistenten anzurufen.",
        "login",
      );
    } else if (response.ok) {
      const info = await response.json();
      if (!active && info.ok) {
        sessionInfo(info);
        present(
          "idle",
          "Bereit zum Anrufen",
          "Sprich nach dem Start einfach los. " +
            agent +
            " antwortet dir nach einer kurzen Sprechpause.",
        );
      }
    }
  })
  .catch(() => {});
