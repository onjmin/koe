export interface NjdNode {
    string: string;
    pos: string;
    pos_group1: string;
    pron: string;
    read: string;
    acc: number;
    mora_size: number;
    chain_flag: number;
}

export interface FeatureFrame {
    mora: string;
    pause: boolean;
    accent_phrase_position?: number;
    accent_phrase_length?: number;
    accent_nucleus?: number;
    accent_high?: boolean;
    accent_phrase_start?: boolean;
    accent_phrase_end?: boolean;
    word_start?: boolean;
    word_end?: boolean;
    pos?: string;
    pos_group1?: string;
}

const PUNCTUATION = new Set(["、", "。", "？", "！", ",", ".", "?", "!"]);
const SMALL_KANA = new Set(["ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ", "ゎ", "ゕ", "ゖ"]);

function toHiragana(character: string): string {
    const code = character.charCodeAt(0);
    if (0x30A1 <= code && code <= 0x30F6) {
        return String.fromCharCode(code - 0x60);
    }
    return character;
}

function splitMorae(reading: string): FeatureFrame[] {
    const result: FeatureFrame[] = [];
    const normalized = reading.normalize("NFC").replace(/'/g, "").replace(/’/g, "");
    for (const character of normalized) {
        if (/\s/.test(character) || PUNCTUATION.has(character)) {
            if (result.length > 0 && !result[result.length - 1].pause) {
                result.push({ mora: "", pause: true });
            }
            continue;
        }
        const mora = toHiragana(character);
        if (SMALL_KANA.has(mora) && result.length > 0 && !result[result.length - 1].pause) {
            result[result.length - 1].mora += mora;
        } else {
            result.push({ mora, pause: false });
        }
    }
    return result;
}

function isHigh(position: number, accent: number): boolean {
    if (accent === 1) return position === 1;
    if (accent > 1) return 2 <= position && position <= accent;
    return position >= 2;
}

export function analyze(nodes: NjdNode[]): { reading: string, features: FeatureFrame[] } {
    const reading_parts: string[] = [];
    const result: FeatureFrame[] = [];
    let index = 0;
    
    while (index < nodes.length) {
        const node = nodes[index];
        const pronunciation = (node.pron || "").replace(/'/g, "").replace(/’/g, "");
        if (node.mora_size === 0 || PUNCTUATION.has(node.string)) {
            reading_parts.push(node.string || "、");
            if (result.length > 0 && !result[result.length - 1].pause) {
                result.push({ mora: "", pause: true });
            }
            index++;
            continue;
        }

        const phrase_nodes: { current: NjdNode, morae: FeatureFrame[] }[] = [];
        while (index < nodes.length) {
            const current = nodes[index];
            if (current.mora_size === 0 || PUNCTUATION.has(current.string)) {
                break;
            }
            if (phrase_nodes.length > 0 && current.chain_flag !== 1) {
                break;
            }
            const current_pronunciation = (current.pron || "").replace(/'/g, "").replace(/’/g, "");
            const morae = splitMorae(current_pronunciation).filter(item => !item.pause);
            phrase_nodes.push({ current, morae });
            reading_parts.push(current_pronunciation);
            index++;
        }

        const phrase_length = phrase_nodes.reduce((sum, item) => sum + item.morae.length, 0);
        const accent = phrase_nodes[0].current.acc || 0;
        let phrase_position = 0;

        for (const { current, morae } of phrase_nodes) {
            for (let word_position = 1; word_position <= morae.length; word_position++) {
                phrase_position++;
                result.push({
                    mora: morae[word_position - 1].mora,
                    pause: false,
                    accent_phrase_position: phrase_position,
                    accent_phrase_length: phrase_length,
                    accent_nucleus: accent,
                    accent_high: isHigh(phrase_position, accent),
                    accent_phrase_start: phrase_position === 1,
                    accent_phrase_end: phrase_position === phrase_length,
                    word_start: word_position === 1,
                    word_end: word_position === morae.length,
                    pos: current.pos || "*",
                    pos_group1: current.pos_group1 || "*",
                });
            }
        }
    }
    return { reading: reading_parts.join(""), features: result };
}
export function sparse_features(token: FeatureFrame): Record<string, number> {
    if (token.pause || token.accent_phrase_position === undefined || token.accent_phrase_length === undefined || token.accent_nucleus === undefined) {
        return {};
    }
    const phrase_length = Math.max(1, token.accent_phrase_length);
    const phrase_position = token.accent_phrase_position;
    const nucleus = token.accent_nucleus;
    
    const result: Record<string, number> = {
        "accent_position": phrase_position / phrase_length,
        "accent_from_end": (phrase_length - phrase_position) / phrase_length,
        "accent_nucleus_position": nucleus / phrase_length,
        "accent_high": token.accent_high ? 1.0 : 0.0,
        "accent_phrase_start": token.accent_phrase_start ? 1.0 : 0.0,
        "accent_phrase_end": token.accent_phrase_end ? 1.0 : 0.0,
        "word_start": token.word_start ? 1.0 : 0.0,
        "word_end": token.word_end ? 1.0 : 0.0,
    };
    
    result[`pos=${token.pos || "*"}`] = 1.0;
    result[`pos_group1=${token.pos_group1 || "*"}`] = 1.0;
    
    if (nucleus === 0) {
        result["accent_type=heiban"] = 1.0;
    } else if (phrase_position < nucleus) {
        result["accent_type=before"] = 1.0;
    } else if (phrase_position === nucleus) {
        result["accent_type=nucleus"] = 1.0;
    } else {
        result["accent_type=after"] = 1.0;
    }
    
    return result;
}
