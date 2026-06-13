/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-inferrable-types, no-empty, prefer-const, @typescript-eslint/ban-ts-comment */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ReactiveFormsModule, FormControl } from '@angular/forms';
import { NgClass, DecimalPipe, UpperCasePipe } from '@angular/common';

import JSZip from 'jszip';

import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

const ICONS: Record<string, string> = {
  circle:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
  triDown: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 18L3 6h18z"/></svg>',
  triUp:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 6l9 12H3z"/></svg>',
  square:  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2.5"/></svg>',
  diamond: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l9 9-9 9-9-9z"/></svg>',
  pill:    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="8" width="18" height="8" rx="4"/></svg>',
  plus:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg>'
};

const INSTRUMENTS: Record<string, any> = {
  fx:     { code:'FX', name:'Texture / FX', icon:'plus',    mdur:'0.55s', mpeak:'45%' },
  keys:   { code:'KY', name:'Keys',         icon:'square',  mdur:'1.1s',  mpeak:'55%' },
  pad:    { code:'PD', name:'Pad',          icon:'pill',    mdur:'2.2s',  mpeak:'40%' },
  lead:   { code:'LD', name:'Lead',         icon:'triUp',   mdur:'0.42s', mpeak:'70%' },
  vocals: { code:'VX', name:'Vocals',       icon:'diamond', mdur:'1.5s',  mpeak:'60%' },
  drums:  { code:'DR', name:'Drums',        icon:'circle',  mdur:'0.24s', mpeak:'88%' },
  bass:   { code:'BS', name:'Bass',         icon:'triDown', mdur:'0.48s', mpeak:'78%' }
};

const LANE_ORDER = ['fx','keys','pad','lead','vocals','drums','bass'];

