pragma ComponentBehavior: Bound

import QtQuick

Item {
    id: root

    property var backend: null
    property string language: "ja"
    property var translations: ({})

    function load(lang) {
        const code = String(lang);
        let content = "";
        if (root.backend && root.backend.loadLanguageFile)
            content = root.backend.loadLanguageFile(code);
        if (content && content.length) {
            try {
                root.translations = JSON.parse(content);
            } catch (error) {
                console.warn("Failed to parse language file for " + code + ": " + error);
            }
        } else {
            console.warn("Failed to load language file for " + code);
        }
        root.language = code;
    }

    function tr(key, ...args) {
        let text = root.translations[key];
        if (text === undefined || text === null)
            text = key;
        for (let index = 0; index < args.length; ++index)
            text = String(text).replace("{" + index + "}", String(args[index]));
        return text;
    }
}