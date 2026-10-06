class HlukomerCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 2048;
    this.buffer = new Float32Array(this.blockSize);
    this.offset = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'reset') this.offset = 0;
    };
  }

  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (!input || !input.length) return true;

    let src = 0;
    while (src < input.length) {
      const copy = Math.min(input.length - src, this.blockSize - this.offset);
      this.buffer.set(input.subarray(src, src + copy), this.offset);
      this.offset += copy;
      src += copy;

      if (this.offset === this.blockSize) {
        const out = this.buffer;
        this.port.postMessage(
          { type: 'block', samples: out, sampleRate },
          [out.buffer]
        );
        this.buffer = new Float32Array(this.blockSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('hlukomer-capture', HlukomerCaptureProcessor);