export function base64ToArrayBuffer(base64: string) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [ReactiveFormsModule, DecimalPipe, UpperCasePipe],
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  cd = inject(ChangeDetectorRef);
  
  theme = signal<'midnight' | 'paper'>('midnight');
  isPlaying = signal(false);
  agentStatus = signal('The band is idle. Describe something.');
  
  chatHistory = signal<{id: string, role: 'user'|'agent', text: string}[]>([
    { id: 'start', role: 'agent', text: 'Welcome to Symstem. Describe a track to get started.' }
  ]);
  
  loopLabTab = signal<'L1'|'L2'|'L3'>('L1');
  
  showLegendairyModal = signal(false);
  isVerified18Plus = signal(false);
  
  // Yjs
  ydoc = new Y.Doc();
  yprovider: WebsocketProvider | null = null;
  yCollabSpace = this.ydoc.getMap('collabSpace');

  promptCtrl = new FormControl('');
  isGenerating = signal(false);
  
  spec = signal<any>(null);
  bricks = signal<any[]>([]);
  selectedBrickId = signal<string | null>(null);
  
  history = signal<{bricks: any[], spec: any}[]>([]);
  future = signal<{bricks: any[], spec: any}[]>([]);
  
  lanes = LANE_ORDER;
  icons = ICONS;
  instruments = INSTRUMENTS;

  audioCtx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  freqData = new Uint8Array(0);
  audioBuffers = new Map<string, AudioBuffer>();
  activeSources: AudioBufferSourceNode[] = [];
  
  rafId: number = 0;
  startTime: number = 0;
  
  bpmTimeout: any;
  lastTapTime: number = 0;
  tapCount: number = 0;
  tapSum: number = 0;
  
  draggingAutoNodeIndex = -1;
  draggingAutoNodeBrickId = '';
  
  @ViewChild('playheadInfo', { static: false }) playhead!: ElementRef<HTMLDivElement>;
  @ViewChild('eqCanvas', { static: false }) eqCanvas!: ElementRef<HTMLCanvasElement>;

  selectedBrick = computed(() => {
    return this.bricks().find(b => b.id === this.selectedBrickId());
  });

  ngOnInit() {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('symstem-theme') as 'midnight' | 'paper';
      if (saved) {
        this.theme.set(saved);
        document.documentElement.setAttribute('data-theme', saved);
      }
    }
  }

  ngOnDestroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.stopPlaying();
  }

  toggleTheme() {
    const next = this.theme() === 'midnight' ? 'paper' : 'midnight';
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('symstem-theme', next); } catch (e) {}
  }

  async play() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioContext();
      this.masterGain = this.audioCtx.createGain();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
    }
    await this.audioCtx.resume();

    if (this.isPlaying()) {
      this.stopPlaying();
    } else {
      this.startPlaying();
    }
  }

  startPlaying() {
    if (!this.audioCtx || !this.masterGain) return;
    this.isPlaying.set(true);
    this.startTime = this.audioCtx.currentTime + 0.1;
    const bpm = this.spec()?.bpm || 120;
    const secPerBeat = 60 / bpm;
    const secPerBar = secPerBeat * 4;

    const hasSolo = this.bricks().some(b => b.solo);

    this.bricks().forEach(b => {
      if (b.muted) return;
      if (hasSolo && !b.solo) return;

      const buf = this.audioBuffers.get(b.id);
      if (!buf) return;
      
      const placements = [0, 4, 8, 12, 16, 20];
      const exactDuration = b.bars * secPerBar; 

      for (const startBar of placements) {
        const source = this.audioCtx!.createBufferSource();
        source.buffer = buf;
        source.loop = true;
        
        // Setup local gain for volume per brick
        const localGain = this.audioCtx!.createGain();
        if (b.automation && b.automation.length > 0) {
          localGain.gain.setValueAtTime(b.automation[0].y, this.startTime + startBar * secPerBar);
          for (let i = 1; i < b.automation.length; i++) {
            localGain.gain.linearRampToValueAtTime(b.automation[i].y, this.startTime + startBar * secPerBar + b.automation[i].x * exactDuration);
          }
        } else {
          localGain.gain.value = b.params.gain;
        }
        source.connect(localGain);
        localGain.connect(this.masterGain!);

        const pitchShift = b.params.pitch || 0;
        source.playbackRate.value = (bpm / b.bpm) * Math.pow(2, pitchShift / 12);

        // Start playing EXACTLY at schedule and stop EXACTLY after the bar length
        source.start(this.startTime + startBar * secPerBar, 0, exactDuration);
        this.activeSources.push(source);
      }
    });

    const loopLen = 24 * secPerBar; 
    
    const tick = () => {
      if (!this.isPlaying()) return;
      const el = this.audioCtx!.currentTime - this.startTime;
      if (el >= loopLen) {
        this.stopPlaying();
        this.startPlaying();
        return;
      }
      
      const bars = el / secPerBar;
      
      if (this.playhead?.nativeElement) {
        this.playhead.nativeElement.style.left = `calc(var(--gutter) + var(--barw) * ${bars})`;
      }

      if (this.analyser && this.eqCanvas?.nativeElement) {
        this.analyser.getByteFrequencyData(this.freqData);
        const cvs = this.eqCanvas.nativeElement;
        const ctx = cvs.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, cvs.width, cvs.height);
          const style = getComputedStyle(document.documentElement);
          ctx.fillStyle = style.getPropertyValue('--sky').trim() || '#38bdf8';
          // Start from index 1 to ignore DC offset if any, step by something or just draw what we have
          const barWidth = cvs.width / this.freqData.length;
          for (let i = 0; i < this.freqData.length; i++) {
            const pct = this.freqData[i] / 255;
            const h = cvs.height * pct;
            ctx.fillRect(i * barWidth, cvs.height - h, barWidth - 1, h);
          }
        }
      }

      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  stopPlaying() {
    this.activeSources.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    this.activeSources = [];
    this.isPlaying.set(false);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.playhead?.nativeElement) {
      this.playhead.nativeElement.style.left = 'var(--gutter)';
    }
    if (this.eqCanvas?.nativeElement) {
      const cvs = this.eqCanvas.nativeElement;
      const ctx = cvs.getContext('2d');
      ctx?.clearRect(0, 0, cvs.width, cvs.height);
    }
  }

  selectBrick(id: string) {
    this.selectedBrickId.set(id);
  }

  startCollab() {
    this.showLegendairyModal.set(true);
    if (this.isVerified18Plus()) {
      this.initYjs();
    }
  }

  verifyAge() {
    // Simulated Proof 18+ Verification Flow
    this.agentStatus.set('Redirecting to Proof 18+ Verification...');
    setTimeout(() => {
       this.isVerified18Plus.set(true);
       this.agentStatus.set('Verified 18+. Legendairy Workspace Unlocked.');
       this.initYjs();
    }, 1500);
  }

  initYjs() {
    if (this.yprovider) return;
    const wsUrl = location.protocol === 'https:' ? `wss://${location.host}/api/yjs` : `ws://${location.host}/api/yjs`;
    this.yprovider = new WebsocketProvider(wsUrl, 'loopster-collab-room-1', this.ydoc);
    
    this.yprovider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') {
        this.agentStatus.set('CRDT Sync Active via loopster-tunnel');
      }
    });

    this.yCollabSpace.observe(() => {
        // We could sync trackspecs over the wire using CRDTs
    });
    
    // Setup Local Camera Preview
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(stream => {
        const vid = document.getElementById('localCam') as HTMLVideoElement;
        if (vid) {
          vid.srcObject = stream;
          vid.play();
        }
      })
      .catch(err => console.warn('Cam error:', err));
  }

  async testStripeCheckout() {
    this.agentStatus.set('Initing test Stripe checkout...');
    try {
      const res = await fetch('/api/checkout', { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        this.agentStatus.set('Stripe mocked (preview key missing).');
      }
    } catch(err) {
      console.error(err);
    }
  }

  pushState() {
    const st = {
      bricks: JSON.parse(JSON.stringify(this.bricks())),
      spec: this.spec() ? JSON.parse(JSON.stringify(this.spec())) : null
    };
    this.history.update(h => [...h, st]);
    this.future.set([]);
  }

  undo() {
    const h = this.history();
    if (h.length === 0) return;
    const current = {
      bricks: JSON.parse(JSON.stringify(this.bricks())),
      spec: this.spec() ? JSON.parse(JSON.stringify(this.spec())) : null
    };
    this.future.update(f => [...f, current]);
    const prev = h[h.length - 1];
    this.history.update(val => val.slice(0, -1));
    this.bricks.set(prev.bricks);
    this.spec.set(prev.spec);
  }

  redo() {
    const f = this.future();
    if (f.length === 0) return;
    const current = {
      bricks: JSON.parse(JSON.stringify(this.bricks())),
      spec: this.spec() ? JSON.parse(JSON.stringify(this.spec())) : null
    };
    this.history.update(h => [...h, current]);
    const next = f[f.length - 1];
    this.future.update(val => val.slice(0, -1));
    this.bricks.set(next.bricks);
    this.spec.set(next.spec);
  }

  deleteBrick(id: string) {
    this.pushState();
    this.bricks.update(bs => bs.filter(b => b.id !== id));
    if (this.selectedBrickId() === id) {
      this.selectedBrickId.set(null);
    }
  }

  toggleMute(id: string) {
    this.pushState();
    this.bricks.update(bs => bs.map(b => {
      if (b.id === id) {
        return { ...b, muted: !b.muted };
      }
      return b;
    }));
  }

  toggleSolo(id: string) {
    this.pushState();
    this.bricks.update(bs => bs.map(b => {
      if (b.id === id) {
        return { ...b, solo: !b.solo };
      }
      return b;
    }));
  }

  updateVolume(e: Event, id: string) {
    const target = e.target as HTMLInputElement;
    const val = parseInt(target.value, 10) / 100;
    this.pushState();
    this.bricks.update(bs => bs.map(b => {
      if (b.id === id) {
        return { ...b, params: { ...b.params, gain: val } };
      }
      return b;
    }));
  }

  updatePitch(e: Event, id: string) {
    const target = e.target as HTMLInputElement;
    const val = parseInt(target.value, 10);
    this.pushState();
    this.bricks.update(bs => bs.map(b => {
      if (b.id === id) {
        return { ...b, params: { ...b.params, pitch: val } };
      }
      return b;
    }));
    if (this.isPlaying()) {
      clearTimeout(this.bpmTimeout);
      this.bpmTimeout = setTimeout(() => {
        this.stopPlaying();
        this.startPlaying();
      }, 500);
    }
  }

  updateBpm(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(val)) {
      this.spec.update(s => s ? { ...s, bpm: val } : s);
      
      if (this.isPlaying()) {
        clearTimeout(this.bpmTimeout);
        this.bpmTimeout = setTimeout(() => {
          this.stopPlaying();
          this.startPlaying();
        }, 500);
      }
    }
  }

  tapTempo() {
    const now = performance.now();
    if (now - this.lastTapTime > 2000) {
      this.tapCount = 1;
      this.tapSum = 0;
    } else {
      const diff = now - this.lastTapTime;
      const currentBpm = 60000 / diff;
      this.tapSum += currentBpm;
      this.tapCount++;
      const avgBpm = Math.round(this.tapSum / (this.tapCount - 1));
      const finalBpm = Math.max(60, Math.min(200, avgBpm));
      
      const currentSpec = this.spec();
      if (currentSpec && currentSpec.bpm !== finalBpm) {
        this.spec.update(s => s ? { ...s, bpm: finalBpm } : s);
        
        if (this.isPlaying()) {
          clearTimeout(this.bpmTimeout);
          this.bpmTimeout = setTimeout(() => {
            this.stopPlaying();
            this.startPlaying();
          }, 500);
        }
      }
    }
    this.lastTapTime = now;
  }

  getAutoNodes(brickId: string) {
    const b = this.bricks().find(x => x.id === brickId);
    if (!b) return [];
    if (!b.automation) return [{x: 0, y: b.params.gain}, {x: 1, y: b.params.gain}];
    return b.automation;
  }

  getAutoPoints(brickId: string) {
    const nodes = this.getAutoNodes(brickId);
    return nodes.map((pt: any) => `${pt.x * 100},${100 - pt.y * 100}`).join(' ');
  }

  startAutoNode(e: MouseEvent) {
    if (this.draggingAutoNodeIndex !== -1) return;
    const b = this.selectedBrick();
    if (!b) return;
    
    // Check if target is a circle (clicking on existing node)
    if ((e.target as HTMLElement).tagName.toLowerCase() === 'circle') return;

    const svg = e.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const bx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const by = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    this.pushState();
    let nodes = this.getAutoNodes(b.id).slice();
    nodes.push({x: bx, y: by});
    nodes.sort((n1: any, n2: any) => n1.x - n2.x);
    
    const idx = nodes.findIndex((n: any) => n.x === bx && n.y === by);
    this.draggingAutoNodeIndex = idx;
    this.draggingAutoNodeBrickId = b.id;

    this.bricks.update(bs => bs.map(brick => brick.id === b.id ? { ...brick, automation: nodes } : brick));
    
    // trigger playback rewrite if playing
    if (this.isPlaying()) {
      clearTimeout(this.bpmTimeout);
      this.bpmTimeout = setTimeout(() => {
        this.stopPlaying();
        this.startPlaying();
      }, 500);
    }
  }

  grabAutoNode(index: number, brickId: string) {
    this.pushState();
    this.draggingAutoNodeIndex = index;
    this.draggingAutoNodeBrickId = brickId;
  }

  moveAutoNode(e: MouseEvent) {
    if (this.draggingAutoNodeIndex === -1 || !this.draggingAutoNodeBrickId) return;
    
    const svg = e.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const bx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const by = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    this.bricks.update(bs => bs.map(brick => {
      if (brick.id === this.draggingAutoNodeBrickId) {
        let nodes = this.getAutoNodes(brick.id).slice();
        nodes[this.draggingAutoNodeIndex] = { x: bx, y: by };
        
        // Ensure first node is always at x=0, last at x=1
        if (this.draggingAutoNodeIndex === 0) nodes[0].x = 0;
        if (this.draggingAutoNodeIndex === nodes.length - 1) nodes[nodes.length - 1].x = 1;
        
        nodes.sort((n1: any, n2: any) => n1.x - n2.x);
        this.draggingAutoNodeIndex = nodes.findIndex((n: any) => n.x === bx && n.y === by);
        
        return { ...brick, automation: nodes };
      }
      return brick;
    }));
  }

  endAutoNode() {
    if (this.draggingAutoNodeIndex !== -1 && this.isPlaying()) {
      clearTimeout(this.bpmTimeout);
      this.bpmTimeout = setTimeout(() => {
        this.stopPlaying();
        this.startPlaying();
      }, 500);
    }
    this.draggingAutoNodeIndex = -1;
    this.draggingAutoNodeBrickId = '';
  }

  removeAutoNode(index: number, brickId: string) {
    this.pushState();
    this.bricks.update(bs => bs.map(brick => {
      if (brick.id === brickId) {
        let nodes = this.getAutoNodes(brick.id).slice();
        if (nodes.length > 2 && index > 0 && index < nodes.length - 1) { // can't remove first or last
           nodes.splice(index, 1);
        }
        return { ...brick, automation: nodes };
      }
      return brick;
    }));
  }

  async askBand(e: Event) {
    e.preventDefault();
    if (this.isGenerating()) return;
    
    const prompt = this.promptCtrl.value;
    if (!prompt) return;

    if (this.bricks().length > 0) {
      this.pushState();
    }

    this.isGenerating.set(true);
    this.agentStatus.set('Producer is briefing the band...');
    this.bricks.set([]);
    this.spec.set(null);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: prompt })
      });

      if (!response.body) throw new Error("No body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        while (buffer.includes('\n\n')) {
          const index = buffer.indexOf('\n\n');
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          
          if (!chunk) continue;
          
          const lines = chunk.split('\n');
          const eventLine = lines.find(l => l.startsWith('event: '));
          const dataLine = lines.find(l => l.startsWith('data: '));
          
          if (eventLine && dataLine) {
            const event = eventLine.replace('event: ', '').trim();
            const data = JSON.parse(dataLine.replace('data: ', '').trim());
            
            if (event === 'status') {
              this.agentStatus.set(data.message);
              this.chatHistory.update(h => {
                const newH = [...h];
                newH[newH.length - 1] = { ...newH[newH.length - 1], text: data.message };
                return newH;
              });
            } else if (event === 'spec') {
              this.spec.set(data);
            } else if (event === 'brick') {
              this.bricks.update(bs => [...bs, data]);
              
              if (typeof window !== 'undefined') {
                const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
                if (!this.audioCtx) this.audioCtx = new AudioContext();
                const ab = await this.audioCtx.decodeAudioData(base64ToArrayBuffer(data.audio_data));
                this.audioBuffers.set(data.id, ab);
              }

              this.agentStatus.set(`<span class="ok">✓</span> "${data.name}" landed — ${data.verified_stem ? 'verified stem' : 'with bleed warning'}.`);
              this.chatHistory.update(h => [...h, { id: Date.now().toString(), role: 'agent', text: `<span class="ok">✓</span> "${data.name}" landed — ${data.verified_stem ? 'verified stem' : 'with bleed warning'}.` }]);
              if (!this.selectedBrickId()) this.selectedBrickId.set(data.id);
            } else if (event === 'done') {
              this.isGenerating.set(false);
              this.chatHistory.update(h => [...h, { id: Date.now().toString(), role: 'agent', text: 'All done. Ready to arrange!' }]);
            } else if (event === 'error') {
              this.agentStatus.set('Error: ' + data.message);
              this.isGenerating.set(false);
            }
          }
        }
      }
    } catch (e: unknown) {
      this.agentStatus.set('Error: ' + (e as Error).message);
      this.isGenerating.set(false);
    }
  }

  getBricksForLane(lane: string) {
    // In MVP, we map instruments to our exact lane keys locally.
    return this.bricks().filter(b => {
      // Find the lane for the brick
      const I = Object.keys(INSTRUMENTS).find(k => b.instrument.toLowerCase().includes(k) || (k==='fx' && b.instrument.toLowerCase().includes('texture')) || (INSTRUMENTS[k].role && b.instrument.toLowerCase().includes(INSTRUMENTS[k].role.toLowerCase())) || (INSTRUMENTS[k].name && b.instrument.toLowerCase().includes(INSTRUMENTS[k].name.toLowerCase())));
      return (I || 'fx') === lane;
    });
  }

  bufferToWav(buffer: AudioBuffer) {
    let numOfChan = buffer.numberOfChannels,
        length = buffer.length * numOfChan * 2 + 44,
        bufferArr = new ArrayBuffer(length),
        view = new DataView(bufferArr),
        channels = [], i, sample,
        offset = 0,
        pos = 0;

    const setUint16 = (data: number) => {
      view.setUint16(pos, data, true);
      pos += 2;
    };
    const setUint32 = (data: number) => {
      view.setUint32(pos, data, true);
      pos += 4;
    };

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);  // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16);         // length = 16
    setUint16(1);          // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2);                    // block-align
    setUint16(16);                               // 16-bit
    setUint32(0x61746164); // "data" chunk
    setUint32(length - pos - 4); // chunk length

    for (i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    while(pos < length) {
      for (i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][offset])); 
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0; 
        view.setInt16(pos, sample, true); 
        pos += 2;
      }
      offset++
    }

    return new Blob([bufferArr], {type: "audio/wav"});
  }

  async exportWav() {
    if (!this.spec() || this.bricks().length === 0) return;
    this.agentStatus.set('Mixing down track locally...');
    
    const bpm = this.spec().bpm || 120;
    const secPerBeat = 60 / bpm;
    const secPerBar = secPerBeat * 4;
    const durationBars = 24;
    const exactDuration = durationBars * secPerBar;

    const sampleRate = 44100;
    // Context could have variable channel counts but standard is 2
    const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(2, sampleRate * exactDuration, sampleRate);
    
    const hasSolo = this.bricks().some(b => b.solo);

    this.bricks().forEach(b => {
      if (b.muted) return;
      if (hasSolo && !b.solo) return;

      const buf = this.audioBuffers.get(b.id);
      if (!buf) return;
      const placements = [0, 4, 8, 12, 16, 20];
      const brickDuration = b.bars * secPerBar;

      for (const startBar of placements) {
        const source = offlineCtx.createBufferSource();
        source.buffer = buf;
        source.loop = true;
        
        const localGain = offlineCtx.createGain();
        if (b.automation && b.automation.length > 0) {
          localGain.gain.setValueAtTime(b.automation[0].y, startBar * secPerBar);
          for (let i = 1; i < b.automation.length; i++) {
            localGain.gain.linearRampToValueAtTime(b.automation[i].y, startBar * secPerBar + b.automation[i].x * brickDuration);
          }
        } else {
          localGain.gain.value = b.params.gain;
        }
        source.connect(localGain);
        localGain.connect(offlineCtx.destination);
        
        const pitchShift = b.params.pitch || 0;
        source.playbackRate.value = (bpm / b.bpm) * Math.pow(2, pitchShift / 12);
        
        source.start(startBar * secPerBar, 0, brickDuration);
      }
    });

    const renderedBuffer = await offlineCtx.startRendering();
    
    // Normalize to -1dB (approx 0.89125) to prevent clipping
    const targetPeak = Math.pow(10, -1 / 20);
    let maxPeak = 0;
    for (let c = 0; c < renderedBuffer.numberOfChannels; c++) {
      const data = renderedBuffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const absVal = Math.abs(data[i]);
        if (absVal > maxPeak) maxPeak = absVal;
      }
    }
    if (maxPeak > 0) {
      const normalizeGain = targetPeak / maxPeak;
      for (let c = 0; c < renderedBuffer.numberOfChannels; c++) {
        const data = renderedBuffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          data[i] *= normalizeGain;
        }
      }
    }

    const wavBlob = this.bufferToWav(renderedBuffer);
    
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.spec().title.replace(/\s+/g, '_')}_mixdown.wav`;
    a.click();
    URL.revokeObjectURL(url);
    this.agentStatus.set('Mixdown completed and downloaded!');
  }

  async exportTrackpack() {
    if (!this.spec() || this.bricks().length === 0) return;
    this.agentStatus.set('Bundling trackpack...');

    const zip = new JSZip();
    
    // Add trackspec.json
    const specRaw = {
       version: "0.2",
       meta: {
          title: this.spec().title,
          bpm: this.spec().bpm,
          key: this.spec().key,
          time_sig: this.spec().time_sig,
          genre: this.spec().genre,
          length_bars: 24
       },
       tracks: this.lanes.map((lane, idx) => ({
          id: idx,
          name: this.instruments[lane].role,
          volume: 0.8,
          mute: false,
          solo: false,
          placements: this.getBricksForLane(lane).map(b => (
             [0, 4, 8, 12, 16, 20].map(startBar => ({
                brick: b.id,
                at_bar: startBar
             }))
          )).flat()
       })),
       bricks: this.bricks().map(b => {
         // Create a sanitized brick matching the schema
         const res = { ...b };
         delete res.audio_data;
         res.audio = `bricks/${b.id}.mp3`;
         return res;
       })
    };
    
    zip.file("trackspec.json", JSON.stringify(specRaw, null, 2));
    
    const bricksFolder = zip.folder("bricks");
    this.bricks().forEach(b => {
      if (b.audio_data) {
        const bytes = base64ToArrayBuffer(b.audio_data);
        bricksFolder!.file(`${b.id}.mp3`, bytes);
      }
    });

    const blob = await zip.generateAsync({type: "blob"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.spec().title.replace(/\s+/g, '_')}_trackpack.zip`;
    a.click();
    URL.revokeObjectURL(url);
    this.agentStatus.set('Trackpack bundled and downloaded!');
  }

  volToMult(v: number) { return (0.55 + (v / 100) * 0.60).toFixed(3); }
  tempoToStyle(bpm: number) {
    const t = Math.max(0, Math.min(1, (bpm - 70) / (170 - 70)));
    return { streak: (20 - t * 13).toFixed(1) + 'px', lean: (82 - t * 32).toFixed(0) + 'deg' };
  }

  getBrickStyle(b: any) {
    const I = Object.keys(INSTRUMENTS).find(k => b.instrument.toLowerCase().includes(k) || (k==='fx' && b.instrument.toLowerCase().includes('texture')) || (INSTRUMENTS[k].role && b.instrument.toLowerCase().includes(INSTRUMENTS[k].role.toLowerCase())) || (INSTRUMENTS[k].name && b.instrument.toLowerCase().includes(INSTRUMENTS[k].name.toLowerCase()))) || 'fx';
    const t = this.tempoToStyle(b.bpm);
    const volPct = Math.round(b.params.gain * 100);
    const bl = `var(--inst-${I}-l)`;
    const bc = `var(--inst-${I}-c)`;
    const bh = `var(--inst-${I}-h)`;

    return `--bl:${bl};--bc:${bc};--bh:${bh};--vol:${this.volToMult(volPct)};--streak:${t.streak};--lean:${t.lean};--pitch:${b.params.pitch || 0.5};--grain:0.1;--volpct:${volPct}%;width:calc(var(--barw) * 4 - 6px)`;
  }
}


