use wasm_bindgen::prelude::*;
use jpreprocess::{JPreprocess, SystemDictionaryConfig};
use jpreprocess::kind::JPreprocessDictionaryKind;

#[wasm_bindgen]
pub fn analyze_text(text: &str) -> String {
    let dictionary = SystemDictionaryConfig::Bundled(JPreprocessDictionaryKind::NaistJdic).load().unwrap();
    let mut jpreprocess = JPreprocess::with_dictionaries(dictionary, None);
    
    let njd = jpreprocess.text_to_njd(text).unwrap();
    
    let mut nodes_json = Vec::new();
    for node in njd.nodes {
        let pos_str = node.get_pos().to_string();
        let pos_split: Vec<&str> = pos_str.split(',').collect();
        let pos0 = pos_split.get(0).copied().unwrap_or("*");
        let pos1 = pos_split.get(1).copied().unwrap_or("*");
        
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
    
    serde_json::to_string(&nodes_json).unwrap()
}

