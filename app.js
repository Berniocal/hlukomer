/* Hlukoměr PWA
   - měří RMS úroveň zvuku z mikrofonu (dBFS) a přes offset ji přepočítá na „dB SPL“ (orientačně).
   - A-vážení je přibližné (jednoduchý biquad high-shelf + low-shelf + peaking).
*/
(() => {
  const $ = (id) => document.getElementById(id);

  const startBtn = $("startBtn");
  const stopBtn  = $("stopBtn");
  const resetBtn = $("resetBtn");

  const dbOut = $("dbOut");
  const unitOut = $("unitOut");
  const subOut = $("subOut");
  const statusPill = $("statusPill");

  const instOut = $("instOut");
  const maxOut  = $("maxOut");
  const minOut  = $("minOut");
  const avgOut  = $("avgOut");
  const bar = $("bar");

  const permWarn = $("permWarn");
  const okInfo = $("okInfo");

  const aWeight = $("aWeight");
  const holdPeak = $("holdPeak");

  const offsetRange = $("offsetRange");
  const offsetNum = $("offsetNum");
  const showSPL = $("showSPL");

  const canvas = $("chart");
  const ctx2d = canvas.getContext("2d");

  // --- persistent settings
  const LS_OFFSET = "noiseMeterOffsetDB";
  const LS_SHOWSPL = "noiseMeterShowSPL";
  const LS_AWEIGHT = "noiseMeterAWeight";
  const LS_HOLDPEAK = "noiseMeterHoldPeak";

  function loadNum(key, fallback){
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  let offsetDB = loadNum(LS_OFFSET, 40); // default: +40 dB (hrubý odhad, ať to „vypadá“ jako SPL)
  offsetRange.value = String(offsetDB);
  offsetNum.value = String(offsetDB);

  showSPL.checked = (localStorage.getItem(LS_SHOWSPL) ?? "1") === "1";
  aWeight.checked = (localStorage.getItem(LS_AWEIGHT) ?? "0") === "1";
  holdPeak.checked = (localStorage.getItem(LS_HOLDPEAK) ?? "1") === "1";

  function persist(){
    localStorage.setItem(LS_OFFSET, String(offsetDB));
    localStorage.setItem(LS_SHOWSPL, showSPL.checked ? "1" : "0");
    localStorage.setItem(LS_AWEIGHT, aWeight.checked ? "1" : "0");
    localStorage.setItem(LS_HOLDPEAK, holdPeak.checked ? "1" : "0");
  }

  offsetRange.addEventListener("input", () => {
    offsetDB = Number(offsetRange.value);
    offsetNum.value = String(offsetDB);
    persist();
    renderUnit();
  });
  offsetNum.addEventListener("input", () => {
    const n = Number(offsetNum.value);
    if (!Number.isFinite(n)) return;
    offsetDB = Math.min(80, Math.max(-40, n));
    offsetRange.value = String(offsetDB);
    persist();
    renderUnit();
  });
  showSPL.addEventListener("change", () => { persist(); renderUnit(); });
  aWeight.addEventListener("change", () => { persist(); rebuildWeighting(); });
  holdPeak.addEventListener("change", () => { persist(); });

  // --- audio state
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let stream = null;
  let raf = 0;

  let weightNode = null;  // destination of filters
  let filters = null;

  const buf = new Float32Array(2048);

  // stats
  let running = false;
  let t0 = 0;
  let minDB = Infinity;
  let maxDB = -Infinity;

  // history for chart (last 20s @ ~20fps)
  const HIST_MAX = 400;
  const hist = [];
  const histTime = [];

  // average window
  const avgWindowSec = 5;
  function avgLastSec(sec){
    const now = performance.now();
    let sum = 0, cnt = 0;
    for (let i = hist.length-1; i >= 0; i--){
      if ((now - histTime[i]) > sec*1000) break;
      sum += hist[i];
      cnt++;
    }
    return cnt ? sum/cnt : NaN;
  }

  function renderUnit(){
    unitOut.textContent = showSPL.checked ? "dB SPL" : "dBFS";
  }

  function fmt(v){
    if (!Number.isFinite(v)) return "--";
    return v.toFixed(1);
  }

  function setStatus(text){
    statusPill.textContent = text;
  }

  function showPermWarn(show){
    permWarn.style.display = show ? "block" : "none";
  }
  function showOk(show){
    okInfo.style.display = show ? "block" : "none";
  }

  function mapToBar(db){
    // Map to 0..100 % roughly across 30..100 dB SPL or -60..0 dBFS
    let p;
    if (showSPL.checked){
      p = (db - 30) / (100 - 30);
    } else {
      p = (db + 60) / 60;
    }
    p = Math.max(0, Math.min(1, p));
    return (p * 100);
  }

  function toDisplayDB(dbfs){
    return showSPL.checked ? (dbfs + offsetDB) : dbfs;
  }

  function computeRMSdBFS(){
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++){
      const x = buf[i];
      sum += x*x;
    }
    const rms = Math.sqrt(sum / buf.length);
    // Avoid -Inf
    const floor = 1e-8;
    const dbfs = 20 * Math.log10(Math.max(floor, rms));
    return dbfs;
  }

  function rebuildWeighting(){
    if (!audioCtx || !source) return;
    if (filters){
      try { filters.forEach(f => f.disconnect()); } catch(e){}
      filters = null;
    }
    if (weightNode){
      try { weightNode.disconnect(); } catch(e){}
      weightNode = null;
    }

    if (!aWeight.checked){
      source.connect(analyser);
      return;
    }

    // Simple "A-like" curve using 3 biquads:
    // - high-pass-ish (low shelf cut)
    // - mid peaking
    // - high shelf boost
    const f1 = audioCtx.createBiquadFilter();
    f1.type = "lowshelf";
    f1.frequency.value = 200;
    f1.gain.value = -10;

    const f2 = audioCtx.createBiquadFilter();
    f2.type = "peaking";
    f2.frequency.value = 1000;
    f2.Q.value = 1;
    f2.gain.value = +2;

    const f3 = audioCtx.createBiquadFilter();
    f3.type = "highshelf";
    f3.frequency.value = 3000;
    f3.gain.value = +4;

    source.disconnect();
    source.connect(f1);
    f1.connect(f2);
    f2.connect(f3);
    f3.connect(analyser);

    filters = [f1, f2, f3];
  }

  async function start(){
    if (running) return;

    showPermWarn(false);
    showOk(false);
    setStatus("žádám o mikrofon…");

    try{
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    } catch(err){
      console.error(err);
      setStatus("mikrofon nepovolen");
      showPermWarn(true);
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;

    source = audioCtx.createMediaStreamSource(stream);

    // connect (maybe with weighting)
    rebuildWeighting();

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    resetBtn.disabled = false;

    minDB = Infinity;
    maxDB = -Infinity;
    hist.length = 0;
    histTime.length = 0;
    t0 = performance.now();

    setStatus("měřím");
    showOk(true);
    renderUnit();
    loop();
  }

  function stop(){
    if (!running) return;
    running = false;

    cancelAnimationFrame(raf);

    try { if (source) source.disconnect(); } catch(e){}
    try { if (analyser) analyser.disconnect(); } catch(e){}
    try { if (filters) filters.forEach(f => f.disconnect()); } catch(e){}

    if (stream){
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (audioCtx){
      audioCtx.close();
      audioCtx = null;
    }

    analyser = null;
    source = null;
    filters = null;

    startBtn.disabled = false;
    stopBtn.disabled = true;

    setStatus("zastaveno");
    subOut.textContent = "Měření zastaveno.";
  }

  function resetMax(){
    minDB = Infinity;
    maxDB = -Infinity;
    maxOut.textContent = "--";
    minOut.textContent = "--";
  }

  function loop(){
    if (!running) return;

    const dbfs = computeRMSdBFS();
    const disp = toDisplayDB(dbfs);

    // update stats
    if (Number.isFinite(disp)){
      minDB = Math.min(minDB, disp);
      maxDB = Math.max(maxDB, disp);
    }

    const now = performance.now();
    hist.push(disp);
    histTime.push(now);
    if (hist.length > HIST_MAX){
      hist.shift();
      histTime.shift();
    }

    // Hold peak behavior: display max as "sticky peak" for the big number
    const bigVal = holdPeak.checked ? Math.max(disp, maxDB) : disp;

    dbOut.textContent = fmt(bigVal);
    instOut.textContent = fmt(disp);
    maxOut.textContent = fmt(maxDB);
    minOut.textContent = fmt(minDB);

    const avg = avgLastSec(avgWindowSec);
    avgOut.textContent = fmt(avg);

    const p = mapToBar(bigVal);
    bar.style.width = p.toFixed(1) + "%";

    subOut.textContent = showSPL.checked
      ? "Orientační dB SPL (s offsetem)."
      : "Relativní úroveň dBFS (bez kalibrace).";

    drawChart();

    raf = requestAnimationFrame(loop);
  }

  function drawChart(){
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0,0,w,h);

    // background grid
    ctx2d.globalAlpha = 1;
    ctx2d.lineWidth = 1;

    const pad = 24;
    const gx = 6;
    const gy = 5;

    ctx2d.strokeStyle = "rgba(148,163,184,.18)";
    for (let i=0;i<=gx;i++){
      const x = pad + (w-2*pad)*(i/gx);
      ctx2d.beginPath(); ctx2d.moveTo(x,pad); ctx2d.lineTo(x,h-pad); ctx2d.stroke();
    }
    for (let j=0;j<=gy;j++){
      const y = pad + (h-2*pad)*(j/gy);
      ctx2d.beginPath(); ctx2d.moveTo(pad,y); ctx2d.lineTo(w-pad,y); ctx2d.stroke();
    }

    // determine y range
    let yMin, yMax;
    if (showSPL.checked){
      yMin = 30; yMax = 110;
    } else {
      yMin = -60; yMax = 0;
    }

    // labels
    ctx2d.fillStyle = "rgba(229,231,235,.85)";
    ctx2d.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx2d.textAlign = "left";
    ctx2d.fillText(showSPL.checked ? "dB SPL" : "dBFS", pad, pad-8);

    ctx2d.textAlign = "right";
    for (let j=0;j<=gy;j++){
      const y = pad + (h-2*pad)*(j/gy);
      const val = yMax - (yMax-yMin)*(j/gy);
      ctx2d.fillStyle = "rgba(148,163,184,.85)";
      ctx2d.fillText(val.toFixed(0), w-pad+2, y+4);
    }

    // plot
    if (hist.length < 2) return;

    ctx2d.strokeStyle = "rgba(56,189,248,.95)";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    for (let i=0;i<hist.length;i++){
      const x = pad + (w-2*pad)*(i/(HIST_MAX-1));
      const v = hist[i];
      const t = (v - yMin) / (yMax - yMin);
      const y = (h-pad) - (h-2*pad)*t;
      if (i===0) ctx2d.moveTo(x,y);
      else ctx2d.lineTo(x,y);
    }
    ctx2d.stroke();

    // current marker
    const last = hist[hist.length-1];
    const tx = pad + (w-2*pad)*((hist.length-1)/(HIST_MAX-1));
    const tt = (last - yMin) / (yMax - yMin);
    const ty = (h-pad) - (h-2*pad)*tt;
    ctx2d.fillStyle = "rgba(251,113,133,.95)";
    ctx2d.beginPath(); ctx2d.arc(tx, ty, 4, 0, Math.PI*2); ctx2d.fill();
  }

  // events
  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);
  resetBtn.addEventListener("click", resetMax);

  // register service worker
  if ("serviceWorker" in navigator){
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(console.error);
    });
  }

  // initial
  renderUnit();
})();
