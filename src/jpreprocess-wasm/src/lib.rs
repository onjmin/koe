//! jpreprocess (OpenJTalk 互換の日本語テキスト前処理) + jbonsai (HTS 音声合成の韻律部分) の Wasm バインディング。
//!
//! 辞書 (naist-jdic, 展開後 ≈80MB) はこの Wasm に同梱せず、JS 側が別ファイルとして
//! 取得した生バイト列を `init_dictionary` で一度だけ渡す。こうすると
//! - Wasm 本体が数MBになり、辞書のダウンロードと並行してコンパイルできる
//! - 辞書ファイルは gzip 済みで配信し、Cache API に保存して次回以降を即時にできる
//! - 解析ごとに辞書を再構築しない (以前は `analyze_text` のたびに ~80MB を読み直していた)
//!
//! `init_voice` で HTS 音声モデル (.htsvoice) を渡すと、`analyze_prosody` でテキストから
//! HTS が生成する音素長と F0 曲線だけを取り出せる (波形は作らない)。UtauTTS はこれを
//! モーラ長とピッチ曲線として受け取り、UTAU 音源の音色で合成する (韻律の移植)。
//!
//! `bundled-dict` feature を有効にすると従来通り同梱辞書も使える (`init_bundled_dictionary`)。

use std::cell::RefCell;

