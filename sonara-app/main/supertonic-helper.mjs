// Vendored verbatim from supertone-inc/supertonic (nodejs/helper.js), MIT licensed.
// Source: https://github.com/supertone-inc/supertonic/blob/main/nodejs/helper.js
// Only loaded dynamically by main/supertonic-tts.js (CJS -> ESM bridge via dynamic import()).
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ort from 'onnxruntime-node';

const AVAILABLE_LANGS = ["en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na"];

class UnicodeProcessor {
    constructor(unicodeIndexerJsonPath) {
        this.indexer = JSON.parse(fs.readFileSync(unicodeIndexerJsonPath, 'utf8'));
    }

    _preprocessText(text, lang) {
        text = text.normalize('NFKD');

        const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
        text = text.replace(emojiPattern, '');

        const replacements = {
            '–': '-', '‑': '-', '—': '-', '_': ' ',
            '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
            '´': "'", '`': "'",
            '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
            '→': ' ', '←': ' ',
        };
        for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v);
        text = text.replace(/[♥☆♡©\\]/g, '');

        const exprReplacements = { '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' };
        for (const [k, v] of Object.entries(exprReplacements)) text = text.replaceAll(k, v);

        text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
                   .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
        while (text.includes('""')) text = text.replace('""', '"');
        while (text.includes("''")) text = text.replace("''", "'");
        while (text.includes('``')) text = text.replace('``', '`');
        text = text.replace(/\s+/g, ' ').trim();

        if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) text += '.';

        if (!AVAILABLE_LANGS.includes(lang)) {
            throw new Error(`Invalid language: ${lang}. Available: ${AVAILABLE_LANGS.join(', ')}`);
        }
        text = `<${lang}>` + text + `</${lang}>`;
        return text;
    }

    _textToUnicodeValues(text) { return Array.from(text).map(c => c.charCodeAt(0)); }
    _getTextMask(textIdsLengths) { return lengthToMask(textIdsLengths); }

    call(textList, langList) {
        const processedTexts = textList.map((t, i) => this._preprocessText(t, langList[i]));
        const textIdsLengths = processedTexts.map(t => t.length);
        const maxLen = Math.max(...textIdsLengths);
        const textIds = [];
        for (let i = 0; i < processedTexts.length; i++) {
            const row = new Array(maxLen).fill(0);
            const unicodeVals = this._textToUnicodeValues(processedTexts[i]);
            for (let j = 0; j < unicodeVals.length; j++) row[j] = this.indexer[unicodeVals[j]];
            textIds.push(row);
        }
        return { textIds, textMask: this._getTextMask(textIdsLengths) };
    }
}

class Style {
    constructor(styleTtlOnnx, styleDpOnnx) { this.ttl = styleTtlOnnx; this.dp = styleDpOnnx; }
}

