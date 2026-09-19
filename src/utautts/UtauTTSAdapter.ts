import { VoiceBank } from "../engine/voice-bank.js";
import { Worldline } from "../engine/worldline.js";
import type { KoeEngineOptions } from "../engine/index.js";

// UtauTTS Wasm で出力される Plan の Unit 型定義
export interface UtauTTSUnit {
    position: number;
    mora: string;
    alias: string;
    oto_path: string;
    note_start_ms: number;
    duration_ms: number;
    offset_ms: number;
    consonant_ms: number;
    cutoff_ms: number;
    preutterance_ms: number;
    overlap_ms: number;
}

export interface UtauTTSPlan {
    duration_ms: number;
    units: UtauTTSUnit[];
    pitch_cents?: number[];
    pitch_frame_ms?: number;
}

export interface UtauTTSResponse {
    success: boolean;
    error?: string;
    plan: string;
}

declare function utautts_plan(requestJSON: string): UtauTTSResponse;
declare class Go {
    importObject: any;
    run(instance: WebAssembly.Instance): void;
}

export class UtauTTSAdapter {
    private worldline: Worldline;

    constructor(worldline: Worldline) {
        this.worldline = worldline;
    }

    /**
     * Wasmモジュールを初期化します。
     */
    static async initializeWasm(wasmUrl: string = "utautts.wasm") {
        if (typeof utautts_plan === "function") {
            return; // 既にロード済み
        }
        if (typeof Go === "undefined") {
            throw new Error("wasm_exec.js must be loaded before calling initializeWasm.");
        }
        const go = new Go();
        try {
            const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
            go.run(result.instance);
        } catch (e) {
            // Fallback for servers not serving application/wasm MIME type
            const response = await fetch(wasmUrl);
            const buffer = await response.arrayBuffer();
            const result = await WebAssembly.instantiate(buffer, go.importObject);
            go.run(result.instance);
        }
        
        // 関数が登録されるまで少し待つ
        await new Promise(resolve => setTimeout(resolve, 50));
        
        if (typeof utautts_plan !== "function") {
            throw new Error("utautts_plan failed to initialize in global scope.");
        }
    }

    /**
     * koe の VoiceBank から、UtauTTS Wasm に渡すための仮想 oto.ini 辞書を構築します。
     */
    private buildOtoEntriesFromKoe(bank: VoiceBank): Record<string, any[]> {
        const entries: Record<string, any[]> = {};
        const manifest = bank.manifest;
        
        for (const [alias, phoneme] of Object.entries(manifest.phonemes)) {
            // koe の PhonemeEntry は 48kHz サンプル単位なので、ミリ秒に変換します (48 samples = 1 ms)
            entries[alias] = [{
                Filename: `v_${alias}.wav`, // Wasm内での識別用ダミーファイル名
                Alias: alias,
                Offset: 0, // koe は事前にトリミング済みのため常に0
                Fixed: phoneme.consonant / 48,
                Preutterance: phoneme.pre / 48,
                Overlap: phoneme.overlap / 48,
                SourceGroup: "koe-bank"
            }];
        }
        return entries;
    }

    /**
     * 指定したテキストを合成するための Plan (発話計画) と音声を生成します。
     */
    public async synthesizeText(bank: VoiceBank, text: string, tone: string = "C4", modelJSON: string = ""): Promise<Float32Array | null> {
        // 1. VoiceBankのマニフェストをWasmが解釈できる形式に変換
        const otoEntries = this.buildOtoEntriesFromKoe(bank);

        // 2. Wasmに推論リクエストを投げる
        const request = {
            text: text,
            oto_entries: otoEntries,
            tone: tone,
            duration_ms: 0, // UtauTTS側に自動計算させる
            model_json: modelJSON
        };

        const response = utautts_plan(JSON.stringify(request));
        if (!response.success) {
            throw new Error(`UtauTTS Error: ${response.error}`);
        }

        const plan: UtauTTSPlan = JSON.parse(response.plan);
        console.log("Generated TTS Plan:", plan);

        // 3. Plan の各 Unit をもとに Worldline にリクエストを追加する
        const phraseUnits = [];
        let currentPosMs = 0;
        
        for (const unit of plan.units) {
            // unitのPCMデータを koe のキャッシュから取得
            const pcm = await bank.getPcm(unit.alias);
            if (!pcm) {
                console.warn(`PCM not found for alias: ${unit.alias}`);
                continue;
            }

            phraseUnits.push({
                pcm,
                posMs: currentPosMs,
                skipMs: unit.offset_ms,
                lengthMs: unit.duration_ms,
                fadeInMs: unit.overlap_ms,
                fadeOutMs: unit.overlap_ms, // 次ノートとのクロスフェードとして設定
                consonantMs: unit.consonant_ms
            });
            
            currentPosMs += unit.duration_ms;
        }

        // F0カーブの適用
        // UtauTTS が `pitch_cents` (各フレームのベースピッチからの相対変動量) を返している場合、それをHzに変換します。
        // `plan.pitch_cents` が未定義の場合は固定ピッチ(C4 = 261.63Hz)をフォールバックとします。
        const baseHz = 261.63; // 261.63 Hz (C4)
        let pitchInput: number | ((tMs: number, totalMs: number) => number) = baseHz;

        if (plan.pitch_cents && plan.pitch_frame_ms) {
            const frameMs = plan.pitch_frame_ms;
            const centsArr = plan.pitch_cents;
            
            pitchInput = (tMs: number, totalMs: number) => {
                const frameIndex = Math.floor(tMs / frameMs);
                if (frameIndex < 0 || frameIndex >= centsArr.length) return baseHz;
                const centsOffset = centsArr[frameIndex];
                // Cents相対値をHzに乗算 (2^(cents/1200))
                return baseHz * Math.pow(2, centsOffset / 1200);
            };
        }

        // 最終合成
        const outPcm = this.worldline.renderPhrase({
            units: phraseUnits,
            pitch: pitchInput
        });

        if (outPcm) {
            console.log(`Successfully generated audio: ${outPcm.length} samples.`);
        } else {
            console.error("Audio generation failed.");
        }
        
        return outPcm;
    }
}
