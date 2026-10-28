// ========== BIOMEXA VOICE PICKER ==========
// Chooses the most natural voice the device offers for the AI Pharmacist / AI Assistant.
// Web pages can't use Siri's own voice, so on iPhone, iPad and Mac this picks Apple's best
// voices instead — Premium, then Enhanced (the same high-quality voices Apple uses for Spoken
// Content), preferring Indian English (Isha, Veena, Rishi) or Hindi (Lekha) — and Siri voices
// themselves when Safari on a Mac exposes them. Other devices get their best neural voice.
(function () {
  const synth = window.speechSynthesis;
  // Apple's joke/novelty voices — never use these for health advice.
  const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|eddy|flo|good news|grandma|grandpa|hysterical|jester|junior|organ|pipe organ|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox|fred|kathy)\b/i;
  const cache = {};

  function score(v, lang) {
    const name = `${v.name} ${v.voiceURI || ''}`;
    if (NOVELTY.test(v.name)) return -100;
    const vl = (v.lang || '').replace('_', '-');
    let s = 0;
    if (vl === lang) s += 40;
    else if (lang.startsWith('en') && vl === 'en-IN') s += 40;
    else if (lang.startsWith('en') && vl.startsWith('en')) s += 12;
    else if (vl.slice(0, 2) === lang.slice(0, 2)) s += 20;
    else return -50;
    if (/siri/i.test(name)) s += 45;                       // Siri voice, when Safari exposes it — always first choice
    if (/premium/i.test(name)) s += 25;                    // Apple Premium
    else if (/enhanced/i.test(name)) s += 18;              // Apple Enhanced
    if (/neural|natural|online/i.test(name)) s += 16;      // Microsoft / Google neural voices
    if (/\b(isha|veena|lekha|kajal|neerja|heera|swara)\b/i.test(v.name)) s += 8; // natural Indian female voices
    if (/\brishi\b/i.test(v.name)) s += 4;
    if (/com\.apple|^apple/i.test(name)) s += 3;
    if (/compact/i.test(name)) s -= 6;                     // low-quality Apple variant
    if (v.localService === false && !/neural|natural|online/i.test(name)) s -= 2;
    return s;
  }

  function pick(lang) {
    if (!synth) return null;
    if (cache[lang]) return cache[lang];
    const voices = synth.getVoices(); if (!voices.length) return null;
    let best = null, bestScore = 0;
    for (const v of voices) { const s = score(v, lang); if (s > bestScore) { bestScore = s; best = v; } }
    return (cache[lang] = best);
  }

  // Devanagari text is read in Hindi, everything else in Indian English.
  const langFor = text => /[ऀ-ॿ]/.test(text || '') ? 'hi-IN' : 'en-IN';

  // Sets lang, voice and a natural-sounding rate/pitch on an utterance.
  function apply(u, text, rate) {
    const lang = langFor(text);
    const v = pick(lang);
    u.lang = v ? v.lang : lang;
    if (v) u.voice = v;
    // Apple's enhanced voices already sound natural at 1.0; slightly slower helps older patients.
    u.rate = rate || 0.95; u.pitch = 1;
    return u;
  }

  if (synth && 'onvoiceschanged' in synth) synth.addEventListener('voiceschanged', () => { for (const k in cache) delete cache[k]; });
  window.BiomexaVoice = { pick, apply, langFor, score };
})();