use jbonsai::{
    duration::DurationEstimator, label::ToLabels, mlpg_adjust::MlpgAdjust, model::Models, Engine,
};
use jpreprocess::{DefaultTokenizer, Dictionary, JPreprocess};
use lindera_dictionary::dictionary::{
    character_definition::CharacterDefinition, connection_cost_matrix::ConnectionCostMatrix,
    metadata::Metadata, prefix_dictionary::PrefixDictionary,
    unknown_dictionary::UnknownDictionary,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

thread_local! {
    static ENGINE: RefCell<Option<JPreprocess<DefaultTokenizer>>> = const { RefCell::new(None) };
    static VOICE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

/// jbonsai が無声フレームに入れる番兵 (`constants::NODATA = -1e10`)。
const HTS_UNVOICED: f64 = -1e9;

fn js_error<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> JsError + '_ {
    move |error| JsError::new(&format!("{context}: {error}"))
}

fn install(dictionary: Dictionary) {
    let engine = JPreprocess::with_dictionaries(dictionary, None);
    ENGINE.with(|slot| *slot.borrow_mut() = Some(engine));
}

/// 辞書ファイルの生バイト列から解析器を構築する。引数は naist-jdic のビルド成果物と同じ名前。
/// 呼び出し後は `analyze_text` が使えるようになる。再呼び出しで辞書を差し替えられる。
#[wasm_bindgen]
pub fn init_dictionary(
    metadata: Vec<u8>,
    char_def: Vec<u8>,
    matrix: Vec<u8>,
    dict_da: Vec<u8>,
    dict_vals: Vec<u8>,
    unk: Vec<u8>,
    words_idx: Vec<u8>,
    words: Vec<u8>,
) -> Result<(), JsError> {
    let dictionary = Dictionary {
        metadata: Metadata::load(&metadata).map_err(js_error("metadata.json"))?,
        prefix_dictionary: PrefixDictionary::load(dict_da, dict_vals, words_idx, words, true)
            .map_err(js_error("dict.da/dict.vals/dict.wordsidx/dict.words"))?,
        connection_cost_matrix: ConnectionCostMatrix::load(matrix)
            .map_err(js_error("matrix.mtx"))?,
        character_definition: CharacterDefinition::load(&char_def)
            .map_err(js_error("char_def.bin"))?,
        unknown_dictionary: UnknownDictionary::load(&unk).map_err(js_error("unk.bin"))?,
    };
    install(dictionary);
    Ok(())
}

/// Wasm に同梱した naist-jdic で解析器を構築する (`bundled-dict` feature のみ)。
#[cfg(feature = "bundled-dict")]
#[wasm_bindgen]
pub fn init_bundled_dictionary() -> Result<(), JsError> {
    use jpreprocess::{kind::JPreprocessDictionaryKind, SystemDictionaryConfig};
    let dictionary = SystemDictionaryConfig::Bundled(JPreprocessDictionaryKind::NaistJdic)
        .load()
        .map_err(js_error("bundled naist-jdic"))?;
    install(dictionary);
    Ok(())
}

/// 辞書が読み込まれ `analyze_text` が呼べる状態かを返す。
#[wasm_bindgen]
pub fn is_ready() -> bool {
    ENGINE.with(|slot| slot.borrow().is_some())
}

/// HTS 音声モデル (.htsvoice の生バイト列) を読み込む。`analyze_prosody` の前に一度呼ぶ。
#[wasm_bindgen]
pub fn init_voice(htsvoice: Vec<u8>) -> Result<(), JsError> {
    let engine = Engine::load_from_bytes([htsvoice]).map_err(js_error("htsvoice"))?;
    VOICE.with(|slot| *slot.borrow_mut() = Some(engine));
    Ok(())
}

/// HTS 音声モデルが読み込まれ `analyze_prosody` が呼べる状態かを返す。
#[wasm_bindgen]
pub fn is_voice_ready() -> bool {
    VOICE.with(|slot| slot.borrow().is_some())
}

fn with_engine<T>(f: impl FnOnce(&JPreprocess<DefaultTokenizer>) -> Result<T, JsError>) -> Result<T, JsError> {
    ENGINE.with(|slot| {
        let slot = slot.borrow();
        let engine = slot.as_ref().ok_or_else(|| {
            JsError::new("jpreprocess dictionary is not loaded; call init_dictionary first")
        })?;
        f(engine)
    })
}

/// テキストを NJD ノード列 (JSON 文字列) にする。各ノードは
/// `{string, pos, pos_group1, pron, read, acc, mora_size, chain_flag}`。
/// 半角英数などは naist-jdic 向けに全角へ正規化してから解析する。
///
/// Open JTalk と同じ NJD 前処理 (読みの補完、数字列の読み、アクセント句の連結、
/// アクセント型、無声化) を掛けてから返す。`extract_fullcontext` / `analyze_prosody`
/// が見るモーラ列と一致させるためで、これが無いと「2024年」「koe」のような
/// 数字・英字を含む文で HTS 韻律とモーラ数が食い違い、整列に失敗する。
#[wasm_bindgen]
pub fn analyze_text(text: &str) -> Result<String, JsError> {
    with_engine(|engine| {
        let normalized = jpreprocess::normalize_text_for_naist_jdic(text);
        let mut njd = engine
            .text_to_njd(&normalized)
            .map_err(js_error("text_to_njd"))?;
        njd.preprocess();

        let mut nodes_json = Vec::with_capacity(njd.nodes.len());
        for node in njd.nodes {
            let pos_str = node.get_pos().to_string();
            let mut pos_split = pos_str.split(',');
            let pos0 = pos_split.next().unwrap_or("*");
            let pos1 = pos_split.next().unwrap_or("*");
            let pron = node.get_pron();
            nodes_json.push(serde_json::json!({
                "string": node.get_string(),
                "pos": pos0,
                "pos_group1": pos1,
                "pron": pron.to_string(),
                "read": node.get_read().unwrap_or(""),
                "acc": pron.accent,
                "mora_size": pron.mora_size(),
                "chain_flag": if node.get_chain_flag().unwrap_or(false) { 1 } else { 0 },
            }));
        }
        serde_json::to_string(&nodes_json).map_err(js_error("serialize"))
    })
}

/// HTS フルコンテキストラベル (Open JTalk と同じ書式) を 1 音素 1 行で返す。デバッグ用。
#[wasm_bindgen]
pub fn extract_fullcontext(text: &str) -> Result<Vec<String>, JsError> {
    with_engine(|engine| {
        let normalized = jpreprocess::normalize_text_for_naist_jdic(text);
        let labels = engine
            .extract_fullcontext(&normalized)
            .map_err(js_error("extract_fullcontext"))?;
        Ok(labels.iter().map(|label| label.to_string()).collect())
    })
}

#[derive(Serialize)]
struct ProsodyPhoneme {
    phone: String,
    start_ms: f64,
    duration_ms: f64,
}

#[derive(Serialize)]
struct Prosody {
    frame_ms: f64,
    sample_rate: usize,
    phonemes: Vec<ProsodyPhoneme>,
    /// フレームごとの F0 (Hz)。無声フレームは 0。
    f0_hz: Vec<f64>,
}

/// テキストから HTS が生成する音素長と F0 曲線を取り出す (JSON 文字列)。
/// `speed` は話速 (1.0 が標準、大きいほど速い)。波形は生成しない。
/// `gv_weight` は F0 の GV (global variance) 重み。省略時は音声モデルの既定値
/// (hts_engine と同じ 1.0)。大きいほど音高の山谷が強調され、0 で GV 無効。
///
/// 出力: `{frame_ms, sample_rate, phonemes: [{phone, start_ms, duration_ms}], f0_hz: [...]}`。
/// 先頭と末尾の `sil`、句読点の `pau` も音素として含む。
#[wasm_bindgen]
pub fn analyze_prosody(
    text: &str,
    speed: f64,
    gv_weight: Option<f64>,
) -> Result<String, JsError> {
    let label_strings = extract_fullcontext(text)?;
    VOICE.with(|slot| {
        let slot = slot.borrow();
        let engine = slot
            .as_ref()
            .ok_or_else(|| JsError::new("HTS voice is not loaded; call init_voice first"))?;
        let condition = &engine.condition;
        let labels = label_strings
            .as_slice()
            .to_labels(condition)
            .map_err(js_error("labels"))?;
        let models = Models::new(
            labels.labels(),
            &engine.voices,
            condition.get_interporation_weight(),
        );
        let nstate = models.nstate();
        let speed = if speed.is_finite() && speed > 0.0 { speed } else { 1.0 };
        let durations = DurationEstimator::new(models.duration(), nstate).create(speed);
        // stream 1 = 対数 F0 (MSD)。無声判定は合成時と同じ設定、GV 重みは引数で上書き可。
        let gv_weight = gv_weight
            .filter(|w| w.is_finite() && *w >= 0.0)
            .unwrap_or_else(|| condition.get_gv_weight(1));
        let lf0 = MlpgAdjust::new(
            gv_weight,
            condition.get_msd_threshold(1),
            models.model_stream(1),
        )
        .create(&durations);

        let sample_rate = condition.get_sampling_frequency();
        let frame_ms = condition.get_fperiod() as f64 * 1000.0 / sample_rate as f64;
        let mut phonemes = Vec::with_capacity(labels.labels().len());
        let mut cursor = 0.0;
        for (index, label) in labels.labels().iter().enumerate() {
            let frames: usize = durations[index * nstate..(index + 1) * nstate].iter().sum();
            let duration_ms = frames as f64 * frame_ms;
            phonemes.push(ProsodyPhoneme {
                phone: label.phoneme.c.clone().unwrap_or_else(|| "xx".to_string()),
                start_ms: cursor,
                duration_ms,
            });
            cursor += duration_ms;
        }
        let f0_hz = lf0
            .iter()
            .map(|frame| {
                let value = frame.first().copied().unwrap_or(HTS_UNVOICED);
                if value < HTS_UNVOICED { 0.0 } else { value.exp() }
            })
            .collect();
        serde_json::to_string(&Prosody { frame_ms, sample_rate, phonemes, f0_hz })
            .map_err(js_error("serialize"))
    })
}
