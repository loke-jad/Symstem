import { Injectable, signal } from '@angular/core';

export interface Brick {
  id: string;
  name: string;
  code: string; // 'FX', 'KY', 'PD', 'LD', 'VX', 'DR', 'BS'
  instrument: 'synth' | 'bass' | 'drum' | 'pad' | 'melody';
  muted: boolean;
  solo: boolean;
  volume: number;     // bright is loud (0.0 to 1.0)
  isFast: boolean;     // streaked is fast (tempo arpeggiator or note density)
  hasBleed: boolean;   // dashed means bleed (adds visual dashed border + Web Audio delay)
  bars: number;
  verified_stem: boolean;
  notes?: string;
  synth_params?: {
    type: 'synth' | 'bass' | 'drum' | 'pad' | 'melody';
    frequencies: number[];
  };
}

@Injectable({
  providedIn: 'root'
})
export class AudioEngine {
  // Public state signals
  readonly isPlaying = signal<boolean>(false);
  readonly currentBeat = signal<number>(0);

  // Private Web Audio state
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private schedulerTimerId: any = null;
  private nextNoteTime = 0.0;
  private beatCounter = 0; // keeps track of internal absolute beat count

  // Closures to retrieve dynamic track list and tempo from the caller (signals)
  private getBricksFn: (() => Brick[]) | null = null;
  private getTempoFn: (() => number) | null = null;

