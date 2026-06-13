import { Component, signal, computed, effect, ViewChild, ElementRef, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AudioEngine, Brick } from './audio';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnDestroy, AfterViewInit {
  title = 'Symstem';

  // State Signals
  bricks = signal<Brick[]>([
    {
      id: 'st-fx',
      name: 'Echoplex Vinyl Noise & Crackle',
      code: 'FX',
      instrument: 'synth',
      muted: false,
      solo: false,
      volume: 0.65,
      isFast: false,
      hasBleed: true,
      bars: 24,
      verified_stem: true,
      notes: 'Generates atmospheric noise floor, static dust, and tape delay spillover.',
      synth_params: { type: 'synth', frequencies: [800, 1200, 2400, 5000] }
    },
    {
      id: 'st-ky',
      name: 'Wurlitzer Electric Piano Progressions',
      code: 'KY',
      instrument: 'synth',
      muted: false,
      solo: false,
      volume: 0.8,
      isFast: false,
      hasBleed: false,
      bars: 24,
      verified_stem: true,
      notes: 'Soft neon electric chords moving down the cycle of fourths.',
      synth_params: { type: 'synth', frequencies: [261.63, 329.63, 392.00, 523.25] }
    },
    {
      id: 'st-pd',
      name: 'Vaporwave Stratus Air Pad',
      code: 'PD',
      instrument: 'pad',
      muted: false,
      solo: false,
      volume: 0.45,
      isFast: false,
      hasBleed: true,
      bars: 24,
      verified_stem: true,
      notes: 'Thick, lush warm wave pads with resonant filter bleed.',
      synth_params: { type: 'pad', frequencies: [130.81, 164.81, 196.00] }
    },
    {
      id: 'st-ld',
      name: 'Luminous Polyphonic Ribbon Lead',
      code: 'LD',
      instrument: 'melody',
      muted: false,
      solo: false,
      volume: 0.5,
      isFast: true,
      hasBleed: false,
      bars: 12,
      verified_stem: false,
      notes: 'Arpeggiated glowing square-wave lead on odd beats.',
      synth_params: { type: 'melody', frequencies: [329.63, 392.00, 440.00, 587.33] }
    },
    {
      id: 'st-vx',
      name: 'Resonator Vocal Synth Chops',
      code: 'VX',
      instrument: 'synth',
      muted: false,
      solo: false,
      volume: 0.55,
      isFast: false,
      hasBleed: true,
      bars: 24,
      verified_stem: true,
      notes: 'Formant chopped voice waves acting as lead counterpoint.',
      synth_params: { type: 'synth', frequencies: [220.00, 261.63, 329.63, 392.00] }
    },
    {
      id: 'st-dr',
      name: 'Slow Acetate Dusty Beat',
      code: 'DR',
      instrument: 'drum',
      muted: false,
      solo: false,
      volume: 0.75,
      isFast: true,
      hasBleed: false,
      bars: 24,
      verified_stem: true,
      notes: 'Kick and snare drums with hihat subdivisions.',
      synth_params: { type: 'drum', frequencies: [150, 200, 350, 450] }
    },
    {
      id: 'st-bs',
      name: 'Sub-bass 808 Saturator',
      code: 'BS',
      instrument: 'bass',
      muted: false,
      solo: false,
      volume: 0.85,
      isFast: false,
      hasBleed: false,
      bars: 24,
      verified_stem: true,
      notes: 'Subterranean bass line matching scale key fundamentals.',
      synth_params: { type: 'bass', frequencies: [55.00, 65.41, 73.42, 82.41] }
    }
  ]);

  chatHistory = signal<ChatMessage[]>([
    { id: '1', role: 'agent', text: 'Welcome to Symstem. Describe a track to get started. Describe a track — "dusty" Make loops.' }
  ]);

  currentTheme = signal<'canvas' | 'midnight' | 'solar' | 'emerald'>('canvas');
  activeScale = signal<string>('C MIN');
  activeBars = signal<number>(24);
  
  agentStatus = signal<string>('System idle. Ready to synthesize.');
  loopLabTab = signal<'L1' | 'L2' | 'L3'>('L1');
  selectedBrickId = signal<string | null>('st-ky');
  tempo = signal<number>(120);

  userInputText = '';
  isGenerating = false;

  // Audio Engine integration
  private audioEngine = inject(AudioEngine);
  isPlaying = this.audioEngine.isPlaying;
  currentBeat = this.audioEngine.currentBeat;

  // Tap tempo state
  private tapTimes: number[] = [];

  // Component local visualizer state
  private freqData = new Uint8Array(0);
  private rafId = 0;

  @ViewChild('eqCanvas', { static: false }) eqCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('waveCanvas', { static: false }) waveCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('chatScroll', { static: false }) chatScroll?: ElementRef<HTMLDivElement>;

  selectedBrick = computed(() => {
    return this.bricks().find(b => b.id === this.selectedBrickId());
  });

  // Watch for selected track change to redraw its waveform
  waveformEffect = effect(() => {
    const brick = this.selectedBrick();
    const tab = this.loopLabTab();
    // Redraw waveform asynchronously
    setTimeout(() => {
      this.drawSelectedWaveform();
    }, 50);
  });

  constructor() {}

  ngAfterViewInit() {
    this.drawSelectedWaveform();
    this.scrollToLatestMessage();
  }

  ngOnDestroy() {
    this.stopPlayback();
  }

  selectTheme(theme: 'canvas' | 'midnight' | 'solar' | 'emerald') {
    this.currentTheme.set(theme);
  }

  cycleScale() {
    const scales = ['C MIN', 'C MAJ', 'A MIN', 'G MAJ', 'Eb MAJ', 'D MIN'];
    const currentIdx = scales.indexOf(this.activeScale());
    const nextIdx = (currentIdx + 1) % scales.length;
    this.activeScale.set(scales[nextIdx]);
    
    // Scale transpositions
    const scaleBaseFreqs: Record<string, number[]> = {
      'C MIN': [130.81, 155.56, 196.00, 220.00],
      'C MAJ': [130.81, 146.83, 164.81, 196.00],
      'A MIN': [110.00, 130.81, 146.83, 164.81],
      'G MAJ': [98.00, 110.00, 123.47, 146.83],
      'Eb MAJ': [155.56, 174.61, 196.00, 233.08],
      'D MIN': [146.83, 174.61, 220.00, 261.63]
    };

    const newFreqs = scaleBaseFreqs[this.activeScale()] || [130.81, 146.83, 164.81, 196.00];

    // Update keys and lead frequencies according to scale transpose
    this.bricks.update(curr => curr.map(b => {
      if (b.id === 'st-ky' && b.synth_params) {
        return {
          ...b,
          synth_params: {
            ...b.synth_params,
            frequencies: newFreqs.map(f => f * 2)
          }
        };
      }
      if (b.id === 'st-ld' && b.synth_params) {
        return {
          ...b,
          synth_params: {
            ...b.synth_params,
            frequencies: newFreqs.map(f => f * 4)
          }
        };
      }
      if (b.id === 'st-bs' && b.synth_params) {
        return {
          ...b,
          synth_params: {
            ...b.synth_params,
            frequencies: newFreqs.map(f => f / 2)
          }
        };
      }
      return b;
    }));

    this.agentStatus.set(`Scale transposed to ${this.activeScale()}`);
  }

  cycleBars() {
    const barsList = [8, 16, 24, 32];
    const currentIdx = barsList.indexOf(this.activeBars());
    const nextIdx = (currentIdx + 1) % barsList.length;
    this.activeBars.set(barsList[nextIdx]);
    
    // update all bricks bars count
    this.bricks.update(curr => curr.map(b => ({ ...b, bars: this.activeBars() })));
    this.agentStatus.set(`Loop length locked at ${this.activeBars()} BARS`);
  }

  tapTempo() {
    const now = Date.now();
    // Filter click occurrences older than 2.0 seconds
    this.tapTimes = this.tapTimes.filter(t => now - t < 2000);
    this.tapTimes.push(now);

    if (this.tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this.tapTimes.length; i++) {
        intervals.push(this.tapTimes[i] - this.tapTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgInterval);
      if (bpm >= 60 && bpm <= 220) {
        this.tempo.set(bpm);
      }
    }
  }

  // Choose another tab or tool (L1, L2, L3)
  selectTab(tab: 'L1' | 'L2' | 'L3') {
    this.loopLabTab.set(tab);
  }

  selectBrick(id: string) {
    this.selectedBrickId.set(id);
  }

  togglePlay() {
    if (this.isPlaying()) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
  }

  startPlayback() {
    this.audioEngine.start(
      () => this.bricks(),
      () => this.tempo()
    );
    const analyser = this.audioEngine.getAnalyser();
    if (analyser) {
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    this.animateVisualizers();
  }

  stopPlayback() {
    this.audioEngine.stop();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    // Clean visualizers
    if (this.eqCanvas?.nativeElement) {
      const ctx = this.eqCanvas.nativeElement.getContext('2d');
      ctx?.clearRect(0, 0, this.eqCanvas.nativeElement.width, this.eqCanvas.nativeElement.height);
    }
  }

  // Animation frame loop for EQ Spectra analysis
  animateVisualizers() {
    if (!this.isPlaying()) return;

    const analyser = this.audioEngine.getAnalyser();
    if (analyser && this.eqCanvas?.nativeElement) {
      analyser.getByteFrequencyData(this.freqData);
      
      const canvas = this.eqCanvas.nativeElement;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Pick visual color based on the selected theme
        const theme = this.currentTheme();
        let barColor = '#4f46e5'; // indigo default
        if (theme === 'canvas') barColor = '#18181b';
        else if (theme === 'solar') barColor = '#b45309';
        else if (theme === 'emerald') barColor = '#10b981';
        else barColor = '#ea580c'; // midnight orange/sky

        ctx.fillStyle = barColor;
        const barWidth = Math.ceil(canvas.width / this.freqData.length);
        
        for (let i = 0; i < this.freqData.length; i++) {
          const val = this.freqData[i];
          const percent = val / 255;
          const h = percent * canvas.height;
          ctx.fillRect(i * barWidth, canvas.height - h, barWidth - 1.5, h);
        }
      }
    }

    this.rafId = requestAnimationFrame(() => this.animateVisualizers());
  }

  // Beautifully draw waveform peaks in a canvas
  drawSelectedWaveform() {
    const canvas = this.waveCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const width = Math.floor(rect.width || 340);
    const height = Math.floor(rect.height || 60);

    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;

    // Pick visual color based on selected theme
    const theme = this.currentTheme();
    let themeStroke = 'rgba(0, 0, 0, 0.1)';
    let graphStroke = '#18181b';
    if (theme === 'midnight') {
      themeStroke = 'rgba(255, 255, 255, 0.08)';
      graphStroke = '#f97316';
    } else if (theme === 'solar') {
      themeStroke = 'rgba(180, 83, 9, 0.1)';
      graphStroke = '#c2410c';
    } else if (theme === 'emerald') {
      themeStroke = 'rgba(16, 185, 129, 0.1)';
      graphStroke = '#10b981';
    } else { // canvas
      themeStroke = 'rgba(24, 24, 27, 0.08)';
      graphStroke = '#18181b';
    }

    // Baseline axis
    ctx.strokeStyle = themeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    const brick = this.selectedBrick();
    if (!brick) {
      ctx.fillStyle = theme === 'midnight' ? 'rgba(255, 255, 255, 0.35)' : 'rgba(24, 24, 27, 0.45)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Select a brick to read it', width / 2, mid);
      return;
    }

    // Generate aesthetic waveform representation algorithmically
    ctx.strokeStyle = graphStroke;
    ctx.lineWidth = 2.0;
    ctx.beginPath();

    const type = brick.synth_params?.type || 'synth';

    for (let x = 0; x < width; x += 3) {
      let amp = 0.1;
      if (type === 'drum') {
        const kickAt = (x % 35 < 4);
        const snareAt = (Math.abs((x % 70) - 35) < 5);
        const hihatAt = (x % 8 === 0);
        amp = kickAt ? 0.75 : (snareAt ? 0.55 : (hihatAt ? 0.22 : 0.06));
      } else if (type === 'bass') {
        amp = 0.35 + 0.3 * Math.sin(x * 0.04) * Math.cos(x * 0.09);
      } else if (type === 'synth' || type === 'melody') {
        amp = 0.15 + 0.5 * Math.abs(Math.sin(x * 0.16)) * Math.sin(x * 0.03 + 0.4);
      } else {
        amp = 0.5 + 0.22 * Math.sin(x * 0.02);
      }

      // Safeguard peak bounds & multiply by brick volume
      const scaleMult = brick.muted ? 0.02 : brick.volume;
      const hScale = Math.min(1.0, Math.max(0.04, amp)) * (mid - 4) * scaleMult;
      ctx.moveTo(x, mid - hScale);
      ctx.lineTo(x, mid + hScale);
    }
    ctx.stroke();
  }

  // Toggle Track states explicitly mapped to manual sliders / buttons
  toggleMute(brick: Brick) {
    brick.muted = !brick.muted;
    this.drawSelectedWaveform();
  }

  toggleSolo(brick: Brick) {
    brick.solo = !brick.solo;
  }

  toggleFast(brick: Brick) {
    brick.isFast = !brick.isFast;
    this.agentStatus.set(`Track ${brick.code} is now ${brick.isFast ? 'Streaked (Fast)' : 'Normal (Static)'}`);
  }

  toggleBleed(brick: Brick) {
    brick.hasBleed = !brick.hasBleed;
    this.agentStatus.set(`Track ${brick.code} bleed is now ${brick.hasBleed ? 'Dashed (Active)' : 'Isolated'}`);
  }

  deleteBrick(id: string) {
    this.bricks.update(prev => prev.filter(b => b.id !== id));
    if (this.selectedBrickId() === id) {
      const remaining = this.bricks();
      this.selectedBrickId.set(remaining.length > 0 ? remaining[0].id : null);
    }
    this.agentStatus.set('Removed track stem.');
  }

  addCustomStem(instrument: 'synth' | 'bass' | 'drum' | 'pad' | 'melody') {
    const codes: Record<string, string> = {
      synth: 'FX',
      bass: 'BS',
      drum: 'DR',
      pad: 'PD',
      melody: 'LD'
    };

    const defaultHz = {
      synth: [261.63, 329.63, 392.00, 523.25],
      bass: [55.00, 65.41, 73.42, 82.41],
      drum: [150, 200, 350, 450],
      pad: [130.81, 164.81, 196.00],
      melody: [329.63, 392.00, 440.00, 587.33]
    };

    const newId = 'stem-' + Date.now().toString();
    const newB: Brick = {
      id: newId,
      name: `Custom ${instrument.charAt(0).toUpperCase() + instrument.slice(1)} Track`,
      code: codes[instrument] || 'ST',
      instrument,
      muted: false,
      solo: false,
      volume: 0.65,
      isFast: false,
      hasBleed: false,
      bars: this.activeBars(),
      verified_stem: true,
      notes: `Custom generated ${instrument} module.`,
      synth_params: {
        type: instrument,
        frequencies: defaultHz[instrument]
      }
    };

    this.bricks.update(prev => [...prev, newB]);
    this.selectedBrickId.set(newId);
    this.agentStatus.set(`Injected custom ${instrument} track.`);
    setTimeout(() => this.drawSelectedWaveform(), 100);
  }

  scrollToLatestMessage() {
    setTimeout(() => {
      if (this.chatScroll?.nativeElement) {
        this.chatScroll.nativeElement.scrollTop = this.chatScroll.nativeElement.scrollHeight;
      }
    }, 100);
  }

  // Pre-fill user prompt from the screenshot suggested link '"dusty"'
  loadPresetPrompt() {
    this.userInputText = 'dusty vintage vinyl lo-fi track with warm Rhodes chords, crackle FX, and tape bass bleed';
  }

  // Interactive conversation submit to Gemini backend endpoint
  async sendChatMessage() {
    if (!this.userInputText.trim() || this.isGenerating) return;

    const chatText = this.userInputText;
    this.userInputText = '';
    this.isGenerating = true;

    // Add user message to scroll
    const userMsgId = 'user-' + Date.now().toString();
    this.chatHistory.update(prev => [...prev, { id: userMsgId, role: 'user', text: chatText }]);
    this.agentStatus.set('Model modeling loop harmonies...');
    this.scrollToLatestMessage();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.chatHistory()
        })
      });

      if (!response.ok) {
        throw new Error('Connection failed.');
      }

      const data = await response.json();
      
      // Update Agent Chat response
      const agentMsgId = 'agent-' + Date.now().toString();
      this.chatHistory.update(prev => [...prev, { id: agentMsgId, role: 'agent', text: data.message || 'Synthesized.' }]);
      this.agentStatus.set('Workspace updated.');

      // Check for adding new stem
      if (data.new_stem) {
        const codes: Record<string, string> = {
          synth: 'FX',
          bass: 'BS',
          drum: 'DR',
          pad: 'PD',
          melody: 'LD'
        };

        const nGrad: Brick = {
          id: data.new_stem.id || 'id-' + Date.now(),
          name: data.new_stem.name,
          code: codes[data.new_stem.instrument] || 'ST',
          instrument: data.new_stem.instrument || 'synth',
          muted: false,
          solo: false,
          volume: 0.7,
          isFast: data.new_stem.isFast ?? (data.new_stem.instrument === 'drum' || data.new_stem.instrument === 'melody'),
          hasBleed: data.new_stem.hasBleed ?? (data.new_stem.instrument === 'pad' || data.new_stem.instrument === 'synth'),
          bars: this.activeBars(),
          verified_stem: data.new_stem.verified_stem ?? true,
          notes: data.new_stem.notes || 'AI Synthesized stem loop.',
          synth_params: data.new_stem.synth_params || {
            type: data.new_stem.instrument || 'synth',
            frequencies: [261.63, 329.63, 392.00, 523.25]
          }
        };

        // Inject new stem track
        this.bricks.update(prev => {
          const filtered = prev.filter(b => b.id !== nGrad.id && b.code !== nGrad.code);
          return [...filtered, nGrad];
        });
        
        this.selectedBrickId.set(nGrad.id);
        this.agentStatus.set(`Landed "${nGrad.name}" successfully — verified isolated stem.`);
      }

    } catch (err: any) {
      console.error(err);
      const errId = 'err-' + Date.now().toString();
      this.chatHistory.update(prev => [...prev, {
        id: errId,
        role: 'agent',
        text: `Error connecting to Audio Modeler. Please verify workspace settings.`
      }]);
      this.agentStatus.set('Frequencies modeling failed.');
    } finally {
      this.isGenerating = false;
      this.scrollToLatestMessage();
      setTimeout(() => this.drawSelectedWaveform(), 100);
    }
  }
}