class TextToSpeech {
    constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
        this.cfgs = cfgs;
        this.textProcessor = textProcessor;
        this.dpOrt = dpOrt;
        this.textEncOrt = textEncOrt;
        this.vectorEstOrt = vectorEstOrt;
        this.vocoderOrt = vocoderOrt;
        this.sampleRate = cfgs.ae.sample_rate;
        this.baseChunkSize = cfgs.ae.base_chunk_size;
        this.chunkCompressFactor = cfgs.ttl.chunk_compress_factor;
        this.ldim = cfgs.ttl.latent_dim;
    }

    sampleNoisyLatent(duration) {
        const wavLenMax = Math.max(...duration) * this.sampleRate;
        const wavLengths = duration.map(d => Math.floor(d * this.sampleRate));
        const chunkSize = this.baseChunkSize * this.chunkCompressFactor;
        const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
        const latentDim = this.ldim * this.chunkCompressFactor;

        const noisyLatent = [];
        for (let b = 0; b < duration.length; b++) {
            const batch = [];
            for (let d = 0; d < latentDim; d++) {
                const row = [];
                for (let t = 0; t < latentLen; t++) {
                    const eps = 1e-10;
                    const u1 = Math.max(eps, Math.random());
                    const u2 = Math.random();
                    row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2));
                }
                batch.push(row);
            }
            noisyLatent.push(batch);
        }

        const latentMask = getLatentMask(wavLengths, this.baseChunkSize, this.chunkCompressFactor);
        for (let b = 0; b < noisyLatent.length; b++)
            for (let d = 0; d < noisyLatent[b].length; d++)
                for (let t = 0; t < noisyLatent[b][d].length; t++)
                    noisyLatent[b][d][t] *= latentMask[b][0][t];
        return { noisyLatent, latentMask };
    }

    async _infer(textList, langList, style, totalStep, speed = 1.05) {
        if (textList.length !== style.ttl.dims[0])
            throw new Error('Number of texts must match number of style vectors');
        const bsz = textList.length;
        const { textIds, textMask } = this.textProcessor.call(textList, langList);
        const textIdsShape = [bsz, textIds[0].length];
        const textMaskShape = [bsz, 1, textMask[0][0].length];
        const textMaskTensor = arrayToTensor(textMask, textMaskShape);

        const dpResult = await this.dpOrt.run({
            text_ids: intArrayToTensor(textIds, textIdsShape),
            style_dp: style.dp,
            text_mask: textMaskTensor
        });

        const durOnnx = Array.from(dpResult.duration.data);
        for (let i = 0; i < durOnnx.length; i++) durOnnx[i] /= speed;

        const textEncResult = await this.textEncOrt.run({
            text_ids: intArrayToTensor(textIds, textIdsShape),
            style_ttl: style.ttl,
            text_mask: textMaskTensor
        });
        const textEmbTensor = textEncResult.text_emb;

        let { noisyLatent, latentMask } = this.sampleNoisyLatent(durOnnx);
        const latentShape = [bsz, noisyLatent[0].length, noisyLatent[0][0].length];
        const latentMaskShape = [bsz, 1, latentMask[0][0].length];
        const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);
        const scalarShape = [bsz];
        const totalStepTensor = arrayToTensor(new Array(bsz).fill(totalStep), scalarShape);

        for (let step = 0; step < totalStep; step++) {
            const vectorEstResult = await this.vectorEstOrt.run({
                noisy_latent: arrayToTensor(noisyLatent, latentShape),
                text_emb: textEmbTensor,
                style_ttl: style.ttl,
                text_mask: textMaskTensor,
                latent_mask: latentMaskTensor,
                total_step: totalStepTensor,
                current_step: arrayToTensor(new Array(bsz).fill(step), scalarShape)
            });
            const denoisedLatent = Array.from(vectorEstResult.denoised_latent.data);
            let idx = 0;
            for (let b = 0; b < noisyLatent.length; b++)
                for (let d = 0; d < noisyLatent[b].length; d++)
                    for (let t = 0; t < noisyLatent[b][d].length; t++)
                        noisyLatent[b][d][t] = denoisedLatent[idx++];
        }

        const vocoderResult = await this.vocoderOrt.run({ latent: arrayToTensor(noisyLatent, latentShape) });
        return { wav: Array.from(vocoderResult.wav_tts.data), duration: durOnnx };
    }

    async call(text, lang, style, totalStep, speed = 1.05, silenceDuration = 0.3) {
        if (style.ttl.dims[0] !== 1) throw new Error('Single speaker text to speech only supports single style');
        const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
        const textList = chunkText(text, maxLen);
        let wavCat = null;
        let durCat = 0;
        for (const chunk of textList) {
            const { wav, duration } = await this._infer([chunk], [lang], style, totalStep, speed);
            if (wavCat === null) { wavCat = wav; durCat = duration[0]; }
            else {
                const silenceLen = Math.floor(silenceDuration * this.sampleRate);
                wavCat = wavCat.concat(new Array(silenceLen).fill(0), wav);
                durCat += duration[0] + silenceDuration;
            }
        }
        return { wav: wavCat, duration: [durCat] };
    }
}

function lengthToMask(lengths, maxLen = null) {
    maxLen = maxLen || Math.max(...lengths);
    const mask = [];
    for (let i = 0; i < lengths.length; i++) {
        const row = [];
        for (let j = 0; j < maxLen; j++) row.push(j < lengths[i] ? 1.0 : 0.0);
        mask.push([row]);
    }
    return mask;
}

function getLatentMask(wavLengths, baseChunkSize, chunkCompressFactor) {
    const latentSize = baseChunkSize * chunkCompressFactor;
    const latentLengths = wavLengths.map(len => Math.floor((len + latentSize - 1) / latentSize));
    return lengthToMask(latentLengths);
}

