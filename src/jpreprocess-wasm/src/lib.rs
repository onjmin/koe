//! jpreprocess (OpenJTalk 互換の日本語テキスト前処理) の Wasm バインディング。
//!
//! 辞書 (naist-jdic, 展開後 ≈80MB) はこの Wasm に同梱せず、JS 側が別ファイルとして
//! 取得した生バイト列を `init_dictionary` で一度だけ渡す。こうすると
//! - Wasm 本体が数MBになり、辞書のダウンロードと並行してコンパイルできる
//! - 辞書ファイルは gzip 済みで配信し、Cache API に保存して次回以降を即時にできる
//! - 解析ごとに辞書を再構築しない (以前は `analyze_text` のたびに ~80MB を読み直していた)
//!
//! `bundled-dict` feature を有効にすると従来通り同梱辞書も使える (`init_bundled_dictionary`)。

use std::cell::RefCell;

use jpreprocess::{DefaultTokenizer, Dictionary, JPreprocess};
use lindera_dictionary::dictionary::{
    character_definition::CharacterDefinition, connection_cost_matrix::ConnectionCostMatrix,
    metadata::Metadata, prefix_dictionary::PrefixDictionary,
    unknown_dictionary::UnknownDictionary,
};
use wasm_bindgen::prelude::*;

thread_local! {
    static ENGINE: RefCell<Option<JPreprocess<DefaultTokenizer>>> = const { RefCell::new(None) };
}

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

/// テキストを NJD ノード列 (JSON 文字列) にする。各ノードは
/// `{string, pos, pos_group1, pron, read, acc, mora_size, chain_flag}`。
/// 半角英数などは naist-jdic 向けに全角へ正規化してから解析する。
#[wasm_bindgen]
pub fn analyze_text(text: &str) -> Result<String, JsError> {
    ENGINE.with(|slot| {
        let slot = slot.borrow();
        let engine = slot
            .as_ref()
            .ok_or_else(|| JsError::new("jpreprocess dictionary is not loaded; call init_dictionary first"))?;
        let normalized = jpreprocess::normalize_text_for_naist_jdic(text);
        let njd = engine
            .text_to_njd(&normalized)
            .map_err(js_error("text_to_njd"))?;

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
