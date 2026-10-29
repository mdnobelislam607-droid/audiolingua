// AudioLingua AI - Cloudflare Worker (free tier) + Workers AI
// Speech->Text: Whisper | Translation: M2M100 | Text->Speech: MeloTTS

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB upload limit (free-friendly)
const MAX_TEXT = 1200; // max characters per translate/tts request

// MeloTTS supports only these languages (app code -> MeloTTS code)
const TTS_LANGS = { en: "en", es: "es", fr: "fr", zh: "zh", ja: "jp", ko: "kr" };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function guard(request, env) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: "Forbidden origin." }, 403);
  }
  if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
    return json({ error: "ACCESS_CODE_REQUIRED" }, 401);
  }
  return null;
}

function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/limit|quota|neuron|capacity|3036|4006/i.test(msg)) {
    return json({ error: "Daily free limit reached. Please try again tomorrow." }, 429);
  }
  return json({ error: "Service error: " + msg.slice(0, 200) }, 502);
}

async function transcribe(request, env) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return json({ error: "File too large (max 8 MB)." }, 413);
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: "Empty file." }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: "File too large (max 8 MB)." }, 413);

  const lang = (request.headers.get("x-lang") || "auto").toLowerCase();
  const input = { audio: toBase64(buf), task: "transcribe" };
  if (lang !== "auto" && /^[a-z]{2,3}$/.test(lang)) input.language = lang;

  const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", input);
  const text = ((out && out.text) || "").trim();
  if (!text) return json({ error: "No clear speech found in this audio." }, 422);
  const detected = out && out.transcription_info && out.transcription_info.language;
  return json({ text, language: detected || (lang !== "auto" ? lang : null) });
}

async function translate(request, env) {
  const { text, source, target } = await request.json();
  if (!text || !source || !target) return json({ error: "Missing fields." }, 400);
  if (text.length > MAX_TEXT) return json({ error: "Text chunk too long." }, 400);
  if (source === target) return json({ text });
  const out = await env.AI.run("@cf/meta/m2m100-1.2b", {
    text,
    source_lang: source,
    target_lang: target,
  });
  const t = ((out && out.translated_text) || "").trim();
  if (!t) return json({ error: "Translation failed." }, 502);
  return json({ text: t });
}

async function tts(request, env) {
  const { text, lang } = await request.json();
  if (!text || !lang) return json({ error: "Missing fields." }, 400);
  if (text.length > MAX_TEXT) return json({ error: "Text chunk too long." }, 400);
  const code = TTS_LANGS[lang];
  if (!code) return json({ error: "TTS_UNSUPPORTED" }, 501);
  const out = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang: code });
  const audio = typeof out === "string" ? out : out && out.audio;
  if (!audio) return json({ error: "Voice generation failed." }, 502);
  return json({ audio }); // base64 MP3
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const blocked = guard(request, env);
    if (blocked) return blocked;
    try {
      if (url.pathname === "/api/transcribe") return await transcribe(request, env);
      if (url.pathname === "/api/translate") return await translate(request, env);
      if (url.pathname === "/api/tts") return await tts(request, env);
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return friendlyError(e);
    }
  },
};
