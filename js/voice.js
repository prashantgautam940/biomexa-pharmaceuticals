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

  // ---------- smooth player ----------
  // say(text, { apiUrl, speed, parts, onState(playing), onSentence(i, total) })
  // 1) Natural voice: the server's /api/tts (Gemini, warm pharmacist tone), fetched in short
  //    chunks a few ahead so playback starts fast and flows without gaps.
  // 2) Fallback: the device voice, queued all at once (no pause between sentences).
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  if (audio) audio.preload = 'auto';
  let run = 0, active = null, naturalOff = false;
  try { naturalOff = sessionStorage.getItem('biomexa_tts_off') === '1'; } catch {}
  // iOS only lets audio play from a tap: unlock the shared player on the first touch/click.
  const unlock = () => { if (!audio) return; try { audio.src = SILENT; const p = audio.play(); p && p.catch(() => {}); } catch {} };
  ['touchend', 'click'].forEach(ev => document.addEventListener(ev, function once() { unlock(); document.removeEventListener(ev, once, true); }, true));

  const splitSentences = t => (String(t).replace(/\*/g, '').match(/[^.!?।\n]+[.!?।]*/g) || [t]).map(s => s.trim()).filter(Boolean);
  function chunk(parts, max = 240) {
    const out = []; let cur = null;
    parts.forEach((s, i) => {
      if (cur && (cur.text + ' ' + s).length <= max) cur.text += ' ' + s;
      else { cur = { text: s, start: i }; out.push(cur); }
    });
    return out;
  }

  function stop() {
    run++;
    if (audio) { try { audio.pause(); } catch {} }
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    if (active) { active.ctrl && active.ctrl.abort(); const f = active.done; active = null; f && f(); }
  }

  function say(text, opts = {}) {
    stop();
    const my = ++run, parts = opts.parts || splitSentences(text), total = parts.length;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let started = false;
    const state = on => { if (on && started) return; started = on; opts.onState && opts.onState(on); };
    active = { ctrl, done: () => { state(false); opts.onSentence && opts.onSentence(-1, total); } };
    const finish = () => { if (my !== run) return; const f = active && active.done; active = null; f && f(); };
    const speed = opts.speed || 1;

    const device = (from) => {
      if (my !== run) return;
      if (!synth) { finish(); return; }
      if (from >= total) { finish(); return; }
      const go = () => {
        if (my !== run) return;
        for (let i = from; i < total; i++) {
          const u = new SpeechSynthesisUtterance(parts[i]);
          apply(u, parts[i], 0.95 * speed);
          u.onstart = () => { if (my !== run) return; state(true); opts.onSentence && opts.onSentence(i, total); };
          if (i === total - 1) { u.onend = finish; u.onerror = finish; }
          synth.speak(u);
        }
      };
      if (!synth.getVoices().length) { let gone = false; const once = () => { if (gone) return; gone = true; go(); }; synth.addEventListener('voiceschanged', once, { once: true }); setTimeout(once, 400); }
      else go();
    };

    if (!audio || !opts.apiUrl || naturalOff) { device(0); return; }
    unlock(); // inside the tap that started playback, so iOS allows the audio that follows
    const chunks = chunk(parts);
    const fetched = [];
    const get = i => {
      if (i >= chunks.length) return null;
      if (!fetched[i]) {
        fetched[i] = Promise.race([
          fetch(opts.apiUrl + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: chunks[i].text }), signal: ctrl && ctrl.signal })
            .then(r => { if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); }),
          new Promise((_, bad) => setTimeout(() => bad(new Error('tts timeout')), i === 0 ? 9000 : 20000))
        ]);
        fetched[i].catch(() => {});
      }
      return fetched[i];
    };
    const play = async i => {
      if (my !== run) return;
      if (i >= chunks.length) { finish(); return; }
      get(i + 1); get(i + 2); // prefetch ahead so there is no gap
      let blob;
      try { blob = await get(i); } catch (err) {
        if (my !== run) return;
        // Natural voice not set up on the server (503/4xx) → use the device voice for the rest of the visit.
        if (i === 0 && /tts (4|503)/.test(err.message)) { naturalOff = true; try { sessionStorage.setItem('biomexa_tts_off', '1'); } catch {} }
        device(chunks[i].start); return;
      }
      if (my !== run) return;
      const url = URL.createObjectURL(blob);
      audio.onended = () => { URL.revokeObjectURL(url); play(i + 1); };
      audio.onerror = () => { URL.revokeObjectURL(url); if (my === run) device(chunks[i].start); };
      audio.src = url; audio.playbackRate = speed;
      try { audio.preservesPitch = true; } catch {}
      try { await audio.play(); } catch (e) { if (my === run) device(chunks[i].start); return; }
      state(true); opts.onSentence && opts.onSentence(chunks[i].start, total);
    };
    play(0);
  }

  window.addEventListener('pagehide', stop);
  window.BiomexaVoice = { pick, apply, langFor, score, say, stop, splitSentences };
})();
