// captain-voice: the Mac app's voice, as a small helper the app starts.
//
//   captain-voice listen <lang>   Live speech to text with Apple's recognizer
//                                 (on this Mac when the language allows).
//                                 Prints one JSON object per line:
//                                   {"type":"ready"}
//                                   {"type":"level","value":0.42}     microphone level, 0…1
//                                   {"type":"partial","text":"…"}     words so far
//                                   {"type":"final","text":"…"}       then it exits
//                                   {"type":"error","message":"…"}    then it exits
//                                 Send "stop" on stdin (or close it) to finish,
//                                 "cancel" to quit without a result.
//   captain-voice speak <lang>    Reads text on stdin and says it with the best
//                                 voice installed for that language; prints
//                                 {"type":"done"} when finished.
//   captain-voice frontapp        The app in front of Captain (where voice
//                                 typing goes): {"type":"app","name":"Notes","pid":123},
//                                 or {"type":"none"}.
//   captain-voice paste <pid>     Reads text on stdin and types it where the
//                                 cursor is in that app (as keyboard input; the
//                                 clipboard isn't touched). Needs Accessibility
//                                 permission (macOS asks the first time); prints
//                                 {"type":"done"} or {"type":"error","message":"…"}.

import AppKit
import ApplicationServices
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

let arguments = CommandLine.arguments
let mode = arguments.count > 1 ? arguments[1] : "listen"
let language = arguments.count > 2 ? arguments[2] : "en-US"

// ------------------------------------------------------------ speak

final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit(["type": "done"])
        exit(0)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        emit(["type": "done"])
        exit(0)
    }
}

func bestVoice(for lang: String) -> AVSpeechSynthesisVoice? {
    let prefix = String(lang.prefix(2))
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == lang || $0.language.hasPrefix(prefix) }
    let exact = voices.filter { $0.language == lang }
    let pool = exact.isEmpty ? voices : exact
    return pool.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: lang)
}

let speechDelegate = SpeechDelegate()
let synthesizer = AVSpeechSynthesizer()

func speak() -> Never {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(data: input, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if text.isEmpty {
        emit(["type": "done"])
        exit(0)
    }
    synthesizer.delegate = speechDelegate
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = bestVoice(for: language)
    synthesizer.speak(utterance)
    RunLoop.main.run()
    exit(0)
}

// ------------------------------------------------------------ listen

final class Listener {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var latest = ""
    var finished = false
    var lastLevelAt = Date.distantPast

    init(lang: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
            fail("This Mac can't recognize speech in \(lang).")
        }
        self.recognizer = recognizer
    }

    func start() {
        guard recognizer.isAvailable else {
            fail("Speech recognition isn't available right now.")
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        if #available(macOS 13, *) {
            request.addsPunctuation = true
        }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("No microphone found.")
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
            self?.reportLevel(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("Couldn't start the microphone: \(error.localizedDescription)")
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let result = result {
                    self.latest = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.finish()
                    } else {
                        emit(["type": "partial", "text": self.latest])
                    }
                } else if error != nil {
                    self.finish()
                }
            }
        }
        emit(["type": "ready"])
        // Nobody talks for more than two minutes at a time: past that, it was
        // left on by mistake, so nothing is sent.
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) {
            if !self.finished {
                fail("Stopped listening after two minutes, and nothing was sent.")
            }
        }
    }

    func reportLevel(_ buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) > 0.07, let samples = buffer.floatChannelData?[0] else { return }
        lastLevelAt = now
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        for i in 0..<count {
            sum += samples[i] * samples[i]
        }
        let rms = (sum / Float(count)).squareRoot()
        let decibels = 20 * log10(max(rms, 0.000_001))
        let level = min(1, max(0, (decibels + 50) / 40)) // -50 dB → 0, -10 dB → 1
        emit(["type": "level", "value": Double(level)])
    }

    func stop() {
        if finished { return }
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        // The final result usually follows at once; don't wait for ever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.finish() }
    }

    func finish() {
        if finished { return }
        finished = true
        emit(["type": "final", "text": latest])
        exit(0)
    }
}

func listen() -> Never {
    let listener = Listener(lang: language)
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async {
            switch status {
            case .authorized:
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        if granted {
                            listener.start()
                        } else {
                            fail("Microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone.")
                        }
                    }
                }
            case .denied, .restricted:
                fail("Speech recognition is off. Turn it on in System Settings → Privacy & Security → Speech Recognition.")
            default:
                fail("Speech recognition isn't available on this Mac.")
            }
        }
    }
    // "stop" (or the app closing our input) finishes; "cancel" quits.
    DispatchQueue.global().async {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespaces)
            if command == "cancel" { exit(0) }
            if command == "stop" { break }
        }
        DispatchQueue.main.async { listener.stop() }
    }
    RunLoop.main.run()
    exit(0)
}

// ------------------------------------------------------------ type into other apps

func frontApp() -> Never {
    let captain = getppid()
    let me = getpid()
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    // Windows come front to back: the first ordinary window not Captain's.
    for info in windows {
        guard let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue, layer == 0,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              pid != captain, pid != me else { continue }
        let app = NSRunningApplication(processIdentifier: pid)
        guard app?.activationPolicy == .regular else { continue }
        let name = app?.localizedName ?? (info[kCGWindowOwnerName as String] as? String) ?? "the app in front"
        emit(["type": "app", "name": name, "pid": Int(pid)])
        exit(0)
    }
    emit(["type": "none"])
    exit(0)
}

func paste(into pid: pid_t) -> Never {
    guard pid > 0 else {
        fail("There's no app to type into.")
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(data: input, encoding: .utf8) ?? ""
    if text.isEmpty {
        emit(["type": "done"])
        exit(0)
    }
    let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(prompt) else {
        fail("Captain needs Accessibility permission to type into other apps. Turn on Captain in System Settings → Privacy & Security → Accessibility, then try again.")
    }
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
        fail("That app has closed.")
    }
    // Bring it back to the front (clicking Captain may have taken it), and make
    // sure it is, so the words don't land somewhere else.
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        app.activate(options: [])
        var waited = 0
        while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid && waited < 20 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            waited += 1
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            fail("Couldn't bring \(app.localizedName ?? "that app") to the front. Click into it and try again.")
        }
        usleep(120_000)
    }
    // Type it: up to 20 characters per key event; a new line is ⇧⏎ (a line
    // break, not "send", in chat apps).
    let source = CGEventSource(stateID: .hidSystemState)
    let lines = text.components(separatedBy: "\n")
    for (index, line) in lines.enumerated() {
        let units = Array(line.utf16)
        var at = 0
        while at < units.count {
            var chunk = Array(units[at..<min(at + 20, units.count)])
            // Don't split a surrogate pair across two events.
            if chunk.count == 20, let last = chunk.last, UTF16.isLeadSurrogate(last) {
                chunk.removeLast()
            }
            at += chunk.count
            for keyDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
                event?.flags = []
                event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event?.post(tap: .cghidEventTap)
            }
            usleep(8_000)
        }
        if index < lines.count - 1 {
            let returnKey: CGKeyCode = 36
            for keyDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: returnKey, keyDown: keyDown)
                event?.flags = .maskShift
                event?.post(tap: .cghidEventTap)
            }
            usleep(8_000)
        }
    }
    emit(["type": "done"])
    exit(0)
}

switch mode {
case "speak":
    speak()
case "frontapp":
    frontApp()
case "paste":
    paste(into: pid_t(language) ?? 0)
default:
    listen()
}