  initAudio() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 0.75;

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
    }
    
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  start(getBricks: () => Brick[], getTempo: () => number) {
    this.initAudio();
    if (this.isPlaying()) return;

    this.getBricksFn = getBricks;
    this.getTempoFn = getTempo;
    
    this.isPlaying.set(true);
    this.beatCounter = 0;
    this.currentBeat.set(0);
    this.nextNoteTime = this.audioCtx!.currentTime;

    // Beat scheduler cycle
    this.schedulerTimerId = setInterval(() => {
      this.scheduleBeats();
    }, 100);
  }

  stop() {
    this.isPlaying.set(false);
    if (this.schedulerTimerId) {
      clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
    this.getBricksFn = null;
    this.getTempoFn = null;
  }

  private scheduleBeats() {
    if (!this.audioCtx || !this.getTempoFn) return;
    const lookahead = 0.150; // seconds
    const tempo = this.getTempoFn();

    while (this.nextNoteTime < this.audioCtx.currentTime + lookahead) {
      const step = this.beatCounter % 16;
      this.currentBeat.set(step);
      
      this.playBeat(step, this.nextNoteTime);
      this.advanceBeat(tempo);
    }
  }

  private advanceBeat(tempo: number) {
    const secondsPerBeat = 60.0 / tempo;
    const tickDuration = secondsPerBeat / 4; // Sixteenth note subdivisions
    this.nextNoteTime += tickDuration;
    this.beatCounter++;
  }

  private playBeat(step: number, time: number) {
    if (!this.audioCtx || !this.masterGain || !this.getBricksFn) return;

    const bricks = this.getBricksFn();
    const activeSoloBricks = bricks.filter(b => b.solo && !b.muted);
    const useSoloMode = activeSoloBricks.length > 0;

    bricks.forEach(brick => {
      if (brick.muted) return;
      if (useSoloMode && !brick.solo) return;

      const p = brick.synth_params;
      if (!p) return;

      const currentVal = brick.volume;
      if (currentVal <= 0.01) return;

      const isAltStep = step % 2 === 0;
      const shouldTrigger = brick.isFast ? true : isAltStep;

      let destination: AudioNode = this.masterGain!;
      if (brick.hasBleed) {
        const delay = this.audioCtx!.createDelay(1.0);
        delay.delayTime.setValueAtTime(0.25, time);
        const feedback = this.audioCtx!.createGain();
        feedback.gain.setValueAtTime(0.35, time);

        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(this.masterGain!);
        destination = delay;
      }

      if (p.type === 'drum') {
        const beatNum = step % 8;
        if ((beatNum === 0 || beatNum === 4) && shouldTrigger) {
          this.synthesizeDrumSound('kick', time, currentVal, destination);
        }
        if ((beatNum === 2 || beatNum === 6) && shouldTrigger) {
          this.synthesizeDrumSound('snare', time, currentVal, destination);
        }
        if (brick.isFast) {
          if (step % 2 !== 0) {
            this.synthesizeDrumSound('hihat', time, currentVal * 0.35, destination);
          }
        } else {
          if (beatNum % 2 !== 0 && shouldTrigger) {
            this.synthesizeDrumSound('hihat', time, currentVal * 0.3, destination);
          }
        }
      } else if (p.type === 'bass') {
        const bassNotes = p.frequencies?.length > 0 ? p.frequencies : [55.00, 65.41, 73.42, 82.41];
        const noteIndex = Math.floor(step / (brick.isFast ? 1 : 2)) % bassNotes.length;
        const noteFreq = bassNotes[noteIndex];
        
        if (shouldTrigger) {
          const bassDuration = brick.isFast ? 0.2 : 0.45;
          this.synthesizeBassSynth(noteFreq, time, bassDuration, currentVal, destination);
        }
      } else if (p.type === 'synth' || p.type === 'melody') {
        const synthNotes = p.frequencies?.length > 0 ? p.frequencies : [220.00, 261.63, 329.63, 392.00];
        const stepPattern = [0, 2, 1, 3, 2, 0, 3, 1];
        const seqIdx = stepPattern[step % stepPattern.length];
        const noteFreq = synthNotes[seqIdx % synthNotes.length];

        if (shouldTrigger) {
          const leadDuration = brick.isFast ? 0.12 : 0.25;
          this.synthesizeLeadSynth(noteFreq, time, leadDuration, currentVal, destination);
        }
      } else if (p.type === 'pad') {
        if (step % 8 === 0) {
          const padNotes = p.frequencies || [130.81, 164.81, 196.00];
          padNotes.forEach(f => {
            this.synthesizePadSynth(f, time, 1.2, currentVal * 0.35, destination);
          });
        }
      }
    });
  }

  private synthesizeDrumSound(type: 'kick' | 'snare' | 'hihat', time: number, vol: number, target: AudioNode) {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const gainNode = this.audioCtx.createGain();
    gainNode.connect(target);

    if (type === 'kick') {
      osc.connect(gainNode);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(115, time);
      osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);

      gainNode.gain.setValueAtTime(vol * 0.9, time);
      gainNode.gain.exponentialRampToValueAtTime(0.01, time + 0.14);

      osc.start(time);
      osc.stop(time + 0.15);
    } else if (type === 'snare') {
      osc.connect(gainNode);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(185, time);

      gainNode.gain.setValueAtTime(vol * 0.55, time);
      gainNode.gain.exponentialRampToValueAtTime(0.01, time + 0.11);

      osc.start(time);
      osc.stop(time + 0.12);
    } else if (type === 'hihat') {
      osc.connect(gainNode);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(9500, time);

      gainNode.gain.setValueAtTime(vol * 0.25, time);
      gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      osc.start(time);
      osc.stop(time + 0.05);
    }
  }

  private synthesizeBassSynth(freq: number, time: number, duration: number, vol: number, target: AudioNode) {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const filter = this.audioCtx.createBiquadFilter();
    const gainNode = this.audioCtx.createGain();

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(target);

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(160, time);
    filter.frequency.exponentialRampToValueAtTime(80, time + duration);

    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(vol * 0.55, time + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.start(time);
    osc.stop(time + duration);
  }

  private synthesizeLeadSynth(freq: number, time: number, duration: number, vol: number, target: AudioNode) {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const filter = this.audioCtx.createBiquadFilter();
    const gainNode = this.audioCtx.createGain();

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(target);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1100, time);
    filter.frequency.exponentialRampToValueAtTime(450, time + duration);

    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(vol * 0.4, time + 0.006);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.start(time);
    osc.stop(time + duration);
  }

  private synthesizePadSynth(freq: number, time: number, duration: number, vol: number, target: AudioNode) {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const gainNode = this.audioCtx.createGain();

    osc.connect(gainNode);
    gainNode.connect(target);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);

    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(vol * 0.35, time + 0.22);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.start(time);
    osc.stop(time + duration);
  }
}
