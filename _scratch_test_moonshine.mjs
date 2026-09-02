import sherpa_onnx from 'sherpa-onnx-node';

const dir = '/tmp/claude-0/-home-user-claude/cf0f45b4-7e7e-56e4-a276-12cd7b18877c/scratchpad/moonshine-dl/extracted/sherpa-onnx-moonshine-tiny-en-int8';

const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    moonshine: {
      preprocessor: `${dir}/preprocess.onnx`,
      encoder: `${dir}/encode.int8.onnx`,
      uncachedDecoder: `${dir}/uncached_decode.int8.onnx`,
      cachedDecoder: `${dir}/cached_decode.int8.onnx`,
    },
    tokens: `${dir}/tokens.txt`,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
};

console.time('load');
const recognizer = new sherpa_onnx.OfflineRecognizer(config);
console.timeEnd('load');

const wave = sherpa_onnx.readWave(`${dir}/test_wavs/0.wav`);
console.log('wave', wave.sampleRate, wave.samples.length, wave.samples.constructor.name);

console.time('decode');
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
console.timeEnd('decode');
console.log('result', result);

// Test silence
const silence = new Float32Array(16000 * 1.5); // 1.5s silence
const s2 = recognizer.createStream();
s2.acceptWaveform({ sampleRate: 16000, samples: silence });
recognizer.decode(s2);
console.log('silence result', recognizer.getResult(s2));

// Test 440hz tone
const tone = new Float32Array(16000 * 1);
for (let i = 0; i < tone.length; i++) tone[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 16000);
const s3 = recognizer.createStream();
s3.acceptWaveform({ sampleRate: 16000, samples: tone });
recognizer.decode(s3);
console.log('tone result', recognizer.getResult(s3));
