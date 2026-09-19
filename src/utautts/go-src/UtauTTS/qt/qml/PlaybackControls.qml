pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    id: root
    required property var translator
    property color mutedText
    property bool busy: false
    property bool playing: false
    property bool hasAudio: false
    property bool canGenerate: false
    property real position: 0
    property real duration: 0
    property string errorText: ""
    signal primaryClicked()
    signal seekRequested(real position)

    spacing: 10

    function formatTime(milliseconds) {
        const seconds = Math.max(0, Math.floor(milliseconds / 1000));
        const minutes = Math.floor(seconds / 60);
        return minutes + ":" + String(seconds % 60).padStart(2, "0");
    }

    RoundButton {
        id: playbackButton
        Layout.preferredWidth: 42
        Layout.preferredHeight: 42
        highlighted: true
        enabled: root.playing || root.hasAudio || (!root.busy && root.canGenerate)
        onClicked: root.primaryClicked()
        ToolTip.visible: hovered
        ToolTip.text: root.errorText.length ? root.errorText
                      : root.playing ? root.translator.tr("main.playback.paused")
                      : root.translator.tr("main.playback.generateAndPlay")

        contentItem: Canvas {
            anchors.fill: parent
            property int iconState: root.busy ? 0 : root.playing ? 1 : 2
            property color iconColor: playbackButton.palette.buttonText
            onIconStateChanged: requestPaint()
            onIconColorChanged: requestPaint()
            onPaint: {
                const context = getContext("2d");
                context.clearRect(0, 0, width, height);
                context.fillStyle = iconColor;
                if (iconState === 0) {
                    const radius = Math.max(1.5, width * 0.055);
                    context.beginPath();
                    context.arc(width * 0.35, height * 0.5, radius, 0, Math.PI * 2);
                    context.arc(width * 0.5, height * 0.5, radius, 0, Math.PI * 2);
                    context.arc(width * 0.65, height * 0.5, radius, 0, Math.PI * 2);
                    context.fill();
                } else if (iconState === 1) {
                    context.fillRect(width * 0.34, height * 0.3, width * 0.11, height * 0.4);
                    context.fillRect(width * 0.55, height * 0.3, width * 0.11, height * 0.4);
                } else {
                    context.beginPath();
                    context.moveTo(width * 0.39, height * 0.28);
                    context.lineTo(width * 0.39, height * 0.72);
                    context.lineTo(width * 0.7, height * 0.5);
                    context.closePath();
                    context.fill();
                }
            }
        }
    }

    Slider {
        Layout.fillWidth: true
        from: 0
        to: Math.max(1, root.duration)
        value: root.position
        enabled: root.hasAudio
        onMoved: root.seekRequested(value)
    }

    Label {
        text: root.formatTime(root.position) + " / " + root.formatTime(root.duration)
        color: root.mutedText
        font.pixelSize: 11
    }
}
