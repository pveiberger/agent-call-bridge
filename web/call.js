import { createCallClient } from "./call-client.js";

const $ = (id) => document.getElementById(id);
const toggle = $("toggle");
let active = false;
let chatUrl = "/";

const client = createCallClient({
  previewSession: true,
  onState(state) {
    active = state.active;
    document.body.dataset.phase = state.phase;
    $("status").textContent = state.status;
    $("detail").textContent = state.detail;
    $("label").textContent = active ? "Anruf beenden" : "Anruf starten";
    toggle.setAttribute("aria-pressed", String(active));
    const action = $("chat-action");
    action.hidden = !state.action || (state.action !== "login" && !chatUrl);
    action.href = state.action === "login" ? "/anruf/login" : chatUrl || "/anruf/";
    action.textContent = state.action === "login" ? "Zur Anmeldung ↗" : "Im Chat öffnen ↗";
  },
  onSession(info) {
    chatUrl = info.chatUrl;
    $("agent").textContent = info.agent;
    $("title").textContent = document.title = "Anruf mit " + info.agent;
    const headerChat = $("header-chat");
    headerChat.hidden = !chatUrl;
    if (chatUrl) headerChat.href = chatUrl;
  },
  onAnswer(text) {
    $("answer").textContent = text;
    $("last").hidden = false;
  },
});

toggle.addEventListener("click", () => {
  if (active) client.stop();
  else void client.start();
});
