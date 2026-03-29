// ============================================================
// PHASE VOCODER — FFT / IFFT
// ============================================================

function pvFFT(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const theta = -2.0 * Math.PI / len;
        const wRe = Math.cos(theta), wIm = Math.sin(theta);
        for (let i = 0; i < n; i += len) {
            let curRe = 1.0, curIm = 0.0;
            const half = len >> 1;
            for (let j = 0; j < half; j++) {
                const uRe = re[i + j], uIm = im[i + j];
                const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
                const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
                re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
                re[i + j + half] = uRe - vRe; im[i + j + half] = uIm - vIm;
                const nr = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe; curRe = nr;
            }
        }
    }
}

function pvIFFT(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    pvFFT(re, im);
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

// stretch < 1 → shorter output → faster playback (tempo up, pitch preserved)
// stretch > 1 → longer output → slower playback (tempo down, pitch preserved)
function phaseVocode(inputData, stretch) {
    const N = 2048;
    const baseHop = N >> 2;
    
    // Dynamic Hop allocation prevents phase breaking
    let Ha, Hs;
    if (stretch >= 1.0) {
        Hs = baseHop;
        Ha = Math.max(1, Math.round(Hs / stretch));
    } else {
        Ha = baseHop;
        Hs = Math.max(1, Math.round(Ha * stretch));
    }

    const TWO_PI = 2.0 * Math.PI;
    const inputLen = inputData.length;
    
    // Calculate precise output length to maintain perfect loop timing
    const outputLen = Math.round(inputLen * (Hs / Ha));
    const numFrames = Math.ceil(inputLen / Ha);

    if (numFrames < 1) return new Float32Array(inputLen);

    const output = new Float64Array(outputLen);
    const norm   = new Float64Array(outputLen);

    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 * (1.0 - Math.cos(TWO_PI * i / N));

    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const outRe = new Float64Array(N);
    const outIm = new Float64Array(N);
    const mag = new Float64Array(N);
    const curPhi = new Float64Array(N);
    const prevAnalysisPhi = new Float64Array(N);
    const synthPhi = new Float64Array(N);

    for (let frame = 0; frame < numFrames; frame++) {
        const inPos  = frame * Ha;
        const outPos = frame * Hs;

        // 1. CIRCULAR INPUT: Wrap the reading index around the buffer
        for (let i = 0; i < N; i++) {
            const s = (inPos + i) % inputLen; 
            re[i] = inputData[s] * win[i];
            im[i] = 0.0;
        }

        pvFFT(re, im);

        for (let k = 0; k < N; k++) {
            mag[k]    = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
            curPhi[k] = Math.atan2(im[k], re[k]);

            if (frame === 0) {
                synthPhi[k] = curPhi[k];
            } else {
                const expected = TWO_PI * k * Ha / N;
                let dphi = curPhi[k] - prevAnalysisPhi[k] - expected;
                dphi -= TWO_PI * Math.round(dphi / TWO_PI);
                synthPhi[k] += (TWO_PI * k / N + dphi / Ha) * Hs;
            }

            prevAnalysisPhi[k] = curPhi[k];
            outRe[k] = mag[k] * Math.cos(synthPhi[k]);
            outIm[k] = mag[k] * Math.sin(synthPhi[k]);
        }

        pvIFFT(outRe, outIm);

        // 2. CIRCULAR OVERLAP-ADD: Wrap the output writing index
        for (let i = 0; i < N; i++) {
            const oIdx = (outPos + i) % outputLen; 
            output[oIdx] += outRe[i] * win[i];
            norm[oIdx]   += win[i] * win[i];
        }
    }

    const result = new Float32Array(outputLen);
    
    // 3. Local Normalization works perfectly now because the norm array
    // is completely flat from start to finish due to the circular wrap!
    for (let i = 0; i < outputLen; i++) {
        if (norm[i] > 1e-6) {
            let v = output[i] / norm[i];
            if      (v >  1.0) v =  1.0;
            else if (v < -1.0) v = -1.0;
            result[i] = v;
        }
    }
    
    return result;
}


// ============================================================
// VUE APPLICATION
// ============================================================
const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

createApp({
    setup() {

        let audioCtx   = null;
        let masterGain = null;
        const fundamental = 440;

        const hasStarted    = ref(false);
        const isPlaying     = ref(false);
        const activeSection = ref(1);

        // Both sliders: speed = 25^sliderValue, range [-1,1], 0 = 1×
        const speedSlider   = ref(0);
        const pvSpeedSlider = ref(0);

        // Section 2
        const isMelodyMode = ref(false);
        let oscillators  = [];
        let melodyBuffer = null;
        let melodySource = null;

        // Section 3
        const pvEnabled       = ref(true);
        const pvIsMelodyMode3 = ref(true);
        const pvIsProcessing  = ref(false);
        let pvMelodyBuffer = null;
        let pvSynthBuffer  = null;
        let pvSource       = null;
        let pvDebounce     = null;

        const activeHarmonics = ref([true, false, false, false, false, false, false, false, false]);

        // -------------------------------------------------------
        // SPEED HELPERS
        // -------------------------------------------------------
        const logSpeed = (v) => Math.pow(25, parseFloat(v));
        const getSection2Speed = () => activeSection.value !== 2 ? 1.0 : logSpeed(speedSlider.value);
        const getPVSpeed       = () => logSpeed(pvSpeedSlider.value);
        const displaySpeed     = computed(() => getSection2Speed().toFixed(2));
        const pvDisplaySpeed   = computed(() => getPVSpeed().toFixed(2));

        // -------------------------------------------------------
        // AUDIO INIT
        // -------------------------------------------------------
        const initAudio = () => {
            if (audioCtx) return;
            audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 0.15;
            masterGain.connect(audioCtx.destination);

            // Melody buffer: C C G G A A G rest
            const sr      = audioCtx.sampleRate;
            const dur     = 4.0;
            melodyBuffer  = audioCtx.createBuffer(1, sr * dur, sr);
            const data    = melodyBuffer.getChannelData(0);
            const notes   = [261.63, 261.63, 392.00, 392.00, 440.00, 440.00, 392.00, 0];
            const noteDur = dur / notes.length;
            for (let i = 0; i < data.length; i++) {
                const t    = i / sr;
                const nIdx = Math.floor(t / noteDur);
                const tN   = t % noteDur;
                const freq = notes[nIdx];
                if (!freq) { data[i] = 0; continue; }
                const env = Math.exp(-6 * tN);
                data[i] = (Math.sin(2 * Math.PI * freq * tN)
                         + Math.sin(2 * Math.PI * freq * 2 * tN) * 0.3) * env * 0.6;
            }
        };

        // -------------------------------------------------------
        // SYNTH BUFFER (OfflineAudioContext render of current harmonics)
        // -------------------------------------------------------
        const generateSynthSourceBuffer = () => {
            const sr  = audioCtx.sampleRate;
            const dur = 2.0;
            const offCtx = new OfflineAudioContext(1, Math.ceil(sr * dur), sr);
            activeHarmonics.value.forEach((on, idx) => {
                if (!on) return;
                const mult = idx + 1;
                const osc  = offCtx.createOscillator();
                const gn   = offCtx.createGain();
                osc.type            = 'sine';
                osc.frequency.value = fundamental * mult;
                gn.gain.value       = (1 / mult) * 0.35;
                osc.connect(gn);
                gn.connect(offCtx.destination);
                osc.start(0);
                osc.stop(dur);
            });
            return offCtx.startRendering();
        };

        // -------------------------------------------------------
        // PV COMPUTATION
        // -------------------------------------------------------
        const stopPVSource = () => {
            if (pvSource) {
                try { pvSource.stop(); } catch (_) {}
                pvSource.disconnect();
                pvSource = null;
            }
        };

        const startPVPlayback = () => {
            stopPVSource();
            const buf = pvIsMelodyMode3.value ? pvMelodyBuffer : pvSynthBuffer;
            if (!buf || !isPlaying.value) return;
            pvSource = audioCtx.createBufferSource();
            pvSource.buffer = buf;
            pvSource.loop   = true;
            const g = audioCtx.createGain();
            g.gain.value = 5;
            pvSource.connect(g);
            g.connect(masterGain);
            pvSource.start();
        };

        const computePVBuffer = async (speed) => {
            if (!audioCtx || !melodyBuffer) return;
            pvIsProcessing.value = true;
            stopPVSource();
            await new Promise(r => setTimeout(r, 20));

            const stretch = 1.0 / speed;

            // --- Process melody ---
            if (Math.abs(speed - 1.0) < 0.02) {
                pvMelodyBuffer = melodyBuffer;
            } else {
                const raw = melodyBuffer.getChannelData(0);
                const out = phaseVocode(raw, stretch);
                pvMelodyBuffer = audioCtx.createBuffer(1, out.length, audioCtx.sampleRate);
                pvMelodyBuffer.getChannelData(0).set(out);
            }

            // --- Process synth (render oscillators then vocode) ---
            const synthSrc = await generateSynthSourceBuffer();
            if (Math.abs(speed - 1.0) < 0.02) {
                pvSynthBuffer = synthSrc;
            } else {
                const raw = synthSrc.getChannelData(0);
                const out = phaseVocode(raw, stretch);
                pvSynthBuffer = audioCtx.createBuffer(1, out.length, audioCtx.sampleRate);
                pvSynthBuffer.getChannelData(0).set(out);
            }

            pvIsProcessing.value = false;

            if (!isPlaying.value || activeSection.value !== 3) return;
            if (pvEnabled.value) startPVPlayback();
            else generateAudio();
        };

        // -------------------------------------------------------
        // AUDIO GENERATION
        // -------------------------------------------------------
        const clearAllAudio = () => {
            oscillators.forEach(o => { try { o.osc.stop(); } catch (_) {} o.osc.disconnect(); });
            oscillators = [];
            if (melodySource) {
                try { melodySource.stop(); } catch (_) {}
                melodySource.disconnect(); melodySource = null;
            }
            stopPVSource();
        };

        const generateAudio = () => {
            if (!isPlaying.value) return;
            clearAllAudio();

            // --- Section 3 ---
            if (activeSection.value === 3) {
                if (pvEnabled.value) {
                    const buf = pvIsMelodyMode3.value ? pvMelodyBuffer : pvSynthBuffer;
                    if (buf && !pvIsProcessing.value) {
                        startPVPlayback();
                    } else if (!pvIsProcessing.value) {
                        computePVBuffer(getPVSpeed());
                    }
                } else {
                    // Non-PV: chipmunk / pitch-shifted
                    const spd = getPVSpeed();
                    if (pvIsMelodyMode3.value) {
                        melodySource = audioCtx.createBufferSource();
                        melodySource.buffer = melodyBuffer;
                        melodySource.loop   = true;
                        melodySource.playbackRate.value = spd;
                        const g = audioCtx.createGain(); g.gain.value = 1.2;
                        melodySource.connect(g); g.connect(masterGain);
                        melodySource.start();
                    } else {
                        activeHarmonics.value.forEach((on, idx) => {
                            if (!on) return;
                            const mult = idx + 1;
                            const osc  = audioCtx.createOscillator();
                            const gn   = audioCtx.createGain();
                            osc.type            = 'sine';
                            osc.frequency.value = fundamental * mult * spd;
                            gn.gain.value       = 1 / mult;
                            osc.connect(gn); gn.connect(masterGain);
                            osc.start();
                            oscillators.push({ osc, harmonic: mult });
                        });
                    }
                }
                return;
            }

            // --- Section 2: melody chipmunk ---
            if (activeSection.value === 2 && isMelodyMode.value) {
                melodySource = audioCtx.createBufferSource();
                melodySource.buffer = melodyBuffer;
                melodySource.loop   = true;
                melodySource.playbackRate.value = getSection2Speed();
                const g = audioCtx.createGain(); g.gain.value = 1.2;
                melodySource.connect(g); g.connect(masterGain);
                melodySource.start();
                return;
            }

            // --- Oscillator bank (sections 1 & 2-synth) ---
            const speedMult = (activeSection.value === 2 && !isMelodyMode.value)
                              ? getSection2Speed() : 1.0;
            activeHarmonics.value.forEach((on, idx) => {
                if (!on) return;
                const mult = idx + 1;
                const osc  = audioCtx.createOscillator();
                const gn   = audioCtx.createGain();
                osc.type            = 'sine';
                osc.frequency.value = fundamental * mult * speedMult;
                gn.gain.value       = 1 / mult;
                osc.connect(gn); gn.connect(masterGain);
                osc.start();
                oscillators.push({ osc, harmonic: mult });
            });
        };

        // -------------------------------------------------------
        // USER INTERACTIONS
        // -------------------------------------------------------
        const startExperience = () => {
            initAudio();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            hasStarted.value = true;
            isPlaying.value  = true;
            generateAudio();
            setTimeout(() => {
                [waveCanvas1.value, waveCanvas2.value, waveCanvas3.value].forEach(c => {
                    if (c) { c.width = c.offsetWidth; c.height = c.offsetHeight; }
                });
                document.documentElement.classList.remove('no-scroll');
                document.body.classList.remove('no-scroll');
                document.getElementById('section-1').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
        };

        const skipToVisualizer = () => {
            initAudio();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            hasStarted.value    = true;
            isPlaying.value     = true;
            activeSection.value = 3;
            computePVBuffer(getPVSpeed());
            setTimeout(() => {
                [waveCanvas1.value, waveCanvas2.value, waveCanvas3.value].forEach(c => {
                    if (c) { c.width = c.offsetWidth; c.height = c.offsetHeight; }
                });
                document.documentElement.classList.remove('no-scroll');
                document.body.classList.remove('no-scroll');
                document.getElementById('section-3').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
        };

        const toggleSound = () => {
            if (!hasStarted.value) return;
            initAudio();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            if (isPlaying.value) { clearAllAudio(); isPlaying.value = false; }
            else { isPlaying.value = true; generateAudio(); }
        };

        const handleSliderInput = () => {
            if (!isPlaying.value) return;
            const spd = getSection2Speed();
            if (activeSection.value === 2 && isMelodyMode.value) {
                if (melodySource) melodySource.playbackRate.setTargetAtTime(spd, audioCtx.currentTime, 0.05);
            } else {
                oscillators.forEach(o =>
                    o.osc.frequency.setTargetAtTime(fundamental * o.harmonic * spd, audioCtx.currentTime, 0.05)
                );
            }
        };
        const handleSliderChange = () => {
            if (isPlaying.value && activeSection.value === 2) generateAudio();
        };

        // Section 3 slider: live scrub when PV off, debounced recompute when PV on
        const handlePVSliderInput = () => {
            if (!isPlaying.value || activeSection.value !== 3 || pvEnabled.value) return;
            const spd = getPVSpeed();
            if (pvIsMelodyMode3.value && melodySource) {
                melodySource.playbackRate.setTargetAtTime(spd, audioCtx.currentTime, 0.05);
            } else {
                oscillators.forEach(o =>
                    o.osc.frequency.setTargetAtTime(fundamental * o.harmonic * spd, audioCtx.currentTime, 0.05)
                );
            }
        };
        const handlePVSliderChange = () => {
            if (pvEnabled.value) {
                clearTimeout(pvDebounce);
                pvDebounce = setTimeout(() => computePVBuffer(getPVSpeed()), 80);
            } else if (isPlaying.value && activeSection.value === 3) {
                generateAudio();
            }
        };

        const setMelodyMode  = (v) => { isMelodyMode.value = v;   if (isPlaying.value) generateAudio(); };

        const setPVMelodyMode = (v) => {
            pvIsMelodyMode3.value = v;
            if (!isPlaying.value || activeSection.value !== 3) return;
            if (pvEnabled.value) startPVPlayback();
            else generateAudio();
        };

        const setPVEnabled = (v) => {
            pvEnabled.value = v;
            if (!isPlaying.value || activeSection.value !== 3) return;
            if (v && !pvMelodyBuffer && !pvSynthBuffer) {
                computePVBuffer(getPVSpeed());
            } else {
                generateAudio();
            }
        };

        const toggleHarmonic = (idx) => {
            activeHarmonics.value[idx] = !activeHarmonics.value[idx];
            if (!isPlaying.value) return;
            if (activeSection.value === 3 && pvEnabled.value && !pvIsMelodyMode3.value) {
                clearTimeout(pvDebounce);
                pvDebounce = setTimeout(() => computePVBuffer(getPVSpeed()), 80);
            } else {
                generateAudio();
            }
        };

        const setCombo = (pat) => {
            activeHarmonics.value = [...pat];
            if (!isPlaying.value) return;
            if (activeSection.value === 3 && pvEnabled.value && !pvIsMelodyMode3.value) {
                clearTimeout(pvDebounce);
                pvDebounce = setTimeout(() => computePVBuffer(getPVSpeed()), 80);
            } else {
                generateAudio();
            }
        };

        // -------------------------------------------------------
        // VISUALISER
        // -------------------------------------------------------
        const waveCanvas1 = ref(null);
        const waveCanvas2 = ref(null);
        const waveCanvas3 = ref(null);
        let t1 = 0, t2 = 0, t3 = 0;
        let animId = null;

        const drawWaves = () => {
            // Section 1
            if (waveCanvas1.value && waveCanvas1.value.width > 0) {
                const ctx = waveCanvas1.value.getContext('2d');
                const w = waveCanvas1.value.width, h = waveCanvas1.value.height;
                ctx.clearRect(0, 0, w, h);
                ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 3;
                for (let x = 0; x < w; x++) {
                    let y = 0;
                    activeHarmonics.value.forEach((on, i) => { if (on) y += (1/(i+1)) * Math.sin((i+1)*(x*0.05+t1)); });
                    x === 0 ? ctx.moveTo(x, h/2 - y*60) : ctx.lineTo(x, h/2 - y*60);
                }
                ctx.stroke();
                t1 += 0.05;
            }

            // Section 2
            if (waveCanvas2.value && waveCanvas2.value.width > 0) {
                const ctx = waveCanvas2.value.getContext('2d');
                const w = waveCanvas2.value.width, h = waveCanvas2.value.height;
                const spd = getSection2Speed();
                const bf  = 0.05 * spd;
                ctx.clearRect(0, 0, w, h);
                ctx.beginPath();
                ctx.strokeStyle = isMelodyMode.value ? '#ef4444' : '#3b82f6';
                ctx.lineWidth = 3;
                for (let x = 0; x < w; x++) {
                    let y = 0;
                    if (isMelodyMode.value) {
                        const beat = ((x * bf * 0.1) - (t2 * 0.5)) % Math.PI;
                        const env  = Math.max(0, Math.sin(beat * 8)) * 0.8 + 0.2;
                        y = (Math.sin(x*bf*2 + t2*2)*0.6 + Math.sin(x*bf*4 - t2*3)*0.4) * env;
                    } else {
                        activeHarmonics.value.forEach((on, i) => { if (on) y += (1/(i+1)) * Math.sin((i+1)*(x*bf+t2)); });
                    }
                    x === 0 ? ctx.moveTo(x, h/2 - y*60) : ctx.lineTo(x, h/2 - y*60);
                }
                ctx.stroke();
                t2 += 0.05 * spd;
            }

            // Section 3
            if (waveCanvas3.value && waveCanvas3.value.width > 0) {
                const ctx   = waveCanvas3.value.getContext('2d');
                const w = waveCanvas3.value.width, h = waveCanvas3.value.height;
                const pvSpd = getPVSpeed();
                ctx.clearRect(0, 0, w, h);
                ctx.beginPath();

                if (pvEnabled.value) {
                    // PV ON: carrier pitch constant regardless of speed
                    // waveform scrolls at pvSpd but spatial frequency stays fixed
                    const PITCH = 0.05;
                    if (pvIsMelodyMode3.value) {
                        ctx.strokeStyle = '#8b5cf6';
                        ctx.lineWidth   = 2.5;
                        for (let x = 0; x < w; x++) {
                            const beat    = ((x * PITCH * 0.1) - (t3 * 0.5)) % Math.PI;
                            const env     = Math.max(0, Math.sin(beat * 8)) * 0.75 + 0.25;
                            const carrier = Math.sin(x*PITCH*2.0 + t3*2.0)*0.65 + Math.sin(x*PITCH*4.0 - t3*3.0)*0.35;
                            x === 0 ? ctx.moveTo(x, h/2 - carrier*env*60) : ctx.lineTo(x, h/2 - carrier*env*60);
                        }
                    } else {
                        ctx.strokeStyle = '#3b82f6';
                        ctx.lineWidth   = 3;
                        for (let x = 0; x < w; x++) {
                            let y = 0;
                            activeHarmonics.value.forEach((on, i) => { if (on) y += (1/(i+1)) * Math.sin((i+1)*(x*PITCH+t3)); });
                            x === 0 ? ctx.moveTo(x, h/2 - y*60) : ctx.lineTo(x, h/2 - y*60);
                        }
                    }
                    ctx.stroke();
                    t3 += 0.05 * pvSpd; // scroll speed scales, pitch doesn't

                } else {
                    // PV OFF: chipmunk — both scroll and pitch scale together
                    const bf = 0.05 * pvSpd;
                    if (pvIsMelodyMode3.value) {
                        ctx.strokeStyle = '#ef4444';
                        ctx.lineWidth   = 2.5;
                        for (let x = 0; x < w; x++) {
                            const beat    = ((x * bf * 0.1) - (t3 * 0.5)) % Math.PI;
                            const env     = Math.max(0, Math.sin(beat * 8)) * 0.75 + 0.25;
                            const carrier = Math.sin(x*bf*2.0 + t3*2.0)*0.65 + Math.sin(x*bf*4.0 - t3*3.0)*0.35;
                            x === 0 ? ctx.moveTo(x, h/2 - carrier*env*60) : ctx.lineTo(x, h/2 - carrier*env*60);
                        }
                    } else {
                        ctx.strokeStyle = '#ef4444';
                        ctx.lineWidth   = 3;
                        for (let x = 0; x < w; x++) {
                            let y = 0;
                            activeHarmonics.value.forEach((on, i) => { if (on) y += (1/(i+1)) * Math.sin((i+1)*(x*bf+t3)); });
                            x === 0 ? ctx.moveTo(x, h/2 - y*60) : ctx.lineTo(x, h/2 - y*60);
                        }
                    }
                    ctx.stroke();
                    t3 += 0.05 * pvSpd;
                }
            }

            animId = requestAnimationFrame(drawWaves);
        };

        // -------------------------------------------------------
        // LIFECYCLE
        // -------------------------------------------------------
        onMounted(() => {
            window.scrollTo(0, 0);
            document.documentElement.classList.add('no-scroll');
            document.body.classList.add('no-scroll');
            drawWaves();

            const obs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (!e.isIntersecting) return;
                    const id  = e.target.id;
                    const sec = id === 'section-1' ? 1 : id === 'section-2' ? 2 : 3;
                    if (activeSection.value === sec) return;
                    activeSection.value = sec;
                    if (hasStarted.value && isPlaying.value) generateAudio();
                    if (sec === 3 && !pvIsProcessing.value) {
                        computePVBuffer(getPVSpeed());
                    }
                });
            }, { root: null, threshold: 0.5 });

            ['section-1', 'section-2', 'section-3'].forEach(id => {
                const el = document.getElementById(id); if (el) obs.observe(el);
            });
        });

        onUnmounted(() => { if (animId) cancelAnimationFrame(animId); });

        return {
            hasStarted, startExperience, skipToVisualizer, isPlaying, toggleSound,
            activeHarmonics, toggleHarmonic, setCombo,
            speedSlider, displaySpeed, handleSliderInput, handleSliderChange,
            isMelodyMode, setMelodyMode,
            waveCanvas1, waveCanvas2, waveCanvas3,
            pvSpeedSlider, pvDisplaySpeed,
            pvIsProcessing,
            pvEnabled, setPVEnabled,
            pvIsMelodyMode3, setPVMelodyMode,
            handlePVSliderInput, handlePVSliderChange,
        };
    }
}).mount('#app');