async function loadOnnx(onnxPath, opts) {
    return await ort.InferenceSession.create(onnxPath, opts);
}

async function loadOnnxAll(onnxDir, opts) {
    const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = await Promise.all([
        loadOnnx(path.join(onnxDir, 'duration_predictor.onnx'), opts),
        loadOnnx(path.join(onnxDir, 'text_encoder.onnx'), opts),
        loadOnnx(path.join(onnxDir, 'vector_estimator.onnx'), opts),
        loadOnnx(path.join(onnxDir, 'vocoder.onnx'), opts),
    ]);
    return { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt };
}

function loadCfgs(onnxDir) { return JSON.parse(fs.readFileSync(path.join(onnxDir, 'tts.json'), 'utf8')); }
function loadTextProcessor(onnxDir) { return new UnicodeProcessor(path.join(onnxDir, 'unicode_indexer.json')); }

export function loadVoiceStyle(voiceStylePaths) {
    const bsz = voiceStylePaths.length;
    const firstStyle = JSON.parse(fs.readFileSync(voiceStylePaths[0], 'utf8'));
    const [, ttlDim1, ttlDim2] = firstStyle.style_ttl.dims;
    const [, dpDim1, dpDim2] = firstStyle.style_dp.dims;

    const ttlFlat = new Float32Array(bsz * ttlDim1 * ttlDim2);
    const dpFlat = new Float32Array(bsz * dpDim1 * dpDim2);

    for (let i = 0; i < bsz; i++) {
        const vs = JSON.parse(fs.readFileSync(voiceStylePaths[i], 'utf8'));
        ttlFlat.set(vs.style_ttl.data.flat(Infinity), i * ttlDim1 * ttlDim2);
        dpFlat.set(vs.style_dp.data.flat(Infinity), i * dpDim1 * dpDim2);
    }
    const ttlStyle = new ort.Tensor('float32', ttlFlat, [bsz, ttlDim1, ttlDim2]);
    const dpStyle  = new ort.Tensor('float32', dpFlat,  [bsz, dpDim1, dpDim2]);
    return new Style(ttlStyle, dpStyle);
}

export async function loadTextToSpeech(onnxDir) {
    const cfgs = loadCfgs(onnxDir);
    // Sessions run sequentially (one worker, one synth at a time via synthQueue)
    // and this worker_thread is off the Electron UI/main thread, so a few
    // intra-op threads speed up each op's matmuls without blocking the UI.
    // interOpNumThreads stays 1 — the 4-stage pipeline is inherently sequential.
    const sessionOptions = {
        executionMode: 'sequential',
        intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
        interOpNumThreads: 1,
    };
    const { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt } = await loadOnnxAll(onnxDir, sessionOptions);
    return new TextToSpeech(cfgs, loadTextProcessor(onnxDir), dpOrt, textEncOrt, vectorEstOrt, vocoderOrt);
}

function arrayToTensor(array, dims) {
    return new ort.Tensor('float32', Float32Array.from(array.flat(Infinity)), dims);
}

function intArrayToTensor(array, dims) {
    return new ort.Tensor('int64', BigInt64Array.from(array.flat(Infinity).map(x => BigInt(x))), dims);
}

// Encode mono float32 PCM (-1..1) into a 16-bit WAV Buffer.
export function encodeWav(audioData, sampleRate, durationSamples) {
    const len = Math.min(audioData.length, durationSamples ?? audioData.length);
    const numChannels = 1, bitsPerSample = 16;
    const dataSize = len * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
    buffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, audioData[i]));
        buffer.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
    }
    return buffer;
}

function chunkText(text, maxLen = 300) {
    if (typeof text !== 'string') throw new Error(`chunkText expects a string, got ${typeof text}`);
    const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
    const chunks = [];
    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim();
        if (!paragraph) continue;
        const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
        let currentChunk = "";
        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= maxLen) {
                currentChunk += (currentChunk ? " " : "") + sentence;
            } else {
                if (currentChunk) chunks.push(currentChunk.trim());
                currentChunk = sentence;
            }
        }
        if (currentChunk) chunks.push(currentChunk.trim());
    }
    return chunks;
}
